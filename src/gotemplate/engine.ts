// A faithful subset implementation of Go's text/template + html/template
// semantics, sufficient to render the original Gogs templates byte-for-byte.
//
// Supported: {{.Field.Chain}} {{$.Var}} {{$x := ...}} {{$x = ...}} pipelines
// with `|`, parenthesized sub-pipelines, if/else if/else, range (with optional
// $i/$v vars, map/array/int/string iteration, else), with/else, template
// include, define, block, comments, trim markers, and the Go builtin funcs
// (and/or/not/eq/ne/lt/le/gt/ge/len/index/slice/print/printf/println/html/js/
// urlquery/call/break/continue).
//
// Auto-escaping mirrors html/template: every interpolated value is HTML-escaped
// (Go html.EscapeString entity set) unless wrapped in SafeHTML (template.HTML).

export class SafeHTML {
  constructor(readonly html: string) {}
  toString(): string {
    return this.html;
  }
}

// ---------------------------------------------------------------- lexer

type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'action'; raw: string; line: number };

const ACTION_START = /\{\{-?/g;

function lex(src: string): Piece[] {
  const pieces: Piece[] = [];
  let pos = 0;
  let line = 1;
  // count newlines in a chunk
  const countNL = (s: string) => {
    for (let i = 0; i < s.length; i++) if (s[i] === '\n') line++;
  };

  ACTION_START.lastIndex = 0;
  while (true) {
    ACTION_START.lastIndex = pos;
    const m = ACTION_START.exec(src);
    if (!m) {
      const rest = src.slice(pos);
      if (rest) pieces.push({ kind: 'text', text: rest });
      break;
    }
    const start = m.index;
    const before = src.slice(pos, start);
    if (before) pieces.push({ kind: 'text', text: before });
    countNL(before);

    let i = start + 2;
    const leftTrim = src[i] === '-';
    if (leftTrim) i++;
    // skip whitespace after {{
    while (i < src.length && /\s/.test(src[i])) i++;

    // comment {{/* ... */}}
    if (src[i] === '/' && src[i + 1] === '*') {
      const endIdx = src.indexOf('*/', i + 2);
      if (endIdx < 0) throw new Error(`unterminated comment in template at line ${line}`);
      let j = endIdx + 2;
      // skip whitespace before }}
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '-' && src[j + 1] === '}') j++;
      if (src[j] === '}' && src[j + 1] === '}') {
        const commentChunk = src.slice(pos, start); // trim right side of before-text
        if (leftTrim && commentChunk.length && pieces.length && pieces[pieces.length - 1].kind === 'text') {
          (pieces[pieces.length - 1] as any).text = (pieces[pieces.length - 1] as any).text.replace(/\s+$/, '');
        }
        pos = j + 2;
        continue;
      }
      throw new Error(`malformed comment in template at line ${line}`);
    }

    // find closing }}
    const closeIdx = src.indexOf('}}', i);
    if (closeIdx < 0) throw new Error(`unclosed action starting at line ${line}`);
    let end = closeIdx;
    let rightTrim = false;
    if (end > i && src[end - 1] === '-') {
      rightTrim = true;
      end--;
    }
    const raw = src.slice(i, end);
    pieces.push({ kind: 'action', raw, line });
    pos = closeIdx + 2;
    if (rightTrim) {
      // trim left whitespace of next text piece lazily: record marker
      pieces.push({ kind: 'text', text: '\u0000TRIMLEFT' });
    }
  }

  // resolve TRIMLEFT markers
  const out: Piece[] = [];
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k];
    if (p.kind === 'text' && p.text === '\u0000TRIMLEFT') {
      const next = pieces[k + 1];
      if (next && next.kind === 'text') {
        next.text = next.text.replace(/^\s+/, '');
        k++;
      }
      continue;
    }
    if (p.kind === 'text' && out.length && out[out.length - 1].kind === 'text') {
      (out[out.length - 1] as any).text += p.text;
      continue;
    }
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- tokenizer (inside actions)

type Tok =
  | { t: 'ident'; v: string }
  | { t: 'field'; v: string; adj?: boolean } // .a.b.c  (leading dot path; v without leading dot; adj = dot attached to previous token)
  | { t: 'dot' } // .
  | { t: 'root' } // $
  | { t: 'var'; v: string } // $name
  | { t: 'number'; v: number; isFloat: boolean }
  | { t: 'string'; v: string }
  | { t: 'rawstring'; v: string }
  | { t: 'char'; v: string }
  | { t: 'punct'; v: string } // | ( ) := = , ?
  | { t: 'bool'; v: boolean }
  | { t: 'nil' };

function tokenize(src: string, line: number): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '|' || c === '(' || c === ')' || c === ',') {
      toks.push({ t: 'punct', v: c });
      i++;
      continue;
    }
    if (c === ':' && src[i + 1] === '=') {
      toks.push({ t: 'punct', v: ':=' });
      i += 2;
      continue;
    }
    if (c === '=') {
      toks.push({ t: 'punct', v: '=' });
      i++;
      continue;
    }
    if (c === '?') {
      toks.push({ t: 'punct', v: '?' });
      i++;
      continue;
    }
    if (c === '"') {
      const { val, next } = readQuoted(src, i, line);
      toks.push({ t: 'string', v: val });
      i = next;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) throw new Error(`line ${line}: unterminated raw string`);
      toks.push({ t: 'rawstring', v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === "'") {
      const { val, next } = readChar(src, i, line);
      toks.push({ t: 'char', v: val });
      i = next;
      continue;
    }
    if (c === '.') {
      // dot or field chain
      if (i + 1 >= n || !/[a-zA-Z0-9_$]/.test(src[i + 1])) {
        toks.push({ t: 'dot' });
        i++;
        continue;
      }
      const fieldStart = i;
      let j = i + 1;
      let path = '';
      while (j < n) {
        // NOTE: no `^` here — with the `y` flag `^` anchors to string start,
        // not lastIndex, which breaks chained segments like .i18n.Tr
        const m = /[a-zA-Z_][a-zA-Z0-9_]*|\.\d+/y;
        m.lastIndex = j;
        const mm = m.exec(src);
        if (!mm) break;
        path += mm[0];
        j = m.lastIndex;
        if (j < n && src[j] === '.') {
          // continue chain only if followed by ident
          if (j + 1 < n && /[a-zA-Z_]/.test(src[j + 1])) {
            path += '.';
            j++;
            continue;
          }
          break;
        }
        break;
      }
      // adjacent = no whitespace before the leading dot (e.g. `$.X`, `$v.X`, `(f).X`)
      toks.push({ t: 'field', v: path, adj: i > 0 && !/\s/.test(src[i - 1]) });
      i = j;
      continue;
    }
    if (c === '$') {
      const m = /\$[a-zA-Z_][a-zA-Z0-9_]*/y;
      m.lastIndex = i;
      const mm = m.exec(src);
      if (mm) {
        toks.push({ t: 'var', v: mm[0].slice(1) });
        i = m.lastIndex;
      } else {
        toks.push({ t: 'root' });
        i++;
      }
      continue;
    }
    if (/[0-9]/.test(c) || ((c === '-' || c === '+') && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/y;
      m.lastIndex = i;
      const mm = m.exec(src);
      if (mm) {
        const s = mm[0];
        const isFloat = /[.eE]/.test(s);
        toks.push({ t: 'number', v: Number(s), isFloat });
        i = m.lastIndex;
        continue;
      }
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /[a-zA-Z_][a-zA-Z0-9_]*/y;
      m.lastIndex = i;
      const mm = m.exec(src);
      if (mm) {
        const word = mm[0];
        if (word === 'true') toks.push({ t: 'bool', v: true });
        else if (word === 'false') toks.push({ t: 'bool', v: false });
        else if (word === 'nil') toks.push({ t: 'nil' });
        else toks.push({ t: 'ident', v: word });
        i = m.lastIndex;
        continue;
      }
    }
    throw new Error(`line ${line}: unexpected character ${JSON.stringify(c)} in action`);
  }
  return toks;
}

