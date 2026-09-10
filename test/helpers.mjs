// Shared helpers for ts-gogs test suites (api / git / ui).
// Run against a live server:  GOGS_URL=http://127.0.0.1:3000 ADMIN_PASS=admin123
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const execFileP = promisify(execFile);

export const BASE = (process.env.GOGS_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
export const ADMIN = { user: process.env.ADMIN_USER || 'root', pass: process.env.ADMIN_PASS || 'admin123' };
export const SSH_PORT = Number(process.env.SSH_PORT || 22);

// ---------------------------------------------------------------- reporting
let passed = 0;
let failed = 0;
const failures = [];

export function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`);
  }
  return cond;
}

export function section(title) {
  console.log(`\n== ${title}`);
}

export function summary(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed${failed ? ' → ' + failures.join(' | ') : ''}`);
  return failed === 0 ? 0 : 1;
}

export function uniq(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

// ---------------------------------------------------------------- HTTP/API
export async function api(method, path, opts = {}) {
  const { user, pass, token, body, headers = {}, raw } = opts;
  const h = { ...headers };
  if (token) h.Authorization = `token ${token}`;
  else if (user) h.Authorization = 'Basic ' + Buffer.from(`${user}:${pass ?? ''}`).toString('base64');
  let payload;
  if (body !== undefined && !(body instanceof Buffer)) {
    h['Content-Type'] = h['Content-Type'] || 'application/json';
    payload = JSON.stringify(body);
  } else if (body instanceof Buffer) {
    payload = body;
  }
  const res = await fetch(BASE + path, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, text, json: json ?? text };
}

export async function waitForServer(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${BASE} not reachable after ${timeoutMs}ms`);
}

// gogs API JSON responses may be wrapped ({ok,data}) or plain — unwrap defensively
export function payload(r) {
  if (r.json && typeof r.json === 'object' && !Array.isArray(r.json) && 'ok' in r.json && 'data' in r.json) return r.json.data;
  return r.json;
}

// ---------------------------------------------------------------- git
export async function git(args, opts = {}) {
  const { cwd, env, mustSucceed = false } = opts;
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 1 << 24 });
    if (mustSucceed) return { ok: true, stdout, stderr };
    return { ok: true, stdout, stderr };
  } catch (e) {
    if (mustSucceed) throw new Error(`git ${args.join(' ')} failed: ${e.message.slice(0, 400)}`);
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}

export async function mkWorkdir(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** Standard git identity + no interactive prompts for test clones. */
export function gitEnv() {
  return {
    GIT_AUTHOR_NAME: 'tsgogs-tester',
    GIT_AUTHOR_EMAIL: 'tester@test.local',
    GIT_COMMITTER_NAME: 'tsgogs-tester',
    GIT_COMMITTER_EMAIL: 'tester@test.local',
    GIT_TERMINAL_PROMPT: '0',
  };
}
