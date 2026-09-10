// serv subcommand: entrypoint for authorized_keys mode. The system sshd runs
// `<ts-gogs> serv key-<id>` via a command= restriction on each public key line;
// the actual git command arrives in SSH_ORIGINAL_COMMAND (gogs cmd/gogs/serv.go).
import * as db from './db/db.js';

export async function runServ(keyArg: string): Promise<void> {
  const keyID = Number(String(keyArg).replace(/^key-/, ''));
  const key = db.getPublicKeyByID(keyID);
  if (!key) {
    console.error('Serv: cannot find public key:', keyArg);
    process.exit(1);
  }
  const userID = (key as any).owner_id;
  const identity = {
    userID,
    keyID,
    deployRepoID: null as number | null,
  };
  if ((key as any).type === 2) {
    const dk = db.db().prepare('SELECT repo_id FROM deploy_key WHERE key_id = ?').get(keyID) as any;
    identity.deployRepoID = dk?.repo_id ?? null;
  }

  const sshCmd = process.env.SSH_ORIGINAL_COMMAND ?? '';
  if (!sshCmd) {
    console.error('Serv: interactive shell is disabled.');
    process.exit(1);
  }

  const { dispatchSSHCommand } = await import('./sshx/dispatch.js');
  // keep the event loop alive until close() — async handlers (LFS transfer)
  // must never be cut off by a premature exit
  const keepAlive = setInterval(() => {}, 1 << 30);
  dispatchSSHCommand(sshCmd, identity, {
    write: (chunk) => process.stdout.write(chunk),
    onStdin: (cb) => {
      process.stdin.on('data', (d: Buffer) => cb(d));
      process.stdin.resume();
    },
    close: (code) => {
      clearInterval(keepAlive);
      process.exit(code);
    },
  });
}
