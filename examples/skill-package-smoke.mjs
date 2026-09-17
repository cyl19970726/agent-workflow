// Opt-in real Codex workflow: npm run build && WORKFLOW_SMOKE_MODEL=gpt-5.6-luna node examples/skill-package-smoke.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defineAgent, workflow, runWorkflow, MemoryRunStore } from '@signal-room/workflow';
import { CodexSdkRunner, snapshotSkill } from '@signal-room/workflow-codex';
const model = process.env.WORKFLOW_SMOKE_MODEL;
if (!model) throw new Error('Choose WORKFLOW_SMOKE_MODEL explicitly; this example calls a real model.');
const root = fs.mkdtempSync(path.resolve('.workflow-skill-smoke-'));
const source = path.join(root, 'source', 'package-probe');
for (const dir of ['references', 'scripts', 'assets']) fs.mkdirSync(path.join(source, dir), { recursive: true });
const token = crypto.randomBytes(12).toString('hex');
fs.writeFileSync(path.join(source, 'references/rule.json'), JSON.stringify({ token, factor: 6 }));
fs.writeFileSync(path.join(source, 'assets/value.bin'), Buffer.from([7, 0, 255]));
fs.writeFileSync(path.join(source, 'scripts/compute.mjs'), `import fs from 'node:fs';
const rule = JSON.parse(fs.readFileSync(new URL('../references/rule.json', import.meta.url)));
const bytes = fs.readFileSync(new URL('../assets/value.bin', import.meta.url));
console.log(JSON.stringify({ token: rule.token, result: bytes[0] * rule.factor, assetHex: bytes.toString('hex') }));\n`, { mode: 0o700 });
fs.writeFileSync(path.join(source, 'SKILL.md'), `---
name: package-probe
description: Read a rule and run a packaged helper against a binary asset.
---
Read references/rule.json, then run node scripts/compute.mjs from this skill directory.
Return the helper's exact JSON with token, result and assetHex. Do not invent missing values.
`);
const skill = snapshotSkill(source);
fs.rmSync(path.join(root, 'source'), { recursive: true });
const definition = defineAgent({
  id: 'package-probe', revision: '2', model, reasoningEffort: 'medium',
  promptRevision: '2', skillsRevision: skill.sha256, permissionsRevision: 'readonly-v1',
  config: {
    prompt: 'Use the required package-probe skill, read its rule and execute its helper. Do not search outside the provided skill directory for resources. Return the requested JSON.',
    skills: [skill], threadOptions: { sandboxMode: 'read-only', approvalPolicy: 'never' }, timeoutMs: 180000,
    outputSchema: { type: 'object', properties: { token: { type: 'string' }, result: { type: 'number' }, assetHex: { type: 'string' } }, required: ['token', 'result', 'assetHex'], additionalProperties: false },
  },
});
const events = [];
class ObservedRunner extends CodexSdkRunner {
  async run(request) {
    return super.run({ ...request, emit: async (type, payload) => { events.push({ type, payload }); await request.emit(type, payload); } });
  }
}
const expected = { token, result: 42, assetHex: '0700ff' };
const flow = workflow('skill-package-smoke', { revision: `2-${skill.sha256}` }, async (ctx, input) => {
  const output = await ctx.agent('probe', definition, input);
  const checked = await ctx.validate('package-contract', output, value => ({ valid: value.token === token && value.result === 42 && value.assetHex === '0700ff' }));
  assert.equal(checked.valid, true, 'Real model must return values from the frozen reference and binary asset');
  return output;
});
const result = await runWorkflow({ workflow: flow, input: { task: 'exercise full package' }, store: new MemoryRunStore(), agentRunner: new ObservedRunner(undefined, path.join(root, 'traces')) });
assert.deepEqual(result.output, expected);
// Inspect raw SDK command receipts, not a model claim that it executed the script.
const traceFiles = fs.readdirSync(path.join(root, 'traces'), { recursive: true }).filter(file => String(file).endsWith('events.jsonl'));
const rawEvents = traceFiles.flatMap(file => fs.readFileSync(path.join(root, 'traces', file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
const helperCommands = rawEvents.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution' && event.item.command.includes('compute.mjs') && event.item.exit_code === 0);
assert.ok(helperCommands.some(event => event.item.aggregated_output.includes(token) && event.item.aggregated_output.includes('0700ff')), 'Need successful helper tool execution with exact output');
const report = { model, skillDigest: skill.sha256, files: skill.files.map(({ path, sha256, bytes, mode }) => ({ path, sha256, bytes, mode })), output: result.output, helperExecuted: true, sourceRemoved: !fs.existsSync(source), traceDirectory: root };
fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
