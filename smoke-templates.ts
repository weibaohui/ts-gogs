import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateSet } from './src/gotemplate/engine.js';

const stubFuncs: Record<string, (...args: any[]) => any> = {
  AppSubURL: () => '', AppURL: () => 'http://localhost:3000/', AppName: () => 'Gogs',
  AppVer: () => '0.13.0', AppDomain: () => 'localhost', BuildCommit: () => 'dev',
  Year: () => 2026, UseHTTPS: () => false, DisableGravatar: () => false,
  ShowFooterTemplateLoadTime: () => true, LoadTimes: () => '0ms',
  AvatarLink: () => '/img/avatar_default.png', AppendAvatarSize: (u: string, s: number) => `${u}?s=${s}`,
  Safe: (x: string) => x, Sanitize: (x: string) => x, Str2HTML: (x: string) => x,
  NewLine2br: (x: string) => String(x).replace(/\n/g, '<br>'),
  TimeSince: () => 'now', RawTimeSince: () => 'now', FileSize: (s: number) => s + 'B',
  Subtract: (a: number, b: number) => a - b, Add: (a: number, b: number) => a + b,
  ActionIcon: () => 'repo', DateFmtLong: () => 'Wed, 09 Sep 2026', DateFmtShort: () => 'Sep 09, 2026',
  SubStr: (s: string, a: number, b: number) => String(s).slice(a, b < 0 ? undefined : a + b),
  Join: (a: string[], sep: string) => (a ?? []).join(sep), EllipsisString: (s: string) => s,
  DiffFileTypeToStr: () => 'add', DiffLineTypeToStr: () => 'same', Sha1: (x: string) => x,
  ShortSHA1: (s: string) => String(s).slice(0, 10), ActionContent2Commits: () => ({ Commits: [] }),
  EscapePound: (x: string) => String(x).replace(/%/g, '%25').replace(/#/g, '%23').replace(/ /g, '%20').replace(/\?/g, '%3F'),
  RenderCommitMessage: (_f: boolean, m: string) => m, ThemeColorMetaTag: () => '#6cc644',
  FilenameIsImage: () => false, TabSizeClass: () => 'tab-size-8', InferSubmoduleURL: () => '',
};
function loadAll(set: TemplateSet, dir: string, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) loadAll(set, full, name);
    else if (entry.name.endsWith('.tmpl')) set.registerFile(name.slice(0, -5), fs.readFileSync(full, 'utf8'));
  }
}
const set = new TemplateSet();
set.funcs = stubFuncs;
loadAll(set, 'templates');
const fakeData: any = new Proxy(
  { i18n: { Tr: (k: string, ...a: any[]) => 'TR[' + k + ']' }, Title: 'T', Lang: 'en-US', Flash: {} },
  { get(t: any, k: string) { return k in t ? t[k] : undefined; } }
);
let ok = 0;
const failures: Array<[string, string]> = [];
for (const name of set.parsed.keys()) {
  try { set.render(name, { ...fakeData }); ok++; } catch (e: any) { failures.push([name, e.message]); }
}
console.log('parsed:', set.parsed.size, '| rendered ok:', ok, '| failed:', failures.length);
for (const [n, e] of failures.slice(0, 10)) console.log('  FAIL', n, '→', e.slice(0, 120));
console.log(failures.length === 0 ? 'SMOKE-OK' : 'SMOKE-FAILED');
