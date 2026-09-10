// API v1 — full endpoint set mirroring internal/route/api/v1/api.go with the
// exact JSON shapes from the contract (docs/contract/api-v1.md).
import type { Router } from '../router.js';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import { Context, authenticateUserByToken } from '../context.js';
import { User, Repository } from '../db/db.js';
import * as git from '../gitx/git.js';
import { sanitizeHTML, markdown } from '../markup.js';

const DOCS_URL = 'https://github.com/gogs/docs-api';
const ITEMS_PER_PAGE = 40; // database.ItemsPerPage

// ---------------------------------------------------------------- API context

class APIContext {
  c: Context;
  user: User | null;
  isTokenAuth = false;
  isBasicAuth = false;
  repo: { Repository: Repository | null; Owner: User | null; AccessMode: number } = { Repository: null, Owner: null, AccessMode: 0 };
  org: { Organization: User | null; Team: any } = { Organization: null, Team: null };

  constructor(c: Context) {
    this.c = c;
    this.user = c.User;
    this.isTokenAuth = c.isTokenAuth;
    this.isBasicAuth = c.isBasicAuth;
  }

  UserID(): number {
    return this.user?.id ?? 0;
  }
  get IsLogged(): boolean {
    return this.user !== null;
  }

  error(message: string): void {
    this.c.JSON(500, { message, url: DOCS_URL });
  }
  errorStatus(status: number, message: string): void {
    this.c.JSON(status, { message, url: DOCS_URL });
  }
  notFound(): void {
    this.c.Status(404);
    this.c.res.end();
    this.c.rendered = true;
  }
}

// ---------------------------------------------------------------- JSON types (contract shapes)

function toUser(u: User, exposeEmail: boolean): any {
  const out: any = {
    id: u.id,
    username: u.name,
    login: u.name,
    full_name: sanitizeHTML(u.full_name ?? ''),
    email: exposeEmail ? u.email : '',
    avatar_url: u.AvatarURL(),
  };
  return out;
}

function toRepository(repo: Repository, perms: { admin: boolean; push: boolean; pull: boolean } | null): any {
  const owner = repo.owner ?? new User({ id: repo.owner_id, name: repo.lower_name, lower_name: repo.lower_name, email: '' });
  const base: any = {
    id: repo.id,
    owner: toUser(owner as User, true),
    name: repo.name,
    full_name: repo.FullName(),
    description: repo.description ?? '',
    private: !!repo.is_private,
    fork: !!repo.is_fork,
    mirror: !!repo.is_mirror,
    size: repo.size,
    html_url: repo.HTMLURL(),
    ssh_url: repoSSHURL(repo),
    clone_url: repo.CloneURL(),
    website: repo.website ?? '',
    stars_count: repo.num_stars,
    forks_count: repo.num_forks,
    watchers_count: repo.num_watches,
    open_issues_count: repo.num_issues - repo.num_closed_issues,
    default_branch: repo.default_branch,
    created_at: new Date((repo.created_unix ?? 0) * 1000).toISOString(),
    updated_at: new Date((repo.updated_unix ?? 0) * 1000).toISOString(),
  };
  if (repo.is_bare) base.empty = true;
  if (perms) base.permissions = perms;
  return base;
}

function repoSSHURL(repo: Repository): string {
  const user = conf.runUser || 'git';
  const host = conf.sshDomain === 'localhost' ? conf.domain : conf.sshDomain;
  if (conf.sshPort === 22) return `${user}@${host}:${repo.FullName()}.git`;
  return `ssh://${user}@${host}:${conf.sshPort}/${repo.FullName()}.git`;
}

function toIssue(issue: any, repo: Repository): any {
  const poster = db.getUserByID(issue.poster_id);
  const milestone = issue.milestone_id ? db.getMilestoneByID(repo.id, issue.milestone_id) : null;
  const assignee = issue.assignee_id ? db.getUserByID(issue.assignee_id) : null;
  const pr = issue.is_pull ? (db.db().prepare('SELECT * FROM pull_request WHERE issue_id = ?').get(issue.id) as any) : null;
  const labels = db.listIssueLabels(issue.id).map(toIssueLabel);
  const out: any = {
    id: issue.id,
    number: issue.index,
    user: poster ? toUser(poster, true) : null,
    title: issue.name,
    body: issue.content ?? '',
    labels,
    milestone: milestone ? toIssueMilestone(milestone) : null,
    assignee: assignee ? toUser(assignee, true) : null,
    state: issue.is_closed ? 'closed' : 'open',
    comments: issue.num_comments ?? 0,
    created_at: new Date((issue.created_unix ?? 0) * 1000).toISOString(),
    updated_at: new Date((issue.updated_unix ?? 0) * 1000).toISOString(),
  };
  if (pr) {
    out.pull_request = {
      merged: !!pr.has_merged,
      merged_at: pr.has_merged && pr.merged_unix ? new Date(pr.merged_unix * 1000).toISOString() : null,
    };
  }
  return out;
}