function prevIsValueEnd(toks: Tok[]): boolean {
  const last = toks[toks.length - 1];
  if (!last) return false;
  return (
    last.t === 'field' || last.t === 'dot' || last.t === 'var' || last.t === 'root' || last.t === 'number' ||
    last.t === 'string' || last.t === 'rawstring' || last.t === 'bool' ||
    (last.t === 'ident' && !BUILTINS.has(last.v))
  );
}

function readQuoted(src: string, start: number, line: number): { val: string; next: number } {
  let i = start + 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return { val: out, next: i + 1 };
    if (c === '\\') {
      const e = src[i + 1];
      switch (e) {
        case 'n': out += '\n'; i += 2; break;
        case 't': out += '\t'; i += 2; break;
        case 'r': out += '\r'; i += 2; break;
        case '\\': out += '\\'; i += 2; break;
        case '"': out += '"'; i += 2; break;
        case "'": out += "'"; i += 2; break;
        case 'a': out += '\x07'; i += 2; break;
        case 'b': out += '\b'; i += 2; break;
        case 'f': out += '\f'; i += 2; break;
        case 'v': out += '\v'; i += 2; break;
        case 'u': {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
          break;
        }
        case 'x': {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
          i += 4;
          break;
        }
        default:
          out += e;
          i += 2;
      }
      continue;
    }
    out += c;
    i++;
  }
  throw new Error(`line ${line}: unterminated quoted string`);
}

function readChar(src: string, start: number, line: number): { val: string; next: number } {
  // minimal char literal support: 'x' and escapes; yields the character itself
  return readQuoted(src, start, line);
}

// ---------------------------------------------------------------- AST

type Expr =
  | { e: 'pipeline'; cmds: Expr[]; decl?: { vars: string[]; assign: boolean } }
  | { e: 'cmd'; operands: Expr[] }
  | { e: 'operand'; tok: Tok; fields?: never }
  | { e: 'field'; base: Expr; path: string } // base.field.path
  | { e: 'call'; fn: Expr; args: Expr[] };

