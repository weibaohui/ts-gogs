// Admin routes.
import * as fs from 'node:fs';
import type { Context } from '../context.js';
import { conf } from '../conf.js';
import * as db from '../db/db.js';
import { newPaginater } from './home.js';
import * as osMod from 'node:os';

function osStats() {
  const mem = process.memoryUsage();
  return {
    NumGoroutine: 1,
    NumCPU: osMod.cpus().length,
    MemAllocated: mem.heapUsed,
    MemSys: mem.rss,
    Uptime: Math.floor(process.uptime()),
    HeapAlloc: mem.heapUsed,
    HeapSys: mem.heapTotal,
    HeapIdle: mem.heapTotal - mem.heapUsed,
    HeapInuse: mem.heapUsed,
    HeapReleased: 0,
    HeapObjects: 0,
    BuckHashSys: 0,
    GCSys: 0,
    MSpanInuse: 0,
    MCacheInuse: 0,
    MemMallocs: 0,
    MemFrees: 0,
    Lookups: 0,
    LastGC: new Date().toISOString(),
    NextGC: 0,
    PauseTotalNs: 0,
    MemTotal: mem.rss + mem.external,
    OtherSys: mem.external,
    StackInuse: 0,
    StackSys: 0,
    NumGC: 0,
    PauseNs: 0,
  };
}

