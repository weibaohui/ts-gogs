// Builtin SSH server (gogs START_SSH_SERVER): publickey auth against the
// public_key table, then pipes `git-upload-pack`/`git-receive-pack` sessions.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import { spawn } from 'node:child_process';

// dynamic import keeps ssh2 out of the critical path when SSH is disabled
type SSH2 = typeof import('ssh2');

function hostKeyPath(): string {
  return path.join(conf.customDir, 'ssh', 'gogs_ed25519.key');
}

function ensureHostKey(): string {
  const file = hostKeyPath();
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  // ssh2 parses PKCS#1 "RSA PRIVATE KEY" PEM reliably
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  fs.writeFileSync(file, pem, { mode: 0o600 });
  return pem;
}

/** Normalize a public key to "type base64" for comparison. */
function normalizeKey(content: string): string {
  const parts = content.trim().split(/\s+/);
  if (parts.length < 2) return '';
  return `${parts[0]} ${parts[1]}`;
}

/** gogs parseSSHCmd: strips quotes like `git-upload-pack 'path'`. */
function parseSSHCmd(cmd: string): string[] {
  const m = /^\s*(git[-\s][a-z-]+|git)\s+'(.*)'\s*$/.exec(cmd) ?? /^\s*(git[-\s][a-z-]+|git)\s+"(.*)"\s*$/.exec(cmd) ?? /^\s*(git[-\s][a-z-]+|git)\s+(.*)\s*$/.exec(cmd);
  if (!m) return [];
  return [m[1], m[2].replace(/^~\//, '')];
}

const EMPTY = '0000000000000000000000000000000000000000';

interface SSHKeyIdentity {
  userID: number;
  keyID: number;
  /** deploy keys (type=2) are scoped to exactly one repository and read-only */
  deployRepoID: number | null;
}

async function authorizeKey(keyData: Buffer): Promise<SSHKeyIdentity | null> {
  const presented = normalizeKey(keyData.toString('utf8'));
  if (!presented) return null;
  const rows = db.db().prepare('SELECT id, owner_id, content, type FROM public_key').all() as any[];
  for (const row of rows) {
    if (normalizeKey(row.content) === presented) {
      if (row.type === 2) {
        const dk = db.db().prepare('SELECT repo_id FROM deploy_key WHERE key_id = ?').get(row.id) as any;
        return { userID: row.owner_id, keyID: row.id, deployRepoID: dk?.repo_id ?? null };
      }
      return { userID: row.owner_id, keyID: row.id, deployRepoID: null };
    }
  }
  return null;
}

async function serveGit(verb: string, repoFullName: string, identity: SSHKeyIdentity, write: (chunk: Buffer) => void, onStdin: (cb: (data: Buffer) => void) => void, onClose: (code: number) => void): Promise<void> {
  const userID = identity.userID;
  let repoName = repoFullName.replace(/^\//, '').replace(/\.git$/, '');
  let isWiki = false;
  if (repoName.endsWith('.wiki')) {
    isWiki = true;
    repoName = repoName.slice(0, -5);
  }
  const slash = repoName.indexOf('/');
  const ownerName = slash > 0 ? repoName.slice(0, slash) : repoName;
  const name = slash > 0 ? repoName.slice(slash + 1) : repoName;

  const owner = db.getUserByUsername(ownerName);
  const repo = owner ? db.getRepoByOwnerAndName(owner, name) : null;
  const fail = (msg: string, status = 404) => {
    write(Buffer.from(`\r\n${status === 404 ? 'Repository does not exist' : msg}\r\n`));
    onClose(1);
  };
  if (!owner || !repo) return fail('', 404);
  const repoDir = isWiki ? repo.WikiPath() : repo.RepoPath();
  if (!fs.existsSync(repoDir)) return fail('', 404);

  const mode = db.accessMode(userID, repo);
  const isPull = verb === 'git-upload-pack';
  const need = isPull ? db.AccessMode.READ : db.AccessMode.WRITE;
  if (!(isPull && !repo.is_private && !conf.requireSigninView) && mode < need) {
    return fail('Access denied', 403);
  }
  if (!isPull && repo.is_mirror) return fail('Mirror repository is read-only', 403);

  // deploy keys: single-repo, read-only
  if (identity.deployRepoID !== null) {
    if (!isPull || identity.deployRepoID !== repo.id) return fail('Access denied', 403);
  }

  const args = isPull ? ['upload-pack', repoDir] : ['receive-pack', repoDir];
  const env: Record<string, string> = {};
  if (!isPull) {
    const user = db.getUserByID(userID);
    Object.assign(env, {
      GOGS_AUTH_USER_ID: String(user?.id ?? 0),
      GOGS_AUTH_USER_NAME: String(user?.name ?? ''),
      GOGS_AUTH_USER_EMAIL: String(user?.email ?? ''),
      GOGS_REPO_OWNER_NAME: owner.name,
      GOGS_REPO_ID: String(repo.id),
      GOGS_REPO_NAME: repo.name,
      GOGS_REPO_CUSTOM_HOOKS_PATH: path.join(repoDir, 'custom_hooks'),
    });
  }

  const child = spawn('git', args, { env: { ...process.env, ...env } });
  child.stdout.on('data', (d: Buffer) => write(d));
  child.stderr.on('data', (d: Buffer) => write(Buffer.from(`remote: ${d.toString()}`)));
  onStdin((data) => child.stdin.write(data));
  child.on('close', (code) => onClose(code ?? 0));
  child.on('error', () => onClose(1));
}

export function startSSHServer(): void {
  import('ssh2').then(({ default: ssh2 }) => {
    const hostKey = ensureHostKey();
    const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
      let authedUser: SSHKeyIdentity | null = null;
      client
        .on('ready', () => {
          client.on('session', (accept: any) => {
            const session = accept();
            session.on('exec', (accept: any, _reject: any, info: any) => {
              const stream: any = accept();
              const [verb, repoFullName] = parseSSHCmd(String(info.command));
              if (!authedUser || !verb || !repoFullName) {
                stream.exit(1);
                stream.end();
                return;
              }
              serveGit(
                verb,
                repoFullName,
                authedUser,
                (chunk) => stream.write(chunk),
                (cb) => stream.on('data', (d: Buffer) => cb(d)),
                (code) => {
                  stream.exit(code);
                  stream.end();
                }
              ).catch((e) => {
                console.error('[ssh]', e);
                stream.exit(1);
                stream.end();
              });
            });
          });
        })
        .on('error', () => {});

      client.on('authentication', (ctx: any) => {
        if (ctx.method !== 'publickey') {
          return ctx.reject(['publickey']);
        }
        const buf: Buffer = ctx.key?.data;
        if (!buf) return ctx.reject();
        // the wire blob starts with a length-prefixed algorithm name
        const algLen = buf.readUInt32BE(0);
        const algName = buf.subarray(4, 4 + algLen).toString('utf8');
        // the .pub base64 IS the full wire blob (alg prefix + body)
        const b64 = buf.toString('base64');
        const line = `${algName} ${b64}`;
        authorizeKey(Buffer.from(line)).then((u) => {
          if (u) {
            authedUser = u;
            ctx.accept();
          } else {
            ctx.reject();
          }
        });
      });
    });

    const port = conf.sshPort === 22 ? 22 : conf.sshPort;
    const listenPort = process.env.GOGS_SSH_PORT ? Number(process.env.GOGS_SSH_PORT) : port;
    server.listen(listenPort, '0.0.0.0', () => {
      console.log(`SSH server started on 0.0.0.0:${listenPort}`);
    });
    server.on('error', (e: any) => console.error('[ssh]', e));
    void http;
    void EMPTY;
  });
}
