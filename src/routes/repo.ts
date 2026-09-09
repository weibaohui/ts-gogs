// Repository web handlers (the largest surface): create/fork/browse/commits/
// issues/labels/milestones/releases/wiki/branches/settings/webhooks.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Context } from '../context.js';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import * as git from '../gitx/git.js';
import * as svc from '../gitx/service.js';
import { markdown, sanitizeHTML, isMarkdownFile, isReadmeFile, isIPythonNotebook } from '../markup.js';
import { SafeHTML } from '../gotemplate/engine.js';
import { newPaginater } from './home.js';
import { ActionType, createRepoAction, forkRepoAction, issueAction } from '../db/actions.js';
import { nowUnix, newUUID } from '../db/db.js';

export { RepoAssignment, RequireRepoAdmin, RequireRepoWriter, RepoRef } from '../context.js';

function repoLink(c: Context): string {
  return conf.subpath + '/' + c.Repo.Repository!.FullName();
}

const ALPHADASHDOT = /^[a-zA-Z0-9_.-]+$/;

// ---------------------------------------------------------------- create / migrate / fork

export async function Create(c: Context): Promise<void> {
  c.Title('repo.create');
  c.Data['PageIsCreate'] = true;
  c.Data['Gitignores'] = svc.listVendorTemplates('gitignore');
  c.Data['Licenses'] = svc.listVendorTemplates('license');
  c.Data['Readmes'] = svc.listVendorTemplates('readme');
  c.Data['ContextUser'] = c.User;
  c.Data['user_id'] = c.UserID();
  c.Data['repo_name'] = '';
  c.Data['description'] = '';
  c.Data['gitignores'] = '';
  c.Data['license'] = '';
  c.Data['readme'] = 'Default';
  c.Data['auto_init'] = '';
  c.Data['private'] = '';
  c.Success('repo/create');
}

async function checkCreateLimit(c: Context, owner: db.User): Promise<boolean> {
  if (owner.id !== c.UserID() && owner.type !== 1) {
    c.flash.Error(c.Tr('repo.form.not_owned'));
    return false;
  }
  const limit = owner.max_repo_creation;
  if (limit !== -1 && db.countUserRepos(owner.id) >= limit) {
    c.flash.Error(c.Tr('repo.form.max_limit', String(limit)));
    return false;
  }
  const globalLimit = conf.maxCreationLimit;
  if (globalLimit !== -1 && db.countUserRepos(owner.id) >= globalLimit) {
    c.flash.Error(c.Tr('repo.form.max_limit', String(globalLimit)));
    return false;
  }
  return true;
}

export async function CreatePost(c: Context): Promise<void> {
  const form = await c.form();
  const uid = Number(form.uid ?? c.UserID());
  const owner = db.getUserByID(uid) ?? c.User!;
  if (!(await checkCreateLimit(c, owner))) {
    c.Redirect(conf.subpath + '/repo/create');
    return;
  }
  const name = String(form.name ?? '').trim();
  if (!ALPHADASHDOT.test(name) || name.length > 100) {
    c.RenderWithErr(c.Tr('repo.form.name_not_allowed'), 'repo/create');
    return;
  }
  if (db.getRepoByName(owner.name, name)) {
    c.RenderWithErr(c.Tr('repo.form.name_been_taken'), 'repo/create');
    return;
  }
  const isPrivate = conf.forcePrivate || String(form.private ?? '') === 'on';
  const repo = await createRepositoryRecord(c.User!, owner, {
    name,
    description: String(form.description ?? ''),
    website: String(form.website ?? ''),
    private: isPrivate,
    autoInit: String(form.auto_init ?? '') === 'on',
    gitignores: String(form.gitignores ?? ''),
    license: String(form.license ?? ''),
    readme: String(form.readme ?? ''),
  });
  c.flash.Success(c.Tr('repo.form.create_success', repo.FullName()));
  c.Redirect(conf.subpath + '/' + repo.FullName());
}

export async function createRepositoryRecord(doer: db.User, owner: db.User, opts: any): Promise<db.Repository> {
  const now = nowUnix();
  const info = db
    .db()
    .prepare(
      `INSERT INTO repository (owner_id, lower_name, name, description, website, default_branch,
        is_private, is_bare, is_mirror, enable_wiki, enable_issues, enable_pulls,
        num_watches, num_stars, num_forks, num_issues, num_closed_issues, num_pulls, num_closed_pulls,
        num_milestones, num_closed_milestones, created_unix, updated_unix, size)
       VALUES (?,?,?,?,?,?,?,?,?,1,1,1,0,0,0,0,0,0,0,0,0,?,?,0)`
    )
    .run(
      owner.id,
      opts.name.toLowerCase(),
      opts.name,
      opts.description ?? '',
      opts.website ?? '',
      conf.defaultBranch,
      opts.private ? 1 : 0,
      opts.autoInit ? 0 : 1,
      opts.mirror ? 1 : 0,
      now,
      now
    );
  const repo = db.getRepoByID(Number(info.lastInsertRowid))!;
  db.db().prepare('UPDATE user SET num_repos = num_repos + 1 WHERE id = ?').run(owner.id);
  // owner watches own repo
  db.watchRepo(doer.id, repo.id, true);
  await svc.initRepository(repo, { autoInit: opts.autoInit, doer, readme: opts.readme, gitignores: opts.gitignores, license: opts.license });
  createRepoAction(doer, repo);
  return repo;
}

export async function Migrate(c: Context): Promise<void> {
  c.Title('repo.migrate');
  c.Data['PageIsMigrate'] = true;
  c.Data['ContextUser'] = c.User;
  c.Data['user_id'] = c.UserID();
  c.Data['repo_name'] = '';
  c.Data['clone_addr'] = '';
  c.Data['description'] = '';
  c.Data['mirror'] = '';
  c.Data['private'] = '';
  c.Success('repo/migrate');
}

export async function MigratePost(c: Context): Promise<void> {
  // mirror-only local implementation: regular git clone --mirror
  const form = await c.form();
  const cloneAddr = String(form.clone_addr ?? '').trim();
  const uid = Number(form.uid ?? c.UserID());
  const owner = db.getUserByID(uid) ?? c.User!;
  if (!cloneAddr) {
    c.RenderWithErr(c.Tr('form.url_error'), 'repo/migrate');
    return;
  }
  const name = String(form.repo_name ?? '').trim();
  if (!ALPHADASHDOT.test(name)) {
    c.RenderWithErr(c.Tr('repo.form.name_not_allowed'), 'repo/migrate');
    return;
  }
  if (db.getRepoByName(owner.name, name)) {
    c.RenderWithErr(c.Tr('repo.form.name_been_taken'), 'repo/migrate');
    return;
  }
  const repo = await createRepositoryRecord(c.User!, owner, {
    name,
    description: String(form.description ?? ''),
    private: conf.forcePrivate || String(form.private ?? '') === 'on',
    autoInit: false,
    mirror: String(form.mirror ?? '') === 'on',
  });
  const repoDir = repo.RepoPath();
  fs.rmSync(repoDir, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    await git.git(process.cwd(), 'clone', '--mirror', '--quiet', '--end-of-options', cloneAddr, repoDir);
    svc.createDelegateHooks(repoDir);
    await git.updateServerInfo(repoDir);
    db.db().prepare('INSERT INTO mirror (repo_id, interval, enable_prune, updated_unix, next_update_unix) VALUES (?,?,?,?,?)')
      .run(repo.id, conf.defaultMirrorInterval * 60, 1, nowUnix(), nowUnix());
  } catch (e: any) {
    fs.rmSync(repoDir, { recursive: true, force: true });
    db.db().prepare('DELETE FROM repository WHERE id = ?').run(repo.id);
    db.db().prepare('UPDATE user SET num_repos = num_repos - 1 WHERE id = ?').run(owner.id);
    c.RenderWithErr(c.Tr('repo.migrate.failed') + ': ' + e.message, 'repo/migrate');
    return;
  }
  c.Redirect(conf.subpath + '/' + repo.FullName());
}

export async function Fork(c: Context): Promise<void> {
  const baseID = c.ParamsInt64(':repoid');
  const base = db.getRepoByID(baseID);
  if (!base) {
    c.NotFound();
    return;
  }
  c.Data['Title'] = c.Tr('repo.fork');
  c.Data['repo_name'] = base.name;
  c.Data['ForkFrom'] = base.FullName();
  c.Data['BaseRepo'] = base;
  c.Success('repo/fork');
}

export async function ForkPost(c: Context): Promise<void> {
  const baseID = c.ParamsInt64(':repoid');
  const base = db.getRepoByID(baseID);
  if (!base) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const uid = Number(form.uid ?? c.UserID());
  const owner = db.getUserByID(uid) ?? c.User!;
  if (!(await checkCreateLimit(c, owner))) {
    c.Redirect(conf.subpath + `/repo/fork/${baseID}`);
    return;
  }
  const name = String(form.name ?? base.name).trim();
  if (!ALPHADASHDOT.test(name)) {
    c.RenderWithErr(c.Tr('repo.form.name_not_allowed'), 'repo/fork');
    return;
  }
  if (db.getRepoByName(owner.name, name)) {
    c.RenderWithErr(c.Tr('repo.form.name_been_taken'), 'repo/fork');
    return;
  }
  const now = nowUnix();
  const info = db
    .db()
    .prepare(
      `INSERT INTO repository (owner_id, lower_name, name, description, default_branch, is_private, is_bare,
        is_fork, fork_id, created_unix, updated_unix, num_watches, num_stars, num_forks, num_issues, num_closed_issues, num_pulls, num_closed_pulls, num_milestones, num_closed_milestones, size)
       VALUES (?,?,?,?,?,?,0,1,?,?,?,?,0,0,0,0,0,0,0,0,0)`
    )
    .run(owner.id, name.toLowerCase(), name, base.description, base.default_branch || conf.defaultBranch, base.is_private, 0, base.id, now, now);
  const fork = db.getRepoByID(Number(info.lastInsertRowid))!;
  db.db().prepare('UPDATE user SET num_repos = num_repos + 1 WHERE id = ?').run(owner.id);
  db.db().prepare('UPDATE repository SET num_forks = num_forks + 1 WHERE id = ?').run(base.id);
  try {
    await svc.forkRepository(base, fork);
  } catch (e: any) {
    console.error('[fork]', e);
  }
  forkRepoAction(c.User!, fork);
  c.flash.Success(c.Tr('repo.form.fork_success', fork.FullName()));
  c.Redirect(conf.subpath + '/' + fork.FullName());
}

// ---------------------------------------------------------------- browse

export function MustEnableIssues(c: Context): void {
  if (!c.Repo.Repository!.enable_issues || c.Repo.Repository!.enable_external_tracker) {
    c.NotFound();
  }
}

export function MustEnableWiki(c: Context): void {
  if (!c.Repo.Repository!.enable_wiki) {
    c.NotFound();
  }
}

export async function TriggerTask(c: Context): Promise<void> {
  const branch = c.Query('branch');
  const pusher = Number(c.Query('pusher'));
  const secret = c.Query('secret');
  const repo = c.Repo.Repository;
  if (!repo || !repo.owner) {
    c.NotFound();
    return;
  }
  const expect = crypto.createHash('md5').update(repo.owner.name + (repo.owner.salt ?? '')).digest('hex');
  if (secret !== expect) {
    c.NotFound();
    return;
  }
  c.Status(202);
  c.res.end();
  c.rendered = true;
  void branch;
  void pusher;
}

