import assert from 'node:assert/strict';
import { defineDecision, MemoryRunStore, runWorkflow, workflow } from '@signal-room/workflow';

// Local lifecycle demonstration only: no account, network, or real inference.
const definition = defineDecision({
  id: 'evidence.support', revision: '1', provider: 'example', model: 'simulated',
  timeoutMs: 1000, maxRetries: 0,
  questions: [{ name: 'support', type: 'choice', instructions: 'Does the evidence support the claim?',
    choices: [{ value: 'supported' }, { value: 'insufficient' }] }],
});
let calls = 0;
const decisionRunner = {
  provider: 'example', revision: '1',
  async run() {
    calls++;
    return { provider: 'example', model: 'simulated', answers: [{ name: 'support', type: 'choice',
      choice: 'insufficient', confidence: 0.8,
      probabilities: [{ value: 'supported', probability: 0.1 }, { value: 'insufficient', probability: 0.9 }] }] };
  },
};
const definitionWorkflow = workflow('evidence.shadow', { revision: '1' }, async (ctx, input) => {
  const judgment = await ctx.decision('support', definition, input);
  const disposition = ctx.decide('disposition', { route: 'review', basis: 'shadow-only' });
  return { judgment, disposition };
});
const agentRunner = { run() { throw new Error('This example does not run an agent'); } };
const store = new MemoryRunStore();
const options = { workflow: definitionWorkflow, input: { text: 'Claim: the object is blue. Evidence: no image was provided.' },
  store, agentRunner, decisionRunner };
const first = await runWorkflow(options);
const resumed = await runWorkflow({ ...options, resumeRunId: first.run.id });
assert.deepEqual(resumed.output, first.output);
assert.equal(calls, 1);
const events = await store.listEvents(first.run.id);
assert.ok(events.some(event => event.type.startsWith('decision.inference.')));
assert.ok(events.some(event => event.type === 'decision.recorded'));
console.log(JSON.stringify({ mode: 'simulated', state: resumed.run.state, calls, replayed: true,
  disposition: resumed.output.disposition }, null, 2));
