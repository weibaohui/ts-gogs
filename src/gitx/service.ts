// Repository lifecycle service: create (bare init), fork, wiki init, and the
// push-update pipeline that gogs runs via delegate hooks + tasks/trigger.
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import * as git from './git.js';
import { userPath } from './paths.js';

const EMPTY_SHA = '0000000000000000000000000000000000000000';

/** ComposeHookEnvs equivalent for local (file-remote) pushes. */
export function composeHookEnv(doer: db.User | undefined, repo: db.Repository, ownerOverride?: string): Record<string, string> {
  const ownerName = ownerOverride ?? repo.OwnerName();
  const salt = repo.owner?.salt ?? '';
  return {
    SSH_ORIGINAL_COMMAND: '1',
    GOGS_AUTH_USER_ID: String(doer?.id ?? 0),
    GOGS_AUTH_USER_NAME: String(doer?.name ?? ''),
    GOGS_AUTH_USER_EMAIL: String(doer?.email ?? ''),
    GOGS_REPO_OWNER_NAME: ownerName,
    GOGS_REPO_OWNER_SALT_MD5: crypto.createHash('md5').update(`${ownerName}${salt}`).digest('hex'),
    GOGS_REPO_ID: String(repo.id),
    GOGS_REPO_NAME: String(repo.name),
    GOGS_REPO_CUSTOM_HOOKS_PATH: path.join(repo.RepoPath(), 'custom_hooks'),
  };
}

/** createDelegateHooks equivalent: since push handling runs in-process after
 * receive-pack, delegate hooks are only written for SSH/custom compat. */
