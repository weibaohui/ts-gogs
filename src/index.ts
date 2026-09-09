// ts-gogs entry point.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { conf } from './conf.js';
import { startServer } from './server.js';
import { db } from './db/db.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // work directory = repo root (contains templates/, public/, vendored-conf/)
  const workDir = path.resolve(__dirname, '..');
  const customDir = process.env.GOGS_CUSTOM ?? path.join(workDir, 'custom');
  fs.mkdirSync(customDir, { recursive: true });

  conf.load(workDir, customDir, process.env.GOGS_CUSTOM_CONF);

  // git delegate hook entrypoint (config must be loaded before dispatch)
  const argv = process.argv.slice(2);
  if (argv[0] === 'hook') {
    const { runHook } = await import('./hook.js');
    await runHook(argv[1] ?? '');
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

  const server = await startServer();
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
