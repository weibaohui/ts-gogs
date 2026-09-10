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
  /** per-segment kind: 0=static literal, 1=:param, 2=wildcard — macaron tree priority */
  kinds: number[];
}

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let source: string;

  // macaron-style regex route: leading "/^" (drop the slash and the anchors —
  // the compiled form already anchors ^/… and tolerates a trailing slash)
  if (pattern.startsWith('/^')) {
    const body = pattern.slice(2).replace(/\$$/, '').replace(/^\^/, '');
    const compiled = compilePattern('/' + body);
    return compiled;
  }

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
    // general segment scan: literal text mixed with :name and :name(rx) params
    // (e.g. `:sha([a-f0-9]{7,40}).:ext(patch|diff)`)
    let rx = '';
    let k = 0;
    let matched = false;
    while (k < seg.length) {
      if (seg[k] === ':') {
        const nm = /^:([a-zA-Z_][a-zA-Z0-9_]*)/.exec(seg.slice(k));
        if (nm) {
          paramNames.push(nm[1]);
          matched = true;
          k += nm[0].length;
          if (seg[k] === '(') {
            // balanced-paren rx group — wrap in a capture group for params
            let depth = 1;
            let e = k + 1;
            while (e < seg.length && depth > 0) {
              if (seg[e] === '(') depth++;
              else if (seg[e] === ')') depth--;
              else if (seg[e] === '\\') e++;
              e++;
            }
            rx += '(' + seg.slice(k + 1, e - 1) + ')';
            k = e;
          } else {
            rx += '([^/]+)';
            k += 0;
          }
          continue;
        }
      }
      rx += seg[k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      k++;
    }
    if (matched) {
      parts.push(rx);
      continue;
    }
    parts.push(seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  source = parts.join('/');
  return { regex: new RegExp('^' + source + '/?$'), paramNames };
}

/** macaron Tree semantics: at any segment position a static literal beats a
 *  :param, which beats a * wildcard — regardless of registration order. */
function segmentKinds(pattern: string): number[] {
  if (pattern.startsWith('/^') || pattern.startsWith('^')) return [1];
  return pattern
    .split('/')
    .slice(1)
    .filter((s) => s !== '')
    .map((seg) => (seg === '*' ? 2 : seg.includes(':') ? 1 : 0));
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, ...handlers: Handler[]): void {
    const { regex, paramNames } = compilePattern(pattern);
    this.routes.push({ method, pattern, regex, paramNames, handlers, kinds: segmentKinds(pattern) });
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

  /** macaron tree priority: a route wins over another if at the first differing
   *  segment it is more specific (static 0 < param 1 < wildcard 2). Ties keep
   *  registration order (best stays). */
  private static moreSpecific(a: Route, b: Route): Route {
    const n = Math.min(a.kinds.length, b.kinds.length);
    for (let i = 0; i < n; i++) {
      if (a.kinds[i] !== b.kinds[i]) return a.kinds[i] < b.kinds[i] ? a : b;
    }
    return a; // tie — prefer the earlier-registered route (a is current best)
  }

  /** Find first matching route. HEAD falls back to GET (SetAutoHead). */
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    let best: { route: Route; params: Record<string, string> } | null = null;
    let getFallback: { route: Route; params: Record<string, string> } | null = null;
    for (const r of this.routes) {
      if (r.method !== 'ANY' && r.method !== method) {
        if (!(method === 'HEAD' && r.method === 'GET')) continue;
      }
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const hit = {
        route: r,
        params: r.paramNames.reduce((acc: Record<string, string>, name, i) => {
          acc[name === '*' ? ':*' : ':' + name] = decodeURIComponent(m[i + 1] ?? '');
          return acc;
        }, {}),
      };
      if (method === 'HEAD' && r.method === 'GET') {
        if (!getFallback || Router.moreSpecific(getFallback.route, hit.route) === hit.route) getFallback = hit;
        continue;
      }
      if (!best || Router.moreSpecific(best.route, hit.route) === hit.route) best = hit;
    }
    return best ?? getFallback;
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
