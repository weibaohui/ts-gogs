// HTTP server: request pipeline wiring session/context/router/static/SPA,
// mirroring cmd/gogs/internal/web/web.go dispatch order.
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { conf } from './conf.js';
import { loadTemplates, Context, Session, ignSignIn, Contexter, setServeWebHandler } from './context.js';
import { i18n } from './i18n.js';
import { registerWebRoutes } from './routes/index.js';
import { registerAPIRoutes } from './api/v1.js';
import { handleWebAPI } from './webapi.js';
import { handleGitHTTP } from './gitx/http.js';
import { md5 } from './authx/password.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

function serveFile(res: http.ServerResponse, file: string, cacheForever = true): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    const ext = path.extname(file).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
    if (cacheForever) {
      res.setHeader('Cache-Control', 'public, max-age=31536000');
    }
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function serveStaticPrefix(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  // static roots, mirroring macaron.Static registration order
  for (const [prefix, dir] of [
    ['/css/', path.join(conf.workDir, 'public', 'css')],
    ['/js/', path.join(conf.workDir, 'public', 'js')],
    ['/img/', path.join(conf.workDir, 'public', 'img')],
    ['/plugins/', path.join(conf.workDir, 'public', 'plugins')],
    ['/assets/', path.join(conf.workDir, 'public', 'assets')],
    ['/less/', path.join(conf.workDir, 'public', 'less')],
  ] as const) {
    if (pathname.startsWith(prefix)) {
      const rel = pathname.slice(prefix.length);
      const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
      return serveFile(res, path.join(dir, safe));
    }
  }
  // custom public overrides first
  const customDir = path.join(conf.customDir, 'public');
  if (fs.existsSync(customDir)) {
    const rel = pathname.replace(/^\/+/, '');
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    if (safe && serveFile(res, path.join(customDir, safe))) return true;
  }
  return false;
}

/** Serve the SPA shell (public/dist/index.html) with WebContext substitution. */
function serveSPA(c: Context, statusCode = 200): void {
  const distDir = path.join(conf.workDir, 'public', 'dist');
  const pathname = c.Path();
  // static assets from dist
  if (pathname.startsWith('/assets/') || pathname.startsWith('/src/') || pathname.startsWith('/img/')) {
    const rel = pathname.replace(/^\/+/, '');
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    if (pathname.startsWith('/img/') && serveFile(c.res, path.join(conf.workDir, 'public', safe), false)) return;
    if (serveFile(c.res, path.join(distDir, safe))) return;
    if (pathname.startsWith('/img/') && serveFile(c.res, path.join(distDir, safe), false)) return;
  }
  const indexFile = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    c.res.statusCode = 404;
    c.res.end('404 page not found');
    return;
  }
  let html = fs.readFileSync(indexFile, 'utf8');
  const payload = JSON.stringify({ lang: c.lang, subURL: conf.subpath }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const script = `<script>window.__webContext=${payload};document.documentElement.lang=window.__webContext.lang;</script>`;
  html = html.replace('{{.WebContext}}', script);
  if (conf.subpath !== '') {
    html = html
      .replaceAll('src="./assets/', `src="${conf.subpath}/assets/`)
      .replaceAll('href="./assets/', `href="${conf.subpath}/assets/`)
      .replaceAll('src="/src/', `src="${conf.subpath}/src/`)
      .replaceAll('href="/img/', `href="${conf.subpath}/img/`);
  }
  c.res.setHeader('Cache-Control', 'no-store');
  c.res.setHeader('Content-Type', 'text/html; charset=utf-8');
  c.res.statusCode = statusCode;
  c.res.end(html);
}

let router: import('./router.js').Router;