export async function Home(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['PageIsRepoHome'] = true;
  c.Require('HighlightJS');
  const repoDir = repo.RepoPath();

  if (repo.is_bare) {
    c.Success('repo/bare');
    return;
  }

  const refName = c.Repo.BranchName || repo.default_branch || conf.defaultBranch;
  const treePath = c.Repo.TreePath ?? '';

  // count commits (root only)
  if (!treePath) {
    const cnt = await git.commitsCount(repoDir, refName);
    c.Data['CommitCount'] = cnt;
    c.Data['CommitsCount'] = cnt;
  } else {
    c.Data['CommitsCount'] = await git.commitsCount(repoDir, refName);
  }

  const commit = c.Repo.Commit ?? (await git.getCommit(repoDir, refName));
  if (!commit) {
    c.NotFound();
    return;
  }

  const tree = await git.lsTree(repoDir, commit.id, treePath);
  if (!tree) {
    // not a directory: render file view
    await renderFileView(c, commit, refName, treePath);
    return;
  }

  // sizes + latest commits; wrap like git-module CommitsInfo ({Entry, Commit, Submodule})
  const files: any[] = [];
  for (const entry of tree.entries) {
    if (entry.type === 'blob') {
      entry.size = await git.entrySize(repoDir, entry.sha);
    }
    const entryView = entryViewOf(entry);
    const latestCommit = await git.commitByPath(repoDir, commit.id, treePath ? `${treePath}/${entry.name}` : entry.name);
    files.push(db.goAlias({ Entry: entryView, Commit: latestCommit, Submodule: null }));
  }
  // sort: trees first, then by name
  files.sort((a, b) => {
    const at = a.Entry.IsTree();
    const bt = b.Entry.IsTree();
    if (at !== bt) return at ? -1 : 1;
    return String(a.Entry.name).localeCompare(String(b.Entry.name));
  });

  c.Data['Files'] = files;
  c.Data['TreeLink'] = `${repoLink(c)}/src/${encodeURIComponent(refName)}` + (treePath ? '/' + treePath : '');
  c.Data['BranchLink'] = `${repoLink(c)}/src/${encodeURIComponent(refName)}`;
  if (treePath) {
    c.Data['HasParentPath'] = true;
    const parts = treePath.split('/').filter(Boolean);
    parts.pop();
    c.Data['ParentPath'] = parts.join('/');
  }

  // latest commit for the directory
  const latest = (await git.commitsByPage(repoDir, refName, 1, 1, treePath || undefined))[0] ?? commit;
  c.Data['LatestCommit'] = latest;
  const authorUser = db.getUserByEmail(latest.author.email);
  c.Data['LatestCommitUser'] = authorUser ?? {
    id: 0,
    name: latest.author.name,
    DisplayName: () => latest.author.name,
    AvatarURLPath: () => avatarLinkForEmail(latest.author.email),
    HomeURLPath: () => '',
  };

  // README
  const readmeEntry = tree.entries.find((e) => e.type === 'blob' && isReadmeFile(e.name));
  if (readmeEntry) {
    try {
      const content = await git.blobBytes(repoDir, readmeEntry.sha);
      const text = content.toString('utf8');
      if (isMarkdownFile(readmeEntry.name)) {
        c.Data['IsMarkdown'] = true;
        c.Data['ReadmeContent'] = new SafeHTML(markdown(text, c.Data['TreeLink'] ?? repoLink(c), repo.ComposeMetas()));
      } else {
        c.Data['ReadmeContent'] = new SafeHTML(`<pre class="raw">${escapeHTML(text)}</pre>`);
      }
      c.Data['ReadmeInList'] = readmeEntry;
    } catch {
      // too large etc.
    }
  }

  const branches = await git.getBranches(repoDir);
  const tags = await git.getTags(repoDir);
  c.Data['Branches'] = branches.map((b) => b.name);
  c.Data['Tags'] = tags.map((t) => t.name);
  (repo as any).NumTags = tags.length;
  c.Data['BranchCount'] = branches.length;
  c.Success('repo/home');
}

/** git.TreeEntry view with Go-style methods (Name/IsTree/IsSymlink/Size). */
function entryViewOf(entry: git.TreeEntry): any {
  const v: any = { ...entry };
  v.Name = () => entry.name;
  v.IsTree = () => entry.type === 'tree';
  v.IsSymlink = () => entry.mode === '120000';
  v.IsSubModule = () => entry.type === 'commit';
  db.goAlias(v);
  return v;
}

function avatarLinkForEmail(email: string): string {
  return conf.gravatarSource + md5hex(String(email ?? '').trim().toLowerCase()) + '?d=identicon';
}