function toIssueLabel(l: any): any {
  return {
    id: l.id,
    name: l.name,
    color: String(l.color ?? '').replace(/^#/, ''),
    url: '',
  };
}

function toIssueMilestone(m: any): any {
  const out: any = {
    id: m.id,
    title: m.name,
    description: m.content ?? '',
    state: m.is_closed ? 'closed' : 'open',
    open_issues: m.num_issues ?? 0,
    closed_issues: m.num_closed_issues ?? 0,
    closed_at: m.closed_date_unix ? new Date(m.closed_date_unix * 1000).toISOString() : null,
    due_on: null,
  };
  if (m.deadline_unix && new Date(m.deadline_unix * 1000).getUTCFullYear() < 9999) {
    out.due_on = new Date(m.deadline_unix * 1000).toISOString();
  }
  return out;
}

function toIssueComment(cm: any, issue: any, repo: Repository): any {
  const poster = db.getUserByID(cm.poster_id);
  return {
    id: cm.id,
    html_url: `${repo.HTMLURL()}/issues/${issue.index}#issuecomment-${cm.id}`,
    user: poster ? toUser(poster, true) : null,
    body: cm.content ?? '',
    created_at: new Date((cm.created_unix ?? 0) * 1000).toISOString(),
    updated_at: new Date((cm.updated_unix ?? 0) * 1000).toISOString(),
  };
}

function toOrganization(org: User): any {
  return {
    id: org.id,
    username: org.name,
    full_name: org.full_name ?? '',
    avatar_url: org.AvatarURL(),
    description: org.description ?? '',
    website: org.website ?? '',
    location: org.location ?? '',
  };
}

function toOrganizationTeam(t: any): any {
  const modeName = ['none', 'read', 'write', 'admin', 'owner'][t.authorize] ?? 'none';
  return {
    id: t.id,
    name: t.name,
    description: t.description ?? '',
    permission: modeName,
  };
}

function toRelease(r: any, repo: Repository): any {
  const publisher = db.getUserByID(r.publisher_id);
  return {
    id: r.id,
    tag_name: r.tag_name,
    target_commitish: r.target ?? '',
    name: r.title ?? '',
    body: r.note ?? '',
    draft: !!r.is_draft,
    prerelease: !!r.is_prerelease,
    author: publisher ? toUser(publisher, true) : null,
    created_at: new Date((r.created_unix ?? 0) * 1000).toISOString(),
    ...(repo ? {} : {}),
  };
}

function commitToWebhookPayloadCommit(repoDir: string, sha: string): any {
  return {
    id: sha,
    message: '',
    url: 'Not implemented',
    author: { name: '', email: '', username: '' },
    committer: { name: '', email: '', username: '' },
    added: null,
    removed: null,
    modified: null,
    timestamp: new Date(0).toISOString(),
    ...(repoDir ? {} : {}),
  };
}

function commitToAPICommit(c: APIContext, repo: Repository, commit: git.Commit, apiPath: string): any {
  const authorUser = db.getUserByEmail(commit.author.email);
  const committerUser = db.getUserByEmail(commit.committer.email);
  return {
    url: conf.externalURL + apiPath.slice(1),
    sha: commit.id,
    html_url: `${repo.HTMLURL()}/commits/${commit.id}`,
    commit: {
      url: conf.externalURL + apiPath.slice(1),
      author: {
        name: commit.author.name,
        email: commit.author.email,
        date: commit.author.when.toISOString(),
      },
      committer: {
        name: commit.committer.name,
        email: commit.committer.email,
        date: commit.committer.when.toISOString(),
      },
      message: commit.Summary(),
      tree: {
        url: conf.externalURL + apiPath.slice(1),
        sha: commit.id,
      },
    },
    author: authorUser ? toUser(authorUser, true) : null,
    committer: committerUser ? toUser(committerUser, true) : null,
    parents: commit.parents.map((p) => ({ url: conf.externalURL + apiPath.slice(1), sha: p })),
  };
}

// ---------------------------------------------------------------- middleware

async function apiContext(c: Context): Promise<APIContext> {
  // token auth (API paths)
  const authHead = String(c.req.headers.authorization ?? '');
  const parts = authHead.split(' ');
  if (parts.length === 2 && parts[0] === 'token') {
    const u = authenticateUserByToken(parts[1]);
    if (u) {
      c.User = u;
      c.isTokenAuth = true;
    }
  } else if (parts.length === 2 && parts[0] === 'Basic') {
    const { authenticateUserByBasic } = await import('../context.js');
    const r = authenticateUserByBasic(authHead);
    if (r) {
      c.User = r.user;
      c.isBasicAuth = true;
    }
  }
  c.Data['IsLogged'] = c.IsLogged;
  return new APIContext(c);
}

function reqToken(ctx: APIContext): boolean {
  if (!ctx.isTokenAuth) {
    ctx.c.Status(401);
    ctx.c.res.end();
    ctx.c.rendered = true;
    return false;
  }
  return true;
}

function reqBasicAuth(ctx: APIContext): boolean {
  if (!ctx.isBasicAuth) {
    ctx.c.Status(401);
    ctx.c.res.end();
    ctx.c.rendered = true;
    return false;
  }
  return true;
}

function reqAdmin(ctx: APIContext): boolean {
  if (!ctx.IsLogged || ctx.user!.is_admin !== 1) {
    ctx.c.Status(403);
    ctx.c.res.end();
    ctx.c.rendered = true;
    return false;
  }
  return true;
}

async function repoAssignment(ctx: APIContext, username: string, reponame: string): Promise<boolean> {
  let owner: User;
  if (ctx.IsLogged && ctx.user!.lower_name === username.toLowerCase()) {
    owner = ctx.user!;
  } else {
    const found = db.getUserByUsername(username);
    if (!found) {
      ctx.notFound();
      return false;
    }
    owner = found;
  }
  const repo = db.getRepoByOwnerAndName(owner, reponame);
  if (!repo) {
    ctx.notFound();
    return false;
  }
  ctx.repo.Owner = owner;
  ctx.repo.Repository = repo;
  if (ctx.isTokenAuth && ctx.user?.is_admin === 1) {
    ctx.repo.AccessMode = db.AccessMode.OWNER;
  } else {
    ctx.repo.AccessMode = db.accessMode(ctx.UserID(), repo);
  }
  if (ctx.repo.AccessMode < db.AccessMode.READ) {
    ctx.notFound();
    return false;
  }
  return true;
}

function setLinkHeader(c: Context, total: number, pageSize: number): void {
  const page = Math.max(1, c.QueryInt('page') || 1);
  const last = Math.max(1, Math.ceil(total / pageSize));
  const base = conf.externalURL.replace(/\/$/, '') + c.Path();
  const links: string[] = [];
  if (page < last) links.push(`<${base}?page=${page + 1}>; rel="next"`, `<${base}?page=${last}>; rel="last"`);
  if (page > 1) links.push(`<${base}?page=1>; rel="first"`, `<${base}?page=${page - 1}>; rel="prev"`);
  if (links.length) c.SetHeader('Link', links.join(', '));
}

// ---------------------------------------------------------------- registration

export function registerAPIRoutes(m: Router): void {
  // wrap every handler through the API contexter
  const wrap = (fn: (ctx: APIContext) => Promise<void> | void) => async (c: Context) => {
    const ctx = await apiContext(c);
    await fn(ctx);
  };

  m.options('/api/v1/*', () => {});

  // Miscellaneous
  m.post('/api/v1/markdown', wrap(async (ctx: APIContext) => {
    const body = await ctx.c.form();
    const text = String((body as any).Text ?? (body as any).text ?? '');
    if (!text) {
      ctx.c.PlainText(200, '');
      return;
    }
    const context = String((body as any).Context ?? (body as any).context ?? '');
    ctx.c.PlainText(200, markdown(text, context, {}));
  }));
  m.post('/api/v1/markdown/raw', wrap(async (ctx: APIContext) => {
    const raw = (await ctx.c.body()).toString('utf8');
    ctx.c.PlainText(200, markdown(raw, conf.subpath + '/', {}));
  }));

  // Users
  m.get('/api/v1/users/search', wrap(async (ctx: APIContext) => {
    const q = ctx.c.Query('q');
    const limit = Math.max(1, ctx.c.QueryInt('limit') || 10);
    const rows = db.db().prepare('SELECT * FROM user WHERE type = 0 AND (lower_name LIKE ? OR lower(full_name) LIKE ?) ORDER BY id LIMIT ?').all(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`, limit) as any[];
    ctx.c.JSONSuccess({ ok: true, data: rows.map((r) => toUser(new User(r), ctx.IsLogged)) });
  }));

  m.get('/api/v1/users/:username', wrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(toUser(u, ctx.IsLogged));
  }));

  m.get('/api/v1/users/:username/tokens', wrap(async (ctx: APIContext) => {
    if (!reqBasicAuth(ctx)) return;
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u || (ctx.user!.id !== u.id && ctx.user!.is_admin !== 1)) {
      ctx.notFound();
      return;
    }
    const tokens = db.listAccessTokens(u.id);
    ctx.c.JSONSuccess(tokens.map((t: any) => ({ name: t.name, sha1: t.sha1 })));
  }));

  m.post('/api/v1/users/:username/tokens', wrap(async (ctx: APIContext) => {
    if (!reqBasicAuth(ctx)) return;
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u || (ctx.user!.id !== u.id && ctx.user!.is_admin !== 1)) {
      ctx.notFound();
      return;
    }
    const body = await ctx.c.form();
    const name = String((body as any).name ?? '').trim();
    if (!name) {
      ctx.c.JSON(422, [{ fieldNames: ['name'], classification: 'RequiredError', message: 'Required' }]);
      return;
    }
    const exists = db.db().prepare('SELECT 1 FROM access_token WHERE uid = ? AND name = ?').get(u.id, name);
    if (exists) {
      ctx.errorStatus(422, `access token name has been used: ${name}`);
      return;
    }
    const { newTokenSHA1, sha256 } = await import('../authx/password.js');
    const sha1 = newTokenSHA1();
    const now = Math.floor(Date.now() / 1000);
    db.db().prepare('INSERT INTO access_token (uid, name, sha1, sha256, created_unix, updated_unix) VALUES (?,?,?,?,?,?)').run(u.id, name, sha1, sha256(sha1), now, now);
    ctx.c.JSON(201, { name, sha1 });
  }));

  const reqTokenWrap = (fn: (ctx: APIContext) => Promise<void> | void) =>
    wrap(async (ctx: APIContext) => {
      if (!reqToken(ctx)) return;
      await fn(ctx);
    });

  m.get('/api/v1/users/:username/keys', reqTokenWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    const keys = db.listPublicKeys(u.id);
    ctx.c.JSONSuccess(
      keys.map((k: any) => ({
        id: k.id,
        key: k.content,
        url: `${conf.externalURL}api/v1/user/keys/${k.id}`,
        title: k.name,
        created_at: new Date((k.created_unix ?? 0) * 1000).toISOString(),
      }))
    );
  }));

  m.get('/api/v1/users/:username/followers', reqTokenWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    const page = Math.max(1, ctx.c.QueryInt('page') || 1);
    ctx.c.JSONSuccess(db.listFollowers(u.id, page, ITEMS_PER_PAGE).map((x) => toUser(x, true)));
  }));

  m.get('/api/v1/users/:username/following', reqTokenWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    const page = Math.max(1, ctx.c.QueryInt('page') || 1);
    ctx.c.JSONSuccess(db.listFollowing(u.id, page, ITEMS_PER_PAGE).map((x) => toUser(x, true)));
  }));

  m.get('/api/v1/users/:username/following/:target', reqTokenWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    const target = db.getUserByUsername(ctx.c.Params(':target'));
    if (!u || !target) {
      ctx.notFound();
      return;
    }
    if (db.isFollowing(u.id, target.id)) {
      ctx.c.NoContent();
    } else {
      ctx.notFound();
    }
  }));

  // ----- /user (authenticated) -----
  m.get('/api/v1/user', reqTokenWrap(async (ctx: APIContext) => {
    ctx.c.JSONSuccess(toUser(ctx.user!, true));
  }));

  m.get('/api/v1/user/emails', reqTokenWrap(async (ctx: APIContext) => {
    const emails = db.listEmailAddresses(ctx.UserID());
    ctx.c.JSONSuccess(
      emails.map((e: any) => ({
        email: e.email,
        verified: !!e.is_activated,
        primary: e.email === ctx.user!.email,
      }))
    );
  }));

  m.post('/api/v1/user/emails', reqTokenWrap(async (ctx: APIContext) => {
    const body = (await ctx.c.form()) as any;
    const emails: string[] = Array.isArray(body.emails) ? body.emails : [];
    if (!emails.length) {
      ctx.c.Status(422);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const created: any[] = [];
    for (const emailRaw of emails) {
      const email = String(emailRaw).toLowerCase().trim();
      if (db.getUserByEmail(email) || db.getEmailAddress(email)) {
        ctx.errorStatus(422, `email address has been used: ${email}`);
        return;
      }
      db.db().prepare('INSERT INTO email_address (uid, email, is_activated) VALUES (?,?,?)').run(ctx.UserID(), email, conf.requireEmailConfirmation ? 0 : 1);
      created.push({ email, verified: !conf.requireEmailConfirmation, primary: false });
    }
    ctx.c.JSON(201, created);
  }));

  m.delete('/api/v1/user/emails', reqTokenWrap(async (ctx: APIContext) => {
    const body = (await ctx.c.form()) as any;
    const emails: string[] = Array.isArray(body.emails) ? body.emails : [];
    for (const emailRaw of emails) {
      const email = String(emailRaw).toLowerCase().trim();
      if (email === ctx.user!.email) {
        ctx.errorStatus(400, `cannot delete primary email "${email}"`);
        return;
      }
      const row = db.getEmailAddress(email);
      if (row && (row as any).uid === ctx.UserID()) {
        db.db().prepare('DELETE FROM email_address WHERE id = ?').run((row as any).id);
      }
    }
    ctx.c.NoContent();
  }));

  m.get('/api/v1/user/followers', reqTokenWrap(async (ctx: APIContext) => {
    const page = Math.max(1, ctx.c.QueryInt('page') || 1);
    ctx.c.JSONSuccess(db.listFollowers(ctx.UserID(), page, ITEMS_PER_PAGE).map((x) => toUser(x, true)));
  }));
  m.get('/api/v1/user/following', reqTokenWrap(async (ctx: APIContext) => {
    const page = Math.max(1, ctx.c.QueryInt('page') || 1);
    ctx.c.JSONSuccess(db.listFollowing(ctx.UserID(), page, ITEMS_PER_PAGE).map((x) => toUser(x, true)));
  }));
  m.get('/api/v1/user/following/:username', reqTokenWrap(async (ctx: APIContext) => {
    const target = db.getUserByUsername(ctx.c.Params(':username'));
    if (target && db.isFollowing(ctx.UserID(), target.id)) {
      ctx.c.NoContent();
    } else {
      ctx.notFound();
    }
  }));
  m.put('/api/v1/user/following/:username', reqTokenWrap(async (ctx: APIContext) => {
    const target = db.getUserByUsername(ctx.c.Params(':username'));
    if (!target) {
      ctx.errorStatus(422, `user does not exist [name: ${ctx.c.Params(':username')}]`);
      return;
    }
    db.followUser(ctx.UserID(), target.id);
    ctx.c.NoContent();
  }));
  m.delete('/api/v1/user/following/:username', reqTokenWrap(async (ctx: APIContext) => {
    const target = db.getUserByUsername(ctx.c.Params(':username'));
    if (target) db.unfollowUser(ctx.UserID(), target.id);
    ctx.c.NoContent();
  }));

  m.get('/api/v1/user/keys', reqTokenWrap(async (ctx: APIContext) => {
    const keys = db.listPublicKeys(ctx.UserID());
    ctx.c.JSONSuccess(
      keys.map((k: any) => ({
        id: k.id,
        key: k.content,
        url: `${conf.externalURL}api/v1/user/keys/${k.id}`,
        title: k.name,
        created_at: new Date((k.created_unix ?? 0) * 1000).toISOString(),
      }))
    );
  }));

  m.post('/api/v1/user/keys', reqTokenWrap(async (ctx: APIContext) => {
    await createPublicKeyHandler(ctx, ctx.UserID());
  }));

  m.get('/api/v1/user/keys/:id', reqTokenWrap(async (ctx: APIContext) => {
    const key = db.getPublicKeyByID(ctx.c.ParamsInt64(':id'));
    if (!key || (key as any).owner_id !== ctx.UserID()) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess({
      id: (key as any).id,
      key: (key as any).content,
      url: `${conf.externalURL}api/v1/user/keys/${(key as any).id}`,
      title: (key as any).name,
      created_at: new Date(((key as any).created_unix ?? 0) * 1000).toISOString(),
    });
  }));

  m.delete('/api/v1/user/keys/:id', reqTokenWrap(async (ctx: APIContext) => {
    const key = db.getPublicKeyByID(ctx.c.ParamsInt64(':id'));
    if (!key || (key as any).owner_id !== ctx.UserID()) {
      ctx.c.JSON(403, { message: 'You do not have access to this key.', url: DOCS_URL });
      return;
    }
    db.db().prepare('DELETE FROM public_key WHERE id = ?').run((key as any).id);
    const { writeAuthorizedKeys } = await import('../routes/sshkey.js');
    writeAuthorizedKeys();
    ctx.c.NoContent();
  }));

  m.get('/api/v1/user/issues', reqTokenWrap(async (ctx: APIContext) => listUserIssues(ctx)));
  m.get('/api/v1/issues', reqTokenWrap(async (ctx: APIContext) => listUserIssues(ctx)));

  // ----- repos -----
  const listReposOfUser = reqTokenWrap(async (ctx: APIContext) => {
    const username = ctx.c.Params(':username') || ctx.c.Params(':org') || '';
    const target = username ? db.getUserByUsername(username) : ctx.user!;
    if (!target) {
      ctx.notFound();
      return;
    }
    if (target.type === 1) {
      const viewerMode = db.isOrgMember(ctx.UserID(), target.id) ? db.AccessMode.READ : db.AccessMode.NONE;
      const repos = db.listReposByOwner(target.id).filter((r) => !r.is_private || viewerMode >= db.AccessMode.READ);
      ctx.c.JSONSuccess(repos.map((r) => toRepository(r, { admin: true, push: true, pull: true })));
      return;
    }
    if (target.id === ctx.UserID()) {
      const own = db.listReposByOwner(target.id);
      const collabRows = db.db().prepare('SELECT r.* FROM repository r JOIN collaboration col ON col.repo_id = r.id WHERE col.user_id = ?').all(ctx.UserID()) as any[];
      const out = own.map((r) => toRepository(r, { admin: true, push: true, pull: true }));
      for (const row of collabRows) {
        const r = new Repository(row);
        r.owner = db.getUserByID(r.owner_id) ?? undefined;
        const mode = db.accessMode(ctx.UserID(), r);
        out.push(toRepository(r, { admin: mode >= db.AccessMode.ADMIN, push: mode >= db.AccessMode.WRITE, pull: mode >= db.AccessMode.READ }));
      }
      ctx.c.JSONSuccess(out);
      return;
    }
    const repos = db.listReposByOwner(target.id).filter((r) => !r.is_private);
    ctx.c.JSONSuccess(repos.map((r) => toRepository(r, { admin: false, push: false, pull: true })));
  });
  m.get('/api/v1/users/:username/repos', listReposOfUser);
  m.get('/api/v1/orgs/:org/repos', listReposOfUser);
  m.get('/api/v1/user/repos', listReposOfUser);

  m.post('/api/v1/user/repos', reqTokenWrap(async (ctx: APIContext) => createRepoHandler(ctx, ctx.user!)));
  m.post('/api/v1/org/:org/repos', reqTokenWrap(async (ctx: APIContext) => {
    const org = db.getUserByUsername(ctx.c.Params(':org'));
    if (!org || org.type !== 1) {
      ctx.notFound();
      return;
    }
    if (!db.isOrgOwner(ctx.UserID(), org.id)) {
      ctx.errorStatus(403, 'Given user is not owner of organization.');
      return;
    }
    await createRepoHandler(ctx, org);
  }));

  m.get('/api/v1/repos/search', wrap(async (ctx: APIContext) => {
    const qRaw = ctx.c.Query('q');
    const q = qRaw.split('/').pop() ?? '';
    const uid = ctx.c.QueryInt('uid');
    const limitRaw = ctx.c.QueryInt('limit');
    const limit = limitRaw <= 0 ? 10 : Math.min(limitRaw, conf.maxResponseItems);
    const page = Math.max(1, ctx.c.QueryInt('page') || 1);
    const { total, repos } = db.listVisibleRepos(ctx.UserID(), q, page, limit, uid);
    setLinkHeader(ctx.c, total, limit);
    ctx.c.JSONSuccess({ ok: true, data: repos.map((r) => toRepository(r, null)) });
  }));

  const repoGroup = (fn: (ctx: APIContext) => Promise<void> | void) =>
    reqTokenWrap(async (ctx: APIContext) => {
      const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
      if (!ok) return;
      await fn(ctx);
    });

  const repoGroupNoToken = (fn: (ctx: APIContext) => Promise<void> | void) =>
    wrap(async (ctx: APIContext) => {
      const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
      if (!ok) return;
      await fn(ctx);
    });

  m.post('/api/v1/repos/migrate', reqTokenWrap(async (ctx: APIContext) => {
    ctx.errorStatus(422, 'Migration is not supported by this build.');
  }));

  m.delete('/api/v1/repos/:username/:reponame', repoGroup(async (ctx: APIContext) => {
    if (ctx.repo.AccessMode < db.AccessMode.OWNER) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const repo = ctx.repo.Repository!;
    const fs = await import('node:fs');
    fs.rmSync(repo.RepoPath(), { recursive: true, force: true });
    fs.rmSync(repo.WikiPath(), { recursive: true, force: true });
    db.db().prepare('DELETE FROM repository WHERE id = ?').run(repo.id);
    db.db().prepare('UPDATE user SET num_repos = MAX(num_repos - 1, 0) WHERE id = ?').run(repo.owner_id);
    ctx.c.NoContent();
  }));

  m.get('/api/v1/repos/:username/:reponame', repoGroupNoToken(async (ctx: APIContext) => {
    ctx.c.JSONSuccess(
      toRepository(ctx.repo.Repository!, {
        admin: ctx.repo.AccessMode >= db.AccessMode.ADMIN,
        push: ctx.repo.AccessMode >= db.AccessMode.WRITE,
        pull: true,
      })
    );
  }));

  m.get('/api/v1/repos/:username/:reponame/releases', repoGroupNoToken(async (ctx: APIContext) => {
    const releases = db.listReleases(ctx.repo.Repository!.id);
    ctx.c.JSONSuccess(releases.map((r) => toRelease(r, ctx.repo.Repository!)));
  }));

  registerRepoSubRoutes(m, wrap, reqTokenWrap, repoGroup, repoGroupNoToken);

  // ----- orgs -----
  m.get('/api/v1/user/orgs', reqTokenWrap(async (ctx: APIContext) => {
    const orgs = db.listUserOrgs(ctx.UserID(), true);
    ctx.c.JSONSuccess(orgs.map(toOrganization));
  }));
  m.post('/api/v1/user/orgs', reqTokenWrap(async (ctx: APIContext) => {
    const body = (await ctx.c.form()) as any;
    const username = String(body.username ?? '').trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(username) || username.length > 35) {
      ctx.c.JSON(422, [{ fieldNames: ['username'], classification: 'AlphaDashDotError', message: 'Must be valid alpha or numeric or dash(-) and dot(-) characters.' }]);
      return;
    }
    try {
      const org = db.createOrganization(ctx.user!, username, {
        fullName: String(body.full_name ?? ''),
        description: String(body.description ?? ''),
        website: String(body.website ?? ''),
        location: String(body.location ?? ''),
      });
      ctx.c.JSON(201, toOrganization(org));
    } catch (e: any) {
      ctx.errorStatus(422, String(e.message ?? e));
    }
  }));
  m.get('/api/v1/users/:username/orgs', wrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    const orgs = db.listUserOrgs(u.id, false);
    ctx.c.JSONSuccess(orgs.map(toOrganization));
  }));
  m.get('/api/v1/orgs/:orgname', reqTokenWrap(async (ctx: APIContext) => {
    const org = db.getUserByUsername(ctx.c.Params(':orgname'));
    if (!org || org.type !== 1) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(toOrganization(org));
  }));
  m.patch('/api/v1/orgs/:orgname', reqTokenWrap(async (ctx: APIContext) => {
    const org = db.getUserByUsername(ctx.c.Params(':orgname'));
    if (!org || org.type !== 1) {
      ctx.notFound();
      return;
    }
    if (!db.isOrgOwner(ctx.UserID(), org.id)) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const body = (await ctx.c.form()) as any;
    db.updateUserColumns(org.id, {
      full_name: String(body.full_name ?? ''),
      description: String(body.description ?? ''),
      website: String(body.website ?? ''),
      location: String(body.location ?? ''),
    });
    ctx.c.JSONSuccess(toOrganization(db.getUserByID(org.id)!));
  }));
  m.get('/api/v1/orgs/:orgname/teams', reqTokenWrap(async (ctx: APIContext) => {
    const org = db.getUserByUsername(ctx.c.Params(':orgname'));
    if (!org || org.type !== 1) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(db.listTeamsByOrg(org.id).map(toOrganizationTeam));
  }));

  // ----- admin -----
  // upstream: m.Group("/admin", ..., reqAdmin()) — any auth (basic/token), admin flag required
  const adminWrap = (fn: (ctx: APIContext) => Promise<void> | void) =>
    wrap(async (ctx: APIContext) => {
      if (!reqAdmin(ctx)) return;
      await fn(ctx);
    });

  adminWrapRegister(m, adminWrap, createRepoHandler);

  m.any('/api/v1/*', (c: Context) => {
    c.Status(404);
    c.res.end();
    c.rendered = true;
  });
}

async function listUserIssues(ctx: APIContext): Promise<void> {
  const page = Math.max(1, ctx.c.QueryInt('page') || 1);
  const state = ctx.c.Query('state') === 'closed' ? 1 : 0;
  const size = conf.issuePagingNum;
  const total = (db.db().prepare('SELECT COUNT(*) AS c FROM issue WHERE assignee_id = ? AND is_closed = ?').get(ctx.UserID(), state) as any).c;
  const rows = db.db().prepare('SELECT * FROM issue WHERE assignee_id = ? AND is_closed = ? ORDER BY updated_unix DESC LIMIT ? OFFSET ?').all(ctx.UserID(), state, size, (page - 1) * size) as any[];
  setLinkHeader(ctx.c, total, size);
  const out = [];
  for (const issue of rows) {
    const repo = db.getRepoByID(issue.repo_id);
    if (repo) out.push(toIssue(issue, repo));
  }
  ctx.c.JSONSuccess(out);
}

async function createRepoHandler(ctx: APIContext, owner: User): Promise<void> {
  if (owner.type === 1 && !db.isOrgOwner(ctx.user!.id, owner.id)) {
    ctx.errorStatus(422, 'Not allowed to create repository for organization.');
    return;
  }
  const body = (await ctx.c.form()) as any;
  const name = String(body.name ?? '').trim();
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name) || name.length > 100) {
    ctx.c.JSON(422, [{ fieldNames: ['name'], classification: 'RequiredError', message: 'Required' }]);
    return;
  }
  if (db.getRepoByName(owner.name, name)) {
    ctx.errorStatus(422, 'The repository with the same name already exists.');
    return;
  }
  const { createRepositoryRecord } = await import('../routes/repo.js');
  const repo = await createRepositoryRecord(ctx.user!, owner, {
    name,
    description: String(body.description ?? ''),
    private: conf.forcePrivate || !!body.private,
    autoInit: !!body.auto_init,
    gitignores: String(body.gitignores ?? ''),
    license: String(body.license ?? ''),
    readme: String(body.readme ?? ''),
  });
  ctx.c.JSON(201, toRepository(repo, { admin: true, push: true, pull: true }));
}

async function createPublicKeyHandler(ctx: APIContext, ownerID: number): Promise<void> {
  const body = (await ctx.c.form()) as any;
  const title = String(body.title ?? '').trim();
  const key = String(body.key ?? '').trim();
  if (!title || !key) {
    ctx.c.JSON(422, [{ fieldNames: [!title ? 'title' : 'key'], classification: 'RequiredError', message: 'Required' }]);
    return;
  }
  const { fingerprintKey } = await import('../routes/sshkey.js');
  const clean = key.replaceAll('\n', '').replaceAll('\r', '');
  const fingerprint = fingerprintKey(clean);
  if (db.db().prepare('SELECT 1 FROM public_key WHERE fingerprint = ?').get(fingerprint)) {
    ctx.errorStatus(422, 'Key content has been used as non-deploy key');
    return;
  }
  if (db.db().prepare('SELECT 1 FROM public_key WHERE owner_id = ? AND name = ?').get(ownerID, title)) {
    ctx.errorStatus(422, 'Key title has been used');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const info = db.db()
    .prepare('INSERT INTO public_key (owner_id, name, fingerprint, content, mode, type, created_unix, updated_unix) VALUES (?,?,?,?,2,1,?,?)')
    .run(ownerID, title, fingerprint, clean, now, now);
  const { writeAuthorizedKeys } = await import('../routes/sshkey.js');
  writeAuthorizedKeys();
  ctx.c.JSON(201, {
    id: Number(info.lastInsertRowid),
    key: clean,
    url: `${conf.externalURL}api/v1/user/keys/${Number(info.lastInsertRowid)}`,
    title,
    created_at: new Date(now * 1000).toISOString(),
  });
}

function adminWrapRegister(m: Router, adminWrap: any, createRepoHandler: any): void {
  m.post('/api/v1/admin/users', adminWrap(async (ctx: APIContext) => {
    const body = (await ctx.c.form()) as any;
    const username = String(body.username ?? '').trim();
    const email = String(body.email ?? '').trim();
    if (!username || !email) {
      ctx.c.JSON(422, [{ fieldNames: [!username ? 'username' : 'email'], classification: 'RequiredError', message: 'Required' }]);
      return;
    }
    try {
      const u = db.createUser(username, email, {
        fullName: String(body.full_name ?? ''),
        password: String(body.password ?? ''),
        activated: true,
      });
      ctx.c.JSON(201, toUser(u, true));
    } catch (e: any) {
      ctx.errorStatus(422, String(e.message ?? e));
    }
  }));

  m.patch('/api/v1/admin/users/:username', adminWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    const body = (await ctx.c.form()) as any;
    const cols: Record<string, any> = {
      full_name: String(body.full_name ?? u.full_name),
      location: String(body.location ?? u.location),
      website: String(body.website ?? u.website),
    };
    if (body.active !== undefined) cols['is_active'] = body.active ? 1 : 0;
    if (body.admin !== undefined) cols['is_admin'] = body.admin ? 1 : 0;
    if (body.password) {
      const { encodePassword, randomSalt } = await import('../authx/password.js');
      const salt = randomSalt();
      cols['passwd'] = encodePassword(String(body.password), salt);
      cols['salt'] = salt;
    }
    db.updateUserColumns(u.id, cols);
    ctx.c.JSONSuccess(toUser(db.getUserByID(u.id)!, true));
  }));

  m.delete('/api/v1/admin/users/:username', adminWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    if (db.countUserRepos(u.id) > 0) {
      ctx.errorStatus(422, 'user still has repository ownership');
      return;
    }
    const orgOwner = db.db().prepare('SELECT COUNT(*) AS c FROM org_user WHERE uid = ? AND is_owner = 1').get(u.id) as any;
    if (orgOwner.c > 0) {
      ctx.errorStatus(422, 'user still is an organization owner');
      return;
    }
    for (const sql of ['DELETE FROM user WHERE id = ?', 'DELETE FROM email_address WHERE uid = ?', 'DELETE FROM org_user WHERE uid = ?', 'DELETE FROM team_user WHERE uid = ?', 'DELETE FROM access_token WHERE uid = ?']) {
      db.db().prepare(sql).run(u.id);
    }
    ctx.c.NoContent();
  }));

  m.post('/api/v1/admin/users/:username/keys', adminWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    await createPublicKeyHandler(ctx, u.id);
  }));

  m.post('/api/v1/admin/users/:username/orgs', adminWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    const body = (await ctx.c.form()) as any;
    const username = String(body.username ?? '').trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      ctx.c.JSON(422, [{ fieldNames: ['username'], classification: 'AlphaDashDotError', message: 'Must be valid alpha or numeric or dash(-) and dot(-) characters.' }]);
      return;
    }
    try {
      const org = db.createOrganization(u, username, {
        fullName: String(body.full_name ?? ''),
        description: String(body.description ?? ''),
        website: String(body.website ?? ''),
        location: String(body.location ?? ''),
      });
      ctx.c.JSON(201, toOrganization(org));
    } catch (e: any) {
      ctx.errorStatus(422, String(e.message ?? e));
    }
  }));

  m.post('/api/v1/admin/users/:username/repos', adminWrap(async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!u) {
      ctx.notFound();
      return;
    }
    await createRepoHandler(ctx, u);
  }));

  m.post('/api/v1/admin/orgs/:orgname/teams', adminWrap(async (ctx: APIContext) => {
    const org = db.getUserByUsername(ctx.c.Params(':orgname'));
    if (!org || org.type !== 1) {
      ctx.notFound();
      return;
    }
    const body = (await ctx.c.form()) as any;
    const name = String(body.name ?? '').trim();
    if (!name) {
      ctx.c.JSON(422, [{ fieldNames: ['name'], classification: 'RequiredError', message: 'Required' }]);
      return;
    }
    if (db.getTeamByName(org.id, name)) {
      ctx.errorStatus(422, 'team already exists');
      return;
    }
    const permission = String(body.permission ?? 'read');
    const authorize = permission === 'admin' ? 3 : permission === 'write' ? 2 : 1;
    const info = db.db().prepare('INSERT INTO team (org_id, lower_name, name, description, authorize, num_repos, num_members) VALUES (?,?,?,?,?,0,0)').run(org.id, name.toLowerCase(), name, String(body.description ?? ''), authorize);
    ctx.c.JSON(201, toOrganizationTeam(db.getTeamByID(Number(info.lastInsertRowid))));
  }));

  m.get('/api/v1/admin/teams/:teamid/members', adminWrap(async (ctx: APIContext) => {
    const team = db.getTeamByID(ctx.c.ParamsInt64(':teamid'));
    if (!team) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(db.listTeamMembers((team as any).id).map((u) => toUser(u, true)));
  }));

  m.put('/api/v1/admin/teams/:teamid/members/:username', adminWrap(async (ctx: APIContext) => {
    const team = db.getTeamByID(ctx.c.ParamsInt64(':teamid'));
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!team || !u) {
      ctx.notFound();
      return;
    }
    if (!db.db().prepare('SELECT 1 FROM team_user WHERE team_id = ? AND uid = ?').get((team as any).id, u.id)) {
      db.db().prepare('INSERT INTO team_user (org_id, team_id, uid) VALUES (?,?,?)').run((team as any).org_id, (team as any).id, u.id);
      db.db().prepare('UPDATE team SET num_members = num_members + 1 WHERE id = ?').run((team as any).id);
    }
    ctx.c.NoContent();
  }));

  m.delete('/api/v1/admin/teams/:teamid/members/:username', adminWrap(async (ctx: APIContext) => {
    const team = db.getTeamByID(ctx.c.ParamsInt64(':teamid'));
    const u = db.getUserByUsername(ctx.c.Params(':username'));
    if (!team || !u) {
      ctx.notFound();
      return;
    }
    db.db().prepare('DELETE FROM team_user WHERE team_id = ? AND uid = ?').run((team as any).id, u.id);
    db.db().prepare('UPDATE team SET num_members = MAX(num_members - 1, 0) WHERE id = ?').run((team as any).id);
    ctx.c.NoContent();
  }));

  m.put('/api/v1/admin/teams/:teamid/repos/:reponame', adminWrap(async (ctx: APIContext) => {
    const team = db.getTeamByID(ctx.c.ParamsInt64(':teamid'));
    if (!team) {
      ctx.notFound();
      return;
    }
    const org = db.getUserByID((team as any).org_id);
    const repo = org ? db.getRepoByOwnerAndName(org, ctx.c.Params(':reponame')) : null;
    if (!repo) {
      ctx.notFound();
      return;
    }
    if (!db.db().prepare('SELECT 1 FROM team_repo WHERE team_id = ? AND repo_id = ?').get((team as any).id, repo.id)) {
      db.db().prepare('INSERT INTO team_repo (org_id, team_id, repo_id) VALUES (?,?,?)').run((team as any).org_id, (team as any).id, repo.id);
      db.db().prepare('UPDATE team SET num_repos = num_repos + 1 WHERE id = ?').run((team as any).id);
    }
    ctx.c.NoContent();
  }));

  m.delete('/api/v1/admin/teams/:teamid/repos/:reponame', adminWrap(async (ctx: APIContext) => {
    const team = db.getTeamByID(ctx.c.ParamsInt64(':teamid'));
    if (!team) {
      ctx.notFound();
      return;
    }
    const org = db.getUserByID((team as any).org_id);
    const repo = org ? db.getRepoByOwnerAndName(org, ctx.c.Params(':reponame')) : null;
    if (!repo) {
      ctx.notFound();
      return;
    }
    db.db().prepare('DELETE FROM team_repo WHERE team_id = ? AND repo_id = ?').run((team as any).id, repo.id);
    db.db().prepare('UPDATE team SET num_repos = MAX(num_repos - 1, 0) WHERE id = ?').run((team as any).id);
    ctx.c.NoContent();
  }));
}

function registerRepoSubRoutes(
  m: Router,
  _wrap: any,
  reqTokenWrap: any,
  repoGroup: any,
  repoGroupNoToken: any
): void {
  // hooks
  m.get('/api/v1/repos/:username/:reponame/hooks', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const hooks = db.listWebhooks(ctx.repo.Repository!.id);
    ctx.c.JSONSuccess(hooks.map(toRepositoryHook));
  }));
  m.get('/api/v1/repos/:username/:reponame/hooks/:id', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const hook = db.db().prepare('SELECT * FROM webhook WHERE id = ? AND repo_id = ?').get(ctx.c.ParamsInt64(':id'), ctx.repo.Repository!.id) as any;
    if (!hook) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(toRepositoryHook(hook));
  }));
  m.post('/api/v1/repos/:username/:reponame/hooks', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const body = (await ctx.c.form()) as any;
    const type = String(body.type ?? 'gogs');
    if (!['gogs', 'slack', 'discord', 'dingtalk'].includes(type)) {
      ctx.errorStatus(422, 'Invalid hook type.');
      return;
    }
    const cfg = body.config ?? {};
    if (!cfg.url) {
      ctx.errorStatus(422, 'Missing config option: url');
      return;
    }
    if (!cfg.content_type) {
      ctx.errorStatus(422, 'Missing config option: content_type');
      return;
    }
    if (!['json', 'form'].includes(String(cfg.content_type))) {
      ctx.errorStatus(422, 'Invalid content type.');
      return;
    }
    const events: string[] = Array.isArray(body.events) && body.events.length ? body.events : ['push'];
    const eventsObj: any = { push_only: false, send_everything: false, choose_events: true, events: {} };
    for (const ev of ['create', 'delete', 'fork', 'push', 'issues', 'issue_comment', 'pull_request', 'release']) {
      eventsObj.events[ev] = events.includes(ev);
    }
    const now = Math.floor(Date.now() / 1000);
    const hookTaskType = { gogs: 1, slack: 2, discord: 3, dingtalk: 4 }[type] ?? 1;
    const meta = type === 'slack' ? JSON.stringify({ channel: cfg.channel ?? '', username: cfg.username ?? '', icon_url: cfg.icon_url ?? '', color: cfg.color ?? '' }) : '{}';
    if (type === 'slack' && !cfg.channel) {
      ctx.errorStatus(422, 'Missing config option: channel');
      return;
    }
    const info = db.db()
      .prepare('INSERT INTO webhook (repo_id, org_id, url, content_type, secret, events, is_ssl, is_active, hook_task_type, meta, last_status, created_unix, updated_unix) VALUES (?,0,?,?,?,?,0,?,?,?,?,?,?)')
      .run(
        ctx.repo.Repository!.id,
        String(cfg.url),
        cfg.content_type === 'form' ? 2 : 1,
        String(cfg.secret ?? ''),
        JSON.stringify(eventsObj),
        body.active === false ? 0 : 1,
        hookTaskType,
        meta,
        0,
        now,
        now
      );
    const hook = db.getWebhookByID(ctx.repo.Repository!.id, Number(info.lastInsertRowid));
    ctx.c.JSON(201, toRepositoryHook(hook));
  }));
  m.patch('/api/v1/repos/:username/:reponame/hooks/:id', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const hook = db.getWebhookByID(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id'));
    if (!hook) {
      ctx.notFound();
      return;
    }
    const body = (await ctx.c.form()) as any;
    const events: string[] = Array.isArray(body.events) && body.events.length ? body.events : ['push'];
    const eventsObj: any = { push_only: false, send_everything: false, choose_events: true, events: {} };
    for (const ev of ['create', 'delete', 'fork', 'push', 'issues', 'issue_comment', 'pull_request', 'release']) {
      eventsObj.events[ev] = events.includes(ev);
    }
    const cfg = body.config ?? {};
    db.db()
      .prepare('UPDATE webhook SET url = ?, content_type = ?, secret = ?, events = ?, is_active = ?, updated_unix = ? WHERE id = ?')
      .run(
        cfg.url !== undefined ? String(cfg.url) : (hook as any).url,
        cfg.content_type !== undefined ? (cfg.content_type === 'form' ? 2 : 1) : (hook as any).content_type,
        cfg.secret !== undefined ? String(cfg.secret) : (hook as any).secret,
        JSON.stringify(eventsObj),
        body.active !== undefined ? (body.active ? 1 : 0) : (hook as any).is_active,
        Math.floor(Date.now() / 1000),
        (hook as any).id
      );
    ctx.c.JSONSuccess(toRepositoryHook(db.getWebhookByID(ctx.repo.Repository!.id, (hook as any).id)));
  }));
  m.delete('/api/v1/repos/:username/:reponame/hooks/:id', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const hook = db.getWebhookByID(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id'));
    if (!hook) {
      ctx.notFound();
      return;
    }
    db.db().prepare('DELETE FROM webhook WHERE id = ?').run((hook as any).id);
    ctx.c.NoContent();
  }));

  // collaborators
  m.get('/api/v1/repos/:username/:reponame/collaborators', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const cols = db.listCollaborations(ctx.repo.Repository!.id);
    ctx.c.JSONSuccess(
      cols.map((col: any) => {
        const u = db.getUserByID(col.user_id)!;
        const user = toUser(u, true);
        user.permissions = {
          admin: col.mode >= db.AccessMode.ADMIN,
          push: col.mode >= db.AccessMode.WRITE,
          pull: true,
        };
        return user;
      })
    );
  }));
  m.get('/api/v1/repos/:username/:reponame/collaborators/:collaborator', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':collaborator'));
    if (!u) {
      ctx.c.Status(422);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    if (db.getCollaboration(ctx.repo.Repository!.id, u.id)) {
      ctx.c.NoContent();
    } else {
      ctx.notFound();
    }
  }));
  m.put('/api/v1/repos/:username/:reponame/collaborators/:collaborator', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':collaborator'));
    if (!u) {
      ctx.c.Status(422);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const body = (await ctx.c.form()) as any;
    const perm = String(body.permission ?? 'read');
    const mode = perm === 'admin' ? db.AccessMode.ADMIN : perm === 'write' ? db.AccessMode.WRITE : db.AccessMode.READ;
    if (!db.getCollaboration(ctx.repo.Repository!.id, u.id)) {
      db.db().prepare('INSERT INTO collaboration (user_id, repo_id, mode) VALUES (?,?,?)').run(u.id, ctx.repo.Repository!.id, mode);
    } else {
      db.db().prepare('UPDATE collaboration SET mode = ? WHERE user_id = ? AND repo_id = ?').run(mode, u.id, ctx.repo.Repository!.id);
    }
    ctx.c.NoContent();
  }));
  m.delete('/api/v1/repos/:username/:reponame/collaborators/:collaborator', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const u = db.getUserByUsername(ctx.c.Params(':collaborator'));
    if (!u) {
      ctx.c.Status(422);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    db.db().prepare('DELETE FROM collaboration WHERE user_id = ? AND repo_id = ?').run(u.id, ctx.repo.Repository!.id);
    ctx.c.NoContent();
  }));

  // raw file
  m.get('/api/v1/repos/:username/:reponame/raw/*', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    const wildcard = ctx.c.Params(':*');
    // greedy ref resolution so slash-named branches work (upstream unescapes {ref})
    const parts = wildcard.split('/');
    const repoDir = ctx.repo.Repository!.RepoPath();
    let ref = '';
    let filePath = '';
    for (let i = 1; i < parts.length; i++) {
      const cand = parts.slice(0, i).join('/');
      if (await git.resolveRef(repoDir, cand)) {
        ref = cand;
        filePath = parts.slice(i).join('/');
        break;
      }
    }
    if (!ref || !filePath) {
      ctx.notFound();
      return;
    }
    const resolved = await git.resolveRef(repoDir, ref);
    if (!resolved) {
      ctx.notFound();
      return;
    }
    const commit = await git.getCommit(repoDir, resolved);
    if (!commit) {
      ctx.notFound();
      return;
    }
    const tree = await git.lsTree(repoDir, commit.id, filePath);
    const entry = tree?.entries[0];
    if (!entry || entry.type !== 'blob') {
      ctx.notFound();
      return;
    }
    const content = await git.blobBytes(repoDir, entry.sha);
    ctx.c.SetHeader('Content-Type', 'application/octet-stream');
    ctx.c.res.end(content);
    ctx.c.rendered = true;
  }));

  // contents
  m.get('/api/v1/repos/:username/:reponame/contents', repoGroupNoToken(contentsHandler));
  m.get('/api/v1/repos/:username/:reponame/contents/*', repoGroupNoToken(contentsHandler));

  m.put('/api/v1/repos/:username/:reponame/contents/*', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.WRITE) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const body = (await ctx.c.form()) as any;
    const message = String(body.message ?? '');
    const content = String(body.content ?? '');
    const branch = String(body.branch ?? '') || ctx.repo.Repository!.default_branch || conf.defaultBranch;
    if (!message || !content) {
      ctx.c.JSON(422, [{ fieldNames: [!message ? 'message' : 'content'], classification: 'RequiredError', message: 'Required' }]);
      return;
    }
    let fileContent: Buffer;
    try {
      fileContent = Buffer.from(content, 'base64');
    } catch {
      ctx.error(500 - 1 === 499 ? 'bad' : 'content is not base64');
      return;
    }
    const filePath = ctx.c.Params(':*');
    const repo = ctx.repo.Repository!;
    const repoDir = repo.RepoPath();
    const tmpDir = `${conf.appDataPath}/tmp/api-put-${Date.now()}`;
    const fs = await import('node:fs');
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await git.git(process.cwd(), 'clone', repoDir, tmpDir);
      await git.git(tmpDir, 'checkout', '--end-of-options', branch);
      const target = `${tmpDir}/${filePath}`;
      fs.mkdirSync(target.substring(0, target.lastIndexOf('/')), { recursive: true });
      fs.writeFileSync(target, fileContent);
      await git.git(tmpDir, 'add', '--all');
      const author = `${ctx.user!.name} <${ctx.user!.email}>`;
      await git.git(tmpDir, 'commit', `--author=${author}`, '-m', message);
      await git.git(tmpDir, 'push', 'origin', `HEAD:refs/heads/${branch}`);
      const commit = await git.getCommit(repoDir, branch);
      const sha = commit ? commit.id : '';
      const tree = await git.lsTree(repoDir, sha, filePath);
      const entry = tree?.entries[0];
      ctx.c.JSON(201, {
        content: contentsEntry(ctx.repo.Repository!, filePath, entry, branch),
        commit: commit ? commitToAPICommit(ctx, repo, commit, `/api/v1/repos/${repo.FullName()}/git/commits/${sha}`) : null,
      });
    } catch (e: any) {
      ctx.error(String(e.message ?? e));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }));

  // archive
  m.get('/api/v1/repos/:username/:reponame/archive/*', repoGroupNoToken(async (ctx: APIContext) => {
    const wildcard = ctx.c.Params(':*');
    const isZip = wildcard.endsWith('.zip');
    const isTarGz = wildcard.endsWith('.tar.gz');
    if (!isZip && !isTarGz) {
      ctx.notFound();
      return;
    }
    const ref = isZip ? wildcard.slice(0, -4) : wildcard.slice(0, -7);
    const repoDir = ctx.repo.Repository!.RepoPath();
    const resolved = await git.resolveRef(repoDir, ref);
    if (!resolved) {
      ctx.notFound();
      return;
    }
    const sha = (await git.gitOK(repoDir, 'rev-parse', '--verify', '--end-of-options', resolved))!.toString().trim();
    const ext = isZip ? '.zip' : '.tar.gz';
    const dst = `/tmp/ts-gogs-archive-${Date.now()}${ext}`;
    await git.archive(repoDir, sha, isZip ? 'zip' : 'tar.gz', dst, `${ctx.repo.Repository!.name}/`);
    const fs = await import('node:fs');
    ctx.c.SetHeader('Content-Type', isZip ? 'application/zip' : 'application/x-gzip');
    ctx.c.SetHeader('Content-Disposition', `attachment; filename=${ctx.repo.Repository!.name}-${sha.slice(0, 10)}${ext}`);
    ctx.c.res.end(fs.readFileSync(dst));
    fs.unlinkSync(dst);
    ctx.c.rendered = true;
  }));

  // git trees & blobs
  m.get('/api/v1/repos/:username/:reponame/git/trees/:sha', repoGroupNoToken(async (ctx: APIContext) => {
    const repo = ctx.repo.Repository!;
    const repoDir = repo.RepoPath();
    const sha = ctx.c.Params(':sha');
    const resolved = await git.resolveRef(repoDir, sha);
    const target = resolved ?? sha;
    const tree = await git.lsTree(repoDir, target, '');
    if (!tree) {
      ctx.notFound();
      return;
    }
    const entries = [];
    for (const e of tree.entries) {
      const type = e.type === 'commit' ? '160000' : e.type === 'tree' ? '040000' : e.type === 'tag' ? '100644' : e.mode;
      entries.push({
        path: e.name,
        mode: e.mode === '160000' ? '160000' : type === '040000' ? '040000' : e.mode,
        type: e.type,
        size: e.type === 'blob' ? await git.entrySize(repoDir, e.sha) : 0,
        sha: e.sha,
        url: `${conf.externalURL}api/v1/repos/${repo.FullName()}/git/trees/${e.sha}`,
      });
    }
    ctx.c.JSONSuccess({
      sha,
      url: `${conf.externalURL}api/v1/repos/${repo.FullName()}/git/trees/${sha}`,
      tree: entries.length ? entries : null,
    });
  }));

  m.get('/api/v1/repos/:username/:reponame/git/blobs/:sha', repoGroupNoToken(async (ctx: APIContext) => {
    const repo = ctx.repo.Repository!;
    const repoDir = repo.RepoPath();
    const sha = ctx.c.Params(':sha');
    try {
      const content = await git.blobBytes(repoDir, sha);
      ctx.c.JSONSuccess({
        content: content.toString('base64'),
        encoding: 'base64',
        url: `${conf.externalURL}api/v1/repos/${repo.FullName()}/git/blobs/${sha}`,
        sha,
        size: content.length,
      });
    } catch {
      ctx.notFound();
    }
  }));

  m.get('/api/v1/repos/:username/:reponame/forks', repoGroupNoToken(async (ctx: APIContext) => {
    const rows = db.db().prepare('SELECT * FROM repository WHERE fork_id = ?').all(ctx.repo.Repository!.id) as any[];
    const out = rows.map((r) => {
      const fork = new Repository(r);
      fork.owner = db.getUserByID(fork.owner_id) ?? undefined;
      const mode = db.accessMode(ctx.UserID(), fork);
      return toRepository(fork, { admin: mode >= db.AccessMode.ADMIN, push: mode >= db.AccessMode.WRITE, pull: mode >= db.AccessMode.READ });
    });
    ctx.c.JSONSuccess(out);
  }));

  m.get('/api/v1/repos/:username/:reponame/tags', repoGroupNoToken(async (ctx: APIContext) => {
    const repoDir = ctx.repo.Repository!.RepoPath();
    const tags = await git.getTags(repoDir);
    ctx.c.JSONSuccess(
      tags.map((t) => ({
        name: t.name,
        commit: {
          id: t.commit.id,
          message: t.commit.message,
          url: 'Not implemented',
          author: { name: t.commit.author.name, email: t.commit.author.email, username: db.getUserByEmail(t.commit.author.email)?.name ?? '' },
          committer: { name: t.commit.committer.name, email: t.commit.committer.email, username: db.getUserByEmail(t.commit.committer.email)?.name ?? '' },
          added: null,
          removed: null,
          modified: null,
          timestamp: t.commit.committer.when.toISOString(),
        },
      }))
    );
  }));

  m.get('/api/v1/repos/:username/:reponame/branches', repoGroupNoToken(async (ctx: APIContext) => {
    const repoDir = ctx.repo.Repository!.RepoPath();
    const branches = await git.getBranches(repoDir);
    ctx.c.JSONSuccess(
      branches.map((b) => ({
        name: b.name,
        commit: webhookCommitFromCommit(b.commit),
      }))
    );
  }));
  m.get('/api/v1/repos/:username/:reponame/branches/*', repoGroupNoToken(async (ctx: APIContext) => {
    const repoDir = ctx.repo.Repository!.RepoPath();
    const name = ctx.c.Params(':*');
    const branch = (await git.getBranches(repoDir)).find((b) => b.name === name);
    if (!branch) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess({ name: branch.name, commit: webhookCommitFromCommit(branch.commit) });
  }));

  m.get('/api/v1/repos/:username/:reponame/commits', repoGroupNoToken(async (ctx: APIContext) => {
    const repoDir = ctx.repo.Repository!.RepoPath();
    const pageSize = Math.max(1, ctx.c.QueryInt('pageSize') || 30);
    const commits = await git.commitsByPage(repoDir, ctx.repo.Repository!.default_branch || conf.defaultBranch, Math.max(1, ctx.c.QueryInt('page') || 1), pageSize);
    ctx.c.JSONSuccess(commits.map((cm) => commitToAPICommit(ctx, ctx.repo.Repository!, cm, `/api/v1/repos/${ctx.repo.Repository!.FullName()}/commits/${cm.id}`)));
  }));
  m.get('/api/v1/repos/:username/:reponame/commits/:sha', repoGroupNoToken(async (ctx: APIContext) => {
    const sha = ctx.c.Params(':sha');
    if (ctx.c.req.headers.accept?.toString().includes('application/vnd.gogs.sha')) {
      return getReferenceSHAHandler(ctx, sha);
    }
    const repoDir = ctx.repo.Repository!.RepoPath();
    const commit = await git.getCommit(repoDir, sha);
    if (!commit) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(commitToAPICommit(ctx, ctx.repo.Repository!, commit, `/api/v1/repos/${ctx.repo.Repository!.FullName()}/commits/${commit.id}`));
  }));
  m.get('/api/v1/repos/:username/:reponame/commits/*', repoGroupNoToken(async (ctx: APIContext) => {
    await getReferenceSHAHandler(ctx, ctx.c.Params(':*'));
  }));

  // deploy keys
  m.get('/api/v1/repos/:username/:reponame/keys', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const rows = db.db().prepare('SELECT p.* FROM public_key p JOIN deploy_key d ON d.key_id = p.id WHERE d.repo_id = ?').all(ctx.repo.Repository!.id) as any[];
    ctx.c.JSONSuccess(
      rows.map((k) => ({
        id: k.id,
        key: k.content,
        url: `${conf.externalURL}api/v1/repos/${ctx.repo.Repository!.FullName()}/keys/${k.id}`,
        title: k.name,
        created_at: new Date((k.created_unix ?? 0) * 1000).toISOString(),
        read_only: true,
      }))
    );
  }));
  m.post('/api/v1/repos/:username/:reponame/keys', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const body = (await ctx.c.form()) as any;
    const title = String(body.title ?? '').trim();
    const key = String(body.key ?? '').trim();
    if (!title || !key) {
      ctx.c.JSON(422, [{ fieldNames: [!title ? 'title' : 'key'], classification: 'RequiredError', message: 'Required' }]);
      return;
    }
    const { fingerprintKey } = await import('../routes/sshkey.js');
    const clean = key.replaceAll('\n', '').replaceAll('\r', '');
    const fingerprint = fingerprintKey(clean);
    if (db.db().prepare('SELECT 1 FROM public_key WHERE fingerprint = ?').get(fingerprint)) {
      ctx.errorStatus(422, 'Key content has been used as non-deploy key');
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const info = db.db()
      .prepare('INSERT INTO public_key (owner_id, name, fingerprint, content, mode, type, created_unix, updated_unix) VALUES (?,?,?,?,2,2,?,?)')
      .run(ctx.repo.Repository!.owner_id, title, fingerprint, clean, now, now);
    const keyID = Number(info.lastInsertRowid);
    db.db().prepare('INSERT INTO deploy_key (key_id, repo_id, name, fingerprint, created_unix, updated_unix) VALUES (?,?,?,?,?,?)')
      .run(keyID, ctx.repo.Repository!.id, title, fingerprint, now, now);
    ctx.c.JSON(201, {
      id: keyID,
      key: clean,
      url: `${conf.externalURL}api/v1/repos/${ctx.repo.Repository!.FullName()}/keys/${keyID}`,
      title,
      created_at: new Date(now * 1000).toISOString(),
      read_only: true,
    });
  }));
  m.get('/api/v1/repos/:username/:reponame/keys/:id', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const row = db.db().prepare('SELECT p.* FROM public_key p JOIN deploy_key d ON d.key_id = p.id WHERE d.repo_id = ? AND p.id = ?').get(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id')) as any;
    if (!row) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess({
      id: row.id,
      key: row.content,
      url: `${conf.externalURL}api/v1/repos/${ctx.repo.Repository!.FullName()}/keys/${row.id}`,
      title: row.name,
      created_at: new Date((row.created_unix ?? 0) * 1000).toISOString(),
      read_only: true,
    });
  }));
  m.delete('/api/v1/repos/:username/:reponame/keys/:id', repoAdminGroup(repoGroup, async (ctx: APIContext) => {
    const row = db.db().prepare('SELECT p.* FROM public_key p JOIN deploy_key d ON d.key_id = p.id WHERE d.repo_id = ? AND p.id = ?').get(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id')) as any;
    if (!row) {
      ctx.notFound();
      return;
    }
    db.db().prepare('DELETE FROM deploy_key WHERE key_id = ?').run(row.id);
    db.db().prepare('DELETE FROM public_key WHERE id = ?').run(row.id);
    ctx.c.NoContent();
  }));

  // issues
  const issuesGroup = (fn: (ctx: APIContext) => Promise<void> | void) =>
    reqTokenWrap(async (ctx: APIContext) => {
      const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
      if (!ok) return;
      const repo = ctx.repo.Repository!;
      if (!repo.enable_issues || repo.enable_external_tracker) {
        ctx.notFound();
        return;
      }
      await fn(ctx);
    });

  m.get('/api/v1/repos/:username/:reponame/issues', issuesGroup(async (ctx: APIContext) => {
    const page = Math.max(1, ctx.c.QueryInt('page') || 1);
    const state = ctx.c.Query('state') === 'closed' ? 1 : 0;
    const { total, issues } = db.listIssues(ctx.repo.Repository!.id, state, page, conf.issuePagingNum);
    setLinkHeader(ctx.c, total, conf.issuePagingNum);
    ctx.c.JSONSuccess(issues.map((i) => toIssue(i, ctx.repo.Repository!)));
  }));

  m.post('/api/v1/repos/:username/:reponame/issues', issuesGroup(async (ctx: APIContext) => {
    const body = (await ctx.c.form()) as any;
    const title = String(body.title ?? '').trim();
    if (!title) {
      ctx.c.JSON(422, [{ fieldNames: ['title'], classification: 'RequiredError', message: 'Required' }]);
      return;
    }
    const repo = ctx.repo.Repository!;
    const isWriter = ctx.repo.AccessMode >= db.AccessMode.WRITE;
    const index = db.maxIssueIndex(repo.id) + 1;
    const now = Math.floor(Date.now() / 1000);
    let assigneeID: number | null = null;
    if (isWriter && body.assignee) {
      const assignee = db.getUserByUsername(String(body.assignee));
      if (!assignee) {
        ctx.errorStatus(422, `assignee does not exist: [name: ${body.assignee}]`);
        return;
      }
      assigneeID = assignee.id;
    }
    const info = db.db()
      .prepare('INSERT INTO issue (repo_id, "index", poster_id, name, content, milestone_id, assignee_id, is_closed, is_pull, num_comments, created_unix, updated_unix) VALUES (?,?,?,?,?,?,?,0,0,0,?,?)')
      .run(repo.id, index, ctx.UserID(), title, String(body.body ?? ''), isWriter ? Number(body.milestone ?? 0) || null : null, assigneeID, now, now);
    const issueID = Number(info.lastInsertRowid);
    db.db().prepare('INSERT INTO issue_user (uid, issue_id, repo_id, is_poster, is_read) VALUES (?,?,?,1,1)').run(ctx.UserID(), issueID, repo.id);
    if (isWriter && Array.isArray(body.labels)) {
      for (const lid of body.labels) {
        db.db().prepare('INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?,?)').run(issueID, Number(lid));
      }
    }
    db.refreshIssueCounts(repo.id);
    if (body.closed) {
      db.updateIssueColumns(issueID, { is_closed: 1 });
      db.refreshIssueCounts(repo.id);
    }
    const { issueAction, ActionType } = await import('../db/actions.js');
    const issue = db.getIssueByID(issueID)!;
    await issueAction(ActionType.CREATE_ISSUE, ctx.user!, repo, issue);
    ctx.c.JSON(201, toIssue(db.getIssueByID(issueID), repo));
  }));

  m.get('/api/v1/repos/:username/:reponame/issues/comments', issuesGroup(async (ctx: APIContext) => {
    const since = ctx.c.Query('since');
    let sinceUnix = 0;
    if (since) {
      const t = new Date(since);
      if (Number.isNaN(t.getTime())) {
        ctx.errorStatus(422, `invalid since: ${since}`);
        return;
      }
      sinceUnix = Math.floor(t.getTime() / 1000);
    }
    const rows = db.db().prepare('SELECT c.* FROM comment c JOIN issue i ON i.id = c.issue_id WHERE i.repo_id = ? AND c.type = 0 ORDER BY c.id').all(ctx.repo.Repository!.id) as any[];
    const out = [];
    for (const cm of rows) {
      if (sinceUnix && (cm.created_unix ?? 0) < sinceUnix) continue;
      const issue = db.getIssueByID(cm.issue_id)!;
      out.push(toIssueComment(cm, issue, ctx.repo.Repository!));
    }
    ctx.c.JSONSuccess(out);
  }));

  m.patch('/api/v1/repos/:username/:reponame/issues/comments/:id', issuesGroup(async (ctx: APIContext) => {
    await editIssueComment(ctx);
  }));

  m.delete('/api/v1/repos/:username/:reponame/issues/comments/:id', issuesGroup(async (ctx: APIContext) => {
    await deleteIssueComment(ctx);
  }));

  m.get('/api/v1/repos/:username/:reponame/issues/:index', issuesGroup(async (ctx: APIContext) => {
    const issue = db.getIssueByIndex(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':index'));
    if (!issue) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(toIssue(issue, ctx.repo.Repository!));
  }));

  m.patch('/api/v1/repos/:username/:reponame/issues/:index', issuesGroup(async (ctx: APIContext) => {
    const repo = ctx.repo.Repository!;
    const issue = db.getIssueByIndex(repo.id, ctx.c.ParamsInt64(':index'));
    if (!issue) {
      ctx.notFound();
      return;
    }
    if (issue.poster_id !== ctx.UserID() && ctx.repo.AccessMode < db.AccessMode.WRITE) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const body = (await ctx.c.form()) as any;
    const cols: Record<string, any> = {};
    if (body.title) cols['name'] = String(body.title);
    if (body.body !== undefined) cols['content'] = String(body.body);
    const isWriter = ctx.repo.AccessMode >= db.AccessMode.WRITE;
    if (isWriter && body.assignee !== undefined) {
      const assignee = body.assignee ? db.getUserByUsername(String(body.assignee)) : null;
      cols['assignee_id'] = assignee?.id ?? null;
    }
    if (isWriter && body.milestone !== undefined) {
      cols['milestone_id'] = Number(body.milestone) || null;
    }
    if (body.state !== undefined) {
      cols['is_closed'] = String(body.state) === 'closed' ? 1 : 0;
    }
    db.updateIssueColumns(issue.id, cols);
    db.refreshIssueCounts(repo.id);
    ctx.c.JSON(201, toIssue(db.getIssueByID(issue.id), repo));
  }));

  m.get('/api/v1/repos/:username/:reponame/issues/:index/comments', issuesGroup(async (ctx: APIContext) => {
    const issue = db.getIssueByIndex(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':index'));
    if (!issue) {
      ctx.notFound();
      return;
    }
    const since = ctx.c.Query('since');
    let sinceUnix = 0;
    if (since) {
      const t = new Date(since);
      if (Number.isNaN(t.getTime())) {
        ctx.errorStatus(422, `invalid since: ${since}`);
        return;
      }
      sinceUnix = Math.floor(t.getTime() / 1000);
    }
    const comments = db.listComments(issue.id).filter((cm: any) => !sinceUnix || (cm.created_unix ?? 0) >= sinceUnix);
    ctx.c.JSONSuccess(comments.map((cm: any) => toIssueComment(cm, issue, ctx.repo.Repository!)));
  }));

  m.post('/api/v1/repos/:username/:reponame/issues/:index/comments', issuesGroup(async (ctx: APIContext) => {
    const repo = ctx.repo.Repository!;
    const issue = db.getIssueByIndex(repo.id, ctx.c.ParamsInt64(':index'));
    if (!issue) {
      ctx.notFound();
      return;
    }
    const body = (await ctx.c.form()) as any;
    const content = String(body.body ?? '').trim();
    if (!content) {
      ctx.c.JSON(422, [{ fieldNames: ['body'], classification: 'RequiredError', message: 'Required' }]);
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const info = db.db().prepare('INSERT INTO comment (type, poster_id, issue_id, content, created_unix, updated_unix) VALUES (0,?,?,?,?,?)').run(ctx.UserID(), issue.id, content, now, now);
    db.db().prepare('UPDATE issue SET num_comments = num_comments + 1 WHERE id = ?').run(issue.id);
    const cm = db.getCommentByID(Number(info.lastInsertRowid))!;
    ctx.c.JSON(201, toIssueComment(cm, issue, repo));
  }));

  m.delete('/api/v1/repos/:username/:reponame/issues/:index/comments/:id', issuesGroup(async (ctx: APIContext) => {
    await deleteIssueComment(ctx);
  }));

  m.get('/api/v1/repos/:username/:reponame/issues/:index/labels', issuesGroup(async (ctx: APIContext) => {
    const issue = db.getIssueByIndex(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':index'));
    if (!issue) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(db.listIssueLabels(issue.id).map(toIssueLabel));
  }));

  const issueLabelsWriter = (fn: (ctx: APIContext, issue: any) => Promise<void> | void) =>
    reqTokenWrap(async (ctx: APIContext) => {
      const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
      if (!ok) return;
      if (ctx.repo.AccessMode < db.AccessMode.WRITE) {
        ctx.c.Status(403);
        ctx.c.res.end();
        ctx.c.rendered = true;
        return;
      }
      const issue = db.getIssueByIndex(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':index'));
      if (!issue) {
        ctx.notFound();
        return;
      }
      await fn(ctx, issue);
    });

  m.post('/api/v1/repos/:username/:reponame/issues/:index/labels', issueLabelsWriter(async (ctx, issue) => {
    const body = (await ctx.c.form()) as any;
    const labels: number[] = Array.isArray(body.labels) ? body.labels.map(Number) : [];
    for (const lid of labels) {
      db.db().prepare('INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?,?)').run(issue.id, lid);
    }
    ctx.c.JSONSuccess(db.listIssueLabels(issue.id).map(toIssueLabel));
  }));

  m.put('/api/v1/repos/:username/:reponame/issues/:index/labels', issueLabelsWriter(async (ctx, issue) => {
    const body = (await ctx.c.form()) as any;
    const labels: number[] = Array.isArray(body.labels) ? body.labels.map(Number) : [];
    db.db().prepare('DELETE FROM issue_label WHERE issue_id = ?').run(issue.id);
    for (const lid of labels) {
      db.db().prepare('INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?,?)').run(issue.id, lid);
    }
    ctx.c.JSONSuccess(db.listIssueLabels(issue.id).map(toIssueLabel));
  }));

  m.delete('/api/v1/repos/:username/:reponame/issues/:index/labels', issueLabelsWriter(async (ctx, issue) => {
    db.db().prepare('DELETE FROM issue_label WHERE issue_id = ?').run(issue.id);
    ctx.c.NoContent();
  }));

  m.delete('/api/v1/repos/:username/:reponame/issues/:index/labels/:id', issueLabelsWriter(async (ctx, issue) => {
    const label = db.getLabelByID(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id'));
    if (!label) {
      ctx.errorStatus(422, `label does not exist [id: ${ctx.c.Params(':id')}]`);
      return;
    }
    db.db().prepare('DELETE FROM issue_label WHERE issue_id = ? AND label_id = ?').run(issue.id, (label as any).id);
    ctx.c.NoContent();
  }));

  // labels
  m.get('/api/v1/repos/:username/:reponame/labels', repoGroupNoToken(async (ctx: APIContext) => {
    ctx.c.JSONSuccess(db.listLabels(ctx.repo.Repository!.id).map(toIssueLabel));
  }));
  m.get('/api/v1/repos/:username/:reponame/labels/:id', repoGroupNoToken(async (ctx: APIContext) => {
    const idParam = ctx.c.Params(':id');
    let label: any;
    if (/^\d+$/.test(idParam) && Number(idParam) > 0) {
      label = db.getLabelByID(ctx.repo.Repository!.id, Number(idParam));
    } else {
      label = db.getLabelByName(ctx.repo.Repository!.id, idParam);
    }
    if (!label) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(toIssueLabel(label));
  }));
  m.post('/api/v1/repos/:username/:reponame/labels', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.WRITE) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const body = (await ctx.c.form()) as any;
    const name = String(body.name ?? '').trim();
    let color = String(body.color ?? '').trim();
    if (!name || !color) {
      ctx.c.JSON(422, [{ fieldNames: [!name ? 'name' : 'color'], classification: 'RequiredError', message: 'Required' }]);
      return;
    }
    if (!color.startsWith('#')) color = '#' + color;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      ctx.c.JSON(422, [{ fieldNames: ['color'], classification: 'SizeError', message: 'Size must be between 6 and 7.' }]);
      return;
    }
    const info = db.db().prepare('INSERT INTO label (repo_id, name, color, num_issues, num_closed_issues) VALUES (?,?,?,0,0)').run(ctx.repo.Repository!.id, name, color);
    const label = db.getLabelByID(ctx.repo.Repository!.id, Number(info.lastInsertRowid));
    ctx.c.JSON(201, toIssueLabel(label));
  }));
  m.patch('/api/v1/repos/:username/:reponame/labels/:id', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.WRITE) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const label = db.getLabelByID(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id'));
    if (!label) {
      ctx.notFound();
      return;
    }
    const body = (await ctx.c.form()) as any;
    let color = (label as any).color;
    if (body.color !== undefined) {
      color = String(body.color).startsWith('#') ? String(body.color) : '#' + String(body.color);
    }
    db.db().prepare('UPDATE label SET name = ?, color = ? WHERE id = ?').run(String(body.name ?? (label as any).name), color, (label as any).id);
    ctx.c.JSONSuccess(toIssueLabel(db.getLabelByID(ctx.repo.Repository!.id, (label as any).id)));
  }));
  m.delete('/api/v1/repos/:username/:reponame/labels/:id', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.WRITE) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const label = db.getLabelByID(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id'));
    if (!label) {
      ctx.notFound();
      return;
    }
    db.db().prepare('DELETE FROM label WHERE id = ?').run((label as any).id);
    db.db().prepare('DELETE FROM issue_label WHERE label_id = ?').run((label as any).id);
    ctx.c.NoContent();
  }));

  // milestones
  m.get('/api/v1/repos/:username/:reponame/milestones', repoGroupNoToken(async (ctx: APIContext) => {
    ctx.c.JSONSuccess(db.listMilestones(ctx.repo.Repository!.id, null).map(toIssueMilestone));
  }));
  m.get('/api/v1/repos/:username/:reponame/milestones/:id', repoGroupNoToken(async (ctx: APIContext) => {
    const m = db.getMilestoneByID(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id'));
    if (!m) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(toIssueMilestone(m));
  }));
  m.post('/api/v1/repos/:username/:reponame/milestones', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.WRITE) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const body = (await ctx.c.form()) as any;
    let deadline = 4102444800; // 9999-12-31 gogs default sentinel
    if (body.due_on) {
      const t = new Date(String(body.due_on));
      if (Number.isNaN(t.getTime())) {
        ctx.c.JSON(422, [{ fieldNames: ['due_on'], classification: 'DeserializationError', message: 'Invalid due_on' }]);
        return;
      }
      deadline = Math.floor(t.getTime() / 1000);
    }
    const info = db.db().prepare('INSERT INTO milestone (repo_id, name, content, deadline_unix, num_issues, num_closed_issues, completeness) VALUES (?,?,?,?,0,0,0)').run(ctx.repo.Repository!.id, String(body.title ?? ''), String(body.description ?? ''), deadline);
    db.refreshMilestoneCounts(ctx.repo.Repository!.id);
    ctx.c.JSON(201, toIssueMilestone(db.getMilestoneByID(ctx.repo.Repository!.id, Number(info.lastInsertRowid))));
  }));
  m.patch('/api/v1/repos/:username/:reponame/milestones/:id', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.WRITE) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const m = db.getMilestoneByID(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id'));
    if (!m) {
      ctx.notFound();
      return;
    }
    const body = (await ctx.c.form()) as any;
    if (body.title !== undefined || body.description !== undefined || body.due_on !== undefined) {
      let deadline = (m as any).deadline_unix ?? 0;
      if (body.due_on !== undefined) {
        if (body.due_on === null) deadline = 0;
        else {
          const t = new Date(String(body.due_on));
          deadline = Number.isNaN(t.getTime()) ? deadline : Math.floor(t.getTime() / 1000);
        }
      }
      db.db().prepare('UPDATE milestone SET name = ?, content = ?, deadline_unix = ? WHERE id = ?').run(String(body.title ?? (m as any).name), body.description !== undefined ? String(body.description) : (m as any).content, deadline, (m as any).id);
    }
    if (body.state !== undefined) {
      const isClosed = String(body.state) === 'closed' ? 1 : 0;
      db.db().prepare('UPDATE milestone SET is_closed = ?, closed_date_unix = ? WHERE id = ?').run(isClosed, isClosed ? Math.floor(Date.now() / 1000) : 0, (m as any).id);
    }
    db.refreshMilestoneCounts(ctx.repo.Repository!.id);
    ctx.c.JSONSuccess(toIssueMilestone(db.getMilestoneByID(ctx.repo.Repository!.id, (m as any).id)));
  }));
  m.delete('/api/v1/repos/:username/:reponame/milestones/:id', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.WRITE) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const m = db.getMilestoneByID(ctx.repo.Repository!.id, ctx.c.ParamsInt64(':id'));
    if (!m) {
      ctx.notFound();
      return;
    }
    db.db().prepare('UPDATE issue SET milestone_id = 0 WHERE milestone_id = ?').run((m as any).id);
    db.db().prepare('DELETE FROM milestone WHERE id = ?').run((m as any).id);
    db.refreshMilestoneCounts(ctx.repo.Repository!.id);
    ctx.c.NoContent();
  }));

  // repo settings
  m.patch('/api/v1/repos/:username/:reponame/issue-tracker', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.ADMIN) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const body = (await ctx.c.form()) as any;
    const repo = ctx.repo.Repository!;
    const cols: Record<string, any> = {};
    if (body.enable_issues !== undefined) cols['enable_issues'] = body.enable_issues ? 1 : 0;
    if (body.enable_external_tracker !== undefined) cols['enable_external_tracker'] = body.enable_external_tracker ? 1 : 0;
    if (body.external_tracker_url !== undefined) cols['external_tracker_url'] = String(body.external_tracker_url);
    if (body.tracker_url_format !== undefined) cols['external_tracker_format'] = String(body.tracker_url_format);
    if (body.tracker_issue_style !== undefined) cols['external_tracker_style'] = String(body.tracker_issue_style);
    db.updateRepoColumns(repo.id, cols);
    ctx.c.NoContent();
  }));

  m.patch('/api/v1/repos/:username/:reponame/wiki', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.ADMIN) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    const body = (await ctx.c.form()) as any;
    const repo = ctx.repo.Repository!;
    const cols: Record<string, any> = {};
    if (body.enable_wiki !== undefined) cols['enable_wiki'] = body.enable_wiki ? 1 : 0;
    if (body.allow_public_wiki !== undefined) cols['allow_public_wiki'] = body.allow_public_wiki ? 1 : 0;
    if (body.enable_external_wiki !== undefined) cols['enable_external_wiki'] = body.enable_external_wiki ? 1 : 0;
    if (body.external_wiki_url !== undefined) cols['external_wiki_url'] = String(body.external_wiki_url);
    db.updateRepoColumns(repo.id, cols);
    ctx.c.NoContent();
  }));

  m.post('/api/v1/repos/:username/:reponame/mirror-sync', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    if (ctx.repo.AccessMode < db.AccessMode.ADMIN) {
      ctx.c.Status(403);
      ctx.c.res.end();
      ctx.c.rendered = true;
      return;
    }
    if (!ctx.repo.Repository!.is_mirror) {
      ctx.notFound();
      return;
    }
    ctx.c.Status(202);
    ctx.c.res.end();
    ctx.c.rendered = true;
    // immediate sync in background (gogs MirrorQueue)
    setImmediate(async () => {
      try {
        const { syncMirror } = await import('../mirror.js');
        await syncMirror(ctx.repo.Repository!.id, ctx.UserID());
      } catch (e) {
        console.error('[mirror-sync]', e);
      }
    });
  }));

  m.get('/api/v1/repos/:username/:reponame/editorconfig/:filename', reqTokenWrap(async (ctx: APIContext) => {
    const ok = await repoAssignment(ctx, ctx.c.Params(':username'), ctx.c.Params(':reponame'));
    if (!ok) return;
    const repo = ctx.repo.Repository!;
    const repoDir = repo.RepoPath();
    const ref = repo.default_branch || conf.defaultBranch;
    const { repoEditorconfig, getDefinitionForFilename } = await import('../editorconfig.js');
    const ec = await repoEditorconfig(repoDir, ref);
    if (!ec) {
      ctx.notFound();
      return;
    }
    const def = getDefinitionForFilename(ec, ctx.c.Params(':filename'));
    if (!def) {
      ctx.notFound();
      return;
    }
    ctx.c.JSONSuccess(def);
  }));
}

function repoAdminGroup(repoGroup: any, fn: any) {
  return reqTokenAdminWrap(repoGroup, fn);
}

function reqTokenAdminWrap(repoGroup: any, fn: any) {
  return async (c: Context) => {
    // repoGroup already applies reqToken + repoAssignment; layer admin check
    let adminChecked = false;
    const wrapped = async (ctx: APIContext) => {
      if (!adminChecked) {
        adminChecked = true;
        if (ctx.repo.AccessMode < db.AccessMode.ADMIN) {
          ctx.c.Status(403);
          ctx.c.res.end();
          ctx.c.rendered = true;
          return;
        }
      }
      await fn(ctx);
    };
    await repoGroup(wrapped)(c);
  };
}

function toRepositoryHook(hook: any): any {
  const eventsObj = JSON.parse(hook.events ?? '{}');
  const events: string[] = [];
  for (const [ev, on] of Object.entries(eventsObj.events ?? {})) {
    if (on) events.push(ev);
  }
  if (eventsObj.push_only) events.push('push');
  if (eventsObj.send_everything) events.push('*');
  const config: Record<string, string> = {
    url: hook.url,
    content_type: hook.content_type === 2 ? 'form' : 'json',
  };
  if (hook.hook_task_type === 2) {
    const meta = JSON.parse(hook.meta ?? '{}');
    config.channel = meta.channel ?? '';
    config.username = meta.username ?? '';
    config.icon_url = meta.icon_url ?? '';
    config.color = meta.color ?? '';
  }
  return {
    id: hook.id,
    type: ({ 1: 'gogs', 2: 'slack', 3: 'discord', 4: 'dingtalk' } as Record<string, string>)[String(hook.hook_task_type)] ?? 'gogs',
    config,
    events,
    active: !!hook.is_active,
    updated_at: new Date((hook.updated_unix ?? 0) * 1000).toISOString(),
    created_at: new Date((hook.created_unix ?? 0) * 1000).toISOString(),
  };
}

function webhookCommitFromCommit(cm: git.Commit): any {
  return {
    id: cm.id,
    message: cm.message,
    url: 'Not implemented',
    author: { name: cm.author.name, email: cm.author.email, username: db.getUserByEmail(cm.author.email)?.name ?? '' },
    committer: { name: cm.committer.name, email: cm.committer.email, username: db.getUserByEmail(cm.committer.email)?.name ?? '' },
    added: null,
    removed: null,
    modified: null,
    timestamp: cm.committer.when.toISOString(),
  };
}

async function contentsHandler(ctx: APIContext): Promise<void> {
  const repo = ctx.repo.Repository!;
  const repoDir = repo.RepoPath();
  const ref = ctx.c.Query('ref') || repo.default_branch || conf.defaultBranch;
  const filePath = ctx.c.Params(':*') ?? '';
  const resolved = await git.resolveRef(repoDir, ref);
  if (!resolved) {
    ctx.notFound();
    return;
  }
  const commit = await git.getCommit(repoDir, resolved);
  if (!commit) {
    ctx.notFound();
    return;
  }
  const tree = await git.lsTree(repoDir, commit.id, filePath);
  if (!tree) {
    ctx.notFound();
    return;
  }
  if (filePath) {
    // file / symlink / submodule case
    const target = tree.entries[0];
    if (target && target.type === 'blob') {
      const content = await git.blobBytes(repoDir, target.sha);
      ctx.c.JSONSuccess(contentsEntry(repo, filePath, target, ref, content));
      return;
    }
    if (target && target.type === 'commit') {
      ctx.c.JSONSuccess(contentsEntry(repo, filePath, target, ref));
      return;
    }
  }
  // directory listing
  const out = [];
  for (const e of tree.entries) {
    out.push(contentsEntry(repo, filePath ? `${filePath}/${e.name}` : e.name, e, ref));
  }
  ctx.c.JSONSuccess(out);
}

function contentsEntry(repo: Repository, filePath: string, entry: any, ref: string, content?: Buffer): any {
  const base = conf.externalURL + repo.FullName();
  const isFile = entry.type === 'blob';
  const isSubmodule = entry.type === 'commit';
  const name = filePath.split('/').pop() ?? '';
  const out: any = {
    type: isSubmodule ? 'submodule' : isFile ? 'file' : 'dir',
    size: isFile ? (entry.size ?? 0) : 0,
    name,
    path: filePath,
    sha: entry.sha,
    url: `${base}/api/v1/contents/${filePath}?ref=${ref}`,
    git_url: `${base}/api/v1/git/${isFile ? 'blobs' : 'trees'}/${entry.sha}`,
    html_url: `${base}/src/${ref}/${filePath}`,
    download_url: isFile ? `${base}/raw/${ref}/${filePath}` : null,
    _links: {
      git: `${base}/api/v1/git/${isFile ? 'blobs' : 'trees'}/${entry.sha}`,
      self: `${base}/api/v1/contents/${filePath}?ref=${ref}`,
      html: `${base}/src/${ref}/${filePath}`,
    },
  };
  if (content !== undefined) {
    out.encoding = 'base64';
    out.content = content.toString('base64');
  }
  // strip null download_url like omitempty would
  if (out.download_url === null) delete out.download_url;
  return out;
}

async function editIssueComment(ctx: APIContext): Promise<void> {
  const cm = db.getCommentByID(ctx.c.ParamsInt64(':id'));
  if (!cm) {
    ctx.notFound();
    return;
  }
  const issue = db.getIssueByID((cm as any).issue_id)!;
  const repo = db.getRepoByID((issue as any).repo_id);
  if (!repo || repo.id !== ctx.repo.Repository!.id) {
    ctx.notFound();
    return;
  }
  if ((cm as any).poster_id !== ctx.UserID() && ctx.repo.AccessMode < db.AccessMode.ADMIN) {
    ctx.c.Status(403);
    ctx.c.res.end();
    ctx.c.rendered = true;
    return;
  }
  if ((cm as any).type !== 0) {
    ctx.c.NoContent();
    return;
  }
  const body = (await ctx.c.form()) as any;
  const content = String(body.body ?? '').trim();
  if (!content) {
    ctx.c.JSON(422, [{ fieldNames: ['body'], classification: 'RequiredError', message: 'Required' }]);
    return;
  }
  db.db().prepare('UPDATE comment SET content = ?, updated_unix = ? WHERE id = ?').run(content, Math.floor(Date.now() / 1000), (cm as any).id);
  ctx.c.JSONSuccess(toIssueComment(db.getCommentByID((cm as any).id), issue, ctx.repo.Repository!));
}

async function deleteIssueComment(ctx: APIContext): Promise<void> {
  const cm = db.getCommentByID(ctx.c.ParamsInt64(':id'));
  if (!cm) {
    ctx.notFound();
    return;
  }
  const issue = db.getIssueByID((cm as any).issue_id)!;
  const repo = db.getRepoByID((issue as any).repo_id);
  if (!repo || repo.id !== ctx.repo.Repository!.id) {
    ctx.notFound();
    return;
  }
  if ((cm as any).poster_id !== ctx.UserID() && ctx.repo.AccessMode < db.AccessMode.ADMIN) {
    ctx.c.Status(403);
    ctx.c.res.end();
    ctx.c.rendered = true;
    return;
  }
  db.db().prepare('DELETE FROM comment WHERE id = ?').run((cm as any).id);
  db.db().prepare('UPDATE issue SET num_comments = MAX(num_comments - 1, 0) WHERE id = ?').run((issue as any).id);
  ctx.c.NoContent();
}

async function getReferenceSHAHandler(ctx: APIContext, ref: string): Promise<void> {
  const repoDir = ctx.repo.Repository!.RepoPath();
  let refName = ref;
  if (!refName.startsWith('refs/')) {
    if (await git.refExists(repoDir, 'refs/heads/' + refName)) refName = 'refs/heads/' + refName;
    else if (await git.refExists(repoDir, 'refs/tags/' + refName)) refName = 'refs/tags/' + refName;
  }
  const sha = (await git.gitOK(repoDir, 'rev-parse', '--verify', '--quiet', '--end-of-options', refName))?.toString().trim();
  if (!sha) {
    ctx.notFound();
    return;
  }
  ctx.c.PlainText(200, sha);
}
