// The 39 template functions registered by gogs internal/template.FuncMap.
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { SafeHTML } from './engine.js';
import { conf } from '../conf.js';
import { i18n } from '../i18n.js';
import { md5 } from '../authx/password.js';
import { sanitizeHTML, renderIssueIndexPattern, htmlEscape } from '../markup.js';

export function shortSHA1(sha: string): string {
  return String(sha).length > 10 ? String(sha).slice(0, 10) : String(sha);
}

export function ellipsis(str: string, threshold: number): string {
  str = String(str ?? '');
  if (str.length <= threshold || threshold < 0) return str;
  return str.slice(0, threshold) + '...';
}

export function escapePound(str: string): string {
  return String(str).replaceAll('%', '%25').replaceAll('#', '%23').replaceAll(' ', '%20').replaceAll('?', '%3F');
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 12 * MONTH;

/** Go time.Time equivalent for template funcs — accepts Date, number (unix sec). */
function toTime(t: any): Date {
  if (t instanceof Date) return t;
  if (typeof t === 'number') return new Date(t * 1000);
  return new Date(t);
}

/** Format a Date like Go: time.Format("2006-01-02 15:04:05") */
export function goFormatTime(d: Date, layout: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  if (layout === '2006-01-02 15:04:05') {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  if (layout === 'Jan 02, 2006') {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${pad(d.getDate())}, ${d.getFullYear()}`;
  }
  // RFC1123Z: Mon, 02 Jan 2006 15:04:05 -0700
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const absTz = Math.abs(tz);
  const tzStr = `${sign}${pad(Math.floor(absTz / 60))}${pad(absTz % 60)}`;
  return `${days[d.getDay()]}, ${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tzStr}`;
}

function timeSinceLabel(lang: string, key: string, ...args: any[]): string {
  return i18n.translate(lang, `tool.${key}`, args);
}

function timeSinceText(then: Date, lang: string): string {
  const now = new Date();
  let lbl = timeSinceLabel(lang, 'ago');
  let diff = Math.floor(now.getTime() / 1000) - Math.floor(then.getTime() / 1000);
  if (then.getTime() > now.getTime()) {
    lbl = timeSinceLabel(lang, 'from_now');
    diff = Math.floor(then.getTime() / 1000) - Math.floor(now.getTime() / 1000);
  }
  if (diff <= 0) return timeSinceLabel(lang, 'now');
  if (diff <= 2) return timeSinceLabel(lang, '1s', lbl);
  if (diff < MINUTE) return timeSinceLabel(lang, 'seconds', diff, lbl);
  if (diff < 2 * MINUTE) return timeSinceLabel(lang, '1m', lbl);
  if (diff < HOUR) return timeSinceLabel(lang, 'minutes', Math.floor(diff / MINUTE), lbl);
  if (diff < 2 * HOUR) return timeSinceLabel(lang, '1h', lbl);
  if (diff < DAY) return timeSinceLabel(lang, 'hours', Math.floor(diff / HOUR), lbl);
  if (diff < 2 * DAY) return timeSinceLabel(lang, '1d', lbl);
  if (diff < WEEK) return timeSinceLabel(lang, 'days', Math.floor(diff / DAY), lbl);
  if (diff < 2 * WEEK) return timeSinceLabel(lang, '1w', lbl);
  if (diff < MONTH) return timeSinceLabel(lang, 'weeks', Math.floor(diff / WEEK), lbl);
  if (diff < 2 * MONTH) return timeSinceLabel(lang, '1mon', lbl);
  if (diff < YEAR) return timeSinceLabel(lang, 'months', Math.floor(diff / MONTH), lbl);
  if (diff < 2 * YEAR) return timeSinceLabel(lang, '1y', lbl);
  return timeSinceLabel(lang, 'years', Math.floor(diff / YEAR), lbl);
}

function humanateBytes(s: number, base: number, sizes: string[]): string {
  if (s < 10) return `${s} B`;
  let e = Math.floor(Math.log(s) / Math.log(base));
  const suffix = sizes[e] ?? 'B';
  let val = s / Math.pow(base, e);
  const f = val.toFixed(1);
  return `${Number(f) === val ? val : f} ${suffix}`;
}

export function fileSize(s: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  return humanateBytes(Math.abs(Number(s)), 1024, sizes);
}

function avatarLink(email: string): string {
  email = String(email ?? '');
  let url = '';
  if (!conf.disableGravatar) {
    url = conf.gravatarSource + md5(email.trim().toLowerCase()) + '?d=identicon';
  }
  if (!url) {
    url = conf.subpath + '/img/avatar_default.png';
  }
  return url;
}

function actionIcon(opType: number): string {
  switch (opType) {
    case 1:
    case 8: return 'repo';
    case 5: return 'git-commit';
    case 6: return 'issue-opened';
    case 7: return 'git-pull-request';
    case 9: return 'tag';
    case 10: return 'comment-discussion';
    case 11: return 'git-merge';
    case 12:
    case 14: return 'issue-closed';
    case 13:
    case 15: return 'issue-reopened';
    case 16: return 'git-branch';
    case 17:
    case 18: return 'alert';
    case 19: return 'repo-forked';
    case 20:
    case 21:
    case 22: return 'repo-clone';
    default: return 'invalid type';
  }
}

export function renderCommitMessage(full: boolean, msg: string, urlPrefix: string, metas: Record<string, string>): string {
  const cleanMsg = htmlEscape(String(msg ?? ''));
  const rendered = renderIssueIndexPattern(cleanMsg, urlPrefix, metas);
  const msgLines = rendered.trim().split('\n');
  const numLines = msgLines.length;
  if (numLines === 0) return '';
  if (!full) return msgLines[0];
  if (numLines === 1 || (numLines >= 2 && msgLines[1] === '')) {
    const header = `<h3>${msgLines[0]}</h3>`;
    if (numLines >= 2) {
      return header + `\n<pre>${msgLines.slice(2).join('\n')}</pre>`;
    }
    return header;
  }
  return `<h4>${msgLines.join('<br>')}</h4>`;
}

export function actionContent2Commits(act: any): any {
  let out: any;
  try {
    out = JSON.parse(act.GetContent());
  } catch {
    out = { Commits: [], Compares: [], TotalCommits: 0, AuthorEmails: [] };
  }
  out.Len = out.Commits?.length ?? 0;
  out.AvatarLink = (email: string) => avatarLink(email);
  return out;
}

function inferSubmoduleURL(baseURL: string, mod: any): string {
  const url = String(mod?.URL ?? mod?.url ?? '');
  if (!url) return '';
  if (url.startsWith('../')) {
    return `${baseURL.replace(/\/$/, '')}/raw/${mod.Commit ?? mod.commit ?? ''}`;
  }
  const scp = /^git@([^:]+):(.*)$/.exec(url);
  if (scp) return `http://${scp[1]}/${scp[2].replace(/\.git$/, '')}`;
  if (url.startsWith('ssh://')) return url.replace('ssh://', 'http://');
  return url;
}

const MIME_IMAGE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.avif',
]);

export function buildFuncMap(): Record<string, (...args: any[]) => any> {
  return {
    BuildCommit: () => conf.buildCommit,
    Year: () => new Date().getFullYear(),
    UseHTTPS: () => conf.url?.protocol === 'https:',
    AppName: () => conf.brandName,
    AppSubURL: () => conf.subpath,
    AppURL: () => conf.externalURL,
    AppVer: () => conf.version,
    AppDomain: () => conf.domain,
    DisableGravatar: () => conf.disableGravatar,
    ShowFooterTemplateLoadTime: () => conf.showFooterTemplateLoadTime,
    LoadTimes: (start: any) => `${Date.now() - (start instanceof Date ? start.getTime() : Number(start))}ms`,
    AvatarLink: avatarLink,
    AppendAvatarSize: (url: string, size: number) => (String(url).includes('?') ? `${url}&s=${size}` : `${url}?s=${size}`),
    Safe: (raw: string) => new SafeHTML(String(raw ?? '')),
    Sanitize: (raw: string) => sanitizeHTML(String(raw ?? '')),
    Str2HTML: (raw: string) => new SafeHTML(sanitizeHTML(String(raw ?? ''))),
    NewLine2br: (raw: string) => String(raw ?? '').replaceAll('\n', '<br>'),
    TimeSince: (t: any, lang: string) => {
      const d = toTime(t);
      return new SafeHTML(
        `<span class="time-since" title="${htmlEscape(goFormatTime(d, conf.timeFormatLayout))}">${timeSinceText(d, lang ?? 'en-US')}</span>`
      );
    },
    RawTimeSince: (t: any, lang: string) => timeSinceText(toTime(t), lang ?? 'en-US'),
    FileSize: fileSize,
    Subtract: (a: any, b: any) => Number(a) - Number(b),
    Add: (a: number, b: number) => a + b,
    ActionIcon: actionIcon,
    DateFmtLong: (t: any) => goFormatTime(toTime(t), 'RFC1123Z'),
    DateFmtShort: (t: any) => goFormatTime(toTime(t), 'Jan 02, 2006'),
    SubStr: (str: string, start: number, length: number) => {
      str = String(str ?? '');
      if (!str) return '';
      const end = length === -1 ? str.length : start + length;
      if (str.length < end) return str;
      return str.slice(start, end);
    },
    Join: (arr: string[], sep: string) => (arr ?? []).join(sep),
    EllipsisString: ellipsis,
    DiffFileTypeToStr: (t: string) => ({ add: 'add', change: 'modify', delete: 'del', rename: 'rename' } as Record<string, string>)[String(t)] ?? '',
    DiffLineTypeToStr: (t: string) => (t === 'add' ? 'add' : t === 'del' ? 'del' : t === 'section' ? 'tag' : 'same'),
    Sha1: (str: string) => crypto.createHash('sha1').update(String(str)).digest('hex'),
    ShortSHA1: shortSHA1,
    ActionContent2Commits: actionContent2Commits,
    EscapePound: escapePound,
    RenderCommitMessage: renderCommitMessage,
    ThemeColorMetaTag: () => conf.themeColorMetaTag,
    FilenameIsImage: (filename: string) => MIME_IMAGE_EXT.has(path.extname(String(filename)).toLowerCase()),
    TabSizeClass: (_ec: any, _filename: string) => 'tab-size-8',
    InferSubmoduleURL: inferSubmoduleURL,
  };
}