function md5hex(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function escapeHTML(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&#34;');
}

async function renderFileView(c: Context, commit: git.Commit, refName: string, treePath: string): Promise<void> {
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  let blobSha: string | null = null;
  const tree = await git.lsTree(repoDir, commit.id, '');
  const parts = treePath.split('/').filter(Boolean);
  let cur = tree;
  for (let i = 0; i < parts.length; i++) {
    const found = cur?.entries.find((e) => e.name === parts[i]);
    if (!found) {
      c.NotFound();
      return;
    }
    if (i === parts.length - 1 && found.type === 'blob') blobSha = found.sha;
    else if (found.type === 'tree') {
      const sub = await git.lsTree(repoDir, found.sha, '');
      cur = sub;
    } else {
      c.NotFound();
      return;
    }
  }
  if (!blobSha) {
    c.NotFound();
    return;
  }
  const size = await git.entrySize(repoDir, blobSha);
  if (size > conf.maxDisplayFileSize) {
    c.Data['FileIsLarge'] = true;
  } else {
    const content = (await git.blobBytes(repoDir, blobSha)).toString('utf8');
    const fileName = parts[parts.length - 1];
    c.Data['FileName'] = fileName;
    if (isMarkdownFile(fileName)) {
      c.Data['IsMarkdown'] = true;
      c.Data['FileContent'] = new SafeHTML(markdown(content, `${repoLink(c)}/src/${encodeURIComponent(refName)}/${treePath}`, repo.ComposeMetas()));
    } else if (isIPythonNotebook(fileName)) {
      c.Data['IsIPythonNotebook'] = true;
      c.Data['FileContent'] = content;
    } else {
      const lines = content.split('\n');
      // strip trailing empty line like gogs
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      c.Data['FileContent'] = lines
        .map((l, i) => `<li class="L${i + 1}" rel="L${i + 1}">${escapeHTML(l) || ' '}</li>`)
        .join('\n');
      c.Data['IsTextFile'] = true;
      c.Data['NumLines'] = lines.length;
    }
  }
  c.Data['FileSize'] = size;
  c.Data['TreeLink'] = `${repoLink(c)}/src/${encodeURIComponent(refName)}/${treePath}`;
  c.Data['BranchLink'] = `${repoLink(c)}/src/${encodeURIComponent(refName)}`;
  c.Data['RawFileLink'] = `${repoLink(c)}/raw/${encodeURIComponent(refName)}/${treePath}`;
  c.Require('HighlightJS');
  c.Success('repo/view_home');
}

export async function RefCommits(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const parts = wildcard.split('/');
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  const ref = c.Repo.BranchName || repo.default_branch;
  const filePath = parts.slice(1).join('/');
  await CommitsPage(c, ref, filePath, `${repoLink(c)}/commits/${wildcard}`);
}

export async function Commits(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const ref = c.Repo.BranchName || repo.default_branch || conf.defaultBranch;
  await CommitsPage(c, ref, '', `${repoLink(c)}/commits`);
}

async function CommitsPage(c: Context, ref: string, filePath: string, link: string): Promise<void> {
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  c.Data['PageIsCommits'] = true;
  c.Require('HighlightJS');
  const page = Math.max(1, c.QueryInt('page'));
  const size = 30;
  const count = await git.commitsCount(repoDir, ref);
  const commits = await git.commitsByPage(repoDir, ref, page, size, filePath || undefined);
  const withUsers = commits.map((cm) => {
    const author = db.getUserByEmail(cm.author.email);
    const committer = db.getUserByEmail(cm.committer.email);
    return { ...cm, User: author, CommitterUser: committer };
  });
  c.Data['Commits'] = withUsers;
  c.Data['Keyword'] = c.Query('q');
  c.Data['CommitCount'] = count;
  c.Data['Page'] = newPaginater(count, size, page, 5);
  c.Data['Username'] = c.Params(':username');
  c.Data['Reponame'] = c.Params(':reponame');
  c.Data['BranchLink'] = link;
  c.Success('repo/commits');
}

export async function Diff(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  const sha = c.Params(':sha');
  c.Data['PageIsDiff'] = true;
  c.Require('HighlightJS');
  const commit = await git.getCommit(repoDir, sha);
  if (!commit) {
    c.NotFound();
    return;
  }
  const diff = await git.repoDiff(repoDir, sha, undefined, conf.maxDiffFiles, conf.maxDiffLines);
  c.Data['Commit'] = commit;
  c.Data['Diff'] = diff;
  c.Data['Username'] = c.Params(':username');
  c.Data['Reponame'] = c.Params(':reponame');
  const author = db.getUserByEmail(commit.author.email);
  c.Data['Author'] = author;
  c.Success('repo/diff/box');
}

export async function CommitRaw(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  const sha = c.Params(':sha');
  const ext = c.Params(':ext');
  const commit = await git.getCommit(repoDir, sha);
  if (!commit) {
    c.NotFound();
    return;
  }
  const diff = await git.repoDiff(repoDir, sha, undefined, 100000, 100000000);
  c.SetHeader('Content-Type', ext === 'patch' ? 'text/plain; charset=utf-8' : 'application/text; charset=utf-8');
  let out = '';
  if (ext === 'patch') {
    out = `From ${commit.id} Mon Sep 17 00:00:00 2001\nFrom: ${commit.author.name} <${commit.author.email}>\nDate: ${commit.author.when.toUTCString()}\nSubject: [PATCH] ${commit.Summary()}\n\n${commit.message}\n---\n`;
  }
  for (const f of diff.files) {
    out += `\ndiff --git a/${f.oldName} b/${f.name}\n`;
    for (const section of f.sections) {
      out += `@@ -${section.leftHunk},${section.leftRange} +${section.rightHunk},${section.rightRange} @@\n`;
      for (const line of section.lines) {
        out += (line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ') + line.content + '\n';
      }
    }
  }
  c.PlainText(200, out);
}

export async function Raw(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const slash = wildcard.indexOf('/');
  if (slash < 0) {
    c.NotFound();
    return;
  }
  const ref = wildcard.slice(0, slash);
  const filePath = wildcard.slice(slash + 1);
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  const resolved = await git.resolveRef(repoDir, ref);
  if (!resolved) {
    c.NotFound();
    return;
  }
  const commit = await git.getCommit(repoDir, resolved);
  if (!commit) {
    c.NotFound();
    return;
  }
  const tree = await git.lsTree(repoDir, commit.id, filePath);
  const entry = tree?.entries[0];
  if (!entry || entry.type !== 'blob') {
    c.NotFound();
    return;
  }
  const content = await git.blobBytes(repoDir, entry.sha);
  const fileName = filePath.split('/').pop() ?? 'file';
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(path.extname(fileName).toLowerCase());
  const isText = isTextContent(content);
  if (!isImage && !isText) {
    c.SetHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    c.SetHeader('Content-Transfer-Encoding', 'binary');
  } else {
    c.SetHeader('Content-Type', isImage ? guessImageMIME(fileName) : 'text/plain; charset=utf-8');
  }
  c.res.end(content);
}

function isTextContent(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  for (const b of sample) {
    if (b === 0) return false;
  }
  return true;
}

function guessImageMIME(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  return map[ext] ?? 'application/octet-stream';
}

export async function Download(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const isZip = wildcard.endsWith('.zip');
  const isTarGz = wildcard.endsWith('.tar.gz');
  if (!isZip && !isTarGz) {
    c.NotFound();
    return;
  }
  const ref = isZip ? wildcard.slice(0, -4) : wildcard.slice(0, -7);
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  const resolved = await git.resolveRef(repoDir, ref);
  if (!resolved) {
    c.NotFound();
    return;
  }
  const shaFull = (await git.gitOK(repoDir, 'rev-parse', '--verify', '--end-of-options', resolved))!.toString().trim();
  const ext = isZip ? '.zip' : '.tar.gz';
  const kind = isZip ? 'zip' : 'targz';
  const cacheDir = path.join(repoDir, 'archives', kind);
  const dst = path.join(cacheDir, shaFull.slice(0, 10) + ext);
  if (!fs.existsSync(dst)) {
    await git.archive(repoDir, shaFull, isZip ? 'zip' : 'tar.gz', dst, `${repo.name}-${shaFull.slice(0, 10)}/`);
  }
  c.SetHeader('Content-Disposition', `attachment; filename=${repo.name}-${shaFull.slice(0, 10)}${ext}`);
  c.SetHeader('Content-Type', isZip ? 'application/zip' : 'application/x-gzip');
  c.res.end(fs.readFileSync(dst));
}

export async function Branches(c: Context): Promise<void> {
  c.Data['PageIsBranchesOverview'] = true;
  await branchesPage(c, 'overview');
}
export async function AllBranches(c: Context): Promise<void> {
  c.Data['PageIsBranchesAll'] = true;
  await branchesPage(c, 'all');
}

async function branchesPage(c: Context, mode: string): Promise<void> {
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  const branches = await git.getBranches(repoDir);
  const now = Date.now();
  const items = branches.map((b: any) => db.goAlias({
    ...b,
    User: db.getUserByEmail(b.commit.committer.email),
    IsProtected: false,
    IsActive: now - b.commit.committer.when.getTime() < 30 * 86400000,
    IsStale: now - b.commit.committer.when.getTime() > 90 * 86400000,
  }));
  c.Data['Branches'] = items;
  c.Data['ActiveBranches'] = mode === 'overview' ? items.filter((b) => b.IsActive) : [];
  c.Data['StaleBranches'] = mode === 'overview' ? items.filter((b) => !b.IsActive && b.IsStale) : [];
  const defName = repo.default_branch || conf.defaultBranch;
  const defBranch = branches.find((b) => b.name === defName) ?? branches[0];
  c.Data['DefaultBranch'] = defBranch
    ? db.goAlias({ Name: defBranch.name, Commit: defBranch.commit })
    : null;
  console.log('[branches:dbg] branches=%d defName=%s defBranch=%s commit=%s data.DefaultBranch=%j', branches.length, defName, !!defBranch, !!defBranch?.commit, c.Data['DefaultBranch']);
  c.Data['PageIsViewFiles'] = true;
  c.Success('repo/branches/' + mode);
}

export async function DeleteBranchPost(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const repo = c.Repo.Repository!;
  const repoDir = repo.RepoPath();
  try {
    await git.git(repoDir, 'push', 'origin', `:${wildcard}`);
  } catch {
    await git.gitOK(repoDir, 'branch', '-D', wildcard);
  }
  const { deleteBranchAction } = await import('../db/actions.js');
  deleteBranchAction(c.User!, repo, wildcard);
  c.flash.Success(c.Tr('repo.branches.deletion_success', wildcard));
  c.Redirect(repoLink(c) + '/branches');
}

export async function Forks(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const rows = db.db().prepare('SELECT * FROM repository WHERE fork_id = ?').all(repo.id) as any[];
  c.Data['Forks'] = rows.map((r) => {
    const fork = new db.Repository(r);
    fork.owner = db.getUserByID(fork.owner_id) ?? undefined;
    return fork;
  });
  c.Success('repo/forks');
}

export async function Stars(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['Title'] = c.Tr('repo.stargazers');
  c.Data['CardsTitle'] = c.Tr('repo.stargazers');
  c.Data['PageIsStargazers'] = true;
  const rows = db.db().prepare('SELECT u.* FROM user u JOIN star s ON s.uid = u.id WHERE s.repo_id = ?').all(repo.id) as any[];
  c.Data['Cards'] = rows.map((r) => new db.User(r));
  c.Success('repo/user_cards');
}

export async function Watchers(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['Title'] = c.Tr('repo.watchers');
  c.Data['CardsTitle'] = c.Tr('repo.watchers');
  c.Data['PageIsWatchers'] = true;
  const rows = db.db().prepare('SELECT u.* FROM user u JOIN watch w ON w.user_id = u.id WHERE w.repo_id = ?').all(repo.id) as any[];
  c.Data['Cards'] = rows.map((r) => new db.User(r));
  c.Success('repo/user_cards');
}

/** watch/star actions via /:username/:reponame/action/:action */
export function repoUserAction(c: Context, repo: db.Repository, action: string): void {
  switch (action) {
    case 'watch':
      db.watchRepo(c.UserID(), repo.id, true);
      break;
    case 'unwatch':
      db.watchRepo(c.UserID(), repo.id, false);
      break;
    case 'star':
      db.starRepo(c.UserID(), repo.id, true);
      break;
    case 'unstar':
      db.starRepo(c.UserID(), repo.id, false);
      break;
    default:
      c.NotFound();
      return;
  }
  const redirectTo = c.Query('redirect_to') || repoLink(c);
  c.Redirect(decodeURIComponent(redirectTo));
}

export async function Action(c: Context): Promise<void> {
  repoUserAction(c, c.Repo.Repository!, c.Params(':action'));
}

export function RetrieveLabels(c: Context): void {
  const repo = c.Repo.Repository!;
  c.Data['Labels'] = db.listLabels(repo.id);
}

// ---------------------------------------------------------------- issues

export async function Issues(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['PageIsIssueList'] = true;
  c.Require('HighlightJS');
  const page = Math.max(1, c.QueryInt('page'));
  const isClosed = c.Query('state') === 'closed' ? 1 : 0;
  c.Data['ViewType'] = 'issues';
  c.Data['SortType'] = c.Query('sort');
  c.Data['IsShowClosed'] = isClosed === 1;
  c.Data['SelectLabels'] = '';
  c.Data['SelectMilestone'] = '';
  c.Data['SelectAssignee'] = '';
  c.Data['Keyword'] = c.Query('q');
  c.Data['MilestoneID'] = 0;
  c.Data['AssigneeID'] = 0;
  c.Data['State'] = isClosed === 1 ? 'closed' : 'open';
  const { total, issues } = db.listIssues(repo.id, isClosed, page, conf.issuePagingNum);
  const items = issues.map((i: any) => {
    const poster = db.getUserByID(i.poster_id);
    return db.goAlias({ ...i, Poster: poster });
  });
  c.Data['Issues'] = items;
  c.Data['IssueStats'] = {
    OpenCount: (db.db().prepare('SELECT COUNT(*) AS c FROM issue WHERE repo_id = ? AND is_closed = 0 AND is_pull = 0').get(repo.id) as any).c,
    ClosedCount: (db.db().prepare('SELECT COUNT(*) AS c FROM issue WHERE repo_id = ? AND is_closed = 1 AND is_pull = 0').get(repo.id) as any).c,
  };
  c.Data['Page'] = newPaginater(total, conf.issuePagingNum, page, 5);
  c.Success('repo/issue/list');
}

export async function Pulls(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['PageIsPullList'] = true;
  const page = Math.max(1, c.QueryInt('page'));
  const isClosed = c.Query('state') === 'closed' ? 1 : 0;
  c.Data['ViewType'] = 'pulls';
  c.Data['IsShowClosed'] = isClosed === 1;
  const { total, issues } = db.listIssues(repo.id, isClosed, page, conf.issuePagingNum);
  c.Data['Issues'] = issues.filter((i: any) => i.is_pull).map((i: any) => ({ ...i, Poster: db.getUserByID(i.poster_id) }));
  c.Data['IssueStats'] = {
    OpenCount: (db.db().prepare('SELECT COUNT(*) AS c FROM issue WHERE repo_id = ? AND is_closed = 0 AND is_pull = 1').get(repo.id) as any).c,
    ClosedCount: (db.db().prepare('SELECT COUNT(*) AS c FROM issue WHERE repo_id = ? AND is_closed = 1 AND is_pull = 1').get(repo.id) as any).c,
  };
  c.Data['Page'] = newPaginater(total, conf.issuePagingNum, page, 5);
  c.Success('repo/pulls');
}

export async function NewIssue(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['Title'] = c.Tr('repo.issues.new');
  c.Data['PageIsIssues'] = true;
  c.Data['RequireSimpleMDE'] = true;
  c.Data['RequireDropzone'] = true;
  c.Data['Labels'] = db.listLabels(repo.id);
  c.Data['Milestones'] = db.listMilestones(repo.id, 0);
  c.Data['Collaborators'] = db.listCollaborations(repo.id);
  c.Success('repo/issue/new');
}

export async function NewIssuePost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const title = String(form.title ?? '').trim();
  if (!title) {
    c.flash.Error(c.Tr('form.title_required'));
    c.Redirect(repoLink(c) + '/issues/new');
    return;
  }
  const isWriter = c.Repo.IsWriter();
  const index = db.maxIssueIndex(repo.id) + 1;
  const now = nowUnix();
  const info = db
    .db()
    .prepare(
      `INSERT INTO issue (repo_id, "index", poster_id, name, content, milestone_id, assignee_id, is_closed, is_pull, num_comments, created_unix, updated_unix)
       VALUES (?,?,?,?,?,?,?,0,0,0,?,?)`
    )
    .run(
      repo.id,
      index,
      c.UserID(),
      title,
      String(form.content ?? ''),
      isWriter ? Number(form.milestone_id ?? 0) || null : null,
      isWriter ? db.getUserByUsername(String(form.assignee_id ?? ''))?.id ?? null : null,
      now,
      now
    );
  const issueID = Number(info.lastInsertRowid);
  db.db().prepare('INSERT INTO issue_user (uid, issue_id, repo_id, is_poster, is_read) VALUES (?,?,?,1,1)').run(c.UserID(), issueID, repo.id);
  // labels
  if (isWriter && form.label_ids) {
    for (const lid of String(form.label_ids).split(',')) {
      if (Number(lid) > 0) {
        db.db().prepare('INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?,?)').run(issueID, Number(lid));
      }
    }
  }
  db.refreshIssueCounts(repo.id);
  const issue = db.getIssueByID(issueID)!;
  await issueAction(ActionType.CREATE_ISSUE, c.User!, repo, issue);
  c.Redirect(repoLink(c) + '/issues/' + index);
}

export async function ViewIssue(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const index = c.ParamsInt64(':index');
  const issue = db.getIssueByIndex(repo.id, index);
  if (!issue) {
    c.NotFound();
    return;
  }
  c.Data['PageIsIssueList'] = issue.is_pull ? false : true;
  c.Data['PageIsPullList'] = !!issue.is_pull;
  c.Data['PageIsPullConversation'] = !!issue.is_pull;
  c.Require('HighlightJS');
  c.Require('SimpleMDE');
  c.Require('Dropzone');

  const poster = db.getUserByID(issue.poster_id);
  const comments = db.listComments(issue.id).map((cm: any) => {
    const user = db.getUserByID(cm.poster_id);
    const rendered = sanitizeHTML(String(cm.content ?? ''));
    return db.goAlias({ ...cm, Poster: user, ShowTag: 0, RenderedContent: new SafeHTML(rendered) });
  });
  c.Data['Issue'] = db.goAlias({
    ...issue,
    Poster: poster,
    Repo: repo,
    RenderedContent: new SafeHTML(markdown(String(issue.content ?? ''), repoLink(c), repo.ComposeMetas())),
    HashTag: 'issue-' + issue.id,
  });
  c.Data['Comments'] = comments;
  c.Data['Labels'] = db.listIssueLabels(issue.id).map((l: any) => db.goAlias({ ...l, IsChecked: true }));
  c.Data['AllLabels'] = db.listLabels(repo.id).map((l: any) => db.goAlias({ ...l, IsChecked: false }));
  if (issue.milestone_id) {
    c.Data['Milestone'] = db.getMilestoneByID(repo.id, issue.milestone_id);
  }
  if (issue.assignee_id) {
    c.Data['Assignee'] = db.getUserByID(issue.assignee_id);
  }
  if (issue.is_pull) {
    const pr = db.db().prepare('SELECT * FROM pull_request WHERE issue_id = ?').get(issue.id) as any;
    if (pr) c.Data['PullRequest'] = pr;
  }
  c.Data['IsIssuePoster'] = issue.poster_id === c.UserID();
  c.Data['IsIssueWriter'] = c.Repo.IsWriter();
  c.Success('repo/issue/view_content');
}

export async function UpdateIssueTitle(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const issue = db.getIssueByIndex(repo.id, c.ParamsInt64(':index'));
  if (!issue) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const title = String(form.title ?? '').trim();
  if (title && (c.UserID() === issue.poster_id || c.Repo.IsWriter())) {
    db.updateIssueColumns(issue.id, { name: title });
  }
  c.Redirect(repoLink(c) + `/issues/${issue.index}`);
}

export async function UpdateIssueContent(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const issue = db.getIssueByIndex(repo.id, c.ParamsInt64(':index'));
  if (!issue) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const content = String(form.content ?? '');
  if (c.UserID() === issue.poster_id || c.Repo.IsWriter()) {
    db.updateIssueColumns(issue.id, { content });
  }
  c.PlainText(200, sanitizeHTML(content));
}

export async function NewComment(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const issue = db.getIssueByIndex(repo.id, c.ParamsInt64(':index'));
  if (!issue) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const content = String(form.content ?? '').trim();
  if (content) {
    const now = nowUnix();
    db.db()
      .prepare('INSERT INTO comment (type, poster_id, issue_id, content, created_unix, updated_unix) VALUES (0,?,?,?,?,?)')
      .run(c.UserID(), issue.id, content, now, now);
    db.db().prepare('UPDATE issue SET num_comments = num_comments + 1 WHERE id = ?').run(issue.id);
    issue.num_comments = (issue.num_comments ?? 0) + 1;
    await issueAction(ActionType.COMMENT_ISSUE, c.User!, repo, issue, content);
  }
  if (String(form.status ?? '') === 'close' && (c.Repo.IsWriter() || issue.poster_id === c.UserID())) {
    db.updateIssueColumns(issue.id, { is_closed: 1 });
    db.refreshIssueCounts(repo.id);
    issue.is_closed = 1;
    await issueAction(issue.is_pull ? ActionType.CLOSE_PULL_REQUEST : ActionType.CLOSE_ISSUE, c.User!, repo, issue);
  } else if (String(form.status ?? '') === 'reopen' && (c.Repo.IsWriter() || issue.poster_id === c.UserID())) {
    db.updateIssueColumns(issue.id, { is_closed: 0 });
    db.refreshIssueCounts(repo.id);
    await issueAction(issue.is_pull ? ActionType.REOPEN_PULL_REQUEST : ActionType.REOPEN_ISSUE, c.User!, repo, issue);
  }
  c.Redirect(repoLink(c) + `/issues/${issue.index}`);
}

export async function UpdateCommentContent(c: Context): Promise<void> {
  const comment = db.getCommentByID(c.ParamsInt64(':id'));
  if (!comment) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const content = String(form.content ?? '').trim();
  if (content && (comment as any).poster_id === c.UserID()) {
    db.db().prepare('UPDATE comment SET content = ?, updated_unix = ? WHERE id = ?').run(content, nowUnix(), (comment as any).id);
  }
  c.PlainText(200, sanitizeHTML(content));
}

export async function DeleteComment(c: Context): Promise<void> {
  const comment = db.getCommentByID(c.ParamsInt64(':id'));
  if (!comment) {
    c.NotFound();
    return;
  }
  if ((comment as any).poster_id === c.UserID() || c.Repo.IsAdmin()) {
    db.db().prepare('DELETE FROM comment WHERE id = ?').run((comment as any).id);
    db.db().prepare('UPDATE issue SET num_comments = MAX(num_comments - 1, 0) WHERE id = ?').run((comment as any).issue_id);
  }
  c.Redirect(String(c.req.headers.referer ?? repoLink(c)));
}

export async function UpdateIssueLabel(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const issue = db.getIssueByIndex(repo.id, c.ParamsInt64(':index'));
  if (!issue) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const action = String(form.action ?? '');
  const ids = String(form.id ?? '').split(',').map(Number).filter(Boolean);
  if (action === 'clear') {
    db.db().prepare('DELETE FROM issue_label WHERE issue_id = ?').run(issue.id);
  } else if (action === 'attach' && ids.length) {
    for (const id of ids) {
      db.db().prepare('INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?,?)').run(issue.id, id);
    }
  } else if (action === 'detach' && ids.length) {
    for (const id of ids) {
      db.db().prepare('DELETE FROM issue_label WHERE issue_id = ? AND label_id = ?').run(issue.id, id);
    }
  }
  c.Redirect(repoLink(c) + `/issues/${issue.index}`);
}

export async function UpdateIssueMilestone(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const issue = db.getIssueByIndex(repo.id, c.ParamsInt64(':index'));
  if (!issue) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const id = Number(form.id ?? 0);
  db.updateIssueColumns(issue.id, { milestone_id: id > 0 ? id : null });
  c.Redirect(repoLink(c) + `/issues/${issue.index}`);
}

export async function UpdateIssueAssignee(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const issue = db.getIssueByIndex(repo.id, c.ParamsInt64(':index'));
  if (!issue) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const name = String(form.assignee_id ?? '');
  const assignee = name ? db.getUserByUsername(name) : null;
  db.updateIssueColumns(issue.id, { assignee_id: assignee?.id ?? null });
  c.Redirect(repoLink(c) + `/issues/${issue.index}`);
}

// ---------------------------------------------------------------- labels

export async function Labels(c: Context): Promise<void> {
  c.Data['PageIsLabels'] = true;
  c.Data['Labels'] = db.listLabels(c.Repo.Repository!.id).map((l: any) => db.goAlias({ ...l, IsChecked: false }));
  c.Success('repo/issue/labels');
}

export async function NewLabel(c: Context): Promise<void> {
  const form = await c.form();
  const name = String(form.title ?? '').trim();
  let color = String(form.color ?? '').trim();
  if (name && /^#[0-9a-fA-F]{6}$/.test(color)) {
    db.db().prepare('INSERT INTO label (repo_id, name, color, num_issues, num_closed_issues) VALUES (?,?,?,0,0)').run(c.Repo.Repository!.id, name, color);
  }
  c.Redirect(repoLink(c) + '/labels');
}

export async function UpdateLabel(c: Context): Promise<void> {
  const form = await c.form();
  const id = Number(form.id ?? 0);
  const name = String(form.title ?? '').trim();
  const color = String(form.color ?? '').trim();
  if (id > 0 && name && /^#[0-9a-fA-F]{6}$/.test(color)) {
    db.db().prepare('UPDATE label SET name = ?, color = ? WHERE id = ? AND repo_id = ?').run(name, color, id, c.Repo.Repository!.id);
  }
  c.Redirect(repoLink(c) + '/labels');
}

export async function DeleteLabel(c: Context): Promise<void> {
  const form = await c.form();
  const id = Number(form.id ?? 0);
  if (id > 0) {
    db.db().prepare('DELETE FROM label WHERE id = ? AND repo_id = ?').run(id, c.Repo.Repository!.id);
    db.db().prepare('DELETE FROM issue_label WHERE label_id = ?').run(id);
  }
  c.Redirect(repoLink(c) + '/labels');
}

export async function InitializeLabels(c: Context): Promise<void> {
  const form = await c.form();
  const choice = String(form.choice ?? '');
  const content = svc.readVendorTemplate('label', choice);
  if (!content) {
    c.Redirect(repoLink(c) + '/labels');
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(';', 2);
    if (parts.length !== 2) continue;
    const color = '#' + parts[0].trim();
    const name = parts[1].trim();
    db.db().prepare('INSERT INTO label (repo_id, name, color, num_issues, num_closed_issues) VALUES (?,?,?,0,0)').run(c.Repo.Repository!.id, name, color);
  }
  c.Redirect(repoLink(c) + '/labels');
}

// ---------------------------------------------------------------- milestones

export async function Milestones(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['PageIsMilestones'] = true;
  const state = c.Query('state') === 'closed' ? 1 : 0;
  c.Data['IsShowClosed'] = c.Query('state') === 'closed';
  const rows = db.listMilestones(repo.id, state).map((m: any) => db.goAlias({ ...m }));
  for (const m of rows) {
    m.Completeness = m.deadline_unix === 0 ? 100 : Math.round(((m.num_closed_issues ?? 0) / Math.max(m.num_issues ?? 0, 1)) * 100);
  }
  c.Data['Milestones'] = rows;
  c.Success('repo/issue/milestones');
}

export async function NewMilestone(c: Context): Promise<void> {
  c.Data['Title'] = c.Tr('repo.milestones.new');
  c.Data['PageIsMilestones'] = true;
  c.Data['RequireDatetimepicker'] = true;
  c.Success('repo/issue/milestone_new');
}

export async function NewMilestonePost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const name = String(form.title ?? '').trim();
  if (!name) {
    c.RenderWithErr(c.Tr('form.title_required'), 'repo/issue/milestone_new');
    return;
  }
  let deadline = 0;
  const due = String(form.due_date ?? '').trim();
  if (due) {
    const parsed = new Date(due);
    if (!Number.isNaN(parsed.getTime())) deadline = Math.floor(parsed.getTime() / 1000);
  }
  db.db()
    .prepare('INSERT INTO milestone (repo_id, name, content, deadline_unix, num_issues, num_closed_issues, completeness) VALUES (?,?,?,?,0,0,0)')
    .run(repo.id, name, String(form.content ?? ''), deadline);
  db.refreshMilestoneCounts(repo.id);
  c.Redirect(repoLink(c) + '/milestones');
}

