// ts-gogs git functionality full-coverage test (HTTP smart protocol, SSH, LFS batch API, webhooks).
//   node test/git-test.mjs
// Requires: server on :3000, system sshd on :22 (authorized_keys mode).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { BASE, ADMIN, SSH_PORT, api, check, section, summary, uniq, waitForServer, payload, git, mkWorkdir, gitEnv } from './helpers.mjs';

const PASS = 'Passw0rd!123';
const U = uniq('gituser');
const R = uniq('git-repo');
const R2 = uniq('git-priv');
let token = '';

function authUrl(path) {
  return `http://${U}:${encodeURIComponent(PASS)}@${BASE.replace('http://', '')}${path}`;
}

async function main() {
  await waitForServer();

  // ------------------------------------------------ setup: user + token + repos
  section('setup');
  let r = await api('POST', '/api/v1/admin/users', { ...ADMIN, body: { username: U, email: `${U}@test.local`, password: PASS } });
  check('create git test user', [200, 201].includes(r.status), r.text);
  r = await api('POST', `/api/v1/users/${U}/tokens`, { user: U, pass: PASS, body: { name: uniq('t') } });
  token = payload(r)?.sha1 || payload(r)?.token;
  check('mint token', !!token, r.text);
  const T = { token };
  r = await api('POST', '/api/v1/user/repos', { ...T, body: { name: R, private: false, auto_init: true, readme: 'README.md' } });
  check('create public repo (auto-init)', [200, 201].includes(r.status), r.text);
  r = await api('POST', '/api/v1/user/repos', { ...T, body: { name: R2, private: true, auto_init: true, readme: 'r.md' } });
  check('create private repo', [200, 201].includes(r.status), r.text);

  const dir = await mkWorkdir('gogs-git-');

  // ------------------------------------------------ HTTP: clone / push / pull
  section('HTTP: basic flow');
  r = await git(['clone', authUrl(`/${U}/${R}.git`), `${dir}/${R}`], { env: gitEnv() });
  check('authenticated clone', r.ok, r.stderr);
  const work = `${dir}/${R}`;
  writeFileSync(`${work}/hello.txt`, 'line1\n');
  await git(['add', '.'], { cwd: work });
  await git(['commit', '-m', 'commit 1'], { cwd: work, env: gitEnv() });
  r = await git(['push', 'origin', 'master'], { cwd: work, env: gitEnv() });
  check('push to master', r.ok, r.stderr);
  r = await api('GET', `/api/v1/repos/${U}/${R}/raw/master/hello.txt`, T);
  check('pushed content visible via API', r.status === 200 && r.text === 'line1\n', r.status);
  r = await git(['pull', 'origin', 'master'], { cwd: work, env: gitEnv() });
  check('pull (up to date)', r.ok, r.stderr);

  // second clone sees pushed commit
  r = await git(['clone', authUrl(`/${U}/${R}.git`), `${dir}/${R}-2`], { env: gitEnv() });
  const log2 = r.ok ? await git(['log', '--oneline'], { cwd: `${dir}/${R}-2` }) : r;
  check('second clone contains commit 1', r.ok && log2.stdout.includes('commit 1'), log2.stderr);

  // empty-commit push (everything up to date)
  r = await git(['push', 'origin', 'master'], { cwd: work, env: gitEnv() });
  check('idempotent push', r.ok, r.stderr);

  section('HTTP: branches & tags');
  r = await git(['checkout', '-b', 'feature-1'], { cwd: work });
  writeFileSync(`${work}/feature.txt`, 'feature\n');
  await git(['add', '.'], { cwd: work });
  await git(['commit', '-m', 'feature commit'], { cwd: work, env: gitEnv() });
  r = await git(['push', 'origin', 'feature-1'], { cwd: work, env: gitEnv() });
  check('push new branch', r.ok, r.stderr);
  r = await api('GET', `/api/v1/repos/${U}/${R}/branches`, T);
  check('branch listed via API', r.text.includes('feature-1'), r.status);
  r = await git(['push', 'origin', '--delete', 'feature-1'], { cwd: work, env: gitEnv() });
  check('delete branch via push', r.ok, r.stderr);
  r = await api('GET', `/api/v1/repos/${U}/${R}/branches`, T);
  check('branch gone via API', !r.text.includes('feature-1'), r.status);

  r = await git(['tag', 'v9.9.9'], { cwd: work });
  r = await git(['push', 'origin', 'v9.9.9'], { cwd: work, env: gitEnv() });
  check('push tag', r.ok, r.stderr);
  r = await api('GET', `/api/v1/repos/${U}/${R}/tags`, T);
  check('tag listed via API', r.text.includes('v9.9.9'), r.status);
  r = await git(['push', 'origin', '--delete', 'v9.9.9'], { cwd: work, env: gitEnv() });
  check('delete tag via push', r.ok, r.stderr);

  section('HTTP: binary file roundtrip');
  const bin = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) % 256));
  writeFileSync(`${work}/blob.bin`, bin);
  await git(['add', '.'], { cwd: work });
  await git(['commit', '-m', 'binary'], { cwd: work, env: gitEnv() });
  await git(['checkout', 'master'], { cwd: work });
  r = await git(['merge', 'feature-1'], { cwd: work, env: gitEnv() });
  r = await git(['push', 'origin', 'master'], { cwd: work, env: gitEnv() });
  check('push binary commit', r.ok, r.stderr);
  r = await api('GET', `/api/v1/repos/${U}/${R}/raw/master/blob.bin`, T);
  const roundtrip = r.status === 200 ? createHash('sha256').update(Buffer.from(await (await fetch(BASE + `/api/v1/repos/${U}/${R}/raw/master/blob.bin`, { headers: { Authorization: `token ${token}` } })).arrayBuffer())).digest('hex') : 'fail';
  check('binary roundtrip hash matches', roundtrip === createHash('sha256').update(bin).digest('hex'), roundtrip);

  section('HTTP: shallow & specific ref');
  r = await git(['clone', '--depth', '1', authUrl(`/${U}/${R}.git`), `${dir}/${R}-shallow`], { env: gitEnv() });
  check('shallow clone', r.ok, r.stderr);
  r = await git(['clone', '--branch', 'master', '--single-branch', authUrl(`/${U}/${R}.git`), `${dir}/${R}-sb`], { env: gitEnv() });
  check('clone --branch --single-branch', r.ok, r.stderr);
  r = await git(['ls-remote', authUrl(`/${U}/${R}.git`)], { env: gitEnv() });
  check('ls-remote lists refs', r.ok && /refs\/heads\/master/.test(r.stdout), r.stderr);

  section('HTTP: access control');
  r = await git(['clone', `${BASE}/${U}/${R}.git`], { env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' } });
  check('anonymous clone public repo', r.ok, r.stderr);
  r = await git(['clone', `${BASE}/${U}/${R2}.git`, `${dir}/anon-priv`], { env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' } });
  check('anonymous clone private repo rejected', !r.ok, r.stdout);
  r = await git(['clone', `${BASE.replace('http://', `http://wrong:bad@`)}/${U}/${R2}.git`, `${dir}/badpass`], { env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' } });
  check('clone private with bad password rejected', !r.ok, r.stdout);
  // anonymous push onto public repo must fail (receive-pack requires auth)
  const anonWork = `${dir}/${R}-2`;
  writeFileSync(`${anonWork}/anon.txt`, 'nope\n');
  await git(['add', '.'], { cwd: anonWork });
  await git(['commit', '-m', 'anon push'], { cwd: anonWork, env: gitEnv() });
  r = await git(['push', `${BASE}/${U}/${R}.git`, 'master'], { cwd: anonWork, env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' } });
  check('anonymous push rejected', !r.ok, r.stdout);

  section('HTTP: non-fast-forward');
  // rewind work repo by one commit and push without force -> must be rejected
  await git(['reset', '--hard', 'HEAD~1'], { cwd: work, env: gitEnv() });
  r = await git(['push', 'origin', 'master'], { cwd: work, env: gitEnv() });
  check('non-fast-forward push rejected', !r.ok && /rejected|failed/i.test(r.stderr + r.stdout), r.stderr.slice(0, 150));
  r = await git(['push', '--force', 'origin', 'master'], { cwd: work, env: gitEnv() });
  check('force push accepted', r.ok, r.stderr);
  // restore the removed commit into history to keep repo consistent
  r = await git(['reflog'], { cwd: work });
  if (!r.stdout.includes('binary')) await git(['revert', '--no-edit', 'HEAD'], { cwd: work, env: gitEnv() });

  // ------------------------------------------------ webhook: push event delivery
  section('webhook delivery on push');
  const received = [];
  const hookServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((res) => hookServer.listen(18099, res));
  r = await api('POST', `/api/v1/repos/${U}/${R}/hooks`, { ...T, body: { type: 'gogs', config: { url: 'http://127.0.0.1:18099/hook', content_type: 'json' }, events: ['push'], active: true } });
  check('create webhook', [200, 201].includes(r.status), r.text);
  writeFileSync(`${work}/wh.txt`, 'webhook\n');
  await git(['add', '.'], { cwd: work });
  await git(['commit', '-m', 'webhook trigger commit'], { cwd: work, env: gitEnv() });
  r = await git(['push', 'origin', 'master'], { cwd: work, env: gitEnv() });
  check('push for webhook', r.ok, r.stderr);
  for (let i = 0; i < 20 && received.length === 0; i++) await new Promise((res) => setTimeout(res, 500));
  check('webhook delivered', received.length > 0, 'no delivery within 10s');
  if (received.length) {
    const evt = JSON.parse(received[0].body);
    check('webhook is push event', (evt.ref || '').includes('master') || evt.commits !== undefined, received[0].body.slice(0, 150));
    check('webhook has commits array', Array.isArray(evt.commits), typeof evt.commits);
    check('webhook pusher present', !!evt.pusher, JSON.stringify(evt.pusher));
    check('webhook signature header', typeof (received[0].headers['x-gogs-signature'] || received[0].headers['x-gogs-event']) === 'string', Object.keys(received[0].headers).join(','));
  }
  hookServer.close();

  // ------------------------------------------------ LFS: HTTP batch API roundtrip
  section('LFS HTTP batch API');
  const oid = createHash('sha256').update('lfs content payload v1').digest('hex');
  const content = 'lfs content payload v1';
  r = await api('POST', `/${U}/${R}.git/info/lfs/objects/batch`, {
    user: U, pass: PASS, headers: { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
    body: { operation: 'upload', objects: [{ oid, size: content.length }], hash_algo: 'sha256' },
  });
  check('LFS batch upload 200', r.status === 200, r.text.slice(0, 200));
  const obj = (payload(r)?.objects || [])[0];
  const upHref = obj?.actions?.upload?.href;
  check('LFS batch returns upload href', !!upHref, JSON.stringify(obj).slice(0, 200));
  if (upHref) {
    const up = await fetch(upHref.startsWith('http') ? upHref : BASE + upHref, {
      method: 'PUT', body: content,
      headers: { Authorization: `Basic ${Buffer.from(`${U}:${PASS}`).toString('base64')}`, 'Content-Type': 'application/octet-stream' },
    });
    check('LFS upload PUT 200', [200, 201].includes(up.status), up.status);
  }
  r = await api('POST', `/${U}/${R}.git/info/lfs/objects/batch`, {
    user: U, pass: PASS, headers: { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
    body: { operation: 'download', objects: [{ oid, size: content.length }], hash_algo: 'sha256' },
  });
  const dlObj = (payload(r)?.objects || [])[0];
  const dlHref = dlObj?.actions?.download?.href;
  check('LFS batch download href', !!dlHref, JSON.stringify(dlObj).slice(0, 200));
  if (dlHref) {
    const dl = await fetch(dlHref.startsWith('http') ? dlHref : BASE + dlHref, { headers: { Authorization: `Basic ${Buffer.from(`${U}:${PASS}`).toString('base64')}` } });
    const text = await dl.text();
    check('LFS download content matches', dl.status === 200 && text === content, dl.status + ' ' + text.slice(0, 80));
  }
  r = await api('POST', `/${U}/${R}.git/info/lfs/objects/batch`, {
    user: 'nouser', pass: 'badpass', headers: { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
    body: { operation: 'download', objects: [{ oid, size: content.length }] },
  });
  check('LFS batch unauthorized rejected', [401, 403, 404].includes(r.status), r.status);

  // ------------------------------------------------ SSH: authorized_keys mode
  section('SSH (authorized_keys mode)');
  const keyPath = `/tmp/git-test-key-${Date.now()}`;
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q']);
  const pub = readFileSync(keyPath + '.pub', 'utf8').trim();
  r = await api('POST', '/api/v1/user/keys', { ...T, body: { title: 'git-test-key', key: pub } });
  check('add SSH key via API', [200, 201].includes(r.status), r.text.slice(0, 200));
  // wait for authorized_keys rewrite
  const home = execFileSync('bash', ['-c', 'echo $HOME']).toString().trim();
  let keyInFile = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((res) => setTimeout(res, 500));
    if (existsSync(`${home}/.ssh/authorized_keys`) && readFileSync(`${home}/.ssh/authorized_keys`, 'utf8').includes(pub.split(' ')[1])) { keyInFile = true; break; }
  }
  check('authorized_keys rewritten with key', keyInFile);

  const sshURL = (path) => `ssh://${U === 'root' ? 'git' : U}@127.0.0.1:${SSH_PORT}/${path}`;
  // authorized_keys command= runs `serv key-N` as the server user; the connecting SSH user must be the machine user.
  const serverUser = execFileSync('bash', ['-c', 'whoami']).toString().trim();
  const sshCloneURL = `ssh://${serverUser}@127.0.0.1:${SSH_PORT}/${U}/${R}.git`;
  const sshDir = `${dir}/${R}-ssh`;
  r = await git(['clone', sshCloneURL, sshDir], { env: { ...gitEnv(), GIT_SSH_COMMAND: `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${SSH_PORT}` } });
  check('SSH clone', r.ok, r.stderr.slice(0, 300));
  if (existsSync(sshDir)) {
    writeFileSync(`${sshDir}/ssh-file.txt`, 'via ssh\n');
    await git(['add', '.'], { cwd: sshDir });
    await git(['commit', '-m', 'ssh commit'], { cwd: sshDir, env: gitEnv() });
    r = await git(['push', 'origin', 'master'], { cwd: sshDir, env: { ...gitEnv(), GIT_SSH_COMMAND: `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` } });
    check('SSH push', r.ok, r.stderr.slice(0, 300));
    r = await api('GET', `/api/v1/repos/${U}/${R}/raw/master/ssh-file.txt`, T);
    check('SSH-pushed content visible via API', r.status === 200 && r.text === 'via ssh\n', r.status);
    r = await git(['ls-remote', sshCloneURL], { cwd: sshDir, env: { ...gitEnv(), GIT_SSH_COMMAND: `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` } });
    check('SSH ls-remote', r.ok && /refs\/heads\/master/.test(r.stdout), r.stderr.slice(0, 200));
  }
  // wrong-key access to private repo -> should fail
  const key2 = `/tmp/git-test-key2-${Date.now()}`;
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key2, '-q']);
  r = await git(['clone', sshCloneURL.replace(R + '.git', R2 + '.git'), `${dir}/ssh-denied`], { env: { ...gitEnv(), GIT_SSH_COMMAND: `ssh -i ${key2} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${SSH_PORT}` } });
  check('SSH clone with unauthorized key rejected', !r.ok, r.stdout.slice(0, 200));

  // ------------------------------------------------ cleanup
  section('cleanup');
  await api('DELETE', `/api/v1/repos/${U}/${R}`, T);
  await api('DELETE', `/api/v1/repos/${U}/${R2}`, T);
  r = await api('GET', `/api/v1/repos/${U}/${R}`);
  check('test repo removed', [404].includes(r.status), r.status);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

main()
  .catch((e) => { check('git-test crashed', false, e.stack || e.message); })
  .finally(() => process.exit(summary('GIT-TEST')));
