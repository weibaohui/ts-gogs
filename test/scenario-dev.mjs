// 开发场景全流程演练：两人团队在 ts-gogs 上开发 "todo-api" 项目。
//   node test/scenario-dev.mjs
// 覆盖：组织/账号/仓库初始化 → 团队授权 → CI webhook → 功能分支开发 →
// issue 协作 → PR 评审合并 → 删分支 → 打 tag → 网页发 Release → 归档下载 →
// star/watch/explore/blame → 关 issue → SSH 克隆。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { BASE, ADMIN, api, check, section, summary, uniq, waitForServer, payload, git, mkWorkdir, gitEnv } from './helpers.mjs';

const PASS = 'Passw0rd!123';
const ORG = 'acme-' + uniq('');
const ALICE = 'dev-alice-' + uniq('');
const BOB = 'dev-bob-' + uniq('');
const R = 'todo-api';
let orik = 0; // run id suffix for org repo names is fixed: repo name stays R under org

// cookie-session helper for web-form actions a developer would do in a browser
async function newSession(user, pass) {
  let cookie = '';
  const first = await fetch(BASE + '/user/sign-in');
  cookie = (first.headers.get('set-cookie') || '').split(';')[0];
  // upstream expects JSON at /api/web/user/sign-in; our port accepts form-encoded — try both
  let res = await fetch(BASE + '/api/web/user/sign-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (res.status !== 200) {
    res = await fetch(BASE + '/api/web/user/sign-in', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: `username=${user}&password=${encodeURIComponent(pass)}`,
    });
  }
  const setCookies = (res.headers.get('set-cookie') || '').match(/[^ ]+?=[^;]*;/g) || [];
  cookie = [cookie, ...setCookies.map((c) => c.trim().replace(/;$/, ''))].filter(Boolean).join('; ');
  if (res.status !== 200) throw new Error(`session login failed for ${user}`);
  return {
    async get(path) {
      const r = await fetch(BASE + path, { headers: { Cookie: cookie } });
      return { status: r.status, text: await r.text(), headers: r.headers };
    },
    async post(path, body = {}) {
      const r = await fetch(BASE + path, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
        redirect: 'manual',
      });
      return { status: r.status, text: await r.text(), headers: r.headers, location: r.headers.get('location') || '' };
    },
  };
}

