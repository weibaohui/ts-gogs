// Web request context: session, flash, i18n, rendering, and the middleware
// suite (Toggle / RepoAssignment / RepoRef / OrgAssignment) mirroring
// gogs internal/context.
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { URLSearchParams } from 'node:url';
import { conf } from './conf.js';
import { i18n, Locale, Lang } from './i18n.js';
import { TemplateSet, SafeHTML } from './gotemplate/engine.js';
import { buildFuncMap } from './gotemplate/funcs.js';
import * as db from './db/db.js';
import { User, Repository } from './db/db.js';
import { getRepoByName, accessMode, AccessMode, hasAccess } from './db/db.js';
import { basicAuthDecode } from './authx/password.js';
import * as umBridge from './authx/um.js';
import { getAccessTokenBySHA1, touchAccessToken } from './db/db.js';
import { verifyPassword } from './authx/password.js';

// ---------------------------------------------------------------- sessions

const sessions = new Map<string, { data: Record<string, any>; expires: number }>();

function newSessionID(): string {
  return crypto.randomBytes(16).toString('hex');
}

export class Session {
  sid: string;
  data: Record<string, any>;
  isNew: boolean;
  private maxAge: number;

  constructor(sid?: string) {
    this.maxAge = 86400 * conf.loginRememberDays;
    const now = Date.now();
    if (sid && sessions.has(sid)) {
      const s = sessions.get(sid)!;
      if (s.expires > now) {
        this.sid = sid;
        this.data = s.data;
        this.isNew = false;
        s.expires = now + this.maxAge * 1000;
        return;
      }
      sessions.delete(sid);
    }
    this.sid = newSessionID();
    this.data = {};
    this.isNew = true;
    sessions.set(this.sid, { data: this.data, expires: now + this.maxAge * 1000 });
  }

  Get(key: string): any {
    return this.data[key];
  }
  Set(key: string, value: any): void {
    this.data[key] = value;
  }
  Delete(key: string): void {
    delete this.data[key];
  }
  Clear(): void {
    this.data = {};
    sessions.set(this.sid, { data: this.data, expires: Date.now() + this.maxAge * 1000 });
  }
  Release(): void {
    sessions.set(this.sid, { data: this.data, expires: Date.now() + this.maxAge * 1000 });
  }
}

// ---------------------------------------------------------------- flash

export class Flash {
  SuccessMsg = '';
  ErrorMsg = '';
  WarningMsg = '';
  InfoMsg = '';
  private values: Record<string, string> = {};

  readFromCookie(cookie: string | undefined): this {
    if (!cookie) return this;
    const params = new URLSearchParams(cookie);
    for (const key of ['error', 'warning', 'info', 'success']) {
      const v = params.get(key);
      if (v === null) continue;
      this.values[key] = v;
      if (key === 'error') this.ErrorMsg = v;
      if (key === 'warning') this.WarningMsg = v;
      if (key === 'info') this.InfoMsg = v;
      if (key === 'success') this.SuccessMsg = v;
    }
    return this;
  }

  Success(msg: string) { this.values['success'] = msg; }
  Error(msg: string) { this.values['error'] = msg; }
  Warning(msg: string) { this.values['warning'] = msg; }
  Info(msg: string) { this.values['info'] = msg; }

  hasWrites(): boolean {
    return Object.keys(this.values).length > 0;
  }
  encoded(): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(this.values)) params.set(k, v);
    return params.toString();
  }
}

// ---------------------------------------------------------------- context

export class Context {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string> = {};
  urlObj!: URL;
  session!: Session;
  locale!: Locale;
  lang = 'en-US';
  Data: Record<string, any> = {};
  flash = new Flash();
  User: User | null = null;
  isBasicAuth = false;
  isTokenAuth = false;
  /** repo assignment */
  Repo: RepoContext = new RepoContext();
  Org: any = {};

  private bodyBuffer: Buffer | null = null;
  private formObj: Record<string, any> | null = null;
  private filesObj: Record<string, any>[] | null = null;
  rendered = false;
  pageStartTime = Date.now();

  constructor(req: http.IncomingMessage, res: http.ServerResponse) {
    this.req = req;
    this.res = res;
  }