export async function EditMilestone(c: Context): Promise<void> {
  const m = db.getMilestoneByID(c.Repo.Repository!.id, c.ParamsInt64(':id'));
  if (!m) {
    c.NotFound();
    return;
  }
  c.Data['Title'] = c.Tr('repo.milestones.edit');
  c.Data['PageIsEditMilestone'] = true;
  c.Data['RequireDatetimepicker'] = true;
  c.Data['Milestone'] = m;
  c.Success('repo/issue/milestone_new');
}

export async function EditMilestonePost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const id = c.ParamsInt64(':id');
  const form = await c.form();
  let deadline = 0;
  const due = String(form.due_date ?? '').trim();
  if (due) {
    const parsed = new Date(due);
    if (!Number.isNaN(parsed.getTime())) deadline = Math.floor(parsed.getTime() / 1000);
  }
  db.db()
    .prepare('UPDATE milestone SET name = ?, content = ?, deadline_unix = ? WHERE id = ? AND repo_id = ?')
    .run(String(form.title ?? '').trim(), String(form.content ?? ''), deadline, id, repo.id);
  c.Redirect(repoLink(c) + '/milestones');
}

export async function ChangeMilestonStatus(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const id = c.ParamsInt64(':id');
  const action = c.Params(':action');
  const m = db.getMilestoneByID(repo.id, id);
  if (!m) {
    c.NotFound();
    return;
  }
  const isClosed = action === 'close' ? 1 : 0;
  db.db()
    .prepare('UPDATE milestone SET is_closed = ?, closed_date_unix = ? WHERE id = ?')
    .run(isClosed, isClosed ? nowUnix() : 0, id);
  db.refreshMilestoneCounts(repo.id);
  c.Redirect(repoLink(c) + '/milestones');
}