export function createDelegateHooks(repoPath: string): void {
  const hooksDir = path.join(repoPath, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const dist = path.join(conf.workDir, 'dist', 'index.js');
  const srcCli = path.join(conf.workDir, 'node_modules', '.bin', 'tsx');
  const srcEntry = path.join(conf.workDir, 'src', 'index.ts');
  const script = (name: string, args: string) => {
    let runner: string;
    if (fs.existsSync(dist)) {
      runner = `${process.execPath} "${dist}"`;
    } else {
      // NOTE: pass config via env — `tsx` consumes --config as its own flag
      runner = `GOGS_CUSTOM_CONF='${conf.customConf}' "${srcCli}" "${srcEntry}"`;
    }
    return `#!/usr/bin/env bash\n${runner} hook ${name} ${args}\n`;
  };
  fs.writeFileSync(path.join(hooksDir, 'pre-receive'), script('pre-receive', ''), { mode: 0o755 });
  fs.writeFileSync(path.join(hooksDir, 'update'), script('update', '$1 $2 $3'), { mode: 0o755 });
  fs.writeFileSync(path.join(hooksDir, 'post-receive'), script('post-receive', ''), { mode: 0o755 });
}

export async function initRepository(repo: db.Repository, opts: { autoInit?: boolean; doer?: db.User; readme?: string; gitignores?: string; license?: string; description?: string } = {}): Promise<void> {
  const repoDir = repo.RepoPath();
  fs.mkdirSync(userPath(repo.OwnerName()), { recursive: true });
  await git.initBare(repoDir, conf.defaultBranch);
  createDelegateHooks(repoDir);

  if (opts.autoInit) {
    // clone to temp dir, seed files, push
    const tmpDir = path.join(conf.appDataPath, 'tmp', 'init-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await git.git(process.cwd(), 'clone', repoDir, tmpDir);
      let hasContent = false;
      const files: Array<[string, string]> = [];
      if (opts.readme) {
        files.push(['README.md', renderReadmeTemplate(opts.readme, repo)]);
        hasContent = true;
      }
      if (opts.gitignores) {
        const gi = readVendorTemplate('gitignore', opts.gitignores);
        if (gi) {
          files.push(['.gitignore', gi]);
          hasContent = true;
        }
      }
      if (opts.license) {
        const lic = readVendorTemplate('license', opts.license);
        if (lic) {
          files.push(['LICENSE', lic]);
          hasContent = true;
        }
      }
      for (const [name, content] of files) {
        fs.writeFileSync(path.join(tmpDir, name), content);
      }
      if (hasContent) {
        const author = opts.doer ? `${opts.doer.name} <${opts.doer.email}>` : 'Gogs <gogs@fake.local>';
        await git.git(tmpDir, 'add', '--all');
        await git.git(tmpDir, 'commit', `--author=${author}`, '-m', 'Initial commit');
        // local remotes inherit the push process env — hooks receive the context
        const hookEnv = composeHookEnv(opts.doer, repo);
        await git.runGit(tmpDir, ['push', 'origin', `master:${conf.defaultBranch}`], 120000, hookEnv);
        if (conf.defaultBranch !== 'master') {
          await git.git(repoDir, 'symbolic-ref', 'HEAD', `refs/heads/${conf.defaultBranch}`);
        }
        await git.updateServerInfo(repoDir);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  await git.updateServerInfo(repoDir);
}

function renderReadmeTemplate(name: string, repo: db.Repository): string {
  const tpl = readVendorTemplate('readme', name);
  if (!tpl) return `# ${repo.name}\n\n${repo.description ?? ''}\n`;
  return tpl
    .replace(/\{\{Filename\}\}/g, 'README.md')
    .replace(/\{\{Description\}\}/g, repo.description ?? '')
    .replace(/\{\{Name\}\}/g, repo.name);
}

export function readVendorTemplate(kind: 'gitignore' | 'license' | 'readme' | 'label', name: string): string | null {
  const file = path.join(conf.workDir, 'vendored-conf', kind, name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

export function listVendorTemplates(kind: 'gitignore' | 'license' | 'readme' | 'label'): string[] {
  const dir = path.join(conf.workDir, 'vendored-conf', kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
}

/** git clone --bare fork. */
export async function forkRepository(base: db.Repository, fork: db.Repository): Promise<void> {
  fs.mkdirSync(userPath(fork.OwnerName()), { recursive: true });
  await git.git(process.cwd(), 'clone', '--bare', base.RepoPath(), fork.RepoPath());
  await git.updateServerInfo(fork.RepoPath());
  createDelegateHooks(fork.RepoPath());
}

/** gogs PushUpdate equivalent, invoked in-process after receive-pack. */
export async function processPushUpdate(opts: {
  doer: db.User;
  repo: db.Repository;
  refName: string; // full ref e.g. refs/heads/main
  oldSha: string;
  newSha: string;
  pusherID: number;
}): Promise<void> {
  const repoDir = opts.repo.RepoPath();
  const { commitRepoAction, pushTagAction, ActionType } = await import('../db/actions.js');

  await git.updateServerInfo(repoDir);
  const { size } = await git.countObjects(repoDir);
  db.updateRepoColumns(opts.repo.id, { size });

  if (opts.refName.startsWith('refs/tags/')) {
    const tagName = opts.refName.slice('refs/tags/'.length);
    if (opts.newSha === EMPTY_SHA) {
      const { deleteBranchAction } = await import('../db/actions.js');
      // tag deletion action (op 18)
      await deleteBranchAction(opts.doer, opts.repo, tagName);
      return;
    }
    await pushTagAction(opts.doer, opts.repo, tagName);
    return;
  }

  const branch = opts.refName.replace('refs/heads/', '');
  if (opts.newSha === EMPTY_SHA) {
    const { deleteBranchAction } = await import('../db/actions.js');
    deleteBranchAction(opts.doer, opts.repo, branch);
    db.db().prepare('UPDATE repository SET is_bare = CASE WHEN ? = default_branch THEN 1 ELSE is_bare END WHERE id = ?').run(opts.repo.default_branch, opts.repo.id);
    return;
  }

  let commits: any[] = [];
  if (opts.oldSha === EMPTY_SHA) {
    // new branch: take up to 10 commits (new + 9 ancestors)
    const head = await git.catFileCommit(repoDir, opts.newSha);
    const ancestors = await commitsList(repoDir, opts.newSha, 9);
    commits = [head, ...ancestors];
    const { createBranchAction } = await import('../db/actions.js');
    createBranchAction(opts.doer, opts.repo, branch);
  } else {
    commits = await git.commitsAfter(repoDir, opts.oldSha, opts.newSha);
  }

  await commitRepoAction(opts.doer, opts.repo, opts.refName, {
    TotalCommits: commits.length,
    Len: commits.length,
    Commits: commits.map((c) => ({
      Sha1: c.id,
      Message: c.message,
      AuthorEmail: c.author.email,
    })),
    Compares: commits.length > 0 ? [{ numCommits: commits.length }] : [],
  });

  // issue reference from commit messages (#123)
  try {
    await processCommitIssueRefs(opts.repo, commits, opts.doer);
  } catch (e) {
    console.error('[push update] issue refs:', e);
  }
}

async function commitsList(repoDir: string, rev: string, maxCount: number): Promise<git.Commit[]> {
  const out = await git.gitOK(repoDir, 'log', `--max-count=${maxCount}`, '--pretty=format:%H', '--end-of-options', rev, '--');
  if (!out) return [];
  const shas = out.toString().trim().split('\n').filter(Boolean);
  const commits: git.Commit[] = [];
  for (const sha of shas) {
    try {
      commits.push(await git.catFileCommit(repoDir, sha));
    } catch {
      // ignore
    }
  }
  return commits;
}

/** Commit messages referencing #123 close/mention issues like gogs update.go. */
async function processCommitIssueRefs(repo: db.Repository, commits: git.Commit[], doer: db.User): Promise<void> {
  for (const commit of commits) {
    const matches = [...commit.message.matchAll(/#(\d+)/g)];
    for (const m of matches) {
      const index = Number(m[1]);
      const issue = db.getIssueByIndex(repo.id, index);
      if (!issue || issue.is_closed) continue;
      const closes = /(^|\s)(close[sd]?|fix(?:e[sd]?)?|resolve[sd]?)[:\s]+#\d+/i.test(commit.message);
      if (closes) {
        db.updateIssueColumns(issue.id, { is_closed: 1 });
        db.db().prepare('INSERT INTO comment (type, poster_id, issue_id, content, created_unix, updated_unix, commit_sha) VALUES (2,?,?,?,?,?,?)')
          .run(doer.id, issue.id, '', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), commit.id);
        db.refreshIssueCounts(repo.id);
      }
    }
  }
}

/** wiki repository helpers */
export async function initWiki(repoDir: string): Promise<void> {
  if (fs.existsSync(repoDir)) return;
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  await git.initBare(repoDir, 'master');
  createDelegateHooks(repoDir);
}

export function wikiBranch(repoDir: string): string {
  // main if exists, else master
  const main = fs.existsSync(path.join(repoDir, 'refs', 'heads', 'main')) ||
    fs.existsSync(path.join(repoDir, 'packed-refs')) &&
    fs.readFileSync(path.join(repoDir, 'packed-refs'), 'utf8').includes('refs/heads/main');
  return main ? 'main' : 'master';
}

export function toWikiPageName(name: string): string {
  let n = name;
  try {
    n = decodeURIComponent(name);
  } catch {
    // keep raw
  }
  n = n.replace(/\\/g, '/').replace(/\/+/g, ' ').replace(/^\/|\/$/g, '');
  n = n.replaceAll('/', ' ').trim();
  return n || 'Home';
}
