// Opt-in PostgreSQL + official Agents SDK smoke: WORKFLOW_DATABASE_URL and
// WORKFLOW_SIWC_MODEL must be selected explicitly; sign in with workflow-siwc first.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { defineAgent, runWorkflow, workflow } from '@signal-room/workflow';
import { OpenAIAgentsSdkRunner, SiwcAuth } from '@signal-room/workflow-agent-sdk';
import { migratePostgresWorkflowStore, PostgresWorkflowRunStore } from '@signal-room/workflow-postgres';
import { snapshotSkill, stageSkill } from '@signal-room/workflow-skill-snapshot';

const connectionString = process.env.WORKFLOW_DATABASE_URL;
const model = process.env.WORKFLOW_SIWC_MODEL;
if (!connectionString || !model) throw new Error('Set WORKFLOW_DATABASE_URL and an explicitly selected WORKFLOW_SIWC_MODEL. Sign in with workflow-siwc login first.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-skill-smoke-'));
const source = path.join(root, 'source', 'package-probe');
fs.mkdirSync(path.join(source, 'references'), { recursive: true });
fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
const token = crypto.randomBytes(12).toString('hex');
fs.writeFileSync(path.join(source, 'references/rule.json'), JSON.stringify({ token, factor: 6 }));
fs.writeFileSync(path.join(source, 'assets/value.bin'), Buffer.from([7, 0, 255]));
fs.writeFileSync(path.join(source, 'scripts/compute.mjs'), `import fs from 'node:fs';
const rule = JSON.parse(fs.readFileSync(new URL('../references/rule.json', import.meta.url)));
const bytes = fs.readFileSync(new URL('../assets/value.bin', import.meta.url));
console.log(JSON.stringify({ token: rule.token, result: bytes[0] * rule.factor, assetHex: bytes.toString('hex') }));\n`, { mode: 0o700 });
fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: package-probe\ndescription: Read a rule and compute a result from a binary asset.\n---\nRead references/rule.json and assets/value.bin, then return their exact token, the first byte times factor, and the asset hex.\n`);
const bundle = snapshotSkill(source);
const staged = stageSkill(bundle, root);
fs.rmSync(path.join(root, 'source'), { recursive: true });
const expected = { token, result: 42, assetHex: '0700ff' };
const agent = defineAgent({
  id: 'package-probe', revision: '1', model, reasoningEffort: 'medium',
  promptRevision: '1', skillsRevision: bundle.sha256, permissionsRevision: 'readonly-v1',
  config: {
    instructions: `${bundle.content}\nCall run_packaged_helper exactly once and return its exact JSON.`,
    outputFormat: 'json',
  },
});
const definition = workflow('skill-package-smoke', { revision: `1-${bundle.sha256}` }, async (ctx, input) => {
  const output = await ctx.agent('probe', agent, input);
  const checked = await ctx.validate('package-contract', output, value => ({ valid: value.token === token && value.result === 42 && value.assetHex === '0700ff' }));
  assert.equal(checked.valid, true, 'The SDK agent must return values from the frozen package');
  return output;
});
const pool = new Pool({ connectionString, max: 4 });
try {
  await migratePostgresWorkflowStore(pool);
  const store = new PostgresWorkflowRunStore(pool, { workspaceId: `skill-smoke-${crypto.randomUUID()}` });
  const agentRunner = new OpenAIAgentsSdkRunner({
    auth: new SiwcAuth(), enforceJsonObject: true,
    tools: () => [{ name: 'run_packaged_helper', description: 'Run the packaged helper and return its JSON output.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      execute: async () => {
        const { execFileSync } = await import('node:child_process');
        const output = execFileSync(process.execPath, [path.join(staged.root, 'scripts/compute.mjs')], { cwd: staged.root, encoding: 'utf8' });
        return JSON.parse(output);
      } }],
  });
  const result = await runWorkflow({ workflow: definition, input: { task: 'Exercise the complete packaged helper' }, store, agentRunner });
  assert.deepEqual(result.output, expected);
  const artifact = (await store.listArtifacts(result.run.id))[0];
  assert.ok(artifact, 'The verified model result must persist through the PostgreSQL workflow store');
  console.log(JSON.stringify({ model, runId: result.run.id, state: result.run.state, skillDigest: bundle.sha256,
    files: bundle.files.map(({ path: filePath, sha256, bytes, mode }) => ({ path: filePath, sha256, bytes, mode })),
    output: result.output, persistedToPostgres: true, sourceRemoved: !fs.existsSync(path.join(root, 'source')) }, null, 2));
} finally {
  await pool.end();
  fs.rmSync(root, { recursive: true, force: true });
}
