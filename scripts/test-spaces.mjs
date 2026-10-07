import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.env.WORKFLOW_TEST_DATABASE_URL) {
  console.error('Set WORKFLOW_TEST_DATABASE_URL to an isolated test PostgreSQL database. No tests ran.');
  process.exitCode = 1;
} else {
  const result = spawnSync('vitest', ['run', 'packages/spaces', 'packages/space-contracts', 'packages/postgres'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: process.env, stdio: 'inherit', shell: false,
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
