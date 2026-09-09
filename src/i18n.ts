// i18n compatible with go-macaron/i18n semantics over gogs locale_*.ini files.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { goSprintf } from './gotemplate/engine.js';

export interface Lang {
  Lang: string;
  Name: string;
}

/** go-ini-style parser: top-level keys land in DEFAULT; sections keep their
 * own namespace even when a top-level key shares the name. */
function parseLocaleIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = { DEFAULT: {} };
  let current = 'DEFAULT';
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+?)\]$/.exec(line);
    if (sec) {
      current = sec[1];
      out[current] = out[current] ?? {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // strip inline comments preceded by whitespace (go-ini behavior)
    const comment = /\s[;#]/.exec(value);
    if (comment) value = value.slice(0, comment.index);
    out[current][key] = value;
  }
  return out;
}

export class I18n {
  /** lang -> (section -> (key -> value)) */
  private store = new Map<string, Record<string, Record<string, string>>>();
  langs: Lang[] = [];

  load(vendoredDir: string, langs: string[], names: string[], customDir?: string): void {
    this.langs = langs.map((l, i) => ({ Lang: l, Name: names[i] ?? l }));
    const localeDir = path.join(vendoredDir, 'locale');
    for (const lang of langs) {
      const file = path.join(localeDir, `locale_${lang}.ini`);
      if (!fs.existsSync(file)) continue;
      const parsed = parseLocaleIni(fs.readFileSync(file, 'utf8'));
      const norm: Record<string, Record<string, string>> = parsed;
      // custom locale overrides: custom/conf/locale/locale_XX.ini
      if (customDir) {
        const customFile = path.join(customDir, 'conf', 'locale', `locale_${lang}.ini`);
        if (fs.existsSync(customFile)) {
          const c = parseLocaleIni(fs.readFileSync(customFile, 'utf8'));
          for (const [sect, kv] of Object.entries(c)) {
            norm[sect] = norm[sect] ?? {};
            Object.assign(norm[sect], kv);
          }
        }
      }
      this.store.set(lang, norm);
    }
  }

  languages(): Lang[] {
    return this.langs;
  }

  /** Resolve translation key like "repo.issues.previous" or bare "home". */
  translate(lang: string, key: string, args: any[]): string {
    let table = this.store.get(lang) ?? this.store.get('en-US');
    if (!table) return key;
    let value: string | undefined;
    const dot = key.indexOf('.');
    if (dot > 0) {
      const sect = key.slice(0, dot);
      if (table[sect] && table[sect][key.slice(dot + 1)] !== undefined) {
        value = table[sect][key.slice(dot + 1)];
      }
    }
    if (value === undefined) {
      value = table['DEFAULT']?.[key];
    }
    if (value === undefined && lang !== 'en-US') {
      return this.translate('en-US', key, args);
    }
    if (value === undefined) return key;
    if (args.length > 0) return goSprintf(value, args);
    return value;
  }
}

export const i18n = new I18n();

/** Locale object exposed to templates as `.i18n` with Tr method. */
export class Locale {
  constructor(readonly lang: string) {}
  Tr(key: string, ...args: any[]): string {
    return i18n.translate(this.lang, key, args);
  }
  Language(): string {
    return this.lang;
  }
}
