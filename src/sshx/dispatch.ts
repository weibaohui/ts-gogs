// Shared SSH command dispatch used by both the builtin SSH server and the
// `serv` subcommand (authorized_keys mode). Verbs mirror gogs cmd/gogs/serv.go
// plus the LFS-over-SSH extensions (git-lfs-authenticate, git-lfs-transfer).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import { runLFSTransfer } from './lfs-transfer.js';

export interface SSHKeyIdentity {
  userID: number;
  keyID: number;
  /** deploy keys (type=2) are scoped to exactly one repository and read-only */
  deployRepoID: number | null;
}

export interface SSHIO {
  write(chunk: Buffer): void;
  onStdin(cb: (data: Buffer) => void): void;
  close(code: number): void;
}

export function parseSSHCmd(cmd: string): string[] {
  const m =
    /^\s*(git[-\s][a-z-]+|git-lfs-authenticate|git-lfs-transfer)\s+'(.*)'\s*$/.exec(cmd) ??
    /^\s*(git[-\s][a-z-]+|git-lfs-authenticate|git-lfs-transfer)\s+"(.*)"\s*$/.exec(cmd) ??
    /^\s*(git[-\s][a-z-]+|git-lfs-authenticate|git-lfs-transfer)\s+(.*)\s*$/.exec(cmd);
  if (!m) return [];
  return [m[1], m[2].replace(/^~\//, '')];
}

function resolveRepo(repoFullName: string): { owner: db.User; repo: db.Repository; repoDir: string } | null {
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
  if (!owner || !repo) return null;
  const repoDir = isWiki ? repo.WikiPath() : repo.RepoPath();
  if (!fs.existsSync(repoDir)) return null;
  return { owner, repo, repoDir };
}

/** git-upload-pack / git-receive-pack with gogs permission semantics. */
export function serveGit(
  verb: string,
  repoFullName: string,
  identity: SSHKeyIdentity,
  io: SSHIO
): void {
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
  const fail = (msg: string) => {
    io.write(Buffer.from(`\r\n${msg}\r\n`));
    io.close(1);
  };
  if (!owner || !repo) return fail('Repository does not exist');
  const repoDir = isWiki ? repo.WikiPath() : repo.RepoPath();
  if (!fs.existsSync(repoDir)) return fail('Repository does not exist');

  const isPull = verb === 'git-upload-pack';
  // deploy keys: single-repo, read-only
  if (identity.deployRepoID !== null && (!isPull || identity.deployRepoID !== repo.id)) {
    return fail('Access denied');
  }
  const mode = db.accessMode(identity.userID, repo);
  const need = isPull ? db.AccessMode.READ : db.AccessMode.WRITE;
  if (!(isPull && !repo.is_private && !conf.requireSigninView) && mode < need) {
    return fail('Access denied');
  }
  if (!isPull && repo.is_mirror) return fail('Mirror repository is read-only');

  const args = isPull ? ['upload-pack', repoDir] : ['receive-pack', repoDir];
  const env: Record<string, string> = {};
  if (!isPull) {
    const user = db.getUserByID(identity.userID);
    Object.assign(env, {
      GOGS_AUTH_USER_ID: String(user?.id ?? 0),
      GOGS_AUTH_USER_NAME: String(user?.name ?? ''),
      GOGS_AUTH_USER_EMAIL: String(user?.email ?? ''),
      GOGS_REPO_OWNER_NAME: owner.name,
      GOGS_REPO_ID: String(repo.id),
      GOGS_REPO_NAME: String(repo.name),
      GOGS_REPO_CUSTOM_HOOKS_PATH: path.join(repoDir, 'custom_hooks'),
    });
  }

  const child = spawn('git', args, { env: { ...process.env, ...env } });
  child.stdout.on('data', (d: Buffer) => io.write(d));
  child.stderr.on('data', (d: Buffer) => io.write(Buffer.from(`remote: ${d.toString()}`)));
  io.onStdin((data) => child.stdin.write(data));
  child.on('close', (code) => io.close(code ?? 0));
  child.on('error', () => io.close(1));
}

/** git-lfs-authenticate <path> <download|upload> → JSON auth response on stdout. */
export async function serveLFSAuthenticate(
  argStr: string,
  identity: SSHKeyIdentity,
  io: SSHIO
): Promise<void> {
  const parts = argStr.trim().split(/\s+/);
  const repoFullName = parts[0];
  const operation = parts[1] ?? 'download';
  if (!['download', 'upload'].includes(operation)) {
    io.write(Buffer.from(`lfs-authenticate: invalid operation: ${operation}\n`));
    io.close(1);
    return;
  }
  const resolved = resolveRepo(repoFullName);
  if (!resolved) {
    io.write(Buffer.from('Repository does not exist\n'));
    io.close(1);
    return;
  }
  const { owner, repo } = resolved;
  const mode = db.accessMode(identity.userID, repo);
  const need = operation === 'upload' ? db.AccessMode.WRITE : db.AccessMode.READ;
  if (!(operation === 'download' && !repo.is_private && !conf.requireSigninView) && mode < need) {
    io.write(Buffer.from('Access denied\n'));
    io.close(1);
    return;
  }
  const { mintLFSToken } = await import('../lfsx.js');
  const { token, expiresAt } = mintLFSToken(identity.userID, repo.id);
  const href = `${conf.externalURL}${owner.name}/${repo.name}.git/info/lfs/objects/batch`;
  io.write(
    Buffer.from(
      JSON.stringify({
        href,
        header: { Authorization: `RemoteAuth ${token}` },
        'expires_in': 86400,
        'expires_at': new Date(expiresAt * 1000).toISOString(),
      }) + '\n'
    )
  );
  io.close(0);
}

/** git-lfs-transfer <path> <download|upload> — pure SSH LFS transfer protocol (lfs-transfer-1). */
export async function serveLFSTransfer(
  argStr: string,
  identity: SSHKeyIdentity,
  io: SSHIO
): Promise<void> {
  await runLFSTransfer(argStr, identity, io);
}

/** Top-level dispatch: parse and run one SSH command. */
export function dispatchSSHCommand(command: string, identity: SSHKeyIdentity, io: SSHIO): void {
  const [verb, args] = parseSSHCmd(command);
  if (!verb) {
    io.close(1);
    return;
  }
  switch (verb) {
    case 'git-upload-pack':
    case 'git-receive-pack':
      serveGit(verb, args, identity, io);
      return;
    case 'git-lfs-authenticate':
      serveLFSAuthenticate(args, identity, io).catch((e) => {
        console.error('[lfs-auth] error:', e);
        io.close(1);
      });
      return;
    case 'git-lfs-transfer':
      serveLFSTransfer(args, identity, io).catch((e) => {
        console.error('[lfs-transfer] error:', e);
        io.close(1);
      });
      return;
    default:
      io.write(Buffer.from(`Serv: unknown command: ${verb}\n`));
      io.close(1);
  }
}