  init(session: Session) {
    this.session = session;
    this.urlObj = new URL(this.req.url ?? '/', 'http://internal');
    this.Data['PageStartTime'] = new Date(this.pageStartTime);
    this.Data['TmplLoadTimes'] = () => `${Date.now() - this.pageStartTime}ms`;
    // security headers like gogs
    this.res.setHeader('X-Content-Type-Options', 'nosniff');
    this.res.setHeader('X-Frame-Options', 'deny');
  }

  // -------------------------------------------------- request accessors
  Method(): string {
    return (this.req.method ?? 'GET').toUpperCase();
  }
  Path(): string {
    return this.urlObj.pathname;
  }
  RequestURI(): string {
    return this.urlObj.pathname + this.urlObj.search;
  }
  Query(name: string): string {
    return this.urlObj.searchParams.get(name) ?? '';
  }
  QueryInt(name: string): number {
    return Number(this.Query(name)) || 0;
  }
  Params(name: string): string {
    return this.params[name] ?? '';
  }
  ParamsInt64(name: string): number {
    return Number(this.params[name]) || 0;
  }

  header(): http.ServerResponse {
    return this.res;
  }
  Header(): http.OutgoingHttpHeaders {
    return this.res.getHeaders();
  }
  SetHeader(name: string, value: string): void {
    this.res.setHeader(name, value);
  }

  async body(): Promise<Buffer> {
    if (this.bodyBuffer === null) {
      const chunks: Buffer[] = [];
      for await (const chunk of this.req) chunks.push(chunk as Buffer);
      this.bodyBuffer = Buffer.concat(chunks);
    }
    return this.bodyBuffer;
  }

  /** Parsed body: urlencoded, JSON, or multipart (fields merged; files in c.Files). */
  async form(): Promise<Record<string, any>> {
    if (this.formObj) return this.formObj;
    const buf = await this.body();
    const ctype = String(this.req.headers['content-type'] ?? '');
    this.formObj = {};
    if (ctype.includes('application/json')) {
      try {
        this.formObj = JSON.parse(buf.toString('utf8') || '{}');
      } catch {
        this.formObj = {};
      }
    } else if (ctype.includes('multipart/form-data')) {
      const { parseMultipart } = await import('./multipart.js');
      const { fields, files } = await parseMultipart(this.req, buf);
      this.formObj = fields;
      this.filesObj = files;
    } else {
      const params = new URLSearchParams(buf.toString('utf8'));
      const obj: Record<string, any> = {};
      for (const [k, v] of params.entries()) {
        if (obj[k] === undefined) obj[k] = v;
        else if (Array.isArray(obj[k])) obj[k].push(v);
        else obj[k] = [obj[k], v];
      }
      this.formObj = obj;
    }
    return this.formObj as Record<string, any>;
  }

  Files(): Record<string, any>[] {
    return this.filesObj ?? [];
  }

  async FormString(name: string): Promise<string> {
    const f = await this.form();
    const v = f[name];
    if (v === undefined || v === null) return '';
    return String(v);
  }

  GetCookie(name: string): string {
    const cookie = this.req.headers.cookie ?? '';
    for (const part of cookie.split(';')) {
      const idx = part.indexOf('=');
      if (idx < 0) continue;
      if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
    }
    return '';
  }