export async function DeleteMilestone(c: Context): Promise<void> {
  const form = await c.form();
  const id = Number(form.id ?? 0);
  if (id > 0) {
    db.db().prepare('UPDATE issue SET milestone_id = 0 WHERE milestone_id = ?').run(id);
    db.db().prepare('DELETE FROM milestone WHERE id = ? AND repo_id = ?').run(id, c.Repo.Repository!.id);
    db.refreshMilestoneCounts(c.Repo.Repository!.id);
  }
  c.Redirect(repoLink(c) + '/milestones');
}

// ---------------------------------------------------------------- releases

export async function Releases(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['PageIsReleases'] = true;
  c.Data['Title'] = c.Tr('repo.release.releases');
  const repoDir = repo.RepoPath();
  const releases = db.listReleases(repo.id).map((r: any) => db.goAlias({ ...r, Publisher: db.getUserByID(r.publisher_id) }));
  c.Data['Releases'] = releases;
  c.Data['HasPrevious'] = false;
  c.Data['ReachEnd'] = true;
  c.Data['PageIsViewFiles'] = true;
  void repoDir;
  c.Success('repo/release/list');
}

export async function NewRelease(c: Context): Promise<void> {
  c.Data['Title'] = c.Tr('repo.release.new_release');
  c.Data['PageIsEditRelease'] = false;
  c.Data['RequireSimpleMDE'] = true;
  c.Data['RequireDropzone'] = true;
  c.Data['TagTargets'] = (await git.getBranches(c.Repo.Repository!.RepoPath())).map((b) => b.name);
  c.Success('repo/release/new');
}

