// Minimal editorconfig-core compatible parser/matcher for the
// /api/v1/repos/:u/:r/editorconfig/:filename endpoint.
import * as git from './gitx/git.js';

export interface ECDefinition {
  Section: string;
  Properties: Record<string, string>;
}

export interface ECConfig {
  root: boolean;
  definitions: Array<{ section: string; props: Record<string, string> }>;
}

export function parseEditorconfig(text: string): ECConfig {
  const out: ECConfig = { root: false, definitions: [] };
  let current: { section: string; props: Record<string, string> } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$|(^|\s)#.*$/, (m, p1) => (p1 ?? '')).trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      current = { section: sec[1], props: {} };
      out.definitions.push(current);
      continue;
    }
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*[=:]\s*(.*?)\s*$/.exec(rawLine);
    if (!kv) continue;
    const [, key, value] = kv;
    if (!current) {
      if (key.toLowerCase() === 'root' && value.toLowerCase() === 'true') out.root = true;
      continue;
    }
    current.props[key.toLowerCase()] = value.toLowerCase() === 'true' ? 'true' : value.toLowerCase() === 'false' ? 'false' : value;
  }
  return out;
}

/** Expand `*.{a,b}` style brace groups into multiple globs. */
function expandBraces(glob: string): string[] {
  const m = /\{([^{}]+)\}/.exec(glob);
  if (!m) return [glob];
  const out: string[] = [];
  for (const alt of m[1].split(',')) {
    out.push(...expandBraces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
  }
  return out;
}

function globToRegex(glob: string): RegExp {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 2;
      } else {
        source += '[^/]*';
        i++;
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      i++;
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + source + '$', 'i');
}

/** editorconfig-core GetDefinitionForFilename: last matching section wins per property. */
export function getDefinitionForFilename(config: ECConfig, filename: string): ECDefinition | null {
  filename = filename.replace(/^\//, '');
  const result: Record<string, string> = {};
  let matchedSection = '';
  for (const def of config.definitions) {
    const globs = expandBraces(def.section);
    for (const glob of globs) {
      // a glob containing '/' matches against the full path; otherwise basename
      const target = glob.includes('/') ? filename : filename.split('/').pop()!;
      if (globToRegex(glob).test(target)) {
        matchedSection = def.section;
        Object.assign(result, def.props);
        break;
      }
    }
  }
  if (!matchedSection) return null;
  // indent_size defaults to tab_width when indent_style=tab (per spec)
  if (result['indent_style'] === 'tab' && result['indent_size'] === undefined && result['tab_width'] !== undefined) {
    result['indent_size'] = result['tab_width'];
  }
  return { Section: matchedSection, Properties: result };
}

/** Fetch and parse {repoDir}/.editorconfig at the given ref. */
export async function repoEditorconfig(repoDir: string, ref: string): Promise<ECConfig | null> {
  const commit = await git.getCommit(repoDir, ref);
  if (!commit) return null;
  const tree = await git.lsTree(repoDir, commit.id, '.editorconfig');
  const entry = tree?.entries[0];
  if (!entry || entry.type !== 'blob') return null;
  const content = (await git.blobBytes(repoDir, entry.sha)).toString('utf8');
  return parseEditorconfig(content);
}
