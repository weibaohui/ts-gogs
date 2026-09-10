// ts-gogs entry point.
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import { conf } from './conf.js';
import { startServer } from './server.js';
import { db } from './db/db.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // work directory = repo root (contains templates/, public/, vendored-conf/)
  const workDir = path.resolve(__dirname, '..');
  const customDir = process.env.GOGS_CUSTOM ?? path.join(workDir, 'custom');
  fs.mkdirSync(customDir, { recursive: true });

  // --config=<path> (gogs CLI convention, used by authorized_keys serv entries)
  const configFlag = argv.find((a) => a.startsWith('--config='));
  const confOverride = configFlag ? configFlag.slice('--config='.length).replace(/^'|'$/g, '') : process.env.GOGS_CUSTOM_CONF;
  conf.load(workDir, customDir, confOverride);

  // asset cache-busting version: real commit when serving from a git checkout
  try {
    conf.buildCommit = execSync('git rev-parse --short HEAD', { cwd: workDir }).toString().trim();
  } catch {}

  // git delegate hook / ssh serv entrypoints (config must be loaded before dispatch)
  if (argv[0] === 'hook') {
    const { runHook } = await import('./hook.js');
    await runHook(argv[1] ?? '');
    return;
  }
  if (argv[0] === 'serv') {
    const { runServ } = await import('./serv.js');
    await runServ(argv[1] ?? '');
    return;
  }
  console.log(`${conf.brandName} ${conf.version} (ts-gogs)`);
  console.log(`Work directory: ${workDir}`);
  console.log(`Custom path:    ${customDir}`);

  // git version check (gogs requires >= 1.8.3)
  const { gitVersion } = await import('./gitx/git.js');
  try {
    const v = await gitVersion();
    console.log(`Git version:    ${v}`);
  } catch (e) {
    console.error('FATAL: git binary not found');
    process.exit(1);
  }
  // gogs NewRepoContext: ensure a global git identity exists
  const { gitOK } = await import('./gitx/git.js');
  if (!(await gitOK(process.cwd(), 'config', '--global', 'user.email'))) {
    await gitOK(process.cwd(), 'config', '--global', 'user.email', 'gogs@fake.local');
    await gitOK(process.cwd(), 'config', '--global', 'user.name', 'Gogs');
  }

  db();
  console.log(`Database:       ${conf.dbPath}`);

  // dsh-git-server 插件模式：DSH_BOOTSTRAP_ADMIN=user:pass 且用户库为空 → 播种管理员
  const bootstrap = process.env.DSH_BOOTSTRAP_ADMIN || '';
  if (bootstrap.includes(':')) {
    const count = (db().prepare('SELECT COUNT(*) AS c FROM user WHERE type = 0').get() as any).c;
    if (count === 0) {
      const idx = bootstrap.indexOf(':');
      const name = bootstrap.slice(0, idx) || 'root';
      const pass = bootstrap.slice(idx + 1);
      const { randomSalt, encodePassword } = await import('./authx/password.js');
      const salt = randomSalt();
      db().prepare('INSERT INTO user (name, lower_name, email, passwd, salt, type, is_admin, created_unix, updated_unix) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)')
        .run(name, name.toLowerCase(), `${name}@dsh.local`, encodePassword(pass, salt), salt, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
      console.log(`Bootstrap admin created: ${name}`);
    }
  }

  const server = await startServer();

  // periodic mirror synchronization (gogs InitSyncMirrors)
  const { startMirrorLoop } = await import('./mirror.js');
  startMirrorLoop();

  // builtin SSH server (gogs START_SSH_SERVER)
  if (conf.startSSHServer) {
    const { startSSHServer } = await import('./sshx/server.js');
    startSSHServer();
  } else if (!conf.disableSSH) {
    // authorized_keys mode: system sshd handles connections via `serv key-<id>`
    const { writeAuthorizedKeys } = await import('./routes/sshkey.js');
    writeAuthorizedKeys();
  }

  console.log(`Available on    ${conf.externalURL}`);
  console.log(`Listening       ${conf.httpAddr}:${conf.httpPort}`);

  const shutdown = () => {
    console.log('\nShutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
