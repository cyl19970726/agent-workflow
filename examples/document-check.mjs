import assert from 'node:assert/strict';
import { MemoryRunStore, runWorkflow, workflow } from '@signal-room/workflow';

// A non-research consumer using only the public package; no Codex account needed.
const store = new MemoryRunStore();
let actions = 0;
const documentCheck = workflow('document.check', { revision: '1' }, async (ctx, input) => {
  return ctx.phase('inspect', { title: 'Inspect document', purpose: 'Measure words and title without a model' }, async (phase) => {
    return phase.parallel('checks', {
      words: () => phase.task('words', text => { actions++; return text.trim().split(/\s+/).length; }, input),
      title: () => phase.task('title', text => { actions++; return text.split('\n')[0]; }, input),
    }, { concurrency: 2 });
  });
});
const agentRunner = { run() { throw new Error('This workflow does not call a model'); } };
const first = await runWorkflow({ workflow: documentCheck, input: 'Shared workflow\nRuns in another project.', store, agentRunner });
const resumed = await runWorkflow({ workflow: documentCheck, input: 'Shared workflow\nRuns in another project.', store, agentRunner, resumeRunId: first.run.id });
assert.equal(first.run.state, 'succeeded');
assert.deepEqual(resumed.output, first.output);
assert.equal(actions, 2, 'Validated steps must be reused on resume');
console.log(JSON.stringify({ state: resumed.run.state, output: resumed.output, actions, replayed: true }, null, 2));