type Node =
  | { n: 'text'; text: string }
  | { n: 'action'; pipe: Expr }
  | { n: 'if'; branches: { cond: Expr; body: Node[] }[]; elseBody: Node[] | null }
  | { n: 'range'; decl: string[]; cond: Expr; body: Node[]; elseBody: Node[] | null }
  | { n: 'with'; branches: { cond: Expr; body: Node[] }[]; elseBody: Node[] | null }
  | { n: 'template'; name: string; pipe: Expr | null }
  | { n: 'define'; name: string; body: Node[] }
  | { n: 'block'; name: string; pipe: Expr | null; body: Node[] }
  | { n: 'break' }
  | { n: 'continue' };

const BUILTINS = new Set([
  'and', 'or', 'not', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'len', 'index', 'slice',
  'print', 'printf', 'println', 'html', 'js', 'urlquery', 'call',
]);

// ---------------------------------------------------------------- parser

class Parser {
  toks: Tok[] = [];
  pos = 0;
  line = 0;

  parseAction(raw: string, line: number): Expr {
    this.toks = tokenize(raw, line);
    this.pos = 0;
    this.line = line;
    return this.parsePipeline();
  }

  peek(): Tok | null {
    return this.pos < this.toks.length ? this.toks[this.pos] : null;
  }
  next(): Tok {
    const t = this.peek();
    if (!t) throw new Error(`line ${this.line}: unexpected end of action`);
    this.pos++;
    return t;
  }
  expectPunct(v: string) {
    const t = this.next();
    if (t.t !== 'punct' || t.v !== v) throw new Error(`line ${this.line}: expected ${v}, got ${JSON.stringify(t)}`);
  }

  parsePipeline(): Expr {
    // check for declaration: $a := / $a, $b := / $a =
    let decl: { vars: string[]; assign: boolean } | undefined;
    const save = this.pos;
    if (this.peek()?.t === 'var') {
      const vars: string[] = [];
      const p2 = this.pos;
      while (this.peek()?.t === 'var') {
        vars.push((this.next() as any).v);
        if (this.peek()?.t === 'punct' && (this.peek() as any).v === ',') {
          this.next();
          continue;
        }
        break;
      }
      if (this.peek()?.t === 'punct' && ((this.peek() as any).v === ':=' || (this.peek() as any).v === '=')) {
        const op = (this.next() as any).v;
        decl = { vars, assign: op === '=' };
      } else {
        this.pos = p2; // not a declaration, rewind fully
      }
    }
    const cmds: Expr[] = [this.parseCmd()];
    while (this.peek()?.t === 'punct' && (this.peek() as any).v === '|') {
      this.next();
      cmds.push(this.parseCmd());
    }
    // NOTE: trailing-token validation happens only at the top level
    // (parseAction); a nested parenthesized pipeline legitimately stops at ')'.
    return { e: 'pipeline', cmds, decl };
  }

  parseActionTop(src: string, line: number): Expr {
    this.toks = tokenize(src, line);
    this.pos = 0;
    this.line = line;
    const pipe = this.parsePipeline();
    if (this.pos !== this.toks.length) {
      throw new Error(`line ${this.line}: trailing tokens in action: ${JSON.stringify(this.toks.slice(this.pos))}`);
    }
    return pipe;
  }

  parseCmd(): Expr {
    const operands: Expr[] = [];
    while (true) {
      const t = this.peek();
      if (!t) break;
      if (t.t === 'punct' && (t.v === '|' || t.v === ')')) break;
      operands.push(this.parseOperand());
    }
    if (operands.length === 0) throw new Error(`line ${this.line}: empty command`);
    if (operands.length === 1) return operands[0];
    return { e: 'call', fn: operands[0], args: operands.slice(1) };
  }

  parseOperand(): Expr {
    const t = this.next();
    switch (t.t) {
      case 'punct':
        if (t.v === '(') {
          const pipe = this.parsePipeline();
          this.expectPunct(')');
          return this.parseFieldChain(pipe);
        }
        throw new Error(`line ${this.line}: unexpected ${t.v}`);
      case 'dot':
        return this.parseFieldChain({ e: 'operand', tok: { t: 'dot' } });
      case 'root':
        return this.parseFieldChain({ e: 'operand', tok: { t: 'root' } });
      case 'var':
        return this.parseFieldChain({ e: 'operand', tok: { t: 'var', v: t.v } });
      case 'field': {
        // .a.b.c — from current dot
        return this.parseFieldChainFrom({ e: 'operand', tok: { t: 'dot' } }, t.v);
      }
      case 'ident': {
        if (['if', 'else', 'end', 'range', 'with', 'template', 'define', 'block', 'break', 'continue'].includes(t.v)) {
          throw new Error(`line ${this.line}: unexpected keyword ${t.v}`);
        }
        return { e: 'operand', tok: { t: 'ident', v: t.v } };
      }
      case 'number':
        return { e: 'operand', tok: { t: 'number', v: t.v, isFloat: t.isFloat } };
      case 'string':
        return { e: 'operand', tok: { t: 'string', v: t.v } };
      case 'rawstring':
        return { e: 'operand', tok: { t: 'rawstring', v: t.v } };
      case 'char':
        return { e: 'operand', tok: { t: 'char', v: t.v } };
      case 'bool':
        return { e: 'operand', tok: { t: 'bool', v: t.v } };
      case 'nil':
        return { e: 'operand', tok: { t: 'nil' } };
    }
  }