export async function startServer(): Promise<http.Server> {
  loadTemplates(conf.workDir);
  setServeWebHandler((c, status) => serveSPA(c, status));

  // i18n load
  const langs = conf.i18nLangs.length
    ? conf.i18nLangs
    : fs
        .readdirSync(path.join(conf.workDir, 'vendored-conf', 'locale'))
        .filter((f) => f.startsWith('locale_') && f.endsWith('.ini'))
        .map((f) => f.slice(7, -4));
  const names = conf.i18nNames.length ? conf.i18nNames : langs;
  i18n.load(path.join(conf.workDir, 'vendored-conf'), langs, names, conf.customDir);

  const { Router } = await import('./router.js');
  router = new Router();
  registerWebRoutes(router);
  registerAPIRoutes(router);

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (e: any) {
      console.error('[server panic]', e?.stack ?? e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end('Internal server error');
    }
  });

  return new Promise((resolve) => {
    server.listen(conf.httpPort, conf.httpAddr, () => resolve(server));
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  let pathname = decodeURIComponent(url.pathname);
  if (conf.subpath && pathname.startsWith(conf.subpath + '/')) {
    pathname = pathname.slice(conf.subpath.length);
  } else if (conf.subpath && pathname === conf.subpath) {
    pathname = '/';
  }

  // internal: /-/api/sanitize_ipynb (bluemonday-style ipynb HTML sanitizer)
  if (pathname === '/-/api/sanitize_ipynb' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const { sanitizeHTML } = await import('./markup.js');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(sanitizeHTML(Buffer.concat(chunks).toString('utf8')));
    return;
  }

  // internal: /-/metrics (prometheus text format; gated by [prometheus] ENABLED)
  if (pathname === '/-/metrics' && req.method === 'GET') {
    if (!conf.prometheusEnabled) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (conf.prometheusEnableBasicAuth) {
      const expected = 'Basic ' + Buffer.from('gogsmetrics:gogsplant').toString('base64');
      if (req.headers.authorization !== expected) {
        res.statusCode = 401;
        res.end();
        return;
      }
    }
    const { renderMetrics } = await import('./metrics.js');
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.end(renderMetrics());
    return;
  }

  // healthcheck
  if (pathname === '/healthcheck' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.statusCode = 200;
    res.end(req.method === 'HEAD' ? undefined : '* Database connection: OK\n');
    return;
  }

  // redirect helper (flamego)
  if (pathname === '/redirect') {
    let to = url.searchParams.get('to') ?? '';
    if (!to.startsWith('/') || to.startsWith('//')) to = conf.subpath + '/';
    res.statusCode = 303;
    res.setHeader('Location', to);
    res.end();
    return;
  }
  if (pathname === '/robots.txt') {
    const f = path.join(conf.customDir, 'robots.txt');
    if (fs.existsSync(f)) {
      serveFile(res, f, false);
    } else {
      res.statusCode = 404;
      res.end();
    }
    return;
  }

  // git smart HTTP: /:username/:reponame(.git)(.wiki)/...
  if (handleGitHTTP(req, res, pathname)) return;

  const c = new Context(req, res);
  const session = new Session(cookieValue(req, conf.cookieUserName));
  c.init(session);

  // flash cookie read
  c.flash.readFromCookie(cookieValue(req, 'macaron_flash'));

  // macaron writes session/flash cookies just before the response flushes
  const origEnd = res.end.bind(res);
  (res as any).end = (...args: any[]) => {
    if (!res.headersSent) {
      const maxAge = 86400 * conf.loginRememberDays;
      c.SetCookie(conf.cookieUserName, session.sid, maxAge);
      if (c.flash.hasWrites()) {
        c.SetCookie('macaron_flash', c.flash.encoded(), 0);
      }
    }
    return (origEnd as any)(...args);
  };

  // global Contexter (i18n + session auth + common Data), like macaron global middleware
  await Contexter()(c);

  // API v1?
  if (pathname === '/api' || pathname.startsWith('/api/v1') || pathname.startsWith('/api/v1/')) {
    const match = router.match(req.method ?? 'GET', pathname);
    if (match) {
      c.params = match.params;
      await runChain(match.route.handlers, c);
      finalize(c);
      return;
    }
    res.statusCode = 404;
    res.end();
    return;
  }

  // captcha image (flamego/captcha equivalent)
  if (pathname.startsWith('/captcha/')) {
    const { newCaptcha } = await import('./toolx.js');
    const { id, svg } = newCaptcha();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', `gogs_captcha=${id}; Path=${conf.subpath || '/'}; HttpOnly`);
    res.end(svg);
    return;
  }

  // SPA web API
  if (pathname.startsWith('/api/web/')) {
    const handled = await handleWebAPI(c, pathname.slice('/api/web'.length));
    if (handled) {
      finalize(c);
      return;
    }
  }

  // avatar endpoints
  const avatarMatch = /^\/user\/avatar\/([0-9a-f]{32})$/.exec(pathname);
  if (avatarMatch) {
    res.statusCode = 302;
    res.setHeader('Location', `${conf.gravatarSource}${avatarMatch[1]}?d=identicon`);
    res.end();
    return;
  }
  const customAvatarMatch = /^\/user\/avatars\/(\d+)$/.exec(pathname);
  if (customAvatarMatch) {
    if (serveFile(res, path.join(conf.avatarUploadPath, customAvatarMatch[1]), false)) return;
    res.statusCode = 302;
    res.setHeader('Location', conf.subpath + '/img/avatar_default.png');
    res.end();
    return;
  }
  const repoAvatarMatch = /^\/repo-avatars\/([0-9a-f]{40})$/.exec(pathname);
  if (repoAvatarMatch) {
    if (serveFile(res, path.join(conf.repositoryAvatarUploadPath, repoAvatarMatch[1]), false)) return;
    res.statusCode = 302;
    res.setHeader('Location', conf.subpath + '/img/avatar_default.png');
    res.end();
    return;
  }

  // go-get meta (gogs ServeGoGet): quick response regardless of repo existence
  if (url.searchParams.get('go-get') === '1') {
    const m = /^\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (m) {
      const [, ownerName, repoName] = m;
      let branchName = 'master';
      const owner = (await import('./db/db.js')).getUserByUsername(ownerName);
      const repo = owner ? (await import('./db/db.js')).getRepoByOwnerAndName(owner, repoName) : null;
      if (repo && repo.default_branch) branchName = repo.default_branch;
      const prefix = conf.externalURL + [ownerName, repoName, 'src', branchName].join('/');
      const goGetImport = conf.url.host + (conf.subpath || '') + '/' + ownerName + '/' + repoName;
      const cloneLink = conf.externalURL + path.posix.join(ownerName, repoName) + '.git';
      const insecureFlag = conf.externalURL.startsWith('https://') ? '' : '--insecure ';
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.statusCode = 200;
      res.end(`<!doctype html>
<html>
\t<head>
\t\t<meta name="go-import" content="${goGetImport} git ${cloneLink}">
\t\t<meta name="go-source" content="${goGetImport} _ ${prefix}{/dir} ${prefix}{/dir}/{file}#L{line}">
\t</head>
\t<body>
\t\tgo get ${insecureFlag}${goGetImport}
\t</body>
</html>
`);
      return;
    }
  }

  // route table
  const match = router.match(req.method ?? 'GET', pathname);
  if (match) {
    c.params = match.params;
    await runChain(match.route.handlers, c);
    finalize(c);
    return;
  }

  // static assets
  if (serveStaticPrefix(req, res, pathname)) return;

  // SPA catch-all
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveSPA(c, 200);
    return;
  }

  res.statusCode = 404;
  res.end();
}

function cookieValue(req: http.IncomingMessage, name: string): string | undefined {
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

async function runChain(handlers: ((c: Context) => void | Promise<void>)[], c: Context): Promise<void> {
  for (const h of handlers) {
    if (c.rendered) return;
    await h(c);
  }
}

/** After handlers: release session back to the store. */
function finalize(c: Context): void {
  c.session.Release();
}

export { serveFile };