  SetCookie(name: string, value: string, maxAge: number, pathStr?: string, httpOnly = true): void {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${pathStr ?? (conf.subpath || '/')}`);
    if (maxAge > 0) parts.push(`Max-Age=${maxAge}`);
    if (maxAge === 0) parts.push('Max-Age=0');
    if (conf.sessionCookieSecure) parts.push('Secure');
    if (httpOnly) parts.push('HttpOnly');
    const prev = this.res.getHeader('Set-Cookie');
    const arr = prev ? (Array.isArray(prev) ? prev.map(String) : [String(prev)]) : [];
    arr.push(parts.join('; '));
    this.res.setHeader('Set-Cookie', arr);
  }

  // -------------------------------------------------- response helpers
  Status(code: number): void {
    this.res.statusCode = code;
  }

  JSON(status: number, obj: any): void {
    this.rendered = true;
    this.res.statusCode = status;
    this.res.setHeader('Content-Type', 'application/json;charset=utf-8');
    this.res.end(JSON.stringify(obj ?? null));
  }

  JSONSuccess(obj: any): void {
    this.JSON(200, obj);
  }

  NoContent(): void {
    this.rendered = true;
    this.res.statusCode = 204;
    this.res.end();
  }

  PlainText(status: number, text: string): void {
    this.rendered = true;
    this.res.statusCode = status;
    this.res.setHeader('Content-Type', 'text/plain;charset=utf-8');
    this.res.end(text);
  }

  Redirect(location: string, status = 303): void {
    this.rendered = true;
    this.res.statusCode = status;
    this.res.setHeader('Location', escapePound(location));
    this.res.end();
  }

  RedirectSubpath(location: string, status = 303): void {
    this.Redirect(conf.subpath + location, status);
  }

  Success(tmpl: string): void {
    this.HTML(200, tmpl);
  }

  HTML(status: number, tmpl: string): void {
    this.rendered = true;
    this.Data['Lang'] = this.lang;
    this.Data['LangName'] = this.locale?.Language() ?? this.lang;
    const allLangs: Lang[] = i18n.languages();
    this.Data['AllLangs'] = allLangs;
    this.Data['RestLangs'] = allLangs.filter((l) => l.Lang !== this.lang);
    this.Data['i18n'] = this.locale;
    this.Data['Tr'] = (key: string, ...args: any[]) => this.locale.Tr(key, ...args);
    this.Data['Flash'] = this.flash;
    this.Data['ShowFooterBranding'] = conf.showFooterBranding;
    if (process.env.TPL_DEBUG && tmpl.startsWith('repo/branches')) {
      console.log('[render:dbg] %s DefaultBranch=%j', tmpl, this.Data['DefaultBranch']);
    }
    try {
      const html = templates.render(tmpl, this.Data);
      this.res.statusCode = status;
      this.res.setHeader('Content-Type', 'text/html; charset=utf-8');
      this.res.end(html);
    } catch (e: any) {
      console.error('[template error]', tmpl, e);
      this.res.statusCode = 500;
      this.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      this.res.end('Internal server error');
    }
  }

  /** gogs 404: redirect to SPA shell — we render a simple 404 page (status/404 template missing in this version) */
  NotFound(): void {
    // gogs 404 hands the request to the React SPA shell with status 404
    this.rendered = true;
    if (serveWebHandler) {
      serveWebHandler(this, 404);
      return;
    }
    this.res.statusCode = 404;
    this.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    this.res.end('404 page not found');
  }

  /** Hand the request to the React SPA (c.ServeWeb in gogs). */
  ServeWeb(statusCode = 200): void {
    this.rendered = true;
    if (serveWebHandler) {
      serveWebHandler(this, statusCode);
      return;
    }
    this.res.statusCode = statusCode;
    this.res.end();
  }

  Error(err: Error, msg: string): void {
    console.error(`[ctx error] ${msg}: ${err?.stack ?? err}`);
    this.Data['Title'] = this.locale?.Tr('status.internal_server_error') ?? 'Internal Server Error';
    if (!conf.isProdMode() || this.User?.is_admin === 1) {
      this.Data['ErrorMsg'] = String(err?.message ?? err);
    }
    try {
      this.rendered = true;
      const html = templates.render('status/500', { ...this.Data, Lang: this.lang, i18n: this.locale, Flash: this.flash });
      this.res.statusCode = 500;
      this.res.setHeader('Content-Type', 'text/html; charset=utf-8');
      this.res.end(html);
    } catch {
      this.res.statusCode = 500;
      this.res.end('Internal server error');
    }
  }

  NotFoundOrError(err: any, msg: string): void {
    if (err instanceof db.NotFoundError || err?.notFound) {
      this.NotFound();
    } else {
      this.Error(err, msg);
    }
  }

  HasError(): boolean {
    return !!this.Data['HasError'];
  }

  FormErr(names: string[]): void {
    for (const n of names) this.Data['Err_' + n] = true;
  }

  Title(key: string): void {
    this.Data['Title'] = this.locale.Tr(key);
  }
  RawTitle(s: string): void {
    this.Data['Title'] = s;
  }
  PageIs(name: string): void {
    this.Data['PageIs' + name] = true;
  }
  Require(name: string): void {
    this.Data['Require' + name] = true;
  }

  async RenderWithErr(msg: string, tpl: string, form?: Record<string, any>): Promise<void> {
    if (form) this.Data['Form'] = form;
    this.Data['HasError'] = true;
    this.Data['ErrorMsg'] = msg;
    this.Data['Flash'] = this.flash;
    this.Success(tpl);
  }

  Tr(key: string, ...args: any[]): string {
    return this.locale.Tr(key, ...args);
  }

  UserID(): number {
    return this.User?.id ?? 0;
  }

  // auth flags
  get IsLogged(): boolean {
    return this.User !== null;
  }

  /** link of current request path (EscapePound'ed), like gogs Contexter */
  get Link(): string {
    return conf.subpath + this.Path().replace(/\/$/, '');
  }
}

export class RepoContext {
  Repository: Repository | null = null;
  Owner: User | null = null;
  AccessMode: number = AccessMode.NONE;
  Commit: any = null;
  CommitID = '';
  BranchName = '';
  TagName = '';
  TreePath = '';
  IsViewBranch = false;
  IsViewTag = false;
  IsViewCommit = false;
  PullRequest: any = { BaseRepo: null, Allowed: false, SameRepo: false, HeadInfo: '' };
  GitRepoDir = '';

  IsOwner(): boolean {
    return this.AccessMode >= AccessMode.OWNER;
  }
  IsAdmin(): boolean {
    return this.AccessMode >= AccessMode.ADMIN;
  }
  IsWriter(): boolean {
    return this.AccessMode >= AccessMode.WRITE;
  }
  HasAccess(): boolean {
    return this.AccessMode >= AccessMode.READ;
  }
}

/** Injected by server.ts so context can render the SPA shell. */
let serveWebHandler: ((c: Context, status: number) => void) | null = null;
export function setServeWebHandler(fn: (c: Context, status: number) => void): void {
  serveWebHandler = fn;
}

// ---------------------------------------------------------------- template set

export const templates = new TemplateSet();
let templatesLoaded = false;

export function loadTemplates(workDir: string): void {
  if (templatesLoaded) return;
  templates.funcs = buildFuncMap();
  const dir = path.join(workDir, 'templates');
  const load = (d: string, rel: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      const name = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) load(full, name);
      else if (entry.name.endsWith('.tmpl')) {
        templates.registerFile(name.slice(0, -5), fs.readFileSync(full, 'utf8'));
      }
    }
  };
  load(dir, '');
  templatesLoaded = true;
}

// ---------------------------------------------------------------- helpers

export function escapePound(str: string): string {
  return String(str).replaceAll('%', '%25').replaceAll('#', '%23').replaceAll(' ', '%20').replaceAll('?', '%3F');
}

// ---------------------------------------------------------------- auth

/** dsh 桥运行时：启用状态 + UM 凭据映射到的本库管理员（懒解析，缓存实例）。 */
let umMappedCache: { name: string; user: User | null } | null = null;
function umRuntime(): { enabled: boolean; umCheck: (u: string, p: string) => { ok: boolean; reason?: string }; mappedUser: () => User | null } {
  const enabled = umBridge.umAuthEnabled();
  const asName = process.env.DSH_UM_AS_USER || 'root';
  if (!enabled) return { enabled, umCheck: () => ({ ok: false }), mappedUser: () => null };
  if (!umMappedCache || umMappedCache.name !== asName) {
    umMappedCache = { name: asName, user: db.getUserByUsername(asName) ?? db.getFirstAdmin() ?? null };
  }
  const mapped = umMappedCache.user;
  return { enabled, umCheck: umBridge.umCheck, mappedUser: () => mapped ?? db.getFirstAdmin() ?? null };
}

export function authenticateUserByBasic(header: string): { user: User; isBasic: boolean } | null {
  const parts = header.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Basic') return null;
  const [uname, passwd] = basicAuthDecode(parts[1]);
  const user = db.getUserByUsername(uname);
  if (user && verifyPassword(passwd, user.salt, user.passwd)) {
    return { user, isBasic: true };
  }
  // dsh 桥：user-management 用户库（见 authx/um.ts）——UM 凭据映射到管理员账号
  const um = umRuntime();
  if (um.enabled) {
    const check = um.umCheck(uname, passwd);
    if (check.ok) {
      const mapped = um.mappedUser();
      if (mapped) return { user: mapped, isBasic: true };
    }
  }
  // try token in either field
  const token = getAccessTokenBySHA1(uname) ?? getAccessTokenBySHA1(passwd);
  if (token) {
    const tu = db.getUserByID((token as any).uid);
    if (tu) return { user: tu, isBasic: true };
  }
  return null;
}

export function authenticateUserByToken(sha1: string): User | null {
  const token = getAccessTokenBySHA1(sha1);
  if (!token) return null;
  touchAccessToken((token as any).id);
  return db.getUserByID((token as any).uid);
}

// ---------------------------------------------------------------- middleware factories

export function Contexter() {
  return async (c: Context) => {
    // i18n resolution: ?lang → cookie → Accept-Language → en-US
    const langs = i18n.languages().map((l) => l.Lang);
    let lang = '';
    const q = c.Query('lang');
    const cookieLang = c.GetCookie('lang');
    if (q && langs.includes(q)) {
      lang = q;
      c.SetCookie('lang', q, 1 << 31 - 1, '/');
    } else if (cookieLang && langs.includes(cookieLang)) {
      lang = cookieLang;
    } else {
      const accept = String(c.req.headers['accept-language'] ?? '');
      for (const part of accept.split(',')) {
        const code = part.split(';')[0].trim();
        if (langs.includes(code)) {
          lang = code;
          break;
        }
        const prefix = code.split('-')[0];
        const hit = langs.find((l) => l === prefix || l.startsWith(prefix + '-'));
        if (hit) {
          lang = hit;
          break;
        }
      }
      lang = lang || 'en-US';
    }
    c.lang = lang;
    c.locale = new Locale(lang);

    // session auth
    const uid = c.session.Get('uid');
    if (uid > 0) {
      c.User = db.getUserByID(uid);
      if (c.User && c.User.prohibit_login === 1) c.User = null;
    }

    // link + common data
    c.Data['Link'] = escapePound(c.Link);
    c.Data['IsLogged'] = c.IsLogged;
    c.Data['LoggedUser'] = c.User;
    c.Data['LoggedUserID'] = c.UserID();
    c.Data['LoggedUserName'] = c.User?.name ?? '';
    c.Data['IsAdmin'] = c.User?.is_admin === 1;
    c.Data['ShowRegistrationButton'] = !conf.disableRegistration;
    // server notice banner
    const noticeFile = path.join(conf.customDir, 'notice', 'banner.md');
    if (fs.existsSync(noticeFile) && fs.statSync(noticeFile).size <= 1024) {
      const { rawMarkdown } = await import('./markup.js');
      c.Data['ServerNotice'] = new SafeHTML(rawMarkdown(fs.readFileSync(noticeFile, 'utf8'), conf.subpath, {}));
    }
  };
}

/** Toggle middleware mirroring gogs context.Toggle. */
export function Toggle(opts: { SignInRequired?: boolean; SignOutRequired?: boolean; AdminRequired?: boolean }) {
  return (c: Context) => {
    if (c.IsLogged && c.User!.prohibit_login === 1) {
      c.Data['Title'] = c.Tr('auth.prohibit_login');
      c.Success('user/auth/prohibit_login');
      return;
    }
    if (!c.IsLogged && c.RequestURI() === '/' && conf.landingURL !== '/') {
      c.RedirectSubpath(conf.landingURL);
      return;
    }
    if (opts.SignOutRequired && c.IsLogged && c.RequestURI() !== '/') {
      c.RedirectSubpath('/');
      return;
    }
    if (opts.SignInRequired) {
      if (!c.IsLogged) {
        if (c.Path().startsWith('/api/')) {
          c.JSON(403, { message: 'Only authenticated user is allowed to call APIs.' });
          return;
        }
        c.SetCookie('redirect_to', encodeURIComponent(conf.subpath + c.RequestURI()), 0);
        c.RedirectSubpath('/user/sign-in');
        return;
      } else if (!c.User!.is_active && conf.requireEmailConfirmation) {
        c.RedirectSubpath('/user/activate');
        return;
      }
    }
    if (opts.AdminRequired) {
      if (c.User?.is_admin !== 1) {
        c.Status(403);
        return;
      }
      c.PageIs('Admin');
    }
  };
}

export const reqSignIn = Toggle({ SignInRequired: true });
export const ignSignIn = Toggle({ SignInRequired: conf.requireSigninView });
export const reqSignOut = Toggle({ SignOutRequired: true });
export const reqAdmin = Toggle({ SignInRequired: true, AdminRequired: true });

/** RepoAssignment middleware (args: mustBeNotBare) */
export function RepoAssignment(mustBeNotBare = false) {
  return (c: Context) => {
    const username = c.Params(':username');
    const reponame = c.Params(':reponame');
    const owner = db.getUserByUsername(username);
    if (!owner) {
      c.NotFound();
      return;
    }
    const repo = getRepoByName(username, reponame);
    if (!repo) {
      c.NotFound();
      return;
    }
    c.Repo.Owner = owner;
    c.Repo.Repository = repo;
    c.Repo.AccessMode = accessMode(c.UserID(), repo);

    if (mustBeNotBare && repo.is_bare) {
      c.NotFound();
      return;
    }

    c.Data['Username'] = username;
    c.Data['Reponame'] = reponame;
    c.Data['IsBareRepo'] = repo.is_bare === 1;
    c.Data['RepoLink'] = conf.subpath + '/' + repo.FullName();
    c.Data['RepoRelPath'] = repo.FullName();
    c.RawTitle(repo.FullName());
    c.Data['Repository'] = repo;
    c.Data['Owner'] = repo.owner;
    c.Data['IsRepositoryOwner'] = c.Repo.IsOwner();
    c.Data['IsRepositoryAdmin'] = c.Repo.IsAdmin();
    c.Data['IsRepositoryWriter'] = c.Repo.IsWriter();
    c.Data['DisableSSH'] = conf.disableSSH;
    c.Data['DisableHTTP'] = conf.disableHTTPGit;
    c.Data['CloneLink'] = {
      HTTPS: repo.CloneURL(),
      SSH: `${conf.sshDomain === 'localhost' ? conf.domain : conf.sshDomain}:${owner.name === conf.runUser ? conf.sshPort : 22}/${repo.FullName()}.git`,
      Git: `git://${conf.domain}/${repo.FullName()}.git`,
    };
    c.Data['WikiCloneLink'] = {
      HTTPS: conf.externalURL + repo.FullName() + '.wiki.git',
      SSH: '',
      Git: '',
    };

