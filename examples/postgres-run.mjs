import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runWorkflow, workflow } from '@signal-room/workflow';
import { migratePostgresWorkflowStore, PostgresWorkflowRunStore } from '@signal-room/workflow-postgres';

const connectionString = process.env.WORKFLOW_DATABASE_URL;
if (!connectionString) {
  console.error('Set WORKFLOW_DATABASE_URL to a development PostgreSQL database. This example does not call a model.');
  process.exitCode = 1;
} else {
  // Unique scope preserves existing data, including earlier examples.
  const workspaceId = `postgres-example-${randomUUID()}`;
  let pool = new Pool({ connectionString, max: 4 });
  const agentRunner = { run() { throw new Error('This storage example must never call a model'); } };
  let actions = 0;
  const definition = workflow('storage.document', { revision: '1' }, async (ctx, input) => {
    const measured = await ctx.task('measure', text => {
      actions++;
      return { text, characters: [...text].length, source: 'deterministic-program' };
    }, input);
    return ctx.publish('document', 'document.measurement', measured, {
      revision: '1', validation: 'valid', review: 'not_applicable',
    });
  });
  try {
    await migratePostgresWorkflowStore(pool);
    let store = new PostgresWorkflowRunStore(pool, { workspaceId });
    const input = '材料、正文与过程进入 PostgreSQL。';
    const first = await runWorkflow({ workflow: definition, input, store, agentRunner });
    assert.equal(first.run.state, 'succeeded');
    assert.ok(first.output);
    const artifactId = first.output.id;
    await pool.end();

    // A new connection and adapter have no in-memory state from the first run.
    pool = new Pool({ connectionString, max: 4 });
    store = new PostgresWorkflowRunStore(pool, { workspaceId });
    const payload = await store.getArtifactPayload(artifactId);
    assert.deepEqual(payload, { text: input, characters: [...input].length, source: 'deterministic-program' });
    const resumed = await runWorkflow({ workflow: definition, input, store, agentRunner, resumeRunId: first.run.id });
    assert.deepEqual(resumed.output, first.output);
    assert.equal(actions, 1, 'Completed valid steps must replay without executing again');
    assert.equal((await store.listArtifacts(first.run.id)).length, 1);
    const events = await store.listEvents(first.run.id);
    assert.ok(events.some(event => event.type === 'artifact.published'));
    assert.ok(events.some(event => event.type === 'step.reused'));
    console.log(JSON.stringify({
      workspaceId, runId: first.run.id, artifactId, state: resumed.run.state,
      payloadReadAfterReconnect: true, replayedWithoutExecution: true,
      eventCount: events.length, modelCalls: 0,
    }, null, 2));
  } finally {
    await pool.end();
  }
}