async function main() {
  await waitForServer();
  const hookHits = [];
  const hookServer = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { hookHits.push({ t: Date.now(), body: b }); res.writeHead(200); res.end(); });
  });
  await new Promise((res) => hookServer.listen(18098, res));

  const tokens = {};
  async function mint(user, pass, auth) {
    const r = await api('POST', `/api/v1/users/${user}/tokens`, { ...auth, body: { name: uniq('t') } });
    if (![200, 201].includes(r.status)) throw new Error(`mint ${user}: ${r.status} ${r.text}`);
    return payload(r)?.sha1 || payload(r)?.token;
  }

  // ================================================ 阶段一 项目初始化（负责人 root）
  section('阶段一 · 项目初始化');
  let r = await api('POST', '/api/v1/admin/users', { ...ADMIN, body: { username: ALICE, email: `${ALICE}@acme.dev`, password: PASS } });
  check('1. 创建开发者账号 dev-alice', [200, 201].includes(r.status), r.text);
  r = await api('POST', '/api/v1/admin/users', { ...ADMIN, body: { username: BOB, email: `${BOB}@acme.dev`, password: PASS } });
  check('2. 创建开发者账号 dev-bob', [200, 201].includes(r.status), r.text);
  r = await api('POST', `/api/v1/admin/users/${ALICE}/orgs`, { ...ADMIN, body: { username: ORG } });
  check('3. 创建组织 acme', [200, 201].includes(r.status), r.text);

  tokens.alice = await mint(ALICE, PASS, { user: ALICE, pass: PASS });
  tokens.bob = await mint(BOB, PASS, { user: BOB, pass: PASS });
  const A = { token: tokens.alice };
  const B = { token: tokens.bob };

  r = await api('POST', `/api/v1/org/${ORG}/repos`, { ...A, body: { name: R, private: false, auto_init: true, readme: 'README.md', gitignores: 'Go', license: '', readme: 'Default' } });
  check('4. 组织下建仓库 todo-api（README+gitignore 初始化）', [200, 201].includes(r.status), r.text);

  r = await api('POST', `/api/v1/admin/orgs/${ORG}/teams`, { ...ADMIN, body: { name: 'developers', permission: 'write' } });
  const teamId = payload(r)?.id;
  check('5. 建开发团队 developers(write)', [200, 201].includes(r.status), r.text);
  if (teamId) {
    await api('PUT', `/api/v1/admin/teams/${teamId}/members/${ALICE}`, ADMIN);
    await api('PUT', `/api/v1/admin/teams/${teamId}/members/${BOB}`, ADMIN);
    r = await api('PUT', `/api/v1/admin/teams/${teamId}/repos/${R}`, ADMIN);
    check('6. 成员入队 + 仓库授权', [200, 201, 204].includes(r.status), r.status);
  }

  r = await api('POST', `/api/v1/repos/${ORG}/${R}/hooks`, { ...A, body: { type: 'gogs', config: { url: 'http://127.0.0.1:18098/ci', content_type: 'json' }, events: ['push'], active: true } });
  check('7. 配置 CI webhook', [200, 201].includes(r.status), r.text);
  r = await api('POST', `/api/v1/repos/${ORG}/${R}/milestones`, { ...A, body: { title: 'v0.1.0 首个可用版本' } });
  check('8. 建里程碑 v0.1.0', [200, 201].includes(r.status), r.text);
  r = await api('POST', `/api/v1/repos/${ORG}/${R}/labels`, { ...A, body: { name: 'bug', color: '#ee0701' } });
  check('9. 建标签 bug', [200, 201].includes(r.status), r.text);
  r = await api('POST', `/api/v1/repos/${ORG}/${R}/labels`, { ...A, body: { name: 'enhancement', color: '#84b6eb' } });
  check('10. 建标签 enhancement', [200, 201].includes(r.status), r.text);

  // ================================================ 阶段二 功能开发（dev-alice）
  section('阶段二 · 功能开发（dev-alice）');
  const dir = await mkWorkdir('drill-');
  const cloneURL = `http://${ALICE}:${encodeURIComponent(PASS)}@${BASE.replace('http://', '')}/${ORG}/${R}.git`;
  r = await git(['clone', cloneURL, `${dir}/todo-api`], { env: gitEnv() });
  check('11. git clone（HTTP + 账号）', r.ok, r.stderr);
  const work = `${dir}/todo-api`;
  r = await git(['checkout', '-b', 'feature/user-api'], { cwd: work });
  writeFileSync(`${work}/src.js`, `const todos = [];\nfunction add(text) { todos.push({ text, done: false }); }\nmodule.exports = { add, todos };\n`);
  writeFileSync(`${work}/README.md`, '# todo-api\n\n一个极简待办 API。\n- [x] 添加待办\n- [ ] 查询待办\n');
  await git(['add', '.'], { cwd: work });
  await git(['commit', '-m', 'feat: 待办添加接口骨架'], { cwd: work, env: gitEnv() });
  writeFileSync(`${work}/src.js`, `const todos = [];\nfunction add(text) { todos.push({ text, done: false }); }\nfunction list() { return todos.filter(t => !t.done); }\nmodule.exports = { add, list, todos };\n`);
  await git(['add', '.'], { cwd: work });
  await git(['commit', '-m', 'feat: 待办列表查询'], { cwd: work, env: gitEnv() });
  r = await git(['push', 'origin', 'feature/user-api'], { cwd: work, env: gitEnv() });
  check('12. 功能分支 feature/user-api 两次提交并推送', r.ok, r.stderr);

  // ================================================ 阶段三 协作（dev-bob）
  section('阶段三 · 协作（dev-bob）');
  r = await git(['clone', `http://${BOB}:${encodeURIComponent(PASS)}@${BASE.replace('http://', '')}/${ORG}/${R}.git`, `${dir}/todo-api-bob`], { env: gitEnv() });
  check('13. dev-bob clone 同一仓库（团队写权限生效）', r.ok, r.stderr);
  r = await api('POST', `/api/v1/repos/${ORG}/${R}/issues`, { ...B, body: { title: '缺少 done 状态切换', body: 'add() 只会追加，无法把待办标记为完成。建议补 toggle 接口。' } });
  const issueNo = payload(r)?.number ?? payload(r)?.index;
  check('14. dev-bob 提 issue', [200, 201].includes(r.status) && !!issueNo, r.text.slice(0, 150));
  r = await api('POST', `/api/v1/repos/${ORG}/${R}/issues/${issueNo}/labels`, { ...B, body: { labels: [] } });
  r = await api('GET', `/api/v1/repos/${ORG}/${R}/labels`, B);
  const labels = payload(r) || [];
  const bugId = labels.find((l) => l.name === 'bug')?.id;
  if (bugId) {
    r = await api('POST', `/api/v1/repos/${ORG}/${R}/issues/${issueNo}/labels`, { ...B, body: { labels: [bugId] } });
    check('15. issue 打上 bug 标签', [200, 201].includes(r.status), r.status);
  }
  r = await api('POST', `/api/v1/repos/${ORG}/${R}/issues/${issueNo}/comments`, { ...A, body: { body: '收到，我在 feature/user-api 分支补上 toggle，随 PR 一起合。' } });
  check('16. dev-alice 在 issue 下回复', [200, 201].includes(r.status), r.text.slice(0, 150));

  // ================================================ 阶段四 评审与合并（PR）
  section('阶段四 · PR 评审与合并');
  writeFileSync(`${work}/src.js`, `const todos = [];\nfunction add(text) { todos.push({ text, done: false }); }\nfunction toggle(index) { todos[index] && (todos[index].done = !todos[index].done); }\nfunction list() { return todos.filter(t => !t.done); }\nmodule.exports = { add, toggle, list, todos };\n`);
  await git(['add', '.'], { cwd: work });
  await git(['commit', '-m', `feat: toggle 完成状态 (fix #${issueNo})`], { cwd: work, env: gitEnv() });
  r = await git(['push', 'origin', 'feature/user-api'], { cwd: work, env: gitEnv() });
  check('17. 修复提交推送', r.ok, r.stderr);

  const alice = await newSession(ALICE, PASS);
  const prPage = await alice.get(`/${ORG}/${R}/compare/master...feature/user-api`);
  check('18. compare 对比页可发起 PR', prPage.status === 200 && /创建合并请求|Create Pull Request/i.test(prPage.text), prPage.status);
  r = await alice.post(`/${ORG}/${R}/compare/master...feature/user-api`, { title: 'feat: 待办添加/列表/toggle 接口', content: `实现了 add/list/toggle。\nfix #${issueNo}` });
  const prLoc = r.location || '';
  const prNo = Number((prLoc.match(/pulls\/(\d+)$/) || [])[1]);
  check('19. 创建 PR（跳转到 /pulls/N）', [302, 303].includes(r.status) && !!prNo, r.status + ' ' + prLoc);

  r = await api('POST', `/api/v1/repos/${ORG}/${R}/issues/${prNo}/comments`, { ...B, body: { body: 'LGTM，代码简洁，测试也补了 👍' } });
  check('20. dev-bob 在 PR 下评论 LGTM', [200, 201].includes(r.status), r.text.slice(0, 120));
  r = await alice.post(`/${ORG}/${R}/pulls/${prNo}/merge?merge_style=create_merge_commit`);
  check('21. 合并 PR', [200, 302, 303].includes(r.status), r.status);
  r = await api('GET', `/api/v1/repos/${ORG}/${R}/raw/master/src.js`, A);
  check('22. master 上出现合并后的代码（含 toggle）', r.status === 200 && r.text.includes('function toggle'), r.status);
  r = await alice.post(`/${ORG}/${R}/branches/delete/feature/user-api`);
  check('23. 合并后删除功能分支', [302, 303].includes(r.status), r.status);
  r = await git(['ls-remote', cloneURL], { env: gitEnv() });
  check('24. 功能分支 refs 已消失', !r.stdout.includes('feature/user-api'), r.stdout);

  // ================================================ 阶段五 发版
  section('阶段五 · 发版');
  await git(['checkout', 'master'], { cwd: work });
  await git(['pull', 'origin', 'master'], { cwd: work, env: gitEnv() });
  r = await git(['tag', '-a', 'v0.1.0', '-m', 'v0.1.0 首个可用版本'], { cwd: work, env: gitEnv() });
  r = await git(['push', 'origin', 'v0.1.0'], { cwd: work, env: gitEnv() });
  check('25. 打 tag v0.1.0 并推送', r.ok, r.stderr);
  r = await alice.get(`/${ORG}/${R}/releases/new`);
  check('26. Release 创建页可访问', r.status === 200, r.status);
  r = await alice.post(`/${ORG}/${R}/releases/new`, { tag_name: 'v0.1.0', tag_target: 'master', target_commitish: 'master', title: 'v0.1.0 首个可用版本', content: '待办 API 首版：add / list / toggle' });
  check('27. 网页创建 Release', [302, 303, 200].includes(r.status), r.status);
  r = await api('GET', `/api/v1/repos/${ORG}/${R}/releases`, A);
  check('28. API 可见 Release v0.1.0', r.status === 200 && r.text.includes('v0.1.0'), r.text.slice(0, 150));
  const zip = await fetch(BASE + `/${ORG}/${R}/archive/v0.1.0.zip`);
  check('29. 下载源码归档 zip', zip.status === 200 && /zip|octet-stream/.test(zip.headers.get('content-type') || ''), zip.status + ' ' + zip.headers.get('content-type'));
  const tgz = await fetch(BASE + `/${ORG}/${R}/archive/v0.1.0.tar.gz`);
  check('30. 下载源码归档 tar.gz', tgz.status === 200, tgz.status);
  const relPage = await alice.get(`/${ORG}/${R}/releases`);
  check('31. releases 页展示发版说明', /v0\.1\.0 首个可用版本/.test(relPage.text), relPage.status);

  // ================================================ 阶段六 日常与社区
  section('阶段六 · 日常操作');
  r = await api('PUT', `/api/v1/user/following/${ALICE}`, B).catch(() => ({ status: 0 }));
  r = await bobStarWatch();
  async function bobStarWatch() {
    const s = await newSession(BOB, PASS);
    await s.post(`/${ORG}/${R}/action/star`);
    const home = await s.get(`/${ORG}/${R}`);
    return /Unstar|取消点赞/i.test(home.text);
  }
  check('32. dev-bob star 仓库（点赞生效）', r === true);

  const explore = await (await fetch(BASE + `/explore/repos?q=todo-api`)).text();
  check('33. explore 搜索能发现仓库', /todo-api/.test(explore));
  const blame = await alice.get(`/${ORG}/${R}/blame/master/src.js`);
  check('34. blame 页查看行级历史', blame.status === 200, blame.status);
  const commitsPage = await alice.get(`/${ORG}/${R}/commits/master`);
  check('35. commits 历史页', commitsPage.status === 200 && /feat:/.test(commitsPage.text), commitsPage.status);
  // fix #N 合并到默认分支后上游会自动关闭引用的 issue —— 双端行为一致
  const closedPage = await alice.get(`/${ORG}/${R}/issues?state=closed`);
  check('36. issue 列表（含 bug 单）', closedPage.status === 200 && closedPage.text.includes('缺少 done 状态切换'), closedPage.status);
  // 关闭 issue（PR 合并说明里 fix #N —— 验证手动关闭兜底）
  r = await api('PATCH', `/api/v1/repos/${ORG}/${R}/issues/${issueNo}`, { ...B, body: { state: 'closed' } });
  check('37. 关闭 issue', [200, 201].includes(r.status), r.status);
  r = await api('GET', `/api/v1/repos/${ORG}/${R}/issues/${issueNo}`, B);
  check('38. issue 已关闭', /"state":"closed"/.test(r.text), r.text.slice(0, 120));

  // SSH 通道
  section('阶段七 · SSH 远程（authorized_keys 模式）');
  const keyPath = `/tmp/drill-key-${Date.now()}`;
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-q']);
  r = await api('POST', '/api/v1/user/keys', { ...A, body: { title: 'drill-key', key: readFileSync(keyPath + '.pub', 'utf8').trim() } });
  check('39. dev-alice 添加 SSH 公钥', [200, 201].includes(r.status), r.text.slice(0, 150));
  const serverUser = execFileSync('bash', ['-c', 'whoami']).toString().trim();
  await new Promise((res) => setTimeout(res, 1500));
  const sshGit = (args, cwd) => git(args, { cwd, env: { ...gitEnv(), GIT_SSH_COMMAND: `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` } });
  r = await sshGit(['clone', `ssh://${serverUser}@127.0.0.1:22/${ORG}/${R}.git`, `${dir}/todo-api-ssh`]);
  check('40. SSH clone 组织仓库', r.ok, r.stderr.slice(0, 250));
  if (existsSyncWorks(`${dir}/todo-api-ssh`)) {
    writeFileSync(`${dir}/todo-api-ssh/CHANGELOG.md`, '# Changelog\n\n## v0.1.0\n- 首版\n');
    await git(['add', '.'], { cwd: `${dir}/todo-api-ssh` });
    await git(['commit', '-m', 'docs: changelog'], { cwd: `${dir}/todo-api-ssh`, env: gitEnv() });
    r = await sshGit(['push', 'origin', 'master'], `${dir}/todo-api-ssh`);
    check('41. SSH push', r.ok, r.stderr.slice(0, 250));
    r = await api('GET', `/api/v1/repos/${ORG}/${R}/raw/master/CHANGELOG.md`, A);
    check('42. SSH 推送内容可见', r.status === 200 && r.text.includes('Changelog'), r.status);
  }

  // webhook 汇总
  await new Promise((res) => setTimeout(res, 2000));
  // upstream delivers one event per push (ours additionally emits merge-push events)
  check('43. CI webhook 收到 push 投递（≥4 次）', hookHits.length >= 4, `got ${hookHits.length}`);
  const firstEvt = hookHits[0] ? JSON.parse(hookHits[0].body) : null;
  check('44. webhook push 事件结构完整（ref/commits/pusher）', !!firstEvt && !!firstEvt.ref && Array.isArray(firstEvt.commits) && !!firstEvt.pusher, JSON.stringify(firstEvt || {}).slice(0, 150));

  hookServer.close();

  function existsSyncWorks(p) { try { execFileSync('bash', ['-c', `test -d ${p}`]); return true; } catch { return false; } }
}

main()
  .catch((e) => { check('演练脚本崩溃', false, e.stack || e.message); })
  .finally(() => process.exit(summary('开发场景演练')));
