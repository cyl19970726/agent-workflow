import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// An explicit database check must never turn green by silently skipping every test.
if (!process.env.WORKFLOW_TEST_DATABASE_URL) {
  console.error('Set WORKFLOW_TEST_DATABASE_URL to a dedicated test PostgreSQL database. No tests ran.');
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync('vitest', ['run', 'packages/postgres'], {
    cwd: root, env: process.env, stdio: 'inherit', shell: false,
  });
  if (result.error) console.error('Unable to start PostgreSQL tests:', result.error.message);
  process.exitCode = result.status ?? 1;
}
