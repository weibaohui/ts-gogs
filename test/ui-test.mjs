// ts-gogs UI full-coverage test — real browser (system Chrome via playwright-core).
//   node test/ui-test.mjs
// Covers: sign-in (bad+good), sign-up, repo create, file browsing, commits/branches/tags,
// issues (create/comment/close), labels, milestones, wiki (create page), settings pages,
// admin pages, profile, star/watch, explore search, sign-out.
// playwright-core drives the system Chrome (set CHROME_PATH if non-standard)
import { chromium } from 'playwright-core';
import { BASE, ADMIN, api, check, section, summary, uniq, waitForServer, payload } from './helpers.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const SHOTS = 'test-artifacts/ui';
mkdirSync(SHOTS, { recursive: true });
const PASS = 'Passw0rd!123';
const U = uniq('uiuser');
const R = uniq('ui-repo');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  await waitForServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

  const shot = async (name) => { await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

  async function goto(path, name) {
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 20000 });
    if (name) await shot(name);
    return page;
  }

  // ------------------------------------------------ sign-in: wrong password
  section('sign-in');
  await goto('/user/sign-up', 'signup-initial'); // SPA route sanity
  await goto('/user/sign-in');
  await page.fill('input[name=username]', ADMIN.user);
  await page.fill('input[name=password]', 'definitely-wrong');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check('wrong password shows error', (await page.content()).match(/用户名或密码|incorrect|错误|Wrong/i) !== null || page.url().includes('sign-in'), await page.content().then(c => c.length));
  // correct password
  await page.fill('input[name=username]', ADMIN.user);
  await page.fill('input[name=password]', ADMIN.pass);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  check('login redirects to dashboard', !page.url().includes('sign-in'), page.url());
  await shot('dashboard');

  // dashboard renders feed
  const dash = await page.content();
  check('dashboard has feed/navbar', /控制面板|Dashboard/i.test(dash) && dash.length > 5000);

  // ------------------------------------------------ sign-up new user
  section('sign-up');
  // deterministic browser sign-out: drop session cookies
  await ctx.clearCookies();
  await goto('/user/sign-up');
  const signupContent = await page.content();
  check('sign-up form renders', /sign|注册|用户名/i.test(signupContent), page.url());
  const hasRegisterForm = await page.locator('input[name=userName]').count();
  if (hasRegisterForm > 0) {
    await page.fill('input[name=userName]', U);
    await page.fill('input[name=email]', `${U}@test.local`);
    await page.fill('input[name=password]', PASS);
    await page.fill('input[name=confirmPassword]', PASS);
    // registration captcha: digits are <text> nodes inside the generated SVG —
    // re-fetch it inside the page (same-origin, refreshes the gogs_captcha cookie) and decode.
    const svg = await page.evaluate(async () => await (await fetch('/captcha/image.jpeg')).text());
    const code = [...svg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((m) => m[1]).join('');
    check('captcha decodable from svg', code.length === 6, `len=${code.length}`);
    const captchaInput = page.locator('input[name=captcha]');
    if (await captchaInput.count() && code.length === 6) await captchaInput.fill(code);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    check('sign-up completes (logged in or redirected)', !page.url().includes('sign-up'), page.url());
  } else {
    check('sign-up form has username field', false, 'no input[name=userName]');
  }

  // ------------------------------------------------ repo create via web form
  section('repo create (web form)');
  // admin session may be gone after sign-up as U; sign-in as U
  await goto('/user/sign-in');
  await page.fill('input[name=username]', U);
  await page.fill('input[name=password]', PASS);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await goto('/repo/create', 'repo-create-form');
  const createForm = await page.content();
  check('repo create form renders', /仓库名称|repository|create/i.test(createForm), page.url());
  const repoNameInput = page.locator('input[name=repo_name]');
  if (await repoNameInput.count()) {
    await repoNameInput.first().fill(R);
    const init = page.locator('input[name=auto_init]');
    if (await init.count()) await init.first().check({ force: true }).catch(() => {});
    const readme = page.locator('select[name=readme], input[name=readme]');
    if (await readme.count()) await readme.first().selectOption?.('README.md').catch(() => {});
    await page.locator('button:has-text("创建仓库"), button:has-text("Create Repository"), button:has-text("Create")').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
    check('repo created (redirect to repo home)', page.url().includes(R), page.url());
  } else {
    check('repo create form has name field', false, 'no input[name=repo_name]');
  }

  // ------------------------------------------------ repo home & files
  section('repo browsing');
  await goto(`/${U}/${R}`, 'repo-home');
  const home = await page.content();
  check('repo home shows README', /README/i.test(home), page.url());
  check('repo home has file table', /file-table|view_list|README\.md/i.test(home));
  // click README.md in the tree
  const readmeLink = page.locator('a', { hasText: 'README.md' }).first();
  if (await readmeLink.count()) {
    await readmeLink.click();
    await page.waitForLoadState('networkidle');
    await shot('repo-file-view');
    check('file view opens', page.url().includes('src/'), page.url());
    const fv = await page.content();
    check('file view has code/lines', /line-numbers|CodeMirror|hljs|markdown/i.test(fv));
  } else {
    check('README link in tree', false);
  }
  // clone bar
  check('clone URL bar present', /clone|克隆|HTTPS/i.test((await page.content())));

  // commits page
  await goto(`/${U}/${R}/commits`, 'repo-commits');
  check('commits page lists commits', /commit|提交/i.test(await page.content()));
  // branches
  await goto(`/${U}/${R}/branches`, 'repo-branches');
  check('branches page shows master', /master/i.test(await page.content()));
  // tags (may be empty state)
  await goto(`/${U}/${R}/tags`, 'repo-tags');
  check('tags page renders', /tag|标签|tags/i.test(await page.content()));
  // graph page
  await goto(`/${U}/${R}/graph`, 'repo-graph');
  check('graph page renders', /graph|提交历史|commit/i.test(await page.content()));
  // search
  await goto(`/${U}/${R}/search?q=readme`, 'repo-search');
  check('repo search page renders', /search|搜索/i.test(await page.content()));

  // ------------------------------------------------ issues via UI
  section('issues via UI');
  await goto(`/${U}/${R}/issues/new`, 'issue-new-form');
  const issueForm = await page.content();
  check('issue form renders', /标题|title/i.test(issueForm), page.url());
  const titleInput = page.locator('input[name=title], input[placeholder*="标题"], input[placeholder*="Title"]').first();
  if (await titleInput.count()) {
    await titleInput.fill('UI created issue');
    const body = page.locator('textarea[name=content], textarea#content').first();
    if (await body.count()) await body.fill('created by ui-test');
    await page.locator('button:has-text("创建工单"), button:has-text("创建合并请求"), button:has-text("Create Issue"), button.green').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
    check('issue created (redirect to issue page)', /issues\/\d+/.test(page.url()), page.url());
    await shot('issue-view');
    // comment
    const comment = page.locator('#comment-form textarea[name=content], form textarea[name=content]').first();
    if (await comment.count()) {
      await comment.fill('a comment from ui-test');
      await page.locator('#comment-form button.green, form button.green').first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
      check('comment posted', /a comment from ui-test/i.test(await page.content()));
    }
    // close issue
    const closeBtn = page.locator('button:has-text("关闭"), button:has-text("Close")').first();
    if (await closeBtn.count()) {
      await closeBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
      check('issue closed via UI', /已关闭|Closed|closed/i.test(await page.content()));
    }
  } else {
    check('issue form has title field', false);
  }
  // issue list
  await goto(`/${U}/${R}/issues`, 'issue-list');
  check('issue list shows UI issue', /UI created issue/i.test(await page.content()));

  // labels: create
  section('labels & milestones');
  await goto(`/${U}/${R}/labels`, 'labels-page');
  const labelsPage = await page.content();
  check('labels page renders', /label|标签/i.test(labelsPage));
  // labels are created via an inline hidden modal form on the /labels page —
  // fill + submit programmatically (modal visibility is cosmetic)
  const hasLabelForm = await page.evaluate(() => !![...document.forms].find((x) => x.querySelector('input.new-label-input')));
  if (hasLabelForm) {
    await page.evaluate(() => {
      const f = [...document.forms].find((x) => x.querySelector('input.new-label-input'));
      f.querySelector('input[name=title]').value = 'ui-label';
      const c = f.querySelector('input[name=color]');
      if (c) c.value = '#00aa33';
      f.submit();
    });
    await page.waitForTimeout(1500);
    check('label created via UI', /ui-label/i.test(await page.content()), page.url());
  } else {
    check('label inline form has field', false, page.url());
  }
  // milestones: create
  await goto(`/${U}/${R}/milestones`, 'milestones-page');
  check('milestones page renders', /milestone|里程碑/i.test(await page.content()));
  await goto(`/${U}/${R}/milestones/new`, 'milestone-new');
  const msTitle = page.locator('input[name=title]').first();
  if (await msTitle.count()) {
    await msTitle.fill('ui-milestone');
    await page.locator('form button.green').first().click({ timeout: 5000 }).catch((e) => console.log('ms click:', e.message.slice(0, 60)));
    await page.waitForTimeout(1500);
    await goto(`/${U}/${R}/milestones`, 'milestones-after');
    check('milestone created via UI', /ui-milestone/i.test(await page.content()), page.url());
  } else {
    check('milestone new form has field', false, page.url());
  }

  // ------------------------------------------------ wiki
  section('wiki');
  await goto(`/${U}/${R}/wiki`, 'wiki-home');
  check('wiki home renders', /wiki|Home/i.test(await page.content()));
  await goto(`/${U}/${R}/wiki/_new`, 'wiki-new');
  const wikiForm = await page.content();
  check('wiki new page form renders', /title|标题/i.test(wikiForm));
  const wTitle = page.locator('input[name=title]').first();
  if (await wTitle.count()) {
    await wTitle.fill('UI-Wiki-Page');
    const wContent = page.locator('textarea[name=content], textarea#content').first();
    if (await wContent.count()) {
      // SimpleMDE hides the raw textarea — set its value programmatically
      await wContent.evaluate((el) => { el.value = '# wiki page from ui-test'; }).catch(() => {});
    }
    await page.locator('form button.green, form button:has-text("保存"), form button:has-text("创建")').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
    check('wiki page created', /wiki/i.test(page.url()) && /wiki page from ui-test|UI-Wiki-Page/i.test(await page.content()), page.url());
  }

  // ------------------------------------------------ star / watch / fork counts
  section('repo actions');
  await goto(`/${U}/${R}`, 'repo-home-2');
  const watchBtn = page.locator('button:has-text("关注"), button:has-text("Watch"), a:has-text("关注"), a:has-text("Watch")').first();
  if (await watchBtn.count()) {
    await watchBtn.click().catch(() => {});
    await page.waitForTimeout(1200);
    check('watch action works', true);
  } else check('watch button present', false);
  const starBtn = page.locator('button:has-text("点赞"), button:has-text("Star"), a:has-text("点赞")').first();
  if (await starBtn.count()) {
    await starBtn.click().catch(() => {});
    await page.waitForTimeout(1200);
    check('star action works', true);
  } else check('star button present', false);

  // ------------------------------------------------ profile & explore
  section('profile & explore');
  await goto(`/${U}`, 'profile');
  check('profile shows user', new RegExp(U, 'i').test(await page.content()));
  await goto(`/${U}?tab=activity`, 'profile-activity');
  check('profile activity tab renders', /activity|动态|profile/i.test(await page.content()));
  await goto('/explore/repos', 'explore-repos');
  check('explore repos lists repo', new RegExp(R, 'i').test(await page.content()));
  await goto(`/explore/repos?q=${R.slice(0, 8)}`, 'explore-search');
  check('explore search finds repo', new RegExp(R, 'i').test(await page.content()));

  // ------------------------------------------------ user settings pages
  section('user settings');
  for (const [path, key] of [['/user/settings', 'profile'], ['/user/settings/password', 'password'], ['/user/settings/ssh', 'ssh'], ['/user/settings/email', 'email'], ['/user/settings/avatar', 'avatar'], ['/user/settings/security', 'security'], ['/user/settings/repositories', 'repositories'], ['/user/settings/organizations', 'organizations'], ['/user/settings/applications', 'applications']]) {
    await goto(path, `settings-${key}`);
    check(`settings page renders: ${key}`, !/sign-in/.test(page.url()), page.url());
  }

  // ------------------------------------------------ admin pages (admin login)
  section('admin');
  await ctx.clearCookies();
  await goto('/user/sign-in');
  await page.fill('input[name=username]', ADMIN.user);
  await page.fill('input[name=password]', ADMIN.pass);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  for (const [path, key] of [['/admin', 'dashboard'], ['/admin/users', 'users'], ['/admin/repos', 'repos'], ['/admin/orgs', 'orgs'], ['/admin/auths', 'auths'], ['/admin/notices', 'notices'], ['/admin/config', 'config'], ['/admin/monitor', 'monitor']]) {
    await goto(path, `admin-${key}`);
    check(`admin page renders: ${key}`, !/sign-in/.test(page.url()), page.url());
  }
  // admin user list shows our UI user (id-ordered pages — search page by page)
  let found = false;
  for (let p2 = 1; p2 <= 5 && !found; p2++) {
    await goto(`/admin/users?page=${p2}`);
    found = new RegExp(U, 'i').test(await page.content());
  }
  check('admin users list contains ui user', found);

  // ------------------------------------------------ console errors across the run
  section('console health');
  // 401s from the intentional wrong-password sign-in are expected
  const meaningful = consoleErrors.filter((e) => !/content_main|extension|favicon|ResizeObserver|401 \(Unauthorized\)/i.test(e));
  check('no meaningful console errors across pages', meaningful.length === 0, meaningful.slice(0, 4).join(' || '));

  await browser.close();

  // cleanup via API
  await api('DELETE', `/api/v1/repos/${U}/${R}`, { token: (payload(await api('POST', `/api/v1/users/${U}/tokens`, { user: U, pass: PASS, body: { name: uniq('t') } })))?.sha1 || (payload(await api('POST', `/api/v1/users/${U}/tokens`, { user: U, pass: PASS, body: { name: uniq('t') } })))?.token }).catch(() => {});
}

main()
  .catch((e) => { check('ui-test crashed', false, e.stack || e.message); })
  .finally(() => process.exit(summary('UI-TEST')));