  parseFieldChain(base: Expr): Expr {
    // after $ / $var / (pipe) a field token continues the chain ONLY when its
    // leading dot was attached to the previous token (`$.X`, `$v.X`, `(f).X`);
    // `... $index .ShortRepoPath` is a separate operand
    const t = this.peek();
    if (t?.t === 'field' && (t as any).adj) {
      const f = this.next() as any;
      return { e: 'field', base, path: f.v };
    }
    return base;
  }

  parseFieldChainFrom(base: Expr, path: string): Expr {
    // the dot-branch tokenizer emits complete chains as a single token
    return { e: 'field', base, path };
  }
}

interface ParseResult {
  body: Node[];
  defines: Map<string, Node[]>;
}

function parseTemplate(name: string, src: string): ParseResult {
  const pieces = lex(src);
  const defines = new Map<string, Node[]>();
  const p = new Parser();
  const result = parseNodes(name, pieces, 0, p, defines, []);
  return { body: result.body, defines };
}

interface ParseCtx {
  pieces: Piece[];
  p: Parser;
  defines: Map<string, Node[]>;
  tmplName: string;
}

function parseNodes(
  name: string,
  pieces: Piece[],
  startIdx: number,
  p: Parser,
  defines: Map<string, Node[]>,
  endTags: string[]
): { body: Node[]; end: string; next: number } {
  const body: Node[] = [];
  let idx = startIdx;
  const ctxCheck = (raw: string) => raw;
  void ctxCheck;

  while (idx < pieces.length) {
    const piece = pieces[idx++];
    if (piece.kind === 'text') {
      if (piece.text) body.push({ n: 'text', text: piece.text });
      continue;
    }
    const raw = (piece as any).raw.trim() as string;
    const line = (piece as any).line as number;
    const firstWord = raw.split(/\s+/)[0] ?? '';

    if (endTags.includes(firstWord)) {
      return { body, end: firstWord, next: idx };
    }

    switch (firstWord) {
      case 'if':
      case 'with': {
        const kwLen = firstWord.length;
        let cond = p.parseActionTop(raw.slice(kwLen).trim(), line);
        const branches: { cond: Expr; body: Node[] }[] = [];
        let elseBody: Node[] | null = null;
        while (true) {
          const r = parseNodes(name, pieces, idx, p, defines, ['else', 'end']);
          idx = r.next;
          branches.push({ cond, body: r.body });
          if (r.end === 'end') break;
          // r.end === 'else': the else piece is at idx-1
          const elseRaw = (pieces[idx - 1] as any).raw.trim();
          const chainRe = firstWord === 'if' ? /^else\s+if\s+([\s\S]*)$/ : /^else\s+with\s+([\s\S]*)$/;
          const m = chainRe.exec(elseRaw);
          if (m) {
            cond = p.parseActionTop(m[1].trim(), (pieces[idx - 1] as any).line);
            continue;
          }
          const r3 = parseNodes(name, pieces, idx, p, defines, ['end']);
          idx = r3.next;
          elseBody = r3.body;
          break;
        }
        body.push(firstWord === 'if' ? { n: 'if', branches, elseBody } : { n: 'with', branches, elseBody });
        break;
      }
      case 'range': {
        const pipe = p.parseAction(raw.slice(5).trim(), line);
        const decl = (pipe as any).decl as { vars: string[]; assign: boolean } | undefined;
        const r1 = parseNodes(name, pieces, idx, p, defines, ['else', 'end']);
        idx = r1.next;
        let elseBody: Node[] | null = null;
        if (r1.end === 'else') {
          const r3 = parseNodes(name, pieces, idx, p, defines, ['end']);
          idx = r3.next;
          elseBody = r3.body;
        }
        body.push({
          n: 'range',
          decl: decl ? decl.vars : [],
          cond: pipe,
          body: r1.body,
          elseBody,
        });
        break;
      }
      case 'define': {
        const m = /^define\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(raw);
        if (!m) throw new Error(`line ${line}: bad define syntax`);
        const r = parseNodes(name, pieces, idx, p, defines, ['end']);
        idx = r.next;
        defines.set(m[1], r.body);
        break;
      }
      case 'block': {
        const m = /^block\s+"((?:[^"\\]|\\.)*)"\s*([\s\S]*)$/.exec(raw);
        if (!m) throw new Error(`line ${line}: bad block syntax`);
        const pipe = m[2].trim() ? p.parseAction(m[2].trim(), line) : null;
        const r = parseNodes(name, pieces, idx, p, defines, ['end']);
        idx = r.next;
        defines.set(m[1], r.body);
        body.push({ n: 'template', name: m[1], pipe });
        break;
      }
      case 'template': {
        const m = /^template\s+"((?:[^"\\]|\\.)*)"\s*([\s\S]*)$/.exec(raw);
        if (!m) throw new Error(`line ${line}: bad template syntax`);
        const pipe = m[2].trim() ? p.parseAction(m[2].trim(), line) : null;
        body.push({ n: 'template', name: m[1], pipe });
        break;
      }
      case 'break':
        body.push({ n: 'break' });
        break;
      case 'continue':
        body.push({ n: 'continue' });
        break;
      case 'else':
      case 'end':
        throw new Error(`line ${line}: unexpected {{${firstWord}}}`);
      default: {
        const node = parseActionNode(raw, piece as any, p, defines);
        if (node) body.push(node);
      }
    }
  }
  if (endTags.length) throw new Error(`template ${name}: unexpected EOF, expected ${endTags.join('/')}`);
  return { body, end: 'eof', next: idx };
}

