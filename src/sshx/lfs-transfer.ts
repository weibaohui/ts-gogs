// git-lfs-transfer: pure SSH LFS transfer protocol (lfs-transfer-1) per the
// git-lfs spec (docs/proposals/ssh_adapter.md). pkt-line framing: flush=0000,
// delim=0001, data pkt = hex(len) + payload. Binary payloads are pkt-framed.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import type { SSHKeyIdentity, SSHIO } from './dispatch.js';

// pkt-line control frames are FOUR ASCII chars '0000'/'0001'
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pkt(data: string | Buffer): Buffer {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const header = Buffer.from((buf.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, buf]);
}

function lfsObjectPath(oid: string): string {
  return `${conf.appDataPath}/lfs-objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`;
}

/** Resolve owner/repo the same way as dispatch.serveGit. */
function resolveRepo(repoFullName: string): { owner: db.User; repo: db.Repository } | null {
  let repoName = repoFullName.replace(/^\//, '').replace(/\.git$/, '');
  if (repoName.endsWith('.wiki')) repoName = repoName.slice(0, -5);
  const slash = repoName.indexOf('/');
  const ownerName = slash > 0 ? repoName.slice(0, slash) : repoName;
  const name = slash > 0 ? repoName.slice(slash + 1) : repoName;
  const owner = db.getUserByUsername(ownerName);
  const repo = owner ? db.getRepoByOwnerAndName(owner, name) : null;
  return owner && repo ? { owner, repo } : null;
}

class PktReader {
  private buf = Buffer.alloc(0);
  private closed = false;
  private waiters: Array<() => void> = [];

  push(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }

  end(): void {
    this.closed = true;
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }

  /** Returns next pkt: {type:'data',payload} | {type:'flush'} | {type:'delim'} | null(EOF). */
  async next(): Promise<{ type: 'data' | 'flush' | 'delim'; payload: Buffer } | null> {
    while (true) {
      if (this.buf.length >= 4) {
        const lenStr = this.buf.toString('utf8', 0, 4);
        if (/^[0-9a-f]{4}$/.test(lenStr)) {
          const len = parseInt(lenStr, 16);
          if (len === 0) {
            this.buf = this.buf.subarray(4);
            return { type: 'flush', payload: Buffer.alloc(0) };
          }
          if (len === 1) {
            this.buf = this.buf.subarray(4);
            return { type: 'delim', payload: Buffer.alloc(0) };
          }
          if (len >= 4 && this.buf.length >= len) {
            const payload = this.buf.subarray(4, len);
            this.buf = this.buf.subarray(len);
            return { type: 'data', payload };
          }
        }
      }
      if (this.closed && this.buf.length < 4) return null;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

export async function runLFSTransfer(
  argStr: string,
  identity: SSHKeyIdentity,
  io: SSHIO
): Promise<void> {
  const parts = argStr.trim().split(/\s+/);
  const repoFullName = parts[0];
  const operation = parts[1] ?? 'download';
  if (!['download', 'upload'].includes(operation)) {
    io.write(Buffer.from(`git-lfs-transfer: invalid operation: ${operation}\n`));
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

  const reader = new PktReader();
  io.onStdin((data) => reader.push(data));

  const writePkt = (s: string) => io.write(pkt(s));
  const writeFlush = () => io.write(FLUSH);
  const writeDelim = () => io.write(DELIM);
  const writeStatus = (code: number, args: string[] = [], delim = false) => {
    io.write(pkt(`status ${code}`));
    for (const a of args) io.write(pkt(a));
    if (delim) writeDelim();
    writeFlush();
  };

  // 1. capability advertisement (server speaks first)
  io.write(pkt('capability-list'));
  io.write(pkt('version=1'));
  io.write(pkt('begin-upload'));
  io.write(pkt('begin-download'));
  writeFlush();

  let quit = false;
  while (!quit) {
    const p = await reader.next();
    if (p === null) break;
    if (p.type === 'flush') continue;
    if (p.type !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const sp = line.indexOf(' ');
    const cmd = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1);

    switch (cmd) {
      case 'version': {
        if (rest === '1') writeStatus(200);
        else writeStatus(400);
        break;
      }
      case 'quit': {
        writeStatus(200);
        quit = true;
        break;
      }
      case 'batch': {
        // collect arguments until delim, then oid lines until flush
        const args: Record<string, string> = {};
        const oids: Array<{ oid: string; size: number }> = [];
        let inOids = false;
        while (true) {
          const q = await reader.next();
          if (q === null || q.type === 'flush') break;
          if (q.type === 'delim') {
            inOids = true;
            continue;
          }
          if (q.type !== 'data') continue;
          const l = q.payload.toString('utf8').replace(/\n$/, '');
          if (!inOids) {
            const eq = l.indexOf('=');
            if (eq > 0) args[l.slice(0, eq)] = l.slice(eq + 1);
          } else {
            const m = /^(\S+) (\d+)(?: (.*))?$/.exec(l);
            if (m) oids.push({ oid: m[1], size: Number(m[2]) });
          }
        }
        io.write(pkt('status 200'));
        writeDelim();
        const wantUpload = operation === 'upload';
        for (const o of oids) {
          const row = db.db().prepare('SELECT * FROM lfs_object WHERE repo_id = ? AND oid = ?').get(repo.id, o.oid) as any;
          const exists = !!row && fs.existsSync(lfsObjectPath(o.oid));
          let action: string;
          if (wantUpload) {
            // upload: offer upload when missing or size mismatch; else noop
            action = !exists || row.size !== o.size ? 'upload' : 'noop';
          } else {
            if (!exists) {
              action = 'noop'; // mirrors HTTP 404 → error shape
              io.write(pkt(`${o.oid} ${o.size} error message=[Object does not exist]`));
              continue;
            }
            action = row.size === o.size ? 'download' : 'noop';
          }
          io.write(pkt(`${o.oid} ${o.size} ${action}`));
        }
        writeFlush();
        break;
      }
      case 'get-object': {
        const oid = rest.trim();
        const file = lfsObjectPath(oid);
        const row = db.db().prepare('SELECT * FROM lfs_object WHERE repo_id = ? AND oid = ?').get(repo.id, oid) as any;
        if (!row || !fs.existsSync(file)) {
          writeStatus(404, [], true);
          io.write(pkt('Object does not exist\n'));
          writeFlush();
          break;
        }
        io.write(pkt('status 200'));
        io.write(pkt(`size=${row.size}`));
        writeDelim();
        const content = fs.readFileSync(file);
        for (let off = 0; off < content.length; off += 65516) {
          io.write(pkt(content.subarray(off, Math.min(off + 65516, content.length))));
        }
        writeFlush();
        break;
      }
      case 'put-object': {
        const oid = rest.trim();
        // arguments until DELIM, then binary data until FLUSH
        let size = 0;
        while (true) {
          const q = await reader.next();
          if (q === null || q.type === 'flush') break;
          if (q.type === 'delim') break;
          if (q.type !== 'data') continue;
          const l = q.payload.toString('utf8').replace(/\n$/, '');
          const eq = l.indexOf('=');
          if (eq > 0 && l.slice(0, eq) === 'size') size = Number(l.slice(eq + 1));
        }
        // binary payload: collect until flush
        const chunks: Buffer[] = [];
        while (true) {
          const q = await reader.next();
          if (q === null || q.type === 'flush') break;
          if (q.type === 'data') chunks.push(q.payload);
        }
        const content = Buffer.concat(chunks);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        if (hash !== oid || (size > 0 && content.length !== size)) {
          writeStatus(422, [], true);
          io.write(pkt('Content-Length and Oid mismatches\n'));
          writeFlush();
          break;
        }
        const dst = lfsObjectPath(oid);
        fs.mkdirSync(dst.slice(0, dst.lastIndexOf('/')), { recursive: true });
        fs.writeFileSync(dst, content);
        db.db()
          .prepare('INSERT OR REPLACE INTO lfs_object (repo_id, oid, size, storage, created_at) VALUES (?,?,?,?,?)')
          .run(repo.id, oid, content.length, 'local', new Date().toISOString().replace('T', ' ').replace('Z', ''));
        writeStatus(200);
        break;
      }
      case 'verify-object': {
        const oid = rest.trim();
        let size = 0;
        while (true) {
          const q = await reader.next();
          if (q === null || q.type === 'flush') break;
          if (q.type !== 'data') continue;
          const l = q.payload.toString('utf8').replace(/\n$/, '');
          const eq = l.indexOf('=');
          if (eq > 0 && l.slice(0, eq) === 'size') size = Number(l.slice(eq + 1));
        }
        const row = db.db().prepare('SELECT * FROM lfs_object WHERE repo_id = ? AND oid = ?').get(repo.id, oid) as any;
        if (!row) {
          writeStatus(404);
          break;
        }
        writeStatus(row.size === size ? 200 : 422);
        break;
      }
      default: {
        // unknown command → protocol error status
        writeStatus(400, [], true);
        io.write(pkt(`Unknown command: ${cmd}\n`));
        writeFlush();
      }
    }
  }
  io.close(0);
}