    if (c.IsLogged) {
      c.Data['IsWatchingRepo'] = db.isWatching(c.UserID(), repo.id);
      c.Data['IsStaringRepo'] = db.isStaring(c.UserID(), repo.id);
    }
    c.Data['IsGuest'] = !c.Repo.HasAccess();

    if (!repo.is_bare) {
      c.Repo.BranchName = repo.default_branch || conf.defaultBranch;
      c.Data['BranchName'] = c.Repo.BranchName;
      c.Data['Branches'] = [];
      c.Data['BranchCount'] = 0;
    }
    if (repo.is_mirror) {
      c.Data['MirrorInterval'] = '';
      c.Data['MirrorEnablePrune'] = true;
    }
  };
}

export function RequireRepoAdmin() {
  return (c: Context) => {
    if (!c.Repo.IsAdmin()) {
      c.NotFound();
    }
  };
}
export function RequireRepoWriter() {
  return (c: Context) => {
    if (!c.Repo.IsWriter()) {
      c.NotFound();
    }
  };
}

/** RepoRef middleware — resolve ref from "*" param or default branch. */
export function RepoRef() {
  return async (c: Context) => {
    const repo = c.Repo.Repository!;
    if (repo.is_bare) return;
    const repoDir = repo.RepoPath();
    c.Repo.GitRepoDir = repoDir;
    const { getCommit, getBranches, refExists, catFileCommit } = await import('./gitx/git.js');

    let refName = '';
    let treePath = '';
    const wildcard = c.Params(':*');

    if (wildcard === '') {
      refName = repo.default_branch || conf.defaultBranch;
      if (!(await refExists(repoDir, 'refs/heads/' + refName))) {
        const branches = await getBranches(repoDir);
        refName = branches[0]?.name ?? refName;
      }
      c.Repo.Commit = await getCommit(repoDir, refName);
      c.Repo.CommitID = c.Repo.Commit?.id ?? '';
      c.Repo.IsViewBranch = true;
    } else {
      const parts = wildcard.split('/');
      let hasMatched = false;
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        acc = (acc ? acc + '/' : '') + parts[i];
        if (
          (await refExists(repoDir, 'refs/heads/' + acc)) ||
          (await refExists(repoDir, 'refs/tags/' + acc))
        ) {
          if (i < parts.length - 1) treePath = parts.slice(i + 1).join('/');
          refName = acc;
          hasMatched = true;
          break;
        }
      }
      if (!hasMatched && parts[0].length === 40) {
        refName = parts[0];
        treePath = parts.slice(1).join('/');
      }
      if (!refName) {
        c.NotFound();
        return;
      }

      if (await refExists(repoDir, 'refs/heads/' + refName)) {
        c.Repo.IsViewBranch = true;
        c.Repo.Commit = await getCommit(repoDir, refName);
        c.Repo.CommitID = c.Repo.Commit?.id ?? '';
      } else if (await refExists(repoDir, 'refs/tags/' + refName)) {
        c.Repo.IsViewTag = true;
        c.Repo.Commit = await getCommit(repoDir, refName + '^{commit}');
        c.Repo.CommitID = c.Repo.Commit?.id ?? '';
      } else if (refName.length === 40) {
        c.Repo.IsViewCommit = true;
        c.Repo.CommitID = refName;
        c.Repo.Commit = await catFileCommit(repoDir, refName).catch(() => null);
        if (!c.Repo.Commit) {
          c.NotFound();
          return;
        }
      } else {
        c.NotFound();
        return;
      }
    }

    c.Repo.BranchName = refName;
    c.Repo.TreePath = treePath;
    c.Data['BranchName'] = refName;
    c.Data['CommitID'] = c.Repo.CommitID;
    c.Data['TreePath'] = treePath;
    c.Data['IsViewBranch'] = c.Repo.IsViewBranch;
    c.Data['IsViewTag'] = c.Repo.IsViewTag;
    c.Data['IsViewCommit'] = c.Repo.IsViewCommit;

    // pull request context
    if (c.Repo.IsWriter() || repo.enable_pulls) {
      c.Repo.PullRequest.Allowed = c.Repo.IsWriter();
      c.Data['PullRequestCtx'] = c.Repo.PullRequest;
      if (c.Repo.IsWriter()) {
        c.Data['BaseRepo'] = repo;
        c.Repo.PullRequest.BaseRepo = repo;
        c.Repo.PullRequest.SameRepo = true;
        c.Repo.PullRequest.HeadInfo = (c.Repo.Owner?.name ?? '') + ':' + refName;
      }
    }
  };
}

/** InjectParamsUser middleware: resolves :username to c.Data ContextUser. */
export function InjectParamsUser() {
  return (c: Context) => {
    const user = db.getUserByUsername(c.Params(':username'));
    if (user === null) {
      c.NotFound();
      return;
    }
    c.Data['ContextUser'] = user;
    (c as any).ContextUser = user;
  };
}

/** Finalize sign-in session (gogs completeSignIn). */
export function completeSignIn(c: Context, u: User): void {
  c.session.Set('uid', u.id);
  c.session.Set('uname', u.name);
  c.session.Delete('mfaUserID');
  c.session.Release();
  if (conf.enableLoginStatusCookie) {
    c.SetCookie(conf.loginStatusCookieName, 'true', 0);
  }
}