function parseActionNode(
  raw: string,
  piece: { raw: string; line: number },
  p: Parser,
  _defines: Map<string, Node[]>
): Node {
  const pipe = p.parseActionTop(raw, piece.line);
  return { n: 'action', pipe };
}

// ---------------------------------------------------------------- execution

export interface TemplateSetOptions {
  funcs: Record<string, (...args: any[]) => any>;
}

export class TemplateError extends Error {
  constructor(message: string, readonly tmplName?: string) {
    super(tmplName ? `[${tmplName}] ${message}` : message);
  }
}

export class TemplateSet {
  parsed = new Map<string, ParseResult>();
  funcs: Record<string, (...args: any[]) => any> = {};

  parse(name: string, src: string) {
    this.parsed.set(name, parseTemplate(name, src));
  }

  // register definitions from one file under all its define names
  registerFile(fileName: string, src: string) {
    const r = parseTemplate(fileName, src);
    this.parsed.set(fileName, r);
    for (const [dn, body] of r.defines) {
      this.parsed.set(dn, { body, defines: r.defines });
    }
  }

  has(name: string): boolean {
    return this.parsed.has(name);
  }

  render(name: string, data: any): string {
    const t = this.parsed.get(name);
    if (!t) throw new TemplateError(`template not found: ${name}`);
    const out = new RenderState(this);
    const buf: string[] = [];
    execList(t.body, data, newScope(null, data), this, out, buf, name);
    return buf.join('');
  }
}

interface Scope {
  vars: Map<string, any>;
  parent: Scope | null;
  root: any;
}

function newScope(parent: Scope | null, root: any): Scope {
  return { vars: new Map(), parent, root };
}

function lookupVar(s: Scope, name: string): { found: boolean; value?: any } {
  let cur: Scope | null = s;
  while (cur) {
    if (cur.vars.has(name)) return { found: true, value: cur.vars.get(name) };
    cur = cur.parent;
  }
  return { found: false };
}

class RenderState {
  breakFlag = false;
  continueFlag = false;
  inScript = 0; // depth of <script> contexts
  constructor(readonly set: TemplateSet) {}
}

function execList(
  body: Node[],
  dot: any,
  scope: Scope,
  set: TemplateSet,
  st: RenderState,
  buf: string[],
  tmplName: string
) {
  for (const node of body) {
    if (st.breakFlag || st.continueFlag) return;
    execNode(node, dot, scope, set, st, buf, tmplName);
  }
}

function execNode(
  node: Node,
  dot: any,
  scope: Scope,
  set: TemplateSet,
  st: RenderState,
  buf: string[],
  tmplName: string
) {
  switch (node.n) {
    case 'text': {
      buf.push(node.text);
      updateScriptContext(st, node.text);
      break;
    }
    case 'action': {
      const v = evalPipeline(node.pipe, dot, scope, set, st, tmplName);
      const decl = (node.pipe as any).decl as { vars: string[]; assign: boolean } | undefined;
      if (decl) {
        const val = v;
        if (decl.assign) {
          // assign to existing var found in scope chain
          let cur: Scope | null = scope;
          let assigned = false;
          while (cur) {
            if (cur.vars.has(decl.vars[0])) {
              cur.vars.set(decl.vars[0], val);
              assigned = true;
              break;
            }
            cur = cur.parent;
          }
          if (!assigned) scope.vars.set(decl.vars[0], val);
        } else {
          scope.vars.set(decl.vars[0], val);
        }
        return;
      }
      buf.push(printValue(v, st));
      break;
    }
    case 'if': {
      for (const br of node.branches) {
        if (isTrue(evalExpr(br.cond, dot, scope, set, st, tmplName))) {
          execList(br.body, dot, scope, set, st, buf, tmplName);
          return;
        }
      }
      if (node.elseBody) execList(node.elseBody, dot, scope, set, st, buf, tmplName);
      break;
    }
    case 'with': {
      for (const br of node.branches) {
        const v = evalExpr(br.cond, dot, scope, set, st, tmplName);
        if (isTrue(v)) {
          execList(br.body, v, scope, set, st, buf, tmplName);
          return;
        }
      }
      if (node.elseBody) execList(node.elseBody, dot, scope, set, st, buf, tmplName);
      break;
    }
    case 'range': {
      const col = evalExpr(node.cond, dot, scope, set, st, tmplName);
      const items = iterateCollection(col);
      if (items.length === 0) {
        if (node.elseBody) execList(node.elseBody, dot, scope, set, st, buf, tmplName);
        return;
      }
      for (const [k, v] of items) {
        const inner = newScope(scope, scope.root);
        if (node.decl.length === 1) inner.vars.set(node.decl[0], v);
        else if (node.decl.length >= 2) {
          inner.vars.set(node.decl[0], k);
          inner.vars.set(node.decl[1], v);
        }
        execList(node.body, v, inner, set, st, buf, tmplName);
        if (st.breakFlag) {
          st.breakFlag = false;
          break;
        }
        if (st.continueFlag) st.continueFlag = false;
      }
      break;
    }
    case 'template': {
      const sub = set.parsed.get(node.name);
      if (!sub) throw new TemplateError(`template not found: ${node.name}`, tmplName);
      const subDot = node.pipe ? evalExpr(node.pipe, dot, scope, set, st, tmplName) : null;
      const inner = newScope(null, subDot);
      execList(sub.body, subDot, inner, set, st, buf, node.name);
      break;
    }
    case 'define':
      break; // already registered at parse time
    case 'block':
      break;
    case 'break':
      st.breakFlag = true;
      return;
    case 'continue':
      st.continueFlag = true;
      return;
  }
}

