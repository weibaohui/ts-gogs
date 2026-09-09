import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemplateSet } from './src/gotemplate/engine.js';

function loadAll(set: TemplateSet, dir: string, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      loadAll(set, full, name);
      continue;
    }
    if (!entry.name.endsWith('.tmpl')) continue;
    try {
      set.registerFile(name.slice(0, -5), fs.readFileSync(full, 'utf8'));
    } catch (e: any) {
      console.log('FAIL-PARSE', name, '→', e.message);
    }
  }
}
const set = new TemplateSet();
loadAll(set, 'templates');
console.log('parsed:', set.parsed.size);
