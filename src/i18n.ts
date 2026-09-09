// i18n compatible with go-macaron/i18n semantics over gogs locale_*.ini files.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseIni } from 'ini';
import { goSprintf } from './gotemplate/engine.js';

export interface Lang {
  Lang: string;
  Name: string;
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
      const parsed = parseIni(fs.readFileSync(file, 'utf8')) as any;
      // normalize: ini lib puts pre-section keys under section key "" (or "_")
      const norm: Record<string, Record<string, string>> = {};
      for (const [sect, kv] of Object.entries(parsed)) {
        if (typeof kv === 'string') {
          // keys before any section → DEFAULT
          norm['DEFAULT'] = norm['DEFAULT'] ?? {};
          norm['DEFAULT'][sect] = kv;
          continue;
        }
        const s = sect === '' || sect === '_' ? 'DEFAULT' : sect;
        if (typeof kv !== 'object' || kv === null) continue;
        norm[s] = norm[s] ?? {};
        for (const [k, v] of Object.entries(kv as Record<string, string>)) {
          if (typeof v === 'string') norm[s][k] = v;
        }
      }
      // custom locale overrides: custom/conf/locale/locale_XX.ini
      if (customDir) {
        const customFile = path.join(customDir, 'conf', 'locale', `locale_${lang}.ini`);
        if (fs.existsSync(customFile)) {
          const c = parseIni(fs.readFileSync(customFile, 'utf8')) as any;
          for (const [sect, kv] of Object.entries(c)) {
            const s = sect === '' || sect === '_' ? 'DEFAULT' : sect;
            if (typeof kv !== 'object' || kv === null) continue;
            norm[s] = norm[s] ?? {};
            for (const [k, v] of Object.entries(kv as Record<string, string>)) {
              if (typeof v === 'string') norm[s][k] = v;
            }
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