function updateScriptContext(st: RenderState, text: string) {
  // Track JS-context depth. Only scripts WITHOUT a src= attribute enter the
  // JS context — `<script src="...">{{url}}</script>` is an attribute (URL)
  // context, and external scripts have no inline body to escape.
  let lower = text.toLowerCase();
  let i = 0;
  while (i < lower.length) {
    const open = lower.indexOf('<script', i);
    const close = lower.indexOf('</script', i);
    if (open >= 0 && (close < 0 || open < close)) {
      const tagEnd = lower.indexOf('>', open);
      if (tagEnd < 0) {
        // tag split across chunks: decide by attribute presence
        if (!lower.slice(open, open + 200).includes('src=')) st.inScript++;
        return; // rest of chunk is inside the (possible) tag; stop scanning
      }
      if (!lower.slice(open, tagEnd).includes('src=')) st.inScript++;
      i = tagEnd + 1;
      continue;
    }
    if (close >= 0) {
      st.inScript = Math.max(0, st.inScript - 1);
      i = close + 8;
      continue;
    }
    break;
  }
}

function iterateCollection(col: any): [any, any][] {
  if (col == null) return [];
  if (typeof col === 'number') {
    const out: [any, any][] = [];
    for (let i = 0; i < col; i++) out.push([i, i]);
    return out;
  }
  if (typeof col === 'string') {
    return Array.from(col).map((ch, i) => [i, ch] as [any, any]);
  }
  if (Array.isArray(col)) return col.map((v, i) => [i, v] as [any, any]);
  if (col instanceof Map) return Array.from(col.entries()).sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1);
  if (typeof col === 'object') {
    return Object.keys(col).sort().map((k) => [k, col[k]] as [any, any]);
  }
  return [];
}

// ---------------------------------------------------------------- evaluation

function evalPipeline(
  pipe: Expr,
  dot: any,
  scope: Scope,
  set: TemplateSet,
  st: RenderState,
  tmplName: string
): any {
  const cmds = (pipe as any).cmds as Expr[];
  let val: any;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (c.e === 'call') {
      const fnVal = evalExpr(c.fn, dot, scope, set, st, tmplName, false, true);
      const args = c.args.map((a) => evalExpr(a, dot, scope, set, st, tmplName, true));
      if (i > 0) args.push(val);
      val = callFunc(fnVal, args, tmplName);
    } else {
      // operand or nested pipeline (parenthesized)
      const v = evalExpr(c, dot, scope, set, st, tmplName, i > 0);
      if (i > 0) {
        val = callFunc(v, [val], tmplName);
      } else {
        // Go: a command that is a niladic function is invoked automatically
        val = typeof v === 'function' ? callFunc(v, [], tmplName) : v;
      }
    }
  }
  return val;
}

function evalExpr(
  expr: Expr,
  dot: any,
  scope: Scope,
  set: TemplateSet,
  st: RenderState,
  tmplName: string,
  nested = false,
  isHead = false
): any {
  switch (expr.e) {
    case 'pipeline':
      return evalPipeline(expr, dot, scope, set, st, tmplName);
    case 'call': {
      const fnVal = evalExpr(expr.fn, dot, scope, set, st, tmplName);
      const args = expr.args.map((a) => evalExpr(a, dot, scope, set, st, tmplName, true));
      return callFunc(fnVal, args, tmplName);
    }
    case 'field': {
      const base = evalExpr(expr.base, dot, scope, set, st, tmplName);
      // command head keeps methods as functions so they receive the args
      return resolveFieldChain(base, expr.path, !isHead);
    }
    case 'operand': {
      const t = expr.tok as any;
      switch (t.t) {
        case 'dot':
          return dot;
        case 'root':
          return scope.root;
        case 'var': {
          const r = lookupVar(scope, t.v);
          if (!r.found) throw new TemplateError(`undefined variable: $${t.v}`, tmplName);
          return r.value;
        }
        case 'number':
          return t.v;
        case 'string':
        case 'rawstring':
        case 'char':
          return t.v;
        case 'bool':
          return t.v;
        case 'nil':
          return null;
        case 'ident': {
          // builtin or user func value (not called here — used via call/pipe)
          if (BUILTINS.has(t.v)) return makeBuiltin(t.v);
          if (set.funcs[t.v]) return set.funcs[t.v];
          throw new TemplateError(`function ${t.v!} not defined`, tmplName);
        }
      }
      throw new TemplateError(`unknown operand`, tmplName);
    }
  }
}

