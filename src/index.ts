// ts-gogs entry point.
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import { conf } from './conf.js';
import { startServer } from './server.js';
import { db } from './db/db.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // work directory = repo root (contains templates/, public/, vendored-conf/)
  const workDir = path.resolve(__dirname, '..');
  const customDir = process.env.GOGS_CUSTOM ?? path.join(workDir, 'custom');
  fs.mkdirSync(customDir, { recursive: true });

  // --config=<path> (gogs CLI convention, used by authorized_keys serv entries)
  const configFlag = argv.find((a) => a.startsWith('--config='));
  const confOverride = configFlag ? configFlag.slice('--config='.length).replace(/^'|'$/g, '') : process.env.GOGS_CUSTOM_CONF;
  conf.load(workDir, customDir, confOverride);

  // asset cache-busting version: real commit when serving from a git checkout
  try {
    conf.buildCommit = execSync('git rev-parse --short HEAD', { cwd: workDir }).toString().trim();
  } catch {}

  // git delegate hook / ssh serv entrypoints (config must be loaded before dispatch)
  if (argv[0] === 'hook') {
    const { runHook } = await import('./hook.js');
    await runHook(argv[1] ?? '');
    return;
  }
  if (argv[0] === 'serv') {
    const { runServ } = await import('./serv.js');
    await runServ(argv[1] ?? '');
    return;
  }
  console.log(`${conf.brandName} ${conf.version} (ts-gogs)`);
  console.log(`Work directory: ${workDir}`);
  console.log(`Custom path:    ${customDir}`);

  // git version check (gogs requires >= 1.8.3)
  const { gitVersion } = await import('./gitx/git.js');
  try {
    const v = await gitVersion();
    console.log(`Git version:    ${v}`);
  } catch (e) {
    console.error('FATAL: git binary not found');
    process.exit(1);
  }
  // gogs NewRepoContext: ensure a global git identity exists
  const { gitOK } = await import('./gitx/git.js');
  if (!(await gitOK(process.cwd(), 'config', '--global', 'user.email'))) {
    await gitOK(process.cwd(), 'config', '--global', 'user.email', 'gogs@fake.local');
    await gitOK(process.cwd(), 'config', '--global', 'user.name', 'Gogs');
  }

  db();
  console.log(`Database:       ${conf.dbPath}`);

  // dsh-git-server 插件模式：
  //   DSH_BOOTSTRAP_ADMIN=user:pass — 用户库为空时播种管理员
  //   DSH_ADMIN_PASSWORD — 每次启动把该管理员密码重置为此值（设置页轮换密码的落点）
  const bootstrap = process.env.DSH_BOOTSTRAP_ADMIN || '';
  const adminPass = process.env.DSH_ADMIN_PASSWORD || '';
  const adminName = bootstrap.split(':')[0] || 'root';
  if (bootstrap.includes(':') || adminPass) {
    const count = (db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 0').get() as any).c;
    const { randomSalt, encodePassword } = await import('./authx/password.js');
    const now = Math.floor(Date.now() / 1000);
    if (count === 0) {
      const pass = bootstrap.includes(':') ? bootstrap.slice(bootstrap.indexOf(':') + 1) : (adminPass || 'gogs-admin');
      const salt = randomSalt();
      db().prepare('INSERT INTO user (name, lower_name, email, passwd, salt, type, is_admin, created_unix, updated_unix) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)')
        .run(adminName, adminName.toLowerCase(), `${adminName}@dsh.local`, encodePassword(pass, salt), salt, now, now);
      console.log(`Bootstrap admin created: ${adminName}`);
    } else if (adminPass) {
      // 管理员已存在：重置密码为插件配置值（设置页轮换的真实落点）
      const admin = db().prepare('SELECT id, salt FROM user WHERE type = 0 AND is_admin = 1 ORDER BY id LIMIT 1').get() as any;
      if (admin) {
        const { encodePassword: enc } = await import('./authx/password.js');
        db().prepare('UPDATE user SET passwd = ?, updated_unix = ? WHERE id = ?').run(enc(adminPass, admin.salt), now, admin.id);
        console.log(`Admin password synced from plugin settings`);
      }
    }
  }

  const server = await startServer();

  // periodic mirror synchronization (gogs InitSyncMirrors)
  const { startMirrorLoop } = await import('./mirror.js');
  startMirrorLoop();

  // builtin SSH server (gogs START_SSH_SERVER)
  if (conf.startSSHServer) {
    const { startSSHServer } = await import('./sshx/server.js');
    startSSHServer();
  } else if (!conf.disableSSH) {
    // authorized_keys mode: system sshd handles connections via `serv key-<id>`
    const { writeAuthorizedKeys } = await import('./routes/sshkey.js');
    writeAuthorizedKeys();
  }

  console.log(`Available on    ${conf.externalURL}`);
  console.log(`Listening       ${conf.httpAddr}:${conf.httpPort}`);

  const shutdown = () => {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
