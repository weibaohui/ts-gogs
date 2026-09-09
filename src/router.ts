// macaron-compatible router: pattern syntax, ordered matching, groups with
// inherited middleware, HEAD auto-routing to GET handlers.
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (c: any) => void | Promise<void>;

interface Route {
  method: string; // uppercase, or "ANY"
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handlers: Handler[];
}

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let source: string;

  if (pattern.startsWith('^')) {
    // Full regex form, e.g. /^:type(issues|pulls)$ — :name(rx) becomes a named
    // capture; bare :name matches [^/]+; other chars literal.
    source = pattern.slice(1);
    source = source.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)\(((?:[^()\\]|\\.)*)\)/g, (_m, name, rx) => {
      paramNames.push(name);
      return `(${rx})`;
    });
    source = source.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_m, name) => {
      paramNames.push(name);
      return `([^/]+)`;
    });
    return { regex: new RegExp('^' + source + '$'), paramNames };
  }

  const segs = pattern.split('/');
  const parts: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '') {
      if (i === 0) parts.push('');
      continue;
    }
    if (seg === '*') {
      paramNames.push('*');
      parts.push('(.*)');
      continue;
    }
    const m = /^:([a-zA-Z_][a-zA-Z0-9_]*)((?:\((?:[^()\\]|\\.)*\))?)$/.exec(seg);
    if (m) {
      paramNames.push(m[1]);
      parts.push(m[2] ? m[2] : '([^/]+)');
      continue;
    }
    parts.push(seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  source = parts.join('/');
  return { regex: new RegExp('^' + source + '/?$'), paramNames };
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, ...handlers: Handler[]): void {
    const { regex, paramNames } = compilePattern(pattern);
    this.routes.push({ method, pattern, regex, paramNames, handlers });
  }

  get(pattern: string, ...h: Handler[]) { this.add('GET', pattern, ...h); }
  post(pattern: string, ...h: Handler[]) { this.add('POST', pattern, ...h); }
  put(pattern: string, ...h: Handler[]) { this.add('PUT', pattern, ...h); }
  patch(pattern: string, ...h: Handler[]) { this.add('PATCH', pattern, ...h); }
  delete(pattern: string, ...h: Handler[]) { this.add('DELETE', pattern, ...h); }
  head(pattern: string, ...h: Handler[]) { this.add('HEAD', pattern, ...h); }
  options(pattern: string, ...h: Handler[]) { this.add('OPTIONS', pattern, ...h); }
  any(pattern: string, ...h: Handler[]) { this.add('ANY', pattern, ...h); }
  /** Route(pattern, "GET,POST", handlers...) — macaron style */
  route(pattern: string, methods: string, ...h: Handler[]) {
    for (const m of methods.split(',')) this.add(m.trim().toUpperCase(), pattern, ...h);
  }
  combo(pattern: string, ...h: Handler[]) {
    // treated as route registered for GET + POST when handlers count allows;
    // gogs uses Combo().Get(x).Post(y) — handled by route() calls at registration
    this.route(pattern, 'GET,POST', ...h);
  }

  /** Find first matching route. HEAD falls back to GET (SetAutoHead). */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    let getFallback: { route: Route; params: Record<string, string> } | null = null;
    for (const r of this.routes) {
      if (r.method !== 'ANY' && r.method !== method) {
        if (!(method === 'HEAD' && r.method === 'GET')) continue;
      }
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => {
        params[name === '*' ? ':*' : ':' + name] = decodeURIComponent(m[i + 1] ?? '');
      });
      if (method === 'HEAD' && r.method === 'GET') {
        if (!getFallback) getFallback = { route: r, params };
        continue;
      }
      return { route: r, params };
    }
    return getFallback;
  }
}

/** Group builder collecting prefix + middleware, mirroring m.Group(). */
export class GroupBuilder {
  constructor(
    private router: Router,
    private prefix: string,
    private middleware: Handler[]
  ) {}

  Group(prefix: string, fn: (g: GroupBuilder) => void, ...middleware: Handler[]): void {
    const g = new GroupBuilder(this.router, this.prefix + prefix, [...this.middleware, ...middleware]);
    fn(g);
  }

  Get(pattern: string, ...h: Handler[]) { this.router.get(this.prefix + pattern, ...this.middleware, ...h); }
  Post(pattern: string, ...h: Handler[]) { this.router.post(this.prefix + pattern, ...this.middleware, ...h); }
  Put(pattern: string, ...h: Handler[]) { this.router.put(this.prefix + pattern, ...this.middleware, ...h); }
  Patch(pattern: string, ...h: Handler[]) { this.router.patch(this.prefix + pattern, ...this.middleware, ...h); }
  Delete(pattern: string, ...h: Handler[]) { this.router.delete(this.prefix + pattern, ...this.middleware, ...h); }
  Any(pattern: string, ...h: Handler[]) { this.router.any(this.prefix + pattern, ...this.middleware, ...h); }
  Route(pattern: string, methods: string, ...h: Handler[]) { this.router.route(this.prefix + pattern, methods, ...this.middleware, ...h); }
  Combo(pattern: string, ...h: Handler[]) { this.router.route(this.prefix + pattern, 'GET,POST', ...this.middleware, ...h); }
}
