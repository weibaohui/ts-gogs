// dsh 桥：user-management 用户库凭据验证（供 dsh-git-server 插件模式使用）。
//
// 启用方式：环境变量 DSH_UM_USERS_FILE 指向 user-management 的 users.json
// （通常 ~/.dsh/user-management/users.json）。启用后：
//   - git HTTP Basic 认证（authenticateUserByBasic）优先对 UM 用户库验证；
//   - 网页登录（/api/web/user/sign-in）同样接受 UM 用户名/密码。
// 验证通过的 UM 用户映射到本库的管理员账号（DSH_UM_AS_USER，默认 root）——
// UM 侧不携带仓库级权限模型，统一按管理员对待（与 dsh-webdav-server 的
// um-auth 同一取舍：挂载/推送凭据只回答"是不是这个团队的人"）。
//
// 口令格式跨仓复刻 user-management store.js：crypto.scrypt（salt 为 hex 字符串、
// hex hash，N=16384/r=8/p=1，keylen 32）。users.json 缺失/损坏 → 桥不可用，
// 回退本库认证，绝不把人锁死在外面。
import * as fs from 'node:fs';
import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 32;
const SCRYPT_COST = 16384;
const POSITIVE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const CACHE_MAX = 500;
// 与 user-management 登录同款：缺失用户也烧一次哈希时间，防用户名枚举
const DUMMY_SALT = '0'.repeat(32);

let cacheUsers: any[] | null = null;
let cacheStamp: string | null = null;
const verdicts = new Map<string, { ok: boolean; expiresAt: number }>();

export function umUsersFile(): string | null {
  const f = process.env.DSH_UM_USERS_FILE || '';
  return f ? f : null;
}

export function umAuthEnabled(): boolean {
  return !!umUsersFile();
}

function loadUsers(): any[] | null {
  const file = umUsersFile();
  if (!file) return null;
  let stamp: string | null = null;
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    cacheUsers = null;
    cacheStamp = null;
    return null;
  }
  if (stamp === cacheStamp && cacheUsers) return cacheUsers;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const users = Array.isArray(doc && doc.users) ? doc.users : null;
    if (!users) {
      cacheUsers = null;
      cacheStamp = null;
      return null;
    }
    cacheUsers = users;
    cacheStamp = stamp;
    return users;
  } catch {
    cacheUsers = null;
    cacheStamp = null;
    return null;
  }
}

export function umAvailability(): 'ok' | 'missing' | 'disabled' {
  if (!umAuthEnabled()) return 'disabled';
  return loadUsers() ? 'ok' : 'missing';
}

function verifyScrypt(record: any, password: string): boolean {
  if (!record || !record.salt || !record.passHash || typeof password !== 'string') return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(record.passHash, 'hex');
  } catch {
    return false;
  }
  let derived: Buffer;
  try {
    derived = scryptSync(password, record.salt, KEY_LEN, { N: SCRYPT_COST, r: 8, p: 1 });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function burnHash(password: string): void {
  try {
    scryptSync(password, DUMMY_SALT, KEY_LEN, { N: SCRYPT_COST, r: 8, p: 1 });
  } catch {}
}

/**
 * check(username, password) → { ok, reason?, unavailable? }
 * reason: 'no-user' | 'disabled' | 'totp' | 'bad-password'（只进日志，HTTP 侧统一 401）
 */
export function umCheck(username: string, password: string): { ok: boolean; reason?: string; unavailable?: boolean } {
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    return { ok: false };
  }
  const users = loadUsers();
  if (!users) return { ok: false, unavailable: true };

  const key = createHash('sha256').update(username + '\0' + password).digest('hex');
  const hit = verdicts.get(key);
  if (hit) {
    if (Date.now() > hit.expiresAt) verdicts.delete(key);
    else return { ok: hit.ok };
  }

  const user = users.find((u) => u && u.username === username);
  let ok = false;
  let reason: string | undefined;
  if (!user) {
    burnHash(password);
    reason = 'no-user';
  } else if (user.disabled) {
    burnHash(password);
    reason = 'disabled';
  } else if (user.totpSecret) {
    // 网页登录处会先走 UM 自己的 MFA 流程走不通，这里 Basic/直登均无法输入动态码：明确拒绝
    burnHash(password);
    reason = 'totp';
  } else {
    ok = verifyScrypt(user, password);
    if (!ok) reason = 'bad-password';
  }
  if (verdicts.size >= CACHE_MAX) verdicts.clear();
  verdicts.set(key, { ok, expiresAt: Date.now() + (ok ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return { ok, reason };
}
