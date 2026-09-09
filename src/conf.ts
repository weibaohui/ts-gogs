// Configuration loading, mirroring gogs internal/conf semantics:
// vendored defaults (vendored-conf/app.ini) overlaid by custom/conf/app.ini,
// %(VAR)s interpolation, ExternalURL/Subpath normalization, absolute paths.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { parse as parseIni } from 'ini';

function toBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return v.toLowerCase() === 'true' || v === '1';
}
function toInt(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export class Conf {
  /** raw merged ini sections (uppercase keys) */
  raw: Record<string, Record<string, string>> = {};

  // [server]
  protocol = 'http';
  domain = 'localhost';
  httpAddr = '0.0.0.0';
  httpPort = 3000;
  externalURL = 'http://localhost:3000/';
  url!: URL;
  subpath = '';
  subpathDepth = 0;
  localRootURL = '';
  appDataPath = 'data';
  disableRouterLog = true;
  enableGzip = false;
  loadAssetsFromDisk = false;
  landingURL = '/';
  offlineMode = false;
  staticRootPath = '';
  // ssh
  disableSSH = false;
  sshDomain = 'localhost';
  sshPort = 22;
  startSSHServer = false;

  // [app]
  brandName = 'Gogs';
  runUser = '';
  runMode = 'prod';
  version = '0.13.0+dev';
  buildCommit = 'unknown';
  buildTime = 'unknown';

  // [database]
  dbType = 'sqlite3';
  dbPath = 'data/gogs.db';
  dbHost = '127.0.0.1:5432';
  dbName = 'gogs';
  dbUser = 'gogs';
  dbPassword = '';

  // [security]
  installLock = false;
  secretKey = '';
  loginRememberDays = 7;
  cookieRememberName = 'gogs_incredible';
  cookieUserName = 'i_like_gogs';
  reverseProxyAuthUserHeader = 'X-Forwarded-User';
  reverseProxyAuthEmailHeader = '';
  enableLoginStatusCookie = false;
  loginStatusCookieName = 'login_status';

  // [auth]
  requireSigninView = false;
  disableRegistration = false;
  enableRegistrationCaptcha = true;
  activateCodeLives = 180;
  resetPwdCodeLives = 180;
  requireEmailConfirmation = false;
  enableNotifyMail = false;
  enableReverseProxyAuthentication = false;
  enableReverseProxyAutoRegistration = false;
  showRegistrationButton = true;

  // [session]
  sessionProvider = 'memory';
  sessionConfig = 'data/sessions';
  sessionCookieSecure = false;

  // [repository]
  repositoryRoot = '';
  scriptType = 'bash';
  forcePrivate = false;
  maxCreationLimit = -1;
  preferredLicenses: string[] = [];
  disableHTTPGit = false;
  defaultBranch = 'master';
  uploadEnabled = true;
  uploadTempPath = 'data/tmp/uploads';
  uploadFileMaxSize = 3;
  uploadMaxFiles = 5;

  // [ui]
  explorePagingNum = 20;
  issuePagingNum = 10;
  feedsPagingNum = 20;
  userRepoPagingNum = 15;
  themeColorMetaTag = '#6cc644';
  maxDisplayFileSize = 8388608;

  // [api]
  maxResponseItems = 50;
  defaultGitTreesPerPage = 1000;

  // [picture]
  gravatarSource = 'https://gravatar.com/avatar/';
  disableGravatar = false;
  enableFederatedAvatar = false;
  avatarUploadPath = 'data/avatars';
  repositoryAvatarUploadPath = 'data/repo-avatars';

  // [time]
  timeFormatLayout = '2006-01-02 15:04:05';
  timeFormatJS = 'YYYY-MM-DD HH:mm:ss';
  timeZone = '';

  // [markdown]
  markdownFileExtensions = ['.md', '.markdown', '.mdown', '.mkd'];
  enableHardLineBreak = false;
  customURLSchemes: string[] = [];

  // [webhook]
  webhookTypes = ['gogs', 'slack', 'discord', 'dingtalk'];
  deliverTimeout = 5;
  skipVerify = false;
  pagingNum = 10;

  // [mirror]
  defaultMirrorInterval = 8;

  // [git]
  maxDiffFiles = 1000;
  maxDiffLines = 5000;
  maxDiffLineCharacters = 2000;
  gitTimeoutMigrate = 600;
  gitTimeoutMirror = 300;
  gitTimeoutClone = 300;
  gitTimeoutPull = 300;
  gitTimeoutGC = 60;

  // [i18n]
  i18nLangs: string[] = [];
  i18nNames: string[] = [];

  // [prometheus]
  prometheusEnabled = false;
  prometheusEnableBasicAuth = false;

  // [mailer]
  emailEnabled = false;
  emailHost = '';
  emailPort = 587;
  emailFrom = '';
  emailUser = '';
  emailPasswd = '';
  emailSkipVerify = false;
  emailUseTLS = true;
  emailSubjectPrefix = '[Gogs] ';

  // [other]
  showFooterBranding = false;
  showFooterTemplateLoadTime = true;

  /** resolved absolute paths */
  workDir!: string;
  customDir!: string;
  customConf!: string;

  private interpolate(value: string): string {
    return String(value ?? '').replace(/%\((\w+)\)s/g, (_m, key: string) => {
      const section = this.raw['DEFAULT'] ?? {};
      const server = this.raw['server'] ?? {};
      const v = section[key] ?? server[key];
      return typeof v === 'string' ? v : '';
    });
  }

  private sect(name: string): Record<string, string> {
    return this.raw[name] ?? {};
  }
  private get(name: string, key: string): string | undefined {
    const v = this.sect(name)[key];
    return v === undefined ? undefined : this.interpolate(v);
  }

  load(workDir: string, customDir: string, customConf?: string): void {
    this.workDir = workDir;
    this.customDir = customDir;
    this.customConf = customConf ?? path.join(customDir, 'conf', 'app.ini');

    // 1. vendored defaults
    const defaultIni = fs.readFileSync(path.join(workDir, 'vendored-conf', 'app.ini'), 'utf8');
    this.raw = parseIni(defaultIni) as any;

    // 2. custom overrides
    if (fs.existsSync(this.customConf)) {
      const custom = parseIni(fs.readFileSync(this.customConf, 'utf8')) as any;
      for (const [sect, kv] of Object.entries(custom)) {
        if (typeof kv !== 'object' || kv === null) {
          // top-level key → DEFAULT section
          this.raw['DEFAULT'] = this.raw['DEFAULT'] ?? {};
          this.raw['DEFAULT'][sect] = String(kv);
          continue;
        }
        if (!this.raw[sect] || typeof this.raw[sect] !== 'object') this.raw[sect] = {};
        Object.assign(this.raw[sect], kv);
      }
    }

    // 3. programmatic defaults & computed values
    this.brandName = this.get('app', 'BRAND_NAME') ?? 'Gogs';
    this.runUser = this.raw['DEFAULT']?.RUN_USER ?? this.get('server', 'RUN_USER') ?? process.env.USER ?? '';
    this.runMode = this.get('app', 'RUN_MODE') ?? 'prod';
    this.protocol = (this.get('server', 'PROTOCOL') ?? 'http').toLowerCase();
    this.domain = this.get('server', 'DOMAIN') ?? 'localhost';
    this.httpAddr = this.get('server', 'HTTP_ADDR') ?? '0.0.0.0';
    this.httpPort = toInt(this.get('server', 'HTTP_PORT'), 3000);

    let ext = this.get('server', 'EXTERNAL_URL') ?? '';
    if (!ext) ext = `${this.protocol}://${this.domain}:${this.httpPort}/`;
    if (!ext.endsWith('/')) ext += '/';
    this.externalURL = ext;
    this.url = new URL(this.externalURL);
    this.subpath = this.url.pathname.replace(/\/+$/, '');
    this.subpathDepth = this.subpath === '' ? 0 : this.subpath.split('/').length - 1;

    this.localRootURL = this.get('server', 'LOCAL_ROOT_URL') ?? `${this.protocol}://${this.httpAddr}:${this.httpPort}/`;
    this.appDataPath = this.ensureAbs(this.get('server', 'APP_DATA_PATH') ?? 'data');
    this.disableRouterLog = toBool(this.get('server', 'DISABLE_ROUTER_LOG'), true);
    this.enableGzip = toBool(this.get('server', 'ENABLE_GZIP'), false);
    this.loadAssetsFromDisk = toBool(this.get('server', 'LOAD_ASSETS_FROM_DISK'), false);
    this.landingURL = this.get('server', 'LANDING_URL') ?? '/';
    this.offlineMode = toBool(this.get('server', 'OFFLINE_MODE'), false);
    this.staticRootPath = path.join(this.workDir, 'public');

    this.disableSSH = toBool(this.get('server', 'DISABLE_SSH'), false);
    this.sshDomain = this.get('server', 'SSH_DOMAIN') ?? this.domain;
    this.sshPort = toInt(this.get('server', 'SSH_PORT'), 22);
    this.startSSHServer = toBool(this.get('server', 'START_SSH_SERVER'), false);

    this.dbType = (this.get('database', 'TYPE') ?? 'sqlite3').toLowerCase();
    this.dbPath = this.ensureAbs(this.get('database', 'PATH') ?? 'data/gogs.db');
    this.dbHost = this.get('database', 'HOST') ?? '127.0.0.1:5432';
    this.dbName = this.get('database', 'NAME') ?? 'gogs';
    this.dbUser = this.get('database', 'USER') ?? 'gogs';
    this.dbPassword = this.get('database', 'PASSWORD') ?? '';

    this.installLock = toBool(this.get('security', 'INSTALL_LOCK'), false);
    this.secretKey = this.get('security', 'SECRET_KEY') ?? '';
    this.loginRememberDays = toInt(this.get('security', 'LOGIN_REMEMBER_DAYS'), 7);
    this.cookieRememberName = this.get('security', 'COOKIE_REMEMBER_NAME') ?? 'gogs_incredible';
    this.cookieUserName = this.get('security', 'COOKIE_USERNAME') ?? 'i_like_gogs';
    this.enableLoginStatusCookie = toBool(this.get('security', 'ENABLE_LOGIN_STATUS_COOKIE'), false);
    this.loginStatusCookieName = this.get('security', 'LOGIN_STATUS_COOKIE_NAME') ?? 'login_status';

    this.requireSigninView = toBool(this.get('auth', 'REQUIRE_SIGNIN_VIEW'), false);
    this.disableRegistration = toBool(this.get('auth', 'DISABLE_REGISTRATION'), false);
    this.enableRegistrationCaptcha = toBool(this.get('auth', 'ENABLE_REGISTRATION_CAPTCHA'), true);
    this.requireEmailConfirmation = toBool(this.get('auth', 'REQUIRE_EMAIL_CONFIRMATION'), false);
    this.enableNotifyMail = toBool(this.get('auth', 'ENABLE_NOTIFY_MAIL'), false);

    this.sessionProvider = this.get('session', 'PROVIDER') ?? 'memory';
    this.sessionConfig = this.get('session', 'PROVIDER_CONFIG') ?? 'data/sessions';
    this.sessionCookieSecure = toBool(this.get('session', 'COOKIE_SECURE'), false);

    const root = this.get('repository', 'ROOT') ?? '';
    this.repositoryRoot = this.ensureAbs(root || path.join(os.homedir(), 'gogs-repositories'));
    this.scriptType = this.get('repository', 'SCRIPT_TYPE') ?? 'bash';
    this.forcePrivate = toBool(this.get('repository', 'FORCE_PRIVATE'), false);
    this.maxCreationLimit = toInt(this.get('repository', 'MAX_CREATION_LIMIT'), -1);
    this.preferredLicenses = (this.get('repository', 'PREFERRED_LICENSES') ?? 'Apache License 2.0, MIT License').split(',').map((s) => s.trim());
    this.disableHTTPGit = toBool(this.get('repository', 'DISABLE_HTTP_GIT'), false);
    this.defaultBranch = this.get('repository', 'DEFAULT_BRANCH') ?? 'master';
    this.uploadEnabled = toBool(this.get('repository.upload', 'ENABLED'), true);
    this.uploadTempPath = this.ensureAbs(this.get('repository.upload', 'TEMP_PATH') ?? 'data/tmp/uploads');
    this.uploadFileMaxSize = toInt(this.get('repository.upload', 'FILE_MAX_SIZE'), 3);
    this.uploadMaxFiles = toInt(this.get('repository.upload', 'MAX_FILES'), 5);

    this.explorePagingNum = toInt(this.get('ui', 'EXPLORE_PAGING_NUM'), 20);
    this.issuePagingNum = toInt(this.get('ui', 'ISSUE_PAGING_NUM'), 10);
    this.feedsPagingNum = toInt(this.get('ui', 'FEEDS_PAGING_NUM'), 20);
    this.userRepoPagingNum = toInt(this.get('ui.user', 'REPO_PAGING_NUM'), 15);
    this.themeColorMetaTag = this.get('ui', 'THEME_COLOR_META_TAG') ?? '#6cc644';
    this.maxDisplayFileSize = toInt(this.get('ui', 'MAX_DISPLAY_FILE_SIZE'), 8388608);

    this.maxResponseItems = toInt(this.get('api', 'MAX_RESPONSE_ITEMS'), 50);
    this.defaultGitTreesPerPage = toInt(this.get('api', 'DEFAULT_GIT_TREES_PER_PAGE'), 1000);

    this.gravatarSource = this.get('picture', 'GRAVATAR_SOURCE') ?? 'https://gravatar.com/avatar/';
    this.disableGravatar = toBool(this.get('picture', 'DISABLE_GRAVATAR'), false);
    this.enableFederatedAvatar = toBool(this.get('picture', 'ENABLE_FEDERATED_AVATAR'), false);
    this.avatarUploadPath = this.ensureAbs(this.get('picture', 'AVATAR_UPLOAD_PATH') ?? 'data/avatars');
    this.repositoryAvatarUploadPath = this.ensureAbs(
      this.get('picture', 'REPOSITORY_AVATAR_UPLOAD_PATH') ?? 'data/repo-avatars'
    );

    this.timeFormatLayout = this.get('time', 'FORMAT') ?? '2006-01-02 15:04:05';
    this.timeFormatJS = this.get('time', 'FORMAT_JS') ?? 'YYYY-MM-DD HH:mm:ss';

    const exts = this.get('markdown', 'FILE_EXTENSIONS');
    if (exts) {
      this.markdownFileExtensions = exts.split(',').map((s) => s.trim());
    }
    this.enableHardLineBreak = toBool(this.get('markdown', 'ENABLE_HARD_LINE_BREAK'), false);
    const schemes = this.get('markdown', 'CUSTOM_URL_SCHEMES');
    this.customURLSchemes = schemes ? schemes.split(',').map((s) => s.trim()) : [];

    this.deliverTimeout = toInt(this.get('webhook', 'DELIVER_TIMEOUT'), 5);
    this.skipVerify = toBool(this.get('webhook', 'SKIP_VERIFY'), false);
    this.pagingNum = toInt(this.get('webhook', 'PAGING_NUM'), 10);

    this.defaultMirrorInterval = toInt(this.get('mirror', 'DEFAULT_INTERVAL'), 8);

    this.maxDiffFiles = toInt(this.get('git', 'MAX_GIT_DIFF_FILES'), 1000);
    this.maxDiffLines = toInt(this.get('git', 'MAX_GIT_DIFF_LINES'), 5000);
    this.maxDiffLineCharacters = toInt(this.get('git', 'MAX_GIT_DIFF_LINE_CHARACTERS'), 2000);
    this.gitTimeoutMigrate = toInt(this.get('git.timeout', 'MIGRATE'), 600);
    this.gitTimeoutMirror = toInt(this.get('git.timeout', 'MIRROR'), 300);
    this.gitTimeoutClone = toInt(this.get('git.timeout', 'CLONE'), 300);
    this.gitTimeoutPull = toInt(this.get('git.timeout', 'PULL'), 300);
    this.gitTimeoutGC = toInt(this.get('git.timeout', 'GC'), 60);

    const langs = this.get('i18n', 'LANGS');
    const names = this.get('i18n', 'NAMES');
    this.i18nLangs = langs ? langs.split(',').map((s) => s.trim()) : [];
    this.i18nNames = names ? names.split(',').map((s) => s.trim()) : [];

    this.prometheusEnabled = toBool(this.get('prometheus', 'ENABLED'), false);
    this.prometheusEnableBasicAuth = toBool(this.get('prometheus', 'ENABLE_BASIC_AUTH'), false);

    this.emailEnabled = toBool(this.get('mailer', 'ENABLED'), false);
    this.emailHost = this.get('mailer', 'HOST') ?? '';
    this.emailPort = toInt(this.get('mailer', 'PORT'), 587);
    this.emailFrom = this.get('mailer', 'FROM') ?? '';
    this.emailUser = this.get('mailer', 'USER') ?? '';
    this.emailPasswd = this.get('mailer', 'PASSWD') ?? '';
    this.emailSkipVerify = toBool(this.get('mailer', 'SKIP_VERIFY'), false);
    this.emailUseTLS = toBool(this.get('mailer', 'USE_TLS'), true);
    this.emailSubjectPrefix = this.get('mailer', 'SUBJECT_PREFIX') ?? '[Gogs] ';

    this.showFooterBranding = toBool(this.get('other', 'SHOW_FOOTER_BRANDING'), false);
    this.showFooterTemplateLoadTime = toBool(this.get('other', 'SHOW_FOOTER_TEMPLATE_LOAD_TIME'), true);

    // generate a secret key for a fresh install if not present
    if (!this.secretKey) {
      this.secretKey = crypto.randomBytes(15).toString('hex');
    }
  }

  isProdMode(): boolean {
    return this.runMode === 'prod';
  }

  private ensureAbs(p: string): string {
    if (path.isAbsolute(p)) return p;
    return path.join(this.workDir, p);
  }

  homeDir(): string {
    return os.homedir();
  }
}

export const conf = new Conf();
