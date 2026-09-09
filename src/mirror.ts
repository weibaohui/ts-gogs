// Mirror synchronization: periodic loop + on-demand sync, mirroring gogs
// internal/database/mirror.go (git remote update + ref-change actions).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { conf } from './conf.js';
import * as db from './db/db.js';
import * as git from './gitx/git.js';
import { userPath } from './gitx/paths.js';

/** Address stored in the bare repo config remote "origin" (credentials stripped for display). */
export function mirrorAddress(repoDir: string): string {
  try {
    const cfg = fs.readFileSync(path.join(repoDir, 'config'), 'utf8');
    const m = /remote "origin"[\s\S]*?url = (.+)/.exec(cfg);
    if (m) {
      // strip credentials for display
      return m[1].replace(/^(https?:\/\/)([^@/]+)@/, '$1');
    }
  } catch {
    // ignore
  }
  return '';
}

function intervalSeconds(repoID: number): number {
  const row = db.db().prepare('SELECT interval FROM mirror WHERE repo_id = ?').get(repoID) as any;
  const hours = row?.interval > 0 ? row.interval : conf.defaultMirrorInterval;
  return hours * 3600;
}

/** Parse `git remote update` stderr into ref changes like gogs parseRemoteUpdateOutput.
 * Real output (space-aligned, no tabs):
 *   ` * [new branch]      master     -> main`          (new)
 *   ` - [deleted]         (none)     -> origin/x`      (delete)
 *   `   cf1685c..4386276  main       -> main`          (update)
 * For --mirror remotes the ref names stay fully qualified. */
export function parseRemoteUpdateOutput(output: string): Array<{ oldSha: string; newSha: string; ref: string }> {
  const refs: Array<{ oldSha: string; newSha: string; ref: string }> = [];
  const EMPTY = '0000000000000000000000000000000000000000';
  for (const line of output.split('\n')) {
    let m = /^ \* \[[^\]]+\]\s+(\S+)\s+->\s+(\S+)$/.exec(line);
    if (m) {
      const ref = m[2].startsWith('refs/') ? m[2] : 'refs/heads/' + m[2];
      refs.push({ oldSha: EMPTY, newSha: '', ref });
      continue;
    }
    m = /^ - \[[^\]]+\]\s+\S+\s+->\s+(\S+)$/.exec(line);
    if (m) {
      const ref = m[1].startsWith('refs/') ? m[1] : 'refs/heads/' + m[1];
      refs.push({ oldSha: '', newSha: EMPTY, ref });
      continue;
    }
    m = /^   ([0-9a-f]+)\.\.([0-9a-f]+)\s+(\S+)\s+->\s+(\S+)\s*$/.exec(line);
    if (m) {
      const ref = m[4].startsWith('refs/') ? m[4] : 'refs/heads/' + m[4];
      refs.push({ oldSha: m[1], newSha: m[2], ref });
      continue;
    }
  }
  return refs;
}

async function fillNewSha(repoDir: string, change: { oldSha: string; newSha: string; ref: string }): Promise<void> {
  if (change.newSha === '') {
    const out = await git.gitOK(repoDir, 'rev-parse', '--verify', '--quiet', '--end-of-options', change.ref);
    change.newSha = out?.toString().trim() ?? '';
  }
  if (change.oldSha === '') {
    change.oldSha = '0000000000000000000000000000000000000000';
  }
}