export async function NewReleasePost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const tagName = String(form.tag_name ?? '').trim();
  const target = String(form.target_commitish ?? repo.default_branch ?? conf.defaultBranch);
  if (!tagName) {
    c.RenderWithErr(c.Tr('form.tag_name_required'), 'repo/release/new');
    return;
  }
  if (db.db().prepare('SELECT 1 FROM release WHERE repo_id = ? AND lower_tag_name = ?').get(repo.id, tagName.toLowerCase())) {
    c.RenderWithErr(c.Tr('form.tag_name_been_taken'), 'repo/release/new');
    return;
  }
  const repoDir = repo.RepoPath();
  const sha = (await git.gitOK(repoDir, 'rev-parse', '--verify', '--end-of-options', target))?.toString().trim() ?? '';
  // create the git tag
  await git.gitOK(repoDir, 'tag', tagName, sha || 'HEAD');
  const numCommits = sha ? await git.commitsCount(repoDir, sha) : 0;
  db.db()
    .prepare(
      `INSERT INTO release (repo_id, publisher_id, tag_name, lower_tag_name, target, title, sha1, num_commits, note, is_draft, is_prerelease, created_unix)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      repo.id,
      c.UserID(),
      tagName,
      tagName.toLowerCase(),
      target,
      String(form.title ?? tagName),
      sha,
      numCommits,
      String(form.content ?? ''),
      String(form.draft ?? '') === 'on' ? 1 : 0,
      String(form.prerelease ?? '') === 'on' ? 1 : 0,
      nowUnix()
    );
  const { pushTagAction } = await import('../db/actions.js');
  await pushTagAction(c.User!, repo, tagName);
  c.flash.Success(c.Tr('repo.release.publish_success'));
  c.Redirect(repoLink(c) + '/releases');
}

export async function EditRelease(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const rel = db.db().prepare('SELECT * FROM release WHERE repo_id = ? AND lower_tag_name = ?').get(c.Repo.Repository!.id, wildcard.toLowerCase()) as any;
  if (!rel) {
    c.NotFound();
    return;
  }
  c.Data['PageIsEditRelease'] = true;
  c.Data['RequireSimpleMDE'] = true;
  c.Data['Release'] = rel;
  c.Success('repo/release/new');
}

export async function EditReleasePost(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const form = await c.form();
  const rel = db.db().prepare('SELECT * FROM release WHERE repo_id = ? AND lower_tag_name = ?').get(c.Repo.Repository!.id, wildcard.toLowerCase()) as any;
  if (!rel) {
    c.NotFound();
    return;
  }
  db.db()
    .prepare('UPDATE release SET title = ?, note = ?, is_draft = ?, is_prerelease = ? WHERE id = ?')
    .run(String(form.title ?? ''), String(form.content ?? ''), String(form.draft ?? '') === 'on' ? 1 : 0, String(form.prerelease ?? '') === 'on' ? 1 : 0, rel.id);
  c.Redirect(repoLink(c) + '/releases');
}

export async function DeleteRelease(c: Context): Promise<void> {
  const form = await c.form();
  const id = Number(form.id ?? 0);
  const rel = db.getReleaseByID(c.Repo.Repository!.id, id);
  if (rel) {
    await git.gitOK(c.Repo.Repository!.RepoPath(), 'tag', '-d', (rel as any).tag_name);
    db.db().prepare('DELETE FROM release WHERE id = ?').run(id);
  }
  c.Redirect(repoLink(c) + '/releases');
}

// ---------------------------------------------------------------- wiki

export async function Wiki(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const wikiDir = repo.WikiPath();
  if (!fs.existsSync(wikiDir)) {
    c.Redirect(repoLink(c) + '/wiki/_new');
    return;
  }
  const pageParam = c.Params(':page') || 'Home';
  const pageName = svc.toWikiPageName(pageParam);
  const branch = svc.wikiBranch(wikiDir);
  const ref = 'refs/heads/' + branch;
  if (!(await git.refExists(wikiDir, ref))) {
    c.Redirect(repoLink(c) + '/wiki/_new');
    return;
  }
  const pages = await wikiPages(wikiDir, branch);
  c.Data['Pages'] = pages;
  const commit = await git.commitByPath(wikiDir, ref, pageName + '.md');
  let content = '';
  try {
    const commitFull = await git.getCommit(wikiDir, ref);
    const tree = await git.lsTree(wikiDir, commitFull!.id, pageName + '.md');
    const entry = tree?.entries[0];
    if (entry) content = (await git.blobBytes(wikiDir, entry.sha)).toString('utf8');
  } catch {
    // page missing
  }
  if (!content) {
    c.NotFound();
    return;
  }
  const lastUser = commit ? db.getUserByEmail(commit.committer.email) : null;
  c.Data['Page'] = { Name: pageName, Commit: commit, User: lastUser };
  c.Data['Content'] = new SafeHTML(markdown(content, `${repoLink(c)}/wiki/${encodeURIComponent(pageName)}`, repo.ComposeMetas()));
  c.Data['PageIsWiki'] = true;
  c.Data['Title'] = pageName;
  c.Require('HighlightJS');
  c.Success('repo/wiki/view');
}

async function wikiPages(wikiDir: string, branch: string): Promise<any[]> {
  const ref = 'refs/heads/' + branch;
  const commit = await git.getCommit(wikiDir, ref);
  if (!commit) return [];
  const tree = await git.lsTree(wikiDir, commit.id, '');
  const pages: any[] = [];
  for (const e of tree?.entries ?? []) {
    if (e.type !== 'blob' || !e.name.endsWith('.md')) continue;
    const name = e.name.slice(0, -3);
    const last = await git.commitByPath(wikiDir, ref, e.name);
    pages.push(db.goAlias({ Name: name, Commit: last, User: last ? db.getUserByEmail(last.committer.email) : null }));
  }
  return pages;
}

export async function WikiPages(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const wikiDir = repo.WikiPath();
  const branch = svc.wikiBranch(wikiDir);
  c.Data['Pages'] = await wikiPages(wikiDir, branch);
  c.Data['PageIsWiki'] = true;
  c.Data['Title'] = c.Tr('repo.wiki.pages');
  c.Success('repo/wiki/pages');
}

export async function NewWiki(c: Context): Promise<void> {
  c.Data['PageIsWiki'] = true;
  c.Data['RequireSimpleMDE'] = true;
  c.Success('repo/wiki/new');
}

export async function NewWikiPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const title = svc.toWikiPageName(String(form.title ?? ''));
  const content = String(form.content ?? '');
  if (!title) {
    c.RenderWithErr(c.Tr('repo.wiki.title_required'), 'repo/wiki/new');
    return;
  }
  await writeWikiPage(repo, title, content, c.User!, null);
  c.flash.Success(c.Tr('repo.wiki.page_created'));
  c.Redirect(repoLink(c) + '/wiki/' + encodeURIComponent(title));
}

export async function EditWiki(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const pageName = svc.toWikiPageName(c.Params(':page'));
  const wikiDir = repo.WikiPath();
  const branch = svc.wikiBranch(wikiDir);
  const ref = 'refs/heads/' + branch;
  let content = '';
  try {
    const commit = await git.getCommit(wikiDir, ref);
    const tree = await git.lsTree(wikiDir, commit!.id, pageName + '.md');
    const entry = tree?.entries[0];
    if (entry) content = (await git.blobBytes(wikiDir, entry.sha)).toString('utf8');
  } catch {
    // ignore
  }
  c.Data['PageIsWikiEdit'] = true;
  c.Data['PageIsWiki'] = true;
  c.Data['RequireSimpleMDE'] = true;
  c.Data['Page'] = { Name: pageName, Content: content };
  c.Success('repo/wiki/new');
}

export async function EditWikiPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const oldName = svc.toWikiPageName(c.Params(':page'));
  const form = await c.form();
  const newName = svc.toWikiPageName(String(form.title ?? ''));
  await writeWikiPage(repo, newName, String(form.content ?? ''), c.User!, oldName);
  c.flash.Success(c.Tr('repo.wiki.page_updated'));
  c.Redirect(repoLink(c) + '/wiki/' + encodeURIComponent(newName));
}

export async function DeleteWikiPagePost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const pageName = svc.toWikiPageName(c.Params(':page'));
  await writeWikiPage(repo, pageName, '', c.User!, pageName, true);
  c.flash.Success(c.Tr('repo.wiki.page_deleted'));
  c.Redirect(repoLink(c) + '/wiki/');
}

async function writeWikiPage(repo: db.Repository, title: string, content: string, doer: db.User, oldTitle: string | null, isDelete = false): Promise<void> {
  const wikiDir = repo.WikiPath();
  await svc.initWiki(wikiDir);
  const tmpDir = path.join(conf.appDataPath, 'tmp', 'wiki-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const branch = svc.wikiBranch(wikiDir);
    const hasBranch = await git.refExists(wikiDir, 'refs/heads/' + branch);
    if (hasBranch) {
      await git.git(process.cwd(), 'clone', wikiDir, tmpDir);
    } else {
      await git.git(process.cwd(), 'clone', wikiDir, tmpDir);
    }
    const target = path.join(tmpDir, title + '.md');
    if (isDelete) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      const symlink = target.endsWith('.md') ? target.slice(0, -3) : target;
      if (fs.existsSync(symlink)) fs.unlinkSync(symlink);
    } else {
      if (oldTitle && oldTitle !== title) {
        const oldPath = path.join(tmpDir, oldTitle + '.md');
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      if (!isDelete && fs.existsSync(target) && oldTitle === null) {
        throw new Error('page already exists');
      }
      fs.writeFileSync(target, content);
    }
    const author = `${doer.name} <${doer.email}>`;
    await git.git(tmpDir, 'add', '--all');
    const msg = isDelete ? `Delete page '${title}'` : oldTitle ? `Update page '${title}'` : `Update page '${title}'`;
    await git.git(tmpDir, 'commit', `--author=${author}`, '-m', msg);
    await git.git(tmpDir, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- pulls

export async function CompareAndPullRequest(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const parts = wildcard.split('...');
  const repo = c.Repo.Repository!;
  const baseBranch = parts[0] || repo.default_branch;
  let headUser = repo.OwnerName();
  let headBranch = parts[1] ?? '';
  if (headBranch.includes(':')) {
    [headUser, headBranch] = headBranch.split(':');
  }
  c.Data['Title'] = c.Tr('repo.pulls.compare_changes');
  c.Data['PageIsComparePull'] = true;
  c.Data['BaseBranch'] = baseBranch;
  c.Data['HeadBranch'] = headBranch;
  c.Data['HeadUserName'] = headUser;
  c.Data['RequireSimpleMDE'] = true;
  c.Data['RequireHighlightJS'] = true;

  const headRepo = headUser === repo.OwnerName() ? repo : db.getRepoByName(headUser, repo.name) ?? (db.getUserByUsername(headUser) ? db.listReposByOwner(db.getUserByUsername(headUser)!.id).find((r) => r.fork_id === repo.id) ?? null : null);
  if (headRepo) {
    const headDir = headRepo.RepoPath();
    const mergeBase = await git.mergeBase(headDir, baseBranch, headBranch);
    if (mergeBase) {
      const commits = await git.gitOK(headDir, 'log', '--pretty=format:%H', '--end-of-options', `${mergeBase}...${headBranch}`, '--');
      const shas = (commits?.toString().trim().split('\n').filter(Boolean) ?? []).reverse();
      const commitList: any[] = [];
      for (const sha of shas) {
        try {
          const cm = await git.catFileCommit(headDir, sha);
          commitList.push({ ...cm, User: db.getUserByEmail(cm.author.email) });
        } catch {
          // ignore
        }
      }
      c.Data['Commits'] = commitList.map((cm: any) => db.goAlias({ ...cm }));
      const diff = await git.repoDiff(headDir, headBranch, mergeBase, conf.maxDiffFiles, conf.maxDiffLines);
      c.Data['Diff'] = diff;
      c.Data['NumFiles'] = diff.numFiles;
    }
  }
  c.Success('repo/diff/compare');
}

export async function CompareAndPullRequestPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const wildcard = c.Params(':*');
  const parts = wildcard.split('...');
  const baseBranch = parts[0] || repo.default_branch;
  let headUser = repo.OwnerName();
  let headBranch = parts[1] ?? '';
  if (headBranch.includes(':')) {
    [headUser, headBranch] = headBranch.split(':');
  }
  const form = await c.form();
  const title = String(form.title ?? '').trim();
  if (!title) {
    c.flash.Error(c.Tr('form.title_required'));
    c.Redirect(repoLink(c) + `/compare/${wildcard}`);
    return;
  }
  const index = db.maxIssueIndex(repo.id) + 1;
  const now = nowUnix();
  const info = db
    .db()
    .prepare(
      `INSERT INTO issue (repo_id, "index", poster_id, name, content, is_closed, is_pull, num_comments, created_unix, updated_unix)
       VALUES (?,?,?,?,?,0,1,0,?,?)`
    )
    .run(repo.id, index, c.UserID(), title, String(form.content ?? ''), now, now);
  const issueID = Number(info.lastInsertRowid);
  db.db().prepare('INSERT INTO issue_user (uid, issue_id, repo_id, is_poster, is_read) VALUES (?,?,?,1,1)').run(c.UserID(), issueID, repo.id);

  const headRepo = headUser === repo.OwnerName() ? repo : null;
  const headDir = (headRepo ?? repo).RepoPath();
  const mergeBase = (await git.mergeBase(headDir, baseBranch, headBranch)) ?? '';
  const patch = await git.git(headDir, 'diff', '--full-index', '--binary', '--end-of-options', mergeBase || baseBranch, headBranch);
  const patchDir = path.join(conf.appDataPath, 'patches', String(repo.id));
  fs.mkdirSync(patchDir, { recursive: true });
  fs.writeFileSync(path.join(patchDir, `${index}.patch`), patch);

  db.db()
    .prepare(
      `INSERT INTO pull_request (type, status, issue_id, "index", head_repo_id, base_repo_id, head_user_name, head_branch, base_branch, merge_base)
       VALUES (0, 2, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(issueID, index, headRepo?.id ?? repo.id, repo.id, headUser, headBranch, baseBranch, mergeBase);

  db.refreshIssueCounts(repo.id);
  const issue = db.getIssueByID(issueID)!;
  await issueAction(ActionType.CREATE_PULL_REQUEST, c.User!, repo, issue);
  c.Redirect(repoLink(c) + '/pulls/' + index);
}

export async function ViewPull(c: Context): Promise<void> {
  await ViewIssue(c);
  c.Data['PageIsPullConversation'] = true;
}

export async function ViewPullCommits(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const index = c.ParamsInt64(':index');
  const issue = db.getIssueByIndex(repo.id, index);
  const pr = issue ? (db.db().prepare('SELECT * FROM pull_request WHERE issue_id = ?').get(issue.id) as any) : null;
  c.Data['PageIsPullCommits'] = true;
  c.Data['PullRequest'] = pr;
  c.Data['Issue'] = issue;
  if (pr) {
    const headRepo = db.getRepoByID(pr.head_repo_id) ?? repo;
    const shas = (await git.gitOK(headRepo.RepoPath(), 'log', '--pretty=format:%H', '--end-of-options', `${pr.merge_base}...${pr.head_branch}`, '--'))?.toString().trim().split('\n').filter(Boolean) ?? [];
    const commits: any[] = [];
    for (const sha of shas) {
      try {
        const cm = await git.catFileCommit(headRepo.RepoPath(), sha);
        commits.push({ ...cm, User: db.getUserByEmail(cm.author.email) });
      } catch {
        // ignore
      }
    }
    c.Data['Commits'] = commits;
  }
  c.Success('repo/pulls/commits');
}

export async function ViewPullFiles(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const index = c.ParamsInt64(':index');
  const issue = db.getIssueByIndex(repo.id, index);
  const pr = issue ? (db.db().prepare('SELECT * FROM pull_request WHERE issue_id = ?').get(issue.id) as any) : null;
  c.Data['PageIsPullFiles'] = true;
  c.Data['PullRequest'] = pr;
  c.Data['Issue'] = issue;
  if (pr) {
    const headRepo = db.getRepoByID(pr.head_repo_id) ?? repo;
    if (pr.merge_base) {
      c.Data['Diff'] = await git.repoDiff(headRepo.RepoPath(), pr.head_branch, pr.merge_base, conf.maxDiffFiles, conf.maxDiffLines);
    }
  }
  c.Success('repo/pulls/files');
}

export async function MergePullRequest(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const index = c.ParamsInt64(':index');
  const issue = db.getIssueByIndex(repo.id, index);
  const pr = issue ? (db.db().prepare('SELECT * FROM pull_request WHERE issue_id = ?').get(issue.id) as any) : null;
  if (!issue || !pr || pr.has_merged) {
    c.NotFound();
    return;
  }
  const baseDir = repo.RepoPath();
  const headRepo = db.getRepoByID(pr.head_repo_id) ?? repo;
  const tmpDir = path.join(conf.appDataPath, 'tmp', 'merge-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    await git.git(process.cwd(), 'clone', '-b', pr.base_branch, baseDir, tmpDir);
    await git.git(tmpDir, 'remote', 'add', 'head_repo', headRepo.RepoPath());
    await git.git(tmpDir, 'fetch', 'head_repo');
    await git.git(tmpDir, 'merge', '--no-ff', '--no-commit', '--end-of-options', `head_repo/${pr.head_branch}`);
    const msg = `Merge branch '${pr.head_branch}' of ${pr.head_user_name}/${headRepo.name} into ${pr.base_branch}`;
    await git.git(tmpDir, 'commit', `--author=${c.User!.name} <${c.User!.email}>`, '-m', msg);
    await git.git(tmpDir, 'push', 'origin', `HEAD:refs/heads/${pr.base_branch}`);
    db.db()
      .prepare('UPDATE pull_request SET has_merged = 1, merger_id = ?, merged_unix = ? WHERE id = ?')
      .run(c.UserID(), nowUnix(), pr.id);
    db.updateIssueColumns(issue.id, { is_closed: 1 });
    db.refreshIssueCounts(repo.id);
    await issueAction(ActionType.MERGE_PULL_REQUEST, c.User!, repo, issue);
    c.flash.Success(c.Tr('repo.pulls.merged_success'));
  } catch (e: any) {
    console.error('[merge pr]', e);
    c.flash.Error(c.Tr('repo.pulls.merge_failed'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  c.Redirect(repoLink(c) + '/pulls/' + index);
}

// ---------------------------------------------------------------- attachments upload

async function saveUpload(c: Context, field: string): Promise<void> {
  const files = c.Files();
  const file = files.find((f: any) => f.field === field);
  if (!file) {
    c.NotFound();
    return;
  }
  if (file.buffer.length > conf.uploadFileMaxSize * 1024 * 1024) {
    c.JSON(400, { error: 'file too large' });
    return;
  }
  const uuid = newUUID();
  const dir = path.join(conf.appDataPath, 'attachments', uuid.slice(0, 1), uuid.slice(1, 2));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, uuid), file.buffer);
  db.db().prepare('INSERT INTO upload (uuid, name) VALUES (?,?)').run(uuid, file.name);
  c.JSONSuccess({ uuid });
}

export async function UploadIssueAttachment(c: Context): Promise<void> {
  await saveUpload(c, 'file');
}

export async function UploadReleaseAttachment(c: Context): Promise<void> {
  await saveUpload(c, 'file');
}

// ---------------------------------------------------------------- web editor

export async function EditFile(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  c.Data['TreePath'] = wildcard;
  c.Data['BranchName'] = c.Repo.BranchName;
  c.Data['RequireSimpleMDE'] = true;
  c.Data['PageIsEdit'] = true;
  const repo = c.Repo.Repository!;
  const commit = c.Repo.Commit ?? (await git.getCommit(repo.RepoPath(), c.Repo.BranchName));
  const tree = await git.lsTree(repo.RepoPath(), commit.id, wildcard);
  const entry = tree?.entries[0];
  if (entry) {
    c.Data['FileContent'] = (await git.blobBytes(repo.RepoPath(), entry.sha)).toString('utf8');
  }
  c.Success('repo/editor/edit');
}

async function commitTreeChanges(c: Context, wildcard: string, mutate: (workDir: string) => string | null): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const branchName = String(form.commit_choice === 'commit-to-new-branch' ? form.new_branch_name : c.Repo.BranchName);
  const repoDir = repo.RepoPath();
  const tmpDir = path.join(conf.appDataPath, 'tmp', 'edit-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    await git.git(process.cwd(), 'clone', repoDir, tmpDir);
    const err = mutate(tmpDir);
    if (err) {
      c.flash.Error(err);
      c.Redirect(`${repoLink(c)}/src/${encodeURIComponent(c.Repo.BranchName)}/${wildcard}`);
      return;
    }
    await git.git(tmpDir, 'add', '--all');
    const msg = String(form.commit_summary ?? '') || String(form.last_commit ?? '') || `Update ${wildcard}`;
    const desc = String(form.commit_description ?? '');
    const author = `${c.User!.name} <${c.User!.email}>`;
    const commitArgs = ['commit', `--author=${author}`, '-m', msg];
    if (desc) commitArgs.push('-m', desc);
    await git.git(tmpDir, ...commitArgs);
    await git.git(tmpDir, 'push', 'origin', `HEAD:refs/heads/${branchName}`);
    if (branchName !== c.Repo.BranchName) {
      const { createBranchAction } = await import('../db/actions.js');
      createBranchAction(c.User!, repo, branchName);
    }
    c.flash.Success(c.Tr('repo.editor.commit_changes_successful'));
    c.Redirect(`${repoLink(c)}/src/${encodeURIComponent(branchName)}/${wildcard}`);
  } catch (e: any) {
    console.error('[editor]', e);
    c.flash.Error(c.Tr('repo.editor.commit_changes_failed'));
    c.Redirect(`${repoLink(c)}/src/${encodeURIComponent(c.Repo.BranchName)}/${wildcard}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function EditFilePost(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const form = await c.form();
  const content = String(form.content ?? '');
  await commitTreeChanges(c, wildcard, (dir) => {
    const target = path.join(dir, wildcard);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return null;
  });
}

export async function NewFile(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  c.Data['TreePath'] = wildcard;
  c.Data['BranchName'] = c.Repo.BranchName;
  c.Data['RequireSimpleMDE'] = true;
  c.Data['PageIsEdit'] = true;
  c.Data['NewFile'] = true;
  c.Success('repo/editor/edit');
}

export async function NewFilePost(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  const form = await c.form();
  const content = String(form.content ?? '');
  await commitTreeChanges(c, wildcard, (dir) => {
    const target = path.join(dir, wildcard);
    if (fs.existsSync(target)) return 'file already exists';
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return null;
  });
}

export async function DiffPreviewPost(c: Context): Promise<void> {
  const form = await c.form();
  c.PlainText(200, markdown(String(form.content ?? ''), repoLink(c), c.Repo.Repository!.ComposeMetas()));
}

export async function DeleteFile(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  c.Data['TreePath'] = wildcard;
  c.Data['BranchName'] = c.Repo.BranchName;
  c.Data['PageIsDelete'] = true;
  c.Success('repo/editor/delete');
}

export async function DeleteFilePost(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  await commitTreeChanges(c, wildcard, (dir) => {
    const target = path.join(dir, wildcard);
    if (!fs.existsSync(target)) return 'file not found';
    fs.unlinkSync(target);
    return null;
  });
}

export async function UploadFile(c: Context): Promise<void> {
  c.Data['TreePath'] = c.Params(':*');
  c.Data['BranchName'] = c.Repo.BranchName;
  c.Data['PageIsUpload'] = true;
  c.Data['RequireDropzone'] = true;
  c.Success('repo/editor/upload');
}

export async function UploadFilePost(c: Context): Promise<void> {
  const wildcard = c.Params(':*');
  await c.form();
  const files = c.Files();
  if (!files.length) {
    c.flash.Error(c.Tr('repo.editor.no_file_uploaded'));
    c.Redirect(`${repoLink(c)}/_upload/${wildcard}`);
    return;
  }
  await commitTreeChanges(c, wildcard, (dir) => {
    for (const f of files) {
      const target = path.join(dir, wildcard, f.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.buffer);
    }
    return null;
  });
}

export async function UploadFileToServer(c: Context): Promise<void> {
  await saveUpload(c, 'file');
}

export async function RemoveUploadFileFromServer(c: Context): Promise<void> {
  const form = await c.form();
  const uuid = String(form.file ?? '');
  db.db().prepare('DELETE FROM upload WHERE uuid = ?').run(uuid);
  c.Status(200);
  c.res.end();
  c.rendered = true;
}

// ---------------------------------------------------------------- settings

export async function Settings(c: Context): Promise<void> {
  c.Data['PageIsSettings'] = true;
  c.Data['PageIsSettingsOptions'] = true;
  c.Data['Repository'] = c.Repo.Repository;
  c.Data['MirrorInterval'] = '';
  c.Success('repo/settings/options');
}

export async function SettingsPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const name = String(form.repo_name ?? '').trim();
  if (name !== repo.name) {
    if (!ALPHADASHDOT.test(name)) {
      c.RenderWithErr(c.Tr('repo.form.name_not_allowed'), 'repo/settings/options');
      return;
    }
    if (db.getRepoByName(repo.OwnerName(), name)) {
      c.RenderWithErr(c.Tr('repo.form.name_been_taken'), 'repo/settings/options');
      return;
    }
  }
  const isPrivate = String(form.private ?? '') === 'on' || conf.forcePrivate;
  // rename on disk when needed
  if (name !== repo.name) {
    const oldPath = repo.RepoPath();
    const newPath = db.repoPath(repo.OwnerName(), name);
    if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
    const oldWiki = repo.WikiPath();
    const newWiki = db.wikiPath(repo.OwnerName(), name);
    if (fs.existsSync(oldWiki)) fs.renameSync(oldWiki, newWiki);
  }
  db.updateRepoColumns(repo.id, {
    name,
    lower_name: name.toLowerCase(),
    description: String(form.description ?? ''),
    website: String(form.website ?? ''),
    is_private: isPrivate ? 1 : 0,
    enable_issues: String(form.enable_issues ?? '') === 'on' ? 1 : 0,
    enable_wiki: String(form.enable_wiki ?? '') === 'on' ? 1 : 0,
    enable_pulls: String(form.enable_pulls ?? '') === 'on' ? 1 : 0,
    enable_external_tracker: String(form.enable_external_tracker ?? '') === 'on' ? 1 : 0,
    external_tracker_url: String(form.external_tracker_url ?? ''),
    external_tracker_format: String(form.tracker_url_format ?? ''),
    external_tracker_style: String(form.tracker_issue_style ?? ''),
  });
  c.flash.Success(c.Tr('repo.settings.update_settings_success'));
  c.Redirect(conf.subpath + '/' + name !== repo.name ? conf.subpath + '/' + repo.OwnerName() + '/' + name : repoLink(c) + '/settings');
}

export async function SettingsAvatar(c: Context): Promise<void> {
  c.Data['PageIsSettings'] = true;
  c.Data['PageIsSettingsAvatar'] = true;
  c.Success('repo/settings/avatar');
}

export async function SettingsAvatarPost(c: Context): Promise<void> {
  await c.form();
  const files = c.Files();
  const avatar = files.find((f: any) => f.field === 'avatar');
  if (avatar) {
    fs.mkdirSync(conf.repositoryAvatarUploadPath, { recursive: true });
    const hash = crypto.createHash('sha1').update(String(c.Repo.Repository!.id)).digest('hex');
    fs.writeFileSync(path.join(conf.repositoryAvatarUploadPath, hash), avatar.buffer);
    db.updateRepoColumns(c.Repo.Repository!.id, { use_custom_avatar: 1 });
  }
  c.Redirect(repoLink(c) + '/settings/avatar');
}

export async function SettingsDeleteAvatar(c: Context): Promise<void> {
  db.updateRepoColumns(c.Repo.Repository!.id, { use_custom_avatar: 0 });
  c.Redirect(repoLink(c) + '/settings/avatar');
}

export async function SettingsCollaboration(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['PageIsSettings'] = true;
  c.Data['PageIsSettingsCollaboration'] = true;
  const rows = db.listCollaborations(repo.id).map((col: any) => {
    const u = db.getUserByID(col.user_id);
    return { ...col, User: u };
  });
  c.Data['Collaborations'] = rows;
  c.Success('repo/settings/collaboration');
}

export async function SettingsCollaborationPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const name = String(form.collaborator ?? '').trim();
  const user = db.getUserByUsername(name);
  if (!user || user.id === repo.owner_id) {
    c.flash.Error(c.Tr('repo.settings.add_collaborator_failure'));
    c.Redirect(repoLink(c) + '/settings/collaboration');
    return;
  }
  if (!db.getCollaboration(repo.id, user.id)) {
    db.db().prepare('INSERT INTO collaboration (user_id, repo_id, mode) VALUES (?,?,2)').run(user.id, repo.id);
    c.flash.Success(c.Tr('repo.settings.add_collaborator_success'));
  }
  c.Redirect(repoLink(c) + '/settings/collaboration');
}

export async function ChangeCollaborationAccessMode(c: Context): Promise<void> {
  const form = await c.form();
  const uid = Number(form.uid ?? 0);
  const mode = Number(form.mode ?? 1);
  if (uid > 0) {
    db.db().prepare('UPDATE collaboration SET mode = ? WHERE repo_id = ? AND user_id = ?').run(mode, c.Repo.Repository!.id, uid);
  }
  c.Redirect(repoLink(c) + '/settings/collaboration');
}

export async function DeleteCollaboration(c: Context): Promise<void> {
  const form = await c.form();
  const uid = Number(form.uid ?? 0);
  db.db().prepare('DELETE FROM collaboration WHERE repo_id = ? AND user_id = ?').run(c.Repo.Repository!.id, uid);
  c.Redirect(repoLink(c) + '/settings/collaboration');
}

export async function SettingsBranches(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['PageIsSettings'] = true;
  c.Data['PageIsSettingsBranches'] = true;
  const branches = await git.getBranches(repo.RepoPath());
  const protectedRows = db.db().prepare('SELECT * FROM protect_branch WHERE repo_id = ?').all(repo.id) as any[];
  c.Data['ProtectedBranches'] = protectedRows;
  c.Data['Branches'] = branches;
  c.Success('repo/settings/branches');
}

export async function UpdateDefaultBranch(c: Context): Promise<void> {
  const form = await c.form();
  const branch = String(form.branch ?? '').trim();
  const repo = c.Repo.Repository!;
  if (await git.refExists(repo.RepoPath(), 'refs/heads/' + branch)) {
    await git.gitOK(repo.RepoPath(), 'symbolic-ref', 'HEAD', 'refs/heads/' + branch);
    db.updateRepoColumns(repo.id, { default_branch: branch });
  }
  c.Redirect(repoLink(c) + '/settings/branches');
}

export async function SettingsProtectedBranch(c: Context): Promise<void> {
  const name = c.Params(':*');
  c.Data['PageIsSettings'] = true;
  c.Data['PageIsSettingsBranches'] = true;
  c.Data['Branch'] = { Name: name };
  const row = db.db().prepare('SELECT * FROM protect_branch WHERE repo_id = ? AND name = ?').get(c.Repo.Repository!.id, name) as any;
  c.Data['ProtectBranch'] = row ?? { name, protected: 0, require_pull_request: 0, enable_whitelist: 0, whitelist_user_ids: '[]' };
  c.Success('repo/settings/protected_branch');
}

export async function SettingsProtectedBranchPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const name = c.Params(':*');
  const form = await c.form();
  const exists = db.db().prepare('SELECT id FROM protect_branch WHERE repo_id = ? AND name = ?').get(repo.id, name) as any;
  const protectedVal = String(form.protected ?? '') === 'on' ? 1 : 0;
  if (exists) {
    db.db()
      .prepare('UPDATE protect_branch SET protected = ?, require_pull_request = ?, enable_whitelist = ? WHERE id = ?')
      .run(protectedVal, String(form.require_pull_request ?? '') === 'on' ? 1 : 0, String(form.enable_whitelist ?? '') === 'on' ? 1 : 0, exists.id);
  } else {
    db.db()
      .prepare('INSERT INTO protect_branch (repo_id, name, protected, require_pull_request, enable_whitelist, whitelist_user_ids, whitelist_team_ids) VALUES (?,?,?,?,?,?,?)')
      .run(repo.id, name, protectedVal, String(form.require_pull_request ?? '') === 'on' ? 1 : 0, String(form.enable_whitelist ?? '') === 'on' ? 1 : 0, '[]', '[]');
  }
  c.flash.Success(c.Tr('repo.settings.protect_branch_success'));
  c.Redirect(`${repoLink(c)}/settings/branches/${name}`);
}

// ---------------------------------------------------------------- deploy keys

export async function SettingsDeployKeys(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  c.Data['PageIsSettings'] = true;
  c.Data['PageIsSettingsKeys'] = true;
  const rows = db.db().prepare('SELECT p.* FROM public_key p JOIN deploy_key d ON d.key_id = p.id WHERE d.repo_id = ?').all(repo.id) as any[];
  c.Data['DeployKeys'] = rows.map((k: any) => db.goAlias({ ...k }));
  c.Success('repo/settings/deploy_keys');
}

export async function SettingsDeployKeysPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const title = String(form.title ?? '').trim();
  const content = String(form.content ?? '').trim();
  const { addPublicKey } = await import('./sshkey.js');
  try {
    // create as deploy key (type 2)
    const clean = content.replaceAll('\n', '').replaceAll('\r', '');
    const { fingerprintKey } = await import('./sshkey.js');
    const fingerprint = fingerprintKey(clean);
    const info = db.db()
      .prepare('INSERT INTO public_key (owner_id, name, fingerprint, content, mode, type, created_unix, updated_unix) VALUES (?,?,?,?,2,2,?,?)')
      .run(repo.owner_id, title, fingerprint, clean, nowUnix(), nowUnix());
    const keyID = Number(info.lastInsertRowid);
    db.db().prepare('INSERT INTO deploy_key (key_id, repo_id, name, fingerprint, created_unix, updated_unix) VALUES (?,?,?,?,?,?)')
      .run(keyID, repo.id, title, fingerprint, nowUnix(), nowUnix());
    c.flash.Success(c.Tr('repo.settings.add_deploy_key_success'));
  } catch (e: any) {
    void e;
    c.flash.Error(c.Tr('repo.settings.add_deploy_key_failure'));
  }
  c.Redirect(repoLink(c) + '/settings/keys');
}

export async function DeleteDeployKey(c: Context): Promise<void> {
  const form = await c.form();
  const id = Number(form.id ?? 0);
  db.db().prepare('DELETE FROM deploy_key WHERE key_id = ? AND repo_id = ?').run(id, c.Repo.Repository!.id);
  db.db().prepare('DELETE FROM public_key WHERE id = ? AND type = 2').run(id);
  c.Redirect(repoLink(c) + '/settings/keys');
}

// ---------------------------------------------------------------- webhooks

export async function Webhooks(c: Context): Promise<void> {
  c.Data['PageIsSettingsHooks'] = true;
  c.Data['Hooks'] = db.listWebhooks(c.Repo.Repository!.id).map((h: any) => db.goAlias({ ...h }));
  c.Success('repo/settings/webhook/list');
}

export async function WebhooksNew(c: Context): Promise<void> {
  c.Data['PageIsSettingsHooks'] = true;
  c.Data['PageIsSettingsHooksNew'] = true;
  c.Data['HookType'] = c.Params(':type');
  c.Success('repo/settings/webhook/new');
}

function hookPayloadConfig(form: Record<string, any>, hookType: string): { config: string; events: string } {
  const cfg: Record<string, string> = {
    url: String(form.payload_url ?? ''),
    content_type: String(form.content_type ?? 'json'),
    secret: String(form.secret ?? ''),
  };
  if (hookType === 'slack') {
    cfg.channel = String(form.channel ?? '');
    cfg.username = String(form.username ?? '');
    cfg.icon_url = String(form.icon_url ?? '');
    cfg.color = String(form.color ?? 'good');
  }
  const events: Record<string, any> = { push_only: false, send_everything: false, choose_events: false, events: {} };
  if (String(form.push_only ?? '') === 'on') events.push_only = true;
  if (String(form.send_everything ?? '') === 'on') events.send_everything = true;
  if (String(form.choose_events ?? '') === 'on') {
    events.choose_events = true;
    for (const ev of ['create', 'delete', 'fork', 'push', 'issues', 'issue_comment', 'pull_request', 'release']) {
      events.events[ev] = String(form[`event_${ev}`] ?? '') === 'on';
    }
  }
  return { config: JSON.stringify(cfg), events: JSON.stringify(events) };
}

export async function WebhooksNewPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const hookType = 1; // gogs
  const { config, events } = hookPayloadConfig(form, 'gogs');
  db.db()
    .prepare(
      `INSERT INTO webhook (repo_id, org_id, url, content_type, secret, events, is_ssl, is_active, hook_task_type, meta, last_status, created_unix, updated_unix)
       VALUES (?,?,?,1,?,?,0,?,1,?,0,?,?)`
    )
    .run(
      repo.id,
      0,
      String(form.payload_url ?? ''),
      String(form.secret ?? ''),
      events,
      String(form.active ?? '') === 'on' ? 1 : 0,
      config,
      nowUnix(),
      nowUnix()
    );
  void hookType;
  c.flash.Success(c.Tr('repo.settings.add_hook_success'));
  c.Redirect(repoLink(c) + '/settings/hooks');
}

export async function WebhooksSlackNewPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const { config, events } = hookPayloadConfig(form, 'slack');
  db.db()
    .prepare(
      `INSERT INTO webhook (repo_id, org_id, url, content_type, secret, events, is_ssl, is_active, hook_task_type, meta, last_status, created_unix, updated_unix)
       VALUES (?,?,?,1,?,?,0,?,2,?,0,?,?)`
    )
    .run(
      repo.id,
      0,
      String(form.payload_url ?? ''),
      String(form.secret ?? ''),
      events,
      String(form.active ?? '') === 'on' ? 1 : 0,
      JSON.stringify({ channel: String(form.channel ?? ''), username: String(form.username ?? ''), icon_url: String(form.icon_url ?? ''), color: String(form.color ?? 'good') }),
      nowUnix(),
      nowUnix()
    );
  c.flash.Success(c.Tr('repo.settings.add_hook_success'));
  c.Redirect(repoLink(c) + '/settings/hooks');
}

export async function WebhooksDiscordNewPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const { config, events } = hookPayloadConfig(form, 'discord');
  db.db()
    .prepare(
      `INSERT INTO webhook (repo_id, org_id, url, content_type, secret, events, is_ssl, is_active, hook_task_type, meta, last_status, created_unix, updated_unix)
       VALUES (?,?,?,1,?,?,0,?,3,?,0,?,?)`
    )
    .run(repo.id, 0, String(form.payload_url ?? ''), String(form.secret ?? ''), events, String(form.active ?? '') === 'on' ? 1 : 0,
      JSON.stringify({ username: String(form.username ?? '') }), nowUnix(), nowUnix());
  void config;
  c.flash.Success(c.Tr('repo.settings.add_hook_success'));
  c.Redirect(repoLink(c) + '/settings/hooks');
}

export async function WebhooksDingtalkNewPost(c: Context): Promise<void> {
  const repo = c.Repo.Repository!;
  const form = await c.form();
  const { config, events } = hookPayloadConfig(form, 'dingtalk');
  db.db()
    .prepare(
      `INSERT INTO webhook (repo_id, org_id, url, content_type, secret, events, is_ssl, is_active, hook_task_type, meta, last_status, created_unix, updated_unix)
       VALUES (?,?,?,1,?,?,0,?,4,?,0,?,?)`
    )
    .run(repo.id, 0, String(form.payload_url ?? ''), String(form.secret ?? ''), events, String(form.active ?? '') === 'on' ? 1 : 0,
      JSON.stringify({}), nowUnix(), nowUnix());
  void config;
  c.flash.Success(c.Tr('repo.settings.add_hook_success'));
  c.Redirect(repoLink(c) + '/settings/hooks');
}

export async function WebhooksEdit(c: Context): Promise<void> {
  const hook = db.getWebhookByID(c.Repo.Repository!.id, c.ParamsInt64(':id'));
  if (!hook) {
    c.NotFound();
    return;
  }
  c.Data['PageIsSettingsHooks'] = true;
  c.Data['PageIsSettingsHooksEdit'] = true;
  c.Data['Hook'] = { ...hook, eventsObj: JSON.parse((hook as any).events ?? '{}'), configObj: JSON.parse((hook as any).meta ?? '{}') };
  c.Success('repo/settings/webhook/' + ((hook as any).hook_task_type === 2 ? 'slack' : 'gogs'));
}

export async function WebhooksEditPost(c: Context): Promise<void> {
  const hook = db.getWebhookByID(c.Repo.Repository!.id, c.ParamsInt64(':id'));
  if (!hook) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const { events } = hookPayloadConfig(form, 'gogs');
  db.db()
    .prepare('UPDATE webhook SET url = ?, secret = ?, events = ?, is_active = ?, updated_unix = ? WHERE id = ?')
    .run(String(form.payload_url ?? ''), String(form.secret ?? ''), events, String(form.active ?? '') === 'on' ? 1 : 0, nowUnix(), (hook as any).id);
  c.flash.Success(c.Tr('repo.settings.update_hook_success'));
  c.Redirect(repoLink(c) + '/settings/hooks');
}

export async function WebhooksSlackEditPost(c: Context): Promise<void> {
  const hook = db.getWebhookByID(c.Repo.Repository!.id, c.ParamsInt64(':id'));
  if (!hook) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const { events } = hookPayloadConfig(form, 'slack');
  db.db()
    .prepare('UPDATE webhook SET url = ?, secret = ?, events = ?, is_active = ?, meta = ?, updated_unix = ? WHERE id = ?')
    .run(String(form.payload_url ?? ''), String(form.secret ?? ''), events, String(form.active ?? '') === 'on' ? 1 : 0,
      JSON.stringify({ channel: String(form.channel ?? ''), username: String(form.username ?? ''), icon_url: String(form.icon_url ?? ''), color: String(form.color ?? 'good') }),
      nowUnix(), (hook as any).id);
  c.flash.Success(c.Tr('repo.settings.update_hook_success'));
  c.Redirect(repoLink(c) + '/settings/hooks');
}

export async function WebhooksDiscordEditPost(c: Context): Promise<void> {
  await WebhooksSlackEditPost(c);
}

export async function WebhooksDingtalkEditPost(c: Context): Promise<void> {
  await WebhooksEditPost(c);
}

export async function DeleteWebhook(c: Context): Promise<void> {
  const form = await c.form();
  const id = Number(form.id ?? 0);
  db.db().prepare('DELETE FROM webhook WHERE id = ? AND repo_id = ?').run(id, c.Repo.Repository!.id);
  db.db().prepare('DELETE FROM hook_task WHERE hook_id = ?').run(id);
  c.flash.Success(c.Tr('repo.settings.webhook_deletion_success'));
  c.Redirect(repoLink(c) + '/settings/hooks');
}

export async function TestWebhook(c: Context): Promise<void> {
  const hook = db.getWebhookByID(c.Repo.Repository!.id, c.ParamsInt64(':id'));
  if (!hook) {
    c.NotFound();
    return;
  }
  const { deliverWebhook } = await import('../webhook.js');
  deliverWebhook(hook, 'push', {
    ref: 'refs/heads/' + (c.Repo.Repository!.default_branch || conf.defaultBranch),
    before: '',
    after: '',
    commits: [],
    total_commits: 0,
    repository: { id: c.Repo.Repository!.id, name: c.Repo.Repository!.name, full_name: c.Repo.Repository!.FullName() },
    pusher: { id: c.User!.id, username: c.User!.name, login: c.User!.name },
    sender: { id: c.User!.id, username: c.User!.name, login: c.User!.name },
  }, c.Repo.Repository!);
  c.flash.Success(c.Tr('repo.settings.webhook.test_delivery_success'));
  c.Redirect(repoLink(c) + '/settings/hooks');
}

export async function RedeliveryWebhook(c: Context): Promise<void> {
  c.Redirect(String(c.req.headers.referer ?? repoLink(c) + '/settings/hooks'));
}
