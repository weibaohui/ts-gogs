// Git LFS server: batch API + basic transfer, mirroring internal/route/lfs.
// Mounted under /{owner}/{repo}.git/info/lfs/.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { conf } from './conf.js';
import * as db from './db/db.js';
import { User, Repository } from './db/db.js';
import { verifyPassword } from './authx/password.js';

const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';

function validOID(oid: string): boolean {
  return /^[a-f0-9]{64}$/.test(oid);
}

function sendJSON(res: http.ServerResponse, status: number, body: any): void {
  res.statusCode = status;
  res.setHeader('Content-Type', LFS_CONTENT_TYPE);
  res.end(JSON.stringify(body ?? {}));
}

function askCredentials(res: http.ServerResponse): void {
  res.setHeader('Lfs-Authenticate', 'Basic realm="Git LFS"');
  sendJSON(res, 401, { message: 'Credentials needed' });
}

function lfsObjectPath(oid: string): string {
  return path.join(conf.appDataPath, 'lfs-objects', oid.slice(0, 2), oid.slice(2, 4), oid);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** gogs LFS authenticate: basic user/pass (2FA users rejected), token as username or password. */
async function authenticate(req: http.IncomingMessage): Promise<User | null> {
  const header = String(req.headers.authorization ?? '');
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const username = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const password = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (!username) return null;

  const user = db.getUserByUsername(username);
  if (user && verifyPassword(password, user.salt, user.passwd)) {
    if (is2FAEnabled(user.id)) return null; // password auth disallowed for 2FA users
    return user;
  }
  // username or password may be an access token
  for (const candidate of [username, password]) {
    const row = db.getAccessTokenBySHA1(candidate);
    if (row) {
      const u = db.getUserByID((row as any).uid);
      if (u) return u;
    }
  }
  return null;
}

function is2FAEnabled(userID: number): boolean {
  return !!db.db().prepare('SELECT 1 FROM two_factor WHERE user_id = ?').get(userID);
}

function ensureStorage(oid: string): string {
  const dst = lfsObjectPath(oid);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  return dst;
}

/**
 * Handle an LFS request; returns true when handled.
 * subPath is the part after "/{owner}/{repo}.git/info/lfs".
 */
export async function handleLFS(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: User,
  repo: Repository,
  subPath: string
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  const user = await authenticate(req);

  // route: /objects/batch, /objects/basic/:oid, /objects/basic/verify
  const m = /^\/objects\/batch$/.exec(subPath);
  const mBasic = /^\/objects\/basic\/([a-f0-9]{64})$/.exec(subPath);
  const mVerify = /^\/objects\/basic\/verify$/.exec(subPath);
  if (!m && !mBasic && !mVerify) {
    sendJSON(res, 404, { message: 'Not found' });
    return true;
  }

  if (!user) {
    askCredentials(res);
    return true;
  }
  const mode = db.accessMode(user.id, repo);
  const canRead = mode >= db.AccessMode.READ || (!repo.is_private && !conf.requireSigninView);
  const canWrite = mode >= db.AccessMode.WRITE;

  // ---- POST /objects/batch
  if (m && method === 'POST') {
    if (!canRead) {
      sendJSON(res, 404, { message: 'Not found' });
      return true;
    }
    if (String(req.headers.accept ?? '') !== LFS_CONTENT_TYPE) {
      sendJSON(res, 406, { message: 'Bad `Accept` header' });
      return true;
    }
    if (String(req.headers['content-type'] ?? '') !== LFS_CONTENT_TYPE) {
      sendJSON(res, 400, { message: 'Bad `Content-Type` header' });
      return true;
    }
    let body: any;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (e: any) {
      sendJSON(res, 400, { message: String(e?.message ?? e).replace(/^./, (ch) => ch.toUpperCase()) });
      return true;
    }
    const operation = String(body.operation ?? '');
    const baseHref = `${conf.externalURL}${owner.name}/${repo.name}.git/info/lfs/objects/basic`;
    const objects: any[] = [];
    if (operation === 'upload') {
      for (const obj of body.objects ?? []) {
        if (validOID(String(obj.oid))) {
          objects.push({
            oid: obj.oid,
            size: obj.size,
            authenticated: true,
            actions: {
              upload: { href: `${baseHref}/${obj.oid}`, header: { 'Content-Type': 'application/octet-stream' } },
              verify: { href: `${baseHref}/verify` },
            },
          });
        } else {
          objects.push({ oid: obj.oid, size: obj.size, error: { code: 422, message: 'Object has invalid oid' } });
        }
      }
    } else if (operation === 'download') {
      for (const obj of body.objects ?? []) {
        const oid = String(obj.oid);
        const row = db.db().prepare('SELECT * FROM lfs_object WHERE repo_id = ? AND oid = ?').get(repo.id, oid) as any;
        if (!row) {
          objects.push({ oid, size: obj.size, error: { code: 404, message: 'Object does not exist' } });
        } else if (row.size !== obj.size) {
          objects.push({ oid, size: obj.size, error: { code: 422, message: 'Object size mismatch' } });
        } else {
          objects.push({ oid, size: obj.size, authenticated: true, actions: { download: { href: `${baseHref}/${oid}` } } });
        }
      }
    } else {
      sendJSON(res, 400, { message: 'Operation not supported' });
      return true;
    }
    sendJSON(res, 200, { transfer: 'basic', authentication: 'basic', objects });
    return true;
  }

  // ---- GET /objects/basic/:oid (download)
  if (mBasic && method === 'GET') {
    if (!canRead) {
      sendJSON(res, 404, { message: 'Not found' });
      return true;
    }
    const oid = mBasic[1];
    const row = db.db().prepare('SELECT * FROM lfs_object WHERE repo_id = ? AND oid = ?').get(repo.id, oid) as any;
    if (!row) {
      sendJSON(res, 404, { message: 'Object does not exist' });
      return true;
    }
    const file = lfsObjectPath(oid);
    if (!fs.existsSync(file)) {
      sendJSON(res, 404, { message: 'Object does not exist' });
      return true;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    fs.createReadStream(file).pipe(res);
    return true;
  }

  // ---- PUT /objects/basic/:oid (upload)
  if (mBasic && method === 'PUT') {
    if (!canWrite) {
      sendJSON(res, 404, { message: 'Not found' });
      return true;
    }
    if (String(req.headers['content-type'] ?? '') !== 'application/octet-stream') {
      sendJSON(res, 400, { message: 'Bad `Content-Type` header' });
      return true;
    }
    const oid = mBasic[1];
    const content = await readBody(req);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (hash !== oid) {
      sendJSON(res, 422, { message: 'Content-Length and Oid mismatches' });
      return true;
    }
    const dst = ensureStorage(oid);
    fs.writeFileSync(dst, content);
    db.db()
      .prepare('INSERT OR REPLACE INTO lfs_object (repo_id, oid, size, storage, created_at) VALUES (?,?,?,?,?)')
      .run(repo.id, oid, content.length, 'local', new Date().toISOString().replace('T', ' ').replace('Z', ''));
    res.statusCode = 200;
    res.end();
    return true;
  }

  // ---- POST /objects/basic/verify
  if (mVerify && method === 'POST') {
    if (!canWrite) {
      sendJSON(res, 404, { message: 'Not found' });
      return true;
    }
    let body: any;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch (e: any) {
      sendJSON(res, 400, { message: String(e?.message ?? e) });
      return true;
    }
    const oid = String(body.oid ?? '');
    const size = Number(body.size ?? -1);
    const row = db.db().prepare('SELECT * FROM lfs_object WHERE repo_id = ? AND oid = ?').get(repo.id, oid) as any;
    if (!row || !validOID(oid)) {
      sendJSON(res, 404, { message: 'Object does not exist' });
      return true;
    }
    if (row.size !== size) {
      sendJSON(res, 422, { message: 'Object size mismatch' });
      return true;
    }
    sendJSON(res, 200, {});
    return true;
  }

  sendJSON(res, 405, { message: 'Method not allowed' });
  return true;
}