export async function Dashboard(c: Context): Promise<void> {
  c.Title('admin.dashboard');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminDashboard'] = true;
  const counter = {
    User: (db.db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 0').get() as any).c,
    Org: (db.db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 1').get() as any).c,
    PublicKey: (db.db().prepare('SELECT COUNT(*) AS c FROM public_key').get() as any).c,
    Repo: (db.db().prepare('SELECT COUNT(*) AS c FROM repository').get() as any).c,
    Watch: (db.db().prepare('SELECT COUNT(*) AS c FROM watch').get() as any).c,
    Star: (db.db().prepare('SELECT COUNT(*) AS c FROM star').get() as any).c,
    Action: (db.db().prepare('SELECT COUNT(*) AS c FROM action').get() as any).c,
    Access: (db.db().prepare('SELECT COUNT(*) AS c FROM access').get() as any).c,
    Issue: (db.db().prepare('SELECT COUNT(*) AS c FROM issue').get() as any).c,
    Comment: (db.db().prepare('SELECT COUNT(*) AS c FROM comment').get() as any).c,
    Oauth: 0,
    Follow: (db.db().prepare('SELECT COUNT(*) AS c FROM follow').get() as any).c,
    Mirror: (db.db().prepare('SELECT COUNT(*) AS c FROM mirror').get() as any).c,
    Release: (db.db().prepare('SELECT COUNT(*) AS c FROM release').get() as any).c,
    LoginSource: (db.db().prepare('SELECT COUNT(*) AS c FROM login_source').get() as any).c,
    Webhook: (db.db().prepare('SELECT COUNT(*) AS c FROM webhook').get() as any).c,
    Milestone: (db.db().prepare('SELECT COUNT(*) AS c FROM milestone').get() as any).c,
    Label: (db.db().prepare('SELECT COUNT(*) AS c FROM label').get() as any).c,
    HookTask: (db.db().prepare('SELECT COUNT(*) AS c FROM hook_task').get() as any).c,
    Team: (db.db().prepare('SELECT COUNT(*) AS c FROM team').get() as any).c,
    UpdateTask: 0,
    Attachment: (db.db().prepare('SELECT COUNT(*) AS c FROM attachment').get() as any).c,
  };
  c.Data['Stats'] = { Counter: counter };
  c.Data['OsStats'] = osStats();
  c.Data['SysStatus'] = osStats();
  try {
    const { gitVersion } = await import('../gitx/git.js');
    c.Data['GitVersion'] = await gitVersion();
  } catch {
    c.Data['GitVersion'] = '';
  }
  c.Data['GoVersion'] = process.version.replace('v', 'go');
  c.Data['BuildCommit'] = conf.buildCommit;
  c.Data['BuildTime'] = conf.buildTime;
  c.Success('admin/dashboard');
}

export async function Operation(c: Context): Promise<void> {
  const form = await c.form();
  const op = String(form.op ?? '');
  if (op === 'delete_repo_activities') {
    db.db().prepare('DELETE FROM action WHERE id > 0').run();
    c.flash.Success(c.Tr('admin.dashboard.delete_repo_activities_success'));
  } else if (op === 'update_mirror') {
    setImmediate(async () => {
      try {
        const mirrors = db.db().prepare('SELECT repo_id FROM mirror').all() as any[];
        const { syncMirror } = await import('../mirror.js');
        for (const m of mirrors) {
          try {
            const repo = db.getRepoByID(m.repo_id);
            if (repo) await syncMirror(m.repo_id, repo.owner_id);
          } catch (e) {
            console.error('[admin update_mirror]', e);
          }
        }
      } catch (e) {
        console.error('[admin update_mirror]', e);
      }
    });
    c.flash.Success(c.Tr('admin.dashboard.operation_success'));
  } else if (op === 'sync_repo_statistics') {
    // refresh issue/pull counters for every repository
    const ids = db.db().prepare('SELECT id FROM repository').all() as any[];
    for (const { id } of ids) {
      db.refreshIssueCounts(id);
      db.refreshMilestoneCounts(id);
    }
    c.flash.Success(c.Tr('admin.dashboard.operation_success'));
  }
  c.Redirect(conf.subpath + '/admin');
}

export async function Config(c: Context): Promise<void> {
  c.Title('admin.config');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminConfig'] = true;
  const i = conf;
  c.Data['App'] = { BrandName: i.brandName, RunUser: i.runUser, RunMode: i.runMode };
  c.Data['Mode'] = i.runMode;
  c.Data['Config'] = i.customConf;
  c.Data['Server'] = {
    Protocol: i.protocol, Domain: i.domain, HTTPAddr: i.httpAddr, HTTPPort: i.httpPort,
    ExternalURL: i.externalURL, AppURL: i.externalURL, OfflineMode: i.offlineMode,
    DisableRouterLog: i.disableRouterLog, AppDataPath: i.appDataPath, StaticRootPath: i.staticRootPath,
    ReverseProxyUser: i.reverseProxyAuthUserHeader,
    CertFile: 'custom/https/cert.pem', KeyFile: 'custom/https/key.pem', TLSMinVersion: 'TLS12',
    UnixSocketMode: '666', LocalRootURL: i.localRootURL, LandingURL: i.landingURL,
    CommitsFetchConcurrency: 0,
  };
  c.Data['LogRootPath'] = i.customDir;
  c.Data['Repository'] = { Root: i.repositoryRoot, ScriptType: i.scriptType, ForcePrivate: i.forcePrivate, MaxCreationLimit: i.maxCreationLimit, PreferredLicenses: i.preferredLicenses, DisableHTTPGit: i.disableHTTPGit, DefaultBranch: i.defaultBranch,
    Editor: { LineWrapExtensions: '.txt,.md,.markdown,.mdown,.mkd', PreviewableFileModes: 'markdown' },
    Upload: { TempPath: i.uploadTempPath, AllowedTypes: '', MaxSize: i.uploadFileMaxSize, MaxFiles: i.uploadMaxFiles },
    CommitsFetchConcurrency: 0,
  };
  c.Data['Database'] = { Type: i.dbType, Host: i.dbHost, Name: i.dbName, User: i.dbUser, SSLMode: 'disable', Path: i.dbPath, MaxOpenConns: 30, MaxIdleConns: 30, Schema: '' };
  c.Data['Security'] = { InstallLock: i.installLock, LoginRememberDays: i.loginRememberDays, LoginStatusCookieName: i.loginStatusCookieName, EnableLoginStatusCookie: i.enableLoginStatusCookie, LocalNetworkAllowlist: '' };
  c.Data['Auth'] = {
    ActivateCodeLives: i.activateCodeLives, ResetPasswordCodeLives: i.resetPwdCodeLives,
    RequireEmailConfirmation: i.requireEmailConfirmation, RequireSigninView: i.requireSigninView,
    DisableRegistration: i.disableRegistration, EnableRegistrationCaptcha: i.enableRegistrationCaptcha,
    ReverseProxyAuthenticationHeader: i.reverseProxyAuthUserHeader, CustomLogoutURL: '',
    TrustedProxyIPs: [],
  };
  c.Data['Email'] = { Enabled: false, Host: '', From: '', User: '', SubjectPrefix: '', HELOHostname: '', CertFile: '', KeyFile: '' };
  c.Data['Session'] = { Provider: i.sessionProvider, Config: i.sessionConfig, CookieSecure: i.sessionCookieSecure, CookieName: i.cookieUserName, GCInterval: 3600, MaxLifeTime: 604800 };
  c.Data['Cache'] = { Adapter: 'memory', Interval: 60 };
  c.Data['CacheConn'] = '';
  c.Data['HTTP'] = { AccessControlAllowOrigin: '' };
  c.Data['Picture'] = { GravatarSource: i.gravatarSource, DisableGravatar: i.disableGravatar, EnableFederatedAvatar: i.enableFederatedAvatar, AvatarUploadPath: i.avatarUploadPath, RepositoryAvatarUploadPath: i.repositoryAvatarUploadPath };
  c.Data['Attachment'] = { Path: i.uploadTempPath, AllowedTypes: '', MaxSize: i.uploadFileMaxSize, MaxFiles: i.uploadMaxFiles };
  c.Data['Release'] = { Attachment: { Path: i.uploadTempPath, AllowedTypes: '', MaxSize: i.uploadFileMaxSize, MaxFiles: i.uploadMaxFiles } };
  c.Data['Time'] = { FormatLayout: i.timeFormatLayout, FormatJS: i.timeFormatJS };
  c.Data['Markdown'] = { Enabled: true, FileExtensions: i.markdownFileExtensions.join(', '), CustomURLSchemes: i.customURLSchemes.join(', ') };
  c.Data['Smartypants'] = { Enabled: false, Fractions: true, AngledQuotes: false, LaTeXDashes: true };
  c.Data['Webhook'] = { Types: i.webhookTypes.join(', '), DeliverTimeout: i.deliverTimeout, SkipVerify: i.skipVerify, PagingNum: i.pagingNum };
  c.Data['Mirror'] = { DefaultInterval: i.defaultMirrorInterval };
  c.Data['Git'] = {
    Version: c.Data['GitVersion'] ?? '', MaxDiffFiles: i.maxDiffFiles, MaxDiffLines: i.maxDiffLines, MaxDiffLineChars: i.maxDiffLineCharacters,
    GCArgs: '', Timeout: { Migrate: i.gitTimeoutMigrate, Mirror: i.gitTimeoutMirror, Clone: i.gitTimeoutClone, Pull: i.gitTimeoutPull, GC: i.gitTimeoutGC },
  };
  c.Data['SSH'] = {
    Domain: i.sshDomain, Port: i.sshPort, ListenHost: '0.0.0.0', ListenPort: i.sshPort,
    RootPath: i.customDir, KeygenPath: 'ssh-keygen', KeyTestPath: '',
    MinimumKeySizeCheck: false, MinimumKeySizes: [],
    ServerCiphers: '', ServerMACs: '', ServerAlgorithms: '',
  };
  c.Data['LFS'] = { ObjectsPath: 'data/lfs-objects', Storage: 'local' };
  c.Data['Cron'] = { UpdateMirrors: false, RepoHealthCheck: false, CheckRepoStats: false, RepoArchiveCleanup: false };
  c.Data['Loggers'] = [];
  c.Data['Attachment.AllowedTypes'] = '';
  c.Data['Other'] = { ShowFooterBranding: i.showFooterBranding, ShowFooterTemplateLoadTime: i.showFooterTemplateLoadTime };
  c.Data['AppDataPath'] = i.appDataPath;
  c.Data['RepoRootPath'] = i.repositoryRoot;
  c.Success('admin/config');
}

export async function SendTestMail(c: Context): Promise<void> {
  if (!conf.emailEnabled) {
    c.flash.Error(c.Tr('admin.config.email_not_enabled'));
    c.Redirect(conf.subpath + '/admin/config');
    return;
  }
  try {
    const { sendMail } = await import('../mailer.js');
    await sendMail({
      from: conf.emailFrom,
      to: c.User!.email,
      subject: 'Gogs Test Email!',
      body: '<p>This is a test email sent by Gogs.</p>',
    });
    c.flash.Success(c.Tr('admin.config.email_test_success', c.User!.email));
  } catch (e: any) {
    c.flash.Error(c.Tr('admin.config.email_test_failed') + ': ' + String(e?.message ?? e));
  }
  c.Redirect(conf.subpath + '/admin/config');
}

export async function Monitor(c: Context): Promise<void> {
  c.Title('admin.monitor');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminMonitor'] = true;
  c.Data['OsStats'] = osStats();
  c.Data['Processes'] = [];
  c.Data['Queues'] = [];
  c.Success('admin/monitor');
}

export async function Users(c: Context): Promise<void> {
  c.Title('admin.users');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminUsers'] = true;
  const page = Math.max(1, c.QueryInt('page'));
  const size = 50;
  const total = (db.db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 0').get() as any).c;
  const rows = db.db().prepare('SELECT * FROM user WHERE type = 0 ORDER BY id LIMIT ? OFFSET ?').all(size, (page - 1) * size) as any[];
  c.Data['Users'] = rows.map((r) => new db.User(r));
  c.Data['Total'] = total;
  c.Data['Page'] = newPaginater(total, size, page, 5);
  c.Success('admin/user/list');
}

export async function NewUser(c: Context): Promise<void> {
  c.Title('admin.users.new_account');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminUsers'] = true;
  c.Success('admin/user/new');
}

export async function NewUserPost(c: Context): Promise<void> {
  const form = await c.form();
  try {
    const user = db.createUser(String(form.username ?? ''), String(form.email ?? ''), {
      fullName: String(form.full_name ?? ''),
      password: String(form.password ?? ''),
      location: String(form.location ?? ''),
      website: String(form.website ?? ''),
      activated: String(form.active ?? '') === 'on',
      admin: String(form.admin ?? '') === 'on',
    });
    c.flash.Success(c.Tr('admin.users.new_success', user.name));
    c.Redirect(conf.subpath + '/admin/users');
  } catch (e: any) {
    c.RenderWithErr(String(e.message ?? e), 'admin/user/new');
  }
}

export async function EditUser(c: Context): Promise<void> {
  const user = db.getUserByID(c.ParamsInt64(':userid'));
  if (!user) {
    c.NotFound();
    return;
  }
  c.Title('admin.users.edit_account');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminUsers'] = true;
  c.Data['EditUser'] = user;
  c.Success('admin/user/edit');
}

export async function EditUserPost(c: Context): Promise<void> {
  const user = db.getUserByID(c.ParamsInt64(':userid'));
  if (!user) {
    c.NotFound();
    return;
  }
  const form = await c.form();
  const cols: Record<string, any> = {
    full_name: String(form.full_name ?? ''),
    email: String(form.email ?? user.email),
    location: String(form.location ?? ''),
    website: String(form.website ?? ''),
    is_active: String(form.active ?? '') === 'on' ? 1 : 0,
    is_admin: String(form.admin ?? '') === 'on' ? 1 : 0,
    allow_git_hook: String(form.allow_git_hook ?? '') === 'on' ? 1 : 0,
    allow_import_local: String(form.allow_import_local ?? '') === 'on' ? 1 : 0,
    prohibit_login: String(form.prohibit_login ?? '') === 'on' ? 1 : 0,
    max_repo_creation: Number(form.max_repo_creation ?? -1) || -1,
  };
  const newPwd = String(form.password ?? '');
  if (newPwd) {
    const { encodePassword, randomSalt } = await import('../authx/password.js');
    const salt = randomSalt();
    cols['passwd'] = encodePassword(newPwd, salt);
    cols['salt'] = salt;
  }
  db.updateUserColumns(user.id, cols);
  c.flash.Success(c.Tr('admin.users.update_profile_success'));
  c.Redirect(conf.subpath + `/admin/users/${user.id}`);
}

export async function DeleteUser(c: Context): Promise<void> {
  const user = db.getUserByID(c.ParamsInt64(':userid'));
  if (!user) {
    c.NotFound();
    return;
  }
  if (db.countUserRepos(user.id) > 0) {
    c.flash.Error(c.Tr('form.user_still_own_repo'));
    c.Redirect(conf.subpath + '/admin/users');
    return;
  }
  for (const sql of [
    'DELETE FROM user WHERE id = ?',
    'DELETE FROM email_address WHERE uid = ?',
    'DELETE FROM follow WHERE user_id = ? OR follow_id = ?',
    'DELETE FROM org_user WHERE uid = ?',
    'DELETE FROM team_user WHERE uid = ?',
    'DELETE FROM access_token WHERE uid = ?',
    'DELETE FROM public_key WHERE owner_id = ?',
    'DELETE FROM collaboration WHERE user_id = ?',
    'DELETE FROM watch WHERE user_id = ?',
    'DELETE FROM star WHERE uid = ?',
  ]) {
    const args = sql.includes('follow WHERE') ? [user.id, user.id] : [user.id];
    db.db().prepare(sql).run(...args);
  }
  db.createNotice(`Deleted user: ${user.name}`);
  c.flash.Success(c.Tr('admin.users.deletion_success'));
  c.Redirect(conf.subpath + '/admin/users');
}

export async function Organizations(c: Context): Promise<void> {
  c.Title('admin.organizations');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminOrganizations'] = true;
  const page = Math.max(1, c.QueryInt('page'));
  const size = 50;
  const total = (db.db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 1').get() as any).c;
  const rows = db.db().prepare('SELECT * FROM user WHERE type = 1 ORDER BY id LIMIT ? OFFSET ?').all(size, (page - 1) * size) as any[];
  c.Data['Orgs'] = rows.map((r) => new db.User(r));
  c.Data['Total'] = total;
  c.Data['Page'] = newPaginater(total, size, page, 5);
  c.Success('admin/org/list');
}

export async function Repos(c: Context): Promise<void> {
  c.Title('admin.repositories');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminRepositories'] = true;
  const page = Math.max(1, c.QueryInt('page'));
  const size = 50;
  const total = (db.db().prepare('SELECT COUNT(*) AS c FROM repository').get() as any).c;
  const rows = db.db().prepare('SELECT * FROM repository ORDER BY id LIMIT ? OFFSET ?').all(size, (page - 1) * size) as any[];
  c.Data['Repos'] = rows.map((r) => {
    const repo = new db.Repository(r);
    repo.owner = db.getUserByID(repo.owner_id) ?? undefined;
    return repo;
  });
  c.Data['Total'] = total;
  c.Data['Page'] = newPaginater(total, size, page, 5);
  c.Success('admin/repo/list');
}

export async function DeleteRepo(c: Context): Promise<void> {
  const form = await c.form();
  const repoID = Number(form.id ?? 0);
  const repo = db.getRepoByID(repoID);
  if (repo) {
    fs.rmSync(repo.RepoPath(), { recursive: true, force: true });
    fs.rmSync(repo.WikiPath(), { recursive: true, force: true });
    for (const sql of [
      'DELETE FROM repository WHERE id = ?',
      'DELETE FROM issue WHERE repo_id = ?',
      'DELETE FROM collaboration WHERE repo_id = ?',
      'DELETE FROM watch WHERE repo_id = ?',
      'DELETE FROM star WHERE repo_id = ?',
      'DELETE FROM webhook WHERE repo_id = ?',
      'DELETE FROM hook_task WHERE repo_id = ?',
      'DELETE FROM release WHERE repo_id = ?',
      'DELETE FROM milestone WHERE repo_id = ?',
      'DELETE FROM label WHERE repo_id = ?',
      'DELETE FROM protect_branch WHERE repo_id = ?',
      'DELETE FROM mirror WHERE repo_id = ?',
      'DELETE FROM action WHERE repo_id = ?',
    ]) {
      db.db().prepare(sql).run(repoID);
    }
    const issues = db.db().prepare('SELECT id FROM issue WHERE repo_id = ?').all(repoID) as any[];
    for (const i of issues) {
      db.db().prepare('DELETE FROM comment WHERE issue_id = ?').run(i.id);
      db.db().prepare('DELETE FROM issue_label WHERE issue_id = ?').run(i.id);
      db.db().prepare('DELETE FROM issue_user WHERE issue_id = ?').run(i.id);
      db.db().prepare('DELETE FROM pull_request WHERE issue_id = ?').run(i.id);
    }
    db.db().prepare('UPDATE user SET num_repos = MAX(num_repos - 1, 0) WHERE id = ?').run(repo.owner_id);
    db.createNotice(`Deleted repository: ${repo.FullName()}`);
    c.flash.Success(c.Tr('admin.repositories.deletion_success'));
  }
  c.Redirect(conf.subpath + '/admin/repos');
}

export async function Notices(c: Context): Promise<void> {
  c.Title('admin.notices');
  c.Data['PageIsAdmin'] = true;
  c.Data['PageIsAdminNotices'] = true;
  const page = Math.max(1, c.QueryInt('page'));
  const { total, notices } = db.listNotices(page, 25);
  c.Data['Notices'] = notices;
  c.Data['Total'] = total;
  c.Data['Page'] = newPaginater(total, 25, page, 5);
  c.Success('admin/notice');
}

export async function DeleteNotices(c: Context): Promise<void> {
  const form = await c.form();
  const ids = String(form.ids ?? '').split(',').map(Number).filter(Boolean);
  for (const id of ids) {
    db.db().prepare('DELETE FROM notice WHERE id = ?').run(id);
  }
  c.Redirect(conf.subpath + '/admin/notices');
}

export async function EmptyNotices(c: Context): Promise<void> {
  db.db().prepare('DELETE FROM notice').run();
  c.Redirect(conf.subpath + '/admin/notices');
}
