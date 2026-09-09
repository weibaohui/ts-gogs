// Git smart HTTP protocol (info/refs, git-upload-pack, git-receive-pack),
// auth & behavior mirroring internal/route/repo/http.go. Push post-processing
// runs in-process after a successful receive-pack.
import * as http from 'node:http';
import * as fsMod from 'node:fs';
import * as zlib from 'node:zlib';
import * as path from 'node:path';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import * as git from './git.js';
import { authenticateUserByBasic } from '../context.js';
import * as crypto from 'node:crypto';

function require_md5hex(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

const NO_CACHE_HEADERS: Record<string, string> = {
  Expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache, max-age=0, must-revalidate',
};

/** Try to handle a git smart-HTTP request; returns false when not a git path. */
export function handleGitHTTP(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  const m = /^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(.*))?$/.exec(pathname);
  if (!m) return false;
  const [, username, rawRepo, rest] = m;
  if (!rest) return false;

  // repoName may carry .git / .wiki suffixes
  let repoName = rawRepo;
  let isWiki = false;
  if (repoName.endsWith('.wiki')) {
    isWiki = true;
    repoName = repoName.slice(0, -5);
  } else if (repoName.endsWith('.git')) {
    repoName = repoName.slice(0, -4);
    if (repoName.endsWith('.wiki')) {
      isWiki = true;
      repoName = repoName.slice(0, -5);
    }
  }

  const action = rest.split('?')[0];

  // Git LFS: /info/lfs/...
  const lfsMatch = /^info\/lfs(\/.*)?$/.exec(action);
  if (lfsMatch) {
    (async () => {
      try {
        const owner = db.getUserByUsername(username);
        const repo = owner ? db.getRepoByOwnerAndName(owner, repoName) : null;
        const fsMod = await import('node:fs');
        if (!owner || !repo || !fsMod.existsSync(isWiki ? repo.WikiPath() : repo.RepoPath())) {
          res.statusCode = 404;
          res.end('repository does not exist');
          return;
        }
        const { handleLFS } = await import('../lfsx.js');
        await handleLFS(req, res, owner, repo, lfsMatch[1] ?? '/');
      } catch (e: any) {
        console.error('[lfs]', e);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      }
    })();
    return true;
  }

  const GIT_ACTIONS = new Set([
    'info/refs', 'HEAD', 'git-upload-pack', 'git-receive-pack',
    'objects/info/alternates', 'objects/info/http-alternates', 'objects/info/packs',
  ]);
  const isObjectReq =
    /^objects\/info\/.*/.test(action) ||
    /^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(action) ||
    /^objects\/pack\/pack-[0-9a-f]{40}\.(pack|idx)$/.test(action);
  if (!GIT_ACTIONS.has(action) && !isObjectReq) return false;

  const lowerPath = pathname.toLowerCase();

  (async () => {
    try {
      const owner = db.getUserByUsername(username);
      const repo = owner ? db.getRepoByOwnerAndName(owner, repoName) : null;
      if (!repo) {
        res.statusCode = 404;
        res.end('repository does not exist');
        return;
      }
      const repoDir = isWiki ? repo.WikiPath() : repo.RepoPath();
      if (!fsMod.existsSync(repoDir)) {
        res.statusCode = 404;
        res.end('repository does not exist');
        return;
      }

      // service detection
      const service = new URL(req.url ?? '/', 'http://internal').searchParams.get('service') ?? '';
      const isReceive = action === 'git-receive-pack' || service === 'git-receive-pack';
      const isPull = action === 'info/refs' ? service !== 'git-receive-pack' : action !== 'git-receive-pack';

      if (conf.disableHTTPGit) {
        res.statusCode = 403;
        res.end('The repository\'s HTTP git is disabled');
        return;
      }

      // public repo pull requires no auth (unless REQUIRE_SIGNIN_VIEW)
      if (!(isPull && !repo.is_private && !conf.requireSigninView)) {
        const authHeader = String(req.headers.authorization ?? '');
        const authed = authenticateUserByBasic(authHeader);
        if (!authed) {
          res.statusCode = 401;
          res.setHeader('WWW-Authenticate', 'Basic realm="."');
          res.end('Requires authentication');
          return;
        }
        const mode = db.accessMode(authed.user.id, repo);
        const need = isPull ? db.AccessMode.READ : db.AccessMode.WRITE;
        if (mode < need) {
          res.statusCode = 403;
          res.end('User does not have access to repository');
          return;
        }
        if (isReceive && repo.is_mirror) {
          res.statusCode = 403;
          res.end('Mirror repository is read-only');
          return;
        }
        // stash authed user for post-processing
        (req as any).__authedUser = authed.user;
      }

      for (const [k, v] of Object.entries(NO_CACHE_HEADERS)) res.setHeader(k, v);

      if (action === 'info/refs') {
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          // dumb protocol: run update-server-info and serve the static file
          await git.git(repoDir, 'update-server-info');
          const file = path.join(repoDir, 'info', 'refs');
          if (fsMod.existsSync(file)) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(fsMod.readFileSync(file));
          } else {
            res.statusCode = 404;
            res.end();
          }
          return;
        }
        const out = await git.statelessRPC(repoDir, service === 'git-receive-pack' ? 'receive-pack' : 'upload-pack', true, Buffer.alloc(0));
        res.setHeader('Content-Type', `application/x-${service}-advertisement`);
        const head = git.pktLine(`# service=${service}\n`) + '0000';
        res.end(Buffer.concat([Buffer.from(head), out]));
        return;
      }

      if (action === 'git-upload-pack' || action === 'git-receive-pack') {
        const svc = action === 'git-upload-pack' ? 'upload-pack' : 'receive-pack';
        const reqContentType = `application/x-git-${svc}-request`;
        if (String(req.headers['content-type'] ?? '') !== reqContentType) {
          res.statusCode = 401;
          res.end();
          return;
        }
        let body = await readBody(req);
        if (String(req.headers['content-encoding'] ?? '') === 'gzip') {
          body = zlib.gunzipSync(body);
        }
        res.setHeader('Content-Type', `application/x-${svc}-result`);
        if (svc === 'receive-pack') {
          // post-processing runs via delegate hooks (env flows into them)
          const out = await git.statelessRPC(repoDir, svc, false, body, {
            GOGS_AUTH_USER_ID: String((req as any).__authedUser?.id ?? 0),
            GOGS_AUTH_USER_NAME: String((req as any).__authedUser?.name ?? ''),
            GOGS_AUTH_USER_EMAIL: String((req as any).__authedUser?.email ?? ''),
            GOGS_REPO_OWNER_NAME: String(owner!.name),
            GOGS_REPO_OWNER_SALT_MD5: require_md5hex(`${owner!.name}${owner!.salt ?? ''}`),
            GOGS_REPO_ID: String(repo.id),
            GOGS_REPO_NAME: String(repo.name),
            GOGS_REPO_CUSTOM_HOOKS_PATH: path.join(repoDir, 'custom_hooks'),
          });
          res.end(out);
        } else {
          const out = await git.statelessRPC(repoDir, svc, false, body);
          res.end(out);
        }
        return;
      }

      // static object serving (dumb protocol)
      const safe = path.normalize(action).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(repoDir, safe);
      if (fsMod.existsSync(file) && fsMod.statSync(file).isFile()) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.end(fsMod.readFileSync(file));
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch (e: any) {
      console.error('[git http]', e);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  })();

  return true;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseRefUpdates(body: Buffer): Array<{ ref: string; old: string; new: string }> {
  // pkt-line stream: 4-hex len lines "old new ref\0capabilities" until 0000
  const updates: Array<{ ref: string; old: string; new: string }> = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const lenStr = body.toString('utf8', pos, pos + 4);
    if (!/^[0-9a-f]{4}$/.test(lenStr)) break;
    const len = parseInt(lenStr, 16);
    if (len === 0) break;
    let line = body.toString('utf8', pos + 4, pos + len);
    pos += len;
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
      updates.push({ old: parts[0], new: parts[1], ref: parts[2] });
    }
  }
  return updates;
}