function resolveFieldChain(base: any, path: string, invokeNiladic = true): any {
  let cur = base;
  const segs = path.split('.').filter((s) => s !== '');
  for (const seg of segs) {
    if (cur == null) return undefined;
    // numeric field access on arrays: .0 rare; support anyway
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      cur = cur[Number(seg)];
      continue;
    }
    const v = (cur as any)[seg];
    if (typeof v === 'function') {
      // Go: method access in operand position invokes niladic methods;
      // as a command head it stays a function to receive the command's args.
      cur = invokeNiladic ? v.call(cur) : v.bind(cur);
    } else {
      cur = v;
    }
  }
  return cur;
}

function callFunc(fn: any, args: any[], tmplName: string): any {
  if (typeof fn !== 'function') {
    // Go: "can't give argument to non-function"; be lenient: ignore extra args
    return fn;
  }
  try {
    return fn(...args);
  } catch (e) {
    if (e instanceof TemplateError) throw e;
    throw new TemplateError(`${(e as Error).message}`, tmplName);
  }
}

function makeBuiltin(name: string): (...args: any[]) => any {
  switch (name) {
    case 'and':
      return (...args: any[]) => {
        for (let i = 0; i < args.length; i++) {
          if (!isTrue(args[i])) return args[i];
        }
        return args[args.length - 1];
      };
    case 'or':
      return (...args: any[]) => {
        for (let i = 0; i < args.length; i++) {
          if (isTrue(args[i])) return args[i];
        }
        return args[args.length - 1];
      };
    case 'not':
      return (v: any) => !isTrue(v);
    case 'eq':
      return (...args: any[]) => {
        for (let i = 1; i < args.length; i++) {
          if (looseEq(args[0], args[i])) return true;
        }
        return false;
      };
    case 'ne':
      return (a: any, b: any) => !looseEq(a, b);
    case 'lt':
      return (a: any, b: any) => compare(a, b) < 0;
    case 'le':
      return (a: any, b: any) => compare(a, b) <= 0;
    case 'gt':
      return (a: any, b: any) => compare(a, b) > 0;
    case 'ge':
      return (a: any, b: any) => compare(a, b) >= 0;
    case 'len':
      return (v: any): number => {
        if (v == null) return 0;
        if (typeof v === 'string') return Buffer.byteLength(v, 'utf8');
        if (Array.isArray(v)) return v.length;
        if (v instanceof Map) return v.size;
        if (typeof v === 'object') return Object.keys(v).length;
        return 0;
      };
    case 'index':
      return (v: any, ...keys: any[]) => {
        let cur = v;
        for (const k of keys) {
          if (cur == null) return null;
          if (Array.isArray(cur) || typeof cur === 'string') cur = cur[Number(k)];
          else cur = (cur as any)[String(k)];
        }
        return cur;
      };
    case 'slice':
      return (v: any, ...idx: any[]) => {
        if (typeof v === 'string') {
          // Go slices strings by bytes; approximate with JS for ASCII parity
          if (idx.length === 1) return v.slice(idx[0]);
          return v.slice(idx[0], idx[1]);
        }
        if (Array.isArray(v)) {
          if (idx.length === 1) return v.slice(idx[0]);
          return v.slice(idx[0], idx[1]);
        }
        return v;
      };
    case 'print':
      return (...args: any[]) => goSprint(args);
    case 'printf':
      return (format: any, ...args: any[]) => goSprintf(String(format ?? ''), args);
    case 'println':
      return (...args: any[]) => goSprint(args) + '\n';
    case 'html':
      return (v: any) => goEscape(String(printPlain(v)));
    case 'js':
      return (v: any) => JSON.stringify(v) ?? 'null';
    case 'urlquery':
      return (v: any) => goQueryEscape(printPlain(v));
    case 'call':
      return (fn: any, ...args: any[]) => (typeof fn === 'function' ? fn(...args) : fn);
  }
  throw new Error(`unknown builtin ${name}`);
}

function looseEq(a: any, b: any): boolean {
  if (a == null && b == null) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (a instanceof SafeHTML) a = a.html;
  if (b instanceof SafeHTML) b = b.html;
  return a === b;
}

function compare(a: any, b: any): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function isTrue(v: any): boolean {
  if (v == null || v === false) return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v) ? true : false;
  if (typeof v === 'string' || v instanceof String) return String(v).length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0 || Object.getPrototypeOf(v) !== Object.prototype;
  return true;
}

// ---------------------------------------------------------------- printing

function printPlain(v: any): string {
  if (v == null) return '<no value>';
  if (v instanceof SafeHTML) return v.html;
  if (typeof v === 'string' || v instanceof String) return String(v);
  if (typeof v === 'number') return fmtNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map((x) => printPlain(x)).join(' ') + ']';
  if (v instanceof Map) {
    const keys = Array.from(v.keys()).map(String).sort();
    return 'map[' + keys.map((k) => `${k}:${printPlain(v.get(k))}`).join(' ') + ']';
  }
  if (typeof v === 'object') {
    // Go struct: {v1 v2}
    return '{' + Object.values(v).map((x) => printPlain(x)).join(' ') + '}';
  }
  return String(v);
}

function fmtNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

export function goEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;');
}