/** Sync one mirror repo now; fires mirror-sync actions and webhooks. */
export async function syncMirror(repoID: number, doerID: number): Promise<void> {
  const mirror = db.db().prepare('SELECT * FROM mirror WHERE repo_id = ?').get(repoID) as any;
  const repo = db.getRepoByID(repoID);
  if (!mirror || !repo) return;
  const repoDir = repo.RepoPath();

  const remoteArgs = ['remote', 'update'];
  if (mirror.enable_prune) remoteArgs.push('--prune');
  const r = await git.runGit(repoDir, remoteArgs, conf.gitTimeoutMirror * 1000);
  const refs = parseRemoteUpdateOutput(r.stderr);

  const doer = db.getUserByID(doerID) ?? db.getUserByID(repo.owner_id);
  if (!doer) return;
  const { ActionType } = await import('./db/actions.js');

  for (const change of refs) {
    await fillNewSha(repoDir, change);
    const branch = change.ref.replace('refs/heads/', '');
    const isTag = change.ref.startsWith('refs/tags/');
    const newEmpty = change.newSha === '0000000000000000000000000000000000000000' || change.newSha === '';
    const oldEmpty = change.oldSha === '0000000000000000000000000000000000000000' || change.oldSha === '';

    try {
      if (isTag) {
        if (newEmpty) {
          await fire(doer, repo, ActionType.DELETE_TAG, '', JSON.stringify(branch));
        } else if (oldEmpty) {
          await fire(doer, repo, ActionType.PUSH_TAG, branch, '');
        }
        continue;
      }
      if (newEmpty) {
        await fire(doer, repo, ActionType.MIRROR_SYNC_DELETE, branch, '');
      } else {
        let commits: git.Commit[] = [];
        if (oldEmpty) {
          const head = await git.catFileCommit(repoDir, change.newSha);
          const ancestors = await git.gitOK(repoDir, 'log', '--max-count=9', '--pretty=format:%H', '--end-of-options', change.newSha, '--');
          const shas = ancestors?.toString().trim().split('\n').filter(Boolean) ?? [];
          commits = [head, ...await Promise.all(shas.map((s) => git.catFileCommit(repoDir, s).catch(() => null as any)))];
          commits = commits.filter(Boolean);
          await fire(doer, repo, ActionType.MIRROR_SYNC_CREATE, branch, JSON.stringify({ Sha1: head?.id, Name: branch }));
        } else {
          commits = await git.commitsAfter(repoDir, change.oldSha, change.newSha);
        }
        await fire(doer, repo, ActionType.MIRROR_SYNC_PUSH, branch, JSON.stringify({
          TotalCommits: commits.length,
          Len: commits.length,
          Commits: commits.map((c) => ({ Sha1: c.id, Message: c.message, AuthorEmail: c.author.email })),
          Compares: commits.length > 0 ? [{ numCommits: commits.length }] : [],
        }));
      }
    } catch (e) {
      console.error('[mirror] action error:', e);
    }
  }

  await git.updateServerInfo(repoDir);
  const { size } = await git.countObjects(repoDir);
  db.updateRepoColumns(repoID, { size });

  // also sync the wiki mirror when present
  const wikiDir = repo.WikiPath();
  if (fs.existsSync(wikiDir)) {
    const wikiArgs = ['remote', 'update'];
    if (mirror.enable_prune) wikiArgs.push('--prune');
    await git.gitOK(wikiDir, ...wikiArgs);
  }

  const now = Math.floor(Date.now() / 1000);
  db.db()
    .prepare('UPDATE mirror SET updated_unix = ?, next_update_unix = ? WHERE repo_id = ?')
    .run(now, now + intervalSeconds(repoID), repoID);
}

async function fire(doer: db.User, repo: db.Repository, opType: number, refName: string, content: string): Promise<void> {
  db.db()
    .prepare(`INSERT INTO action (user_id, op_type, act_user_id, act_user_name, repo_id, repo_user_name, repo_name, ref_name, is_private, content, created_unix)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(repo.owner_id, opType, doer.id, doer.name, repo.id, repo.OwnerName(), repo.name, refName, repo.is_private ?? 0, content, Math.floor(Date.now() / 1000));
  // mirror push actions carry a webhook payload like commitRepo
  const actionsMod = await import('./db/actions.js');
  if (opType === 20 && content.includes('Commits')) {
    try {
      const parsed = JSON.parse(content);
      await actionsMod.mirrorSyncPushAction(doer, repo, 'refs/heads/' + refName, parsed);
      return;
    } catch {
      // fall through to generic create/delete events below
    }
  }
  if (opType === 9) await actionsMod.pushTagAction(doer, repo, refName);
  else if (opType === 21) await actionsMod.createBranchAction(doer, repo, refName);
  else if (opType === 18 || opType === 22) await actionsMod.deleteBranchAction(doer, repo, refName);
}

let loopStarted = false;

/** Periodic mirror update loop (gogs InitSyncMirrors + cron.UPDATE_MIRRORS). */
export function startMirrorLoop(): void {
  if (loopStarted) return;
  loopStarted = true;
  const tick = async () => {
    try {
      const due = db
        .db()
        .prepare('SELECT repo_id FROM mirror WHERE next_update_unix <= ?')
        .all(Math.floor(Date.now() / 1000)) as any[];
      for (const row of due) {
        const repo = db.getRepoByID(row.repo_id);
        if (!repo) continue;
        console.log('[mirror] syncing', repo.FullName());
        try {
          await syncMirror(row.repo_id, repo.owner_id);
        } catch (e: any) {
          console.error(`[mirror] sync failed for ${repo.FullName()}: ${e?.message ?? e}`);
          // push next attempt back
          const now = Math.floor(Date.now() / 1000);
          db.db().prepare('UPDATE mirror SET updated_unix = ?, next_update_unix = ? WHERE repo_id = ?').run(now, now + intervalSeconds(row.repo_id), row.repo_id);
        }
      }
    } catch (e) {
      console.error('[mirror] loop error:', e);
    }
  };
  setInterval(tick, 60 * 1000);
  setTimeout(tick, 10 * 1000);
}
