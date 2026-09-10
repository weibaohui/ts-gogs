// Builtin SSH server (gogs START_SSH_SERVER): publickey auth against the
// public_key table, then pipes `git-upload-pack`/`git-receive-pack` sessions.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import { dispatchSSHCommand, SSHKeyIdentity } from './dispatch.js';

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
              const user = authedUser;
              if (!user) {
                stream.exit(1);
                stream.end();
                return;
              }
              dispatchSSHCommand(String(info.command), user, {
                write: (chunk) => stream.write(chunk),
                onStdin: (cb) => stream.on('data', (d: Buffer) => cb(d)),
                close: (code) => {
                  stream.exit(code);
                  stream.end();
                },
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
  });
}