/** html/template jsEscaper: escape JS-special chars, no added quotes. */
function jsEscape(s: string): string {
  let out = '';
  for (const ch of String(s)) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case "'": out += "\\'"; break;
      case '"': out += '\\"'; break;
      case '<': out += '\\u003C'; break;
      case '>': out += '\\u003E'; break;
      case '&': out += '\\u0026'; break;
      case '=': out += '\\u003D'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\u2028': out += '\\u2028'; break;
      case '\u2029': out += '\\u2029'; break;
      default: out += ch;
    }
  }
  return out;
}

function goQueryEscape(s: string): string {
  // Go url.QueryEscape: unreserved chars A-Za-z0-9-_.~ kept, space -> '+'
  let out = '';
  for (const ch of s) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === ' ') out += '+';
    else {
      const bytes = Buffer.from(ch, 'utf8');
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase();
    }
  }
  return out;
}

function printValue(v: any, st: RenderState): string {
  if (v == null) return st.inScript > 0 ? 'null' : '<no value>';
  if (v instanceof SafeHTML) return v.html;
  if (typeof v === 'string' || v instanceof String) return st.inScript > 0 ? jsEscape(String(v)) : goEscape(String(v));
  if (typeof v === 'function') return '';
  if (typeof v === 'number') return st.inScript > 0 ? String(v) : printPlain(v);
  if (typeof v === 'boolean') return String(v);
  const plain = printPlain(v);
  return st.inScript > 0 ? jsEscape(plain) : goEscape(plain);
}

// ---------------------------------------------------------------- fmt.Sprint / Sprintf subset

function goSprint(args: any[]): string {
  let out = '';
  for (let i = 0; i < args.length; i++) {
    const s = printPlain(args[i]);
    if (i > 0 && typeof args[i] !== 'string' && typeof args[i - 1] !== 'string') out += ' ';
    out += s;
  }
  return out;
}

export function goSprintf(format: string, args: any[]): string {
  let argIdx = 0;
  let out = '';
  let i = 0;
  while (i < format.length) {
    const c = format[i];
    if (c !== '%') {
      out += c;
      i++;
      continue;
    }
    // positional form: %[N]<verb> — sets the argument index for this verb only
    const posMatch = /^%\[(\d+)\]/.exec(format.slice(i));
    let positional = false;
    if (posMatch) {
      argIdx = Number(posMatch[1]) - 1;
      i += posMatch[0].length;
      positional = true;
    }
    // parse verb: %[-+ #0]*[0-9]*(\.[0-9]+)?[bdeEfFgGoOqxXscvU%]
    let j = positional ? i : i + 1;
    let flags = '';
    while (j < format.length && /[-+ #0]/.test(format[j])) {
      flags += format[j];
      j++;
    }
    let width = '';
    while (j < format.length && /[0-9]/.test(format[j])) {
      width += format[j];
      j++;
    }
    let prec = '';
    if (format[j] === '.') {
      j++;
      while (j < format.length && /[0-9]/.test(format[j])) {
        prec += format[j];
        j++;
      }
      if (prec === '') prec = '0';
    }
    const verb = format[j];
    if (verb === undefined) {
      out += '%';
      break;
    }
    if (verb === '%') {
      out += '%';
      i = j + 1;
      continue;
    }
    const arg = args[argIdx];
    argIdx = argIdx + 1;
    out += formatVerb(verb, flags, width, prec, arg);
    i = j + 1;
  }
  return out;
}

function formatVerb(verb: string, flags: string, width: string, prec: string, arg: any): string {
  let s: string;
  switch (verb) {
    case 's':
      s = arg == null ? '%!s(<nil>)' : printPlain(arg);
      if (prec !== '') s = s.slice(0, Number(prec));
      break;
    case 'd': {
      const n = Math.trunc(Number(arg));
      if (Number.isNaN(n)) s = `%!d(${printPlain(arg)})`;
      else s = String(n);
      break;
    }
    case 'x':
      s = typeof arg === 'string' ? Buffer.from(arg, 'utf8').toString('hex') : (Number(arg) >>> 0).toString(16);
      break;
    case 'X':
      s = typeof arg === 'string' ? Buffer.from(arg, 'utf8').toString('hex').toUpperCase() : (Number(arg) >>> 0).toString(16).toUpperCase();
      break;
    case 'f':
    case 'F': {
      const n = Number(arg);
      s = n.toFixed(prec === '' ? 6 : Number(prec));
      break;
    }
    case 'g':
      s = String(Number(arg));
      break;
    case 'q':
      s = JSON.stringify(printPlain(arg)) ?? '""';
      break;
    case 'v':
      s = printPlain(arg);
      break;
    case 't':
      s = String(isTrue(arg));
      break;
    default:
      s = `%!${verb}(${printPlain(arg)})`;
  }
  // width padding
  if (width) {
    const w = Number(width);
    if (s.length < w) {
      if (flags.includes('-')) s = s.padEnd(w);
      else if (flags.includes('0') && (verb === 'd' || verb === 'f')) {
        const neg = s.startsWith('-');
        s = neg ? '-' + s.slice(1).padStart(w - (neg ? 1 : 0), '0') : s.padStart(w, '0');
      } else s = s.padStart(w);
    }
  }
  return s;
}
