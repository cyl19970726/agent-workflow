import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSON_SCHEMA_DIALECT, type SchemaRef, type StorageContractDraft } from '@signal-room/workflow-space-contracts';
import { PostgresBlobStore } from './blob-store.js';
import { migrateWorkflowSpaces } from './migration.js';
import { RuntimeCommandAlreadyStartedError, WorkflowSpaceService } from './service.js';

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let pool: Pool;
const actor = { id: 'command-test-owner', kind: 'human' as const };

async function fixture() {
  const service = new WorkflowSpaceService(pool, new PostgresBlobStore(pool), actor);
  const space = await service.createSpace({ id: `command-test-${randomUUID()}`, purpose: 'Command claim regression' });
  const [schema] = await service.registerSchemas(space.id, [{ namespace: 'test/command-report', revision: '1', dialect: JSON_SCHEMA_DIALECT,
    schema: { $schema: JSON_SCHEMA_DIALECT, type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }]);
  const ref: SchemaRef = { namespace: schema!.namespace, revision: schema!.revision, hash: schema!.hash };
  const contract: StorageContractDraft = { workflowVersion: 'v1', nodes: {
    writer: { actorKinds: ['agent'], inputs: { source: { schema: ref, states: ['imported'] } },
      outputs: { report: { schema: ref, requiredInputs: ['source'], appendVersions: true, initialState: 'candidate' } },
      actions: ['readBoundInput', 'appendOutputVersion'] },
  }, stateRules: [] };
  await service.publishWorkflow(space.id, { id: 'v1', revision: '1', changeReason: 'Test', config: {},
    entrypoints: { content: { workflowId: 'command-workflow', codeRevision: '1', storageContract: contract } } });
  const source = await service.importAsset(space.id, { schema: ref, payload: { text: 'Source' }, description: 'Input', idempotencyKey: 'source' });
  const item = { id: 'case', title: 'Case', objective: 'Report', constraints: [] as string[] };
  await service.createCase(space.id, item);
  const manifest = await service.freezeInputs(space.id, item.id, { source: source.id });
  return { service, space, ref, source, item, manifest };
}

suite('Workflow Space command claims and write retries', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 12 });
    await migrateWorkflowSpaces(pool);
    await new PostgresBlobStore(pool).migrate();
  });
  afterAll(async () => { await pool?.end(); });

  it('claims one runtime command across concurrent hosts before any second model execution', async () => {
    const f = await fixture();
    const other = new WorkflowSpaceService(pool, new PostgresBlobStore(pool), actor);
    const config = { workflowVersionId: 'v1', entrypoint: 'content', inputManifestId: f.manifest.id };
    const draft = { workflowId: 'command-workflow', workflowRevision: '1', inputFingerprint: f.manifest.hash,
      state: 'running' as const, metadata: { commandKey: 'same-command', commandFingerprint: 'a'.repeat(64) } };
    const results = await Promise.allSettled([f.service.bindRuntimeRun(f.space.id, config, draft), other.bindRuntimeRun(f.space.id, config, draft)]);
    const winner = results.find(result => result.status === 'fulfilled');
    const duplicate = results.find(result => result.status === 'rejected');
    expect(winner?.status).toBe('fulfilled');
    expect(duplicate?.status).toBe('rejected');
    if (winner?.status !== 'fulfilled' || duplicate?.status !== 'rejected') throw new Error('Expected one winner and one duplicate');
    expect(duplicate.reason).toBeInstanceOf(RuntimeCommandAlreadyStartedError);
    expect((duplicate.reason as RuntimeCommandAlreadyStartedError).runId).toBe(winner.value.id);
    expect((await f.service.overview(f.space.id)).runs.map(run => run.runId)).toEqual([winner.value.id]);
    await expect(f.service.bindRuntimeRun(f.space.id, config, { ...draft, metadata: { ...draft.metadata, commandFingerprint: 'b'.repeat(64) } }))
      .rejects.toThrow('conflicts with a different request');
    const changedSource = await f.service.importAsset(f.space.id, { schema: f.ref, payload: { text: 'Changed input' }, description: 'Other input', idempotencyKey: 'changed-source' });
    const changedManifest = await f.service.freezeInputs(f.space.id, f.item.id, { source: changedSource.id });
    await expect(f.service.bindRuntimeRun(f.space.id, { ...config, inputManifestId: changedManifest.id }, draft))
      .rejects.toThrow('conflicts with a different binding');
    expect((await f.service.overview(f.space.id)).runs).toHaveLength(1);
    const rollbackDraft = { ...draft, metadata: { commandKey: 'rollback-key', commandFingerprint: 'c'.repeat(64) } };
    await expect(f.service.bindRuntimeRun(f.space.id, config, { ...rollbackDraft, parentRunId: 'missing-parent' })).rejects.toThrow();
    const afterRollback = await f.service.bindRuntimeRun(f.space.id, config, rollbackDraft);
    expect(afterRollback.id).toBeTruthy();
    expect((await f.service.overview(f.space.id)).runs).toHaveLength(2);
  });

  it('reads identical case, review and comparison receipts while rejecting changed retry bodies', async () => {
    const f = await fixture();
    expect(await f.service.createCase(f.space.id, f.item)).toMatchObject(f.item);
    await expect(f.service.createCase(f.space.id, { ...f.item, title: 'Changed' })).rejects.toThrow('conflicts');
    const first = await f.service.startRun(f.space.id, { workflowVersionId: 'v1', entrypoint: 'content', inputManifestId: f.manifest.id, idempotencyKey: 'first' });
    const firstNode = await f.service.startNode(f.space.id, { runId: first.runId, nodeId: 'writer', key: 'write', inputs: { source: f.source.id }, producer: 'agent', instructions: 'Write', effectiveConfig: {} });
    const firstAsset = (await (await f.service.nodeClient(f.space.id, firstNode.id)).submit({ idempotencyKey: 'output', outputs: [{ slot: 'report', payload: { text: 'First' }, dependencySlots: ['source'] }] })).versions[0]!;
    const second = await f.service.startRun(f.space.id, { workflowVersionId: 'v1', entrypoint: 'content', inputManifestId: f.manifest.id, idempotencyKey: 'second' });
    const secondNode = await f.service.startNode(f.space.id, { runId: second.runId, nodeId: 'writer', key: 'write', inputs: { source: f.source.id }, producer: 'agent', instructions: 'Write', effectiveConfig: {} });
    const secondAsset = (await (await f.service.nodeClient(f.space.id, secondNode.id)).submit({ idempotencyKey: 'output', outputs: [{ slot: 'report', payload: { text: 'Second' }, dependencySlots: ['source'] }] })).versions[0]!;
    const base = { id: 'review-1', runId: first.runId, assetVersionIds: [firstAsset.id], standard: { id: 'four', revision: '1', content: 'Four questions' },
      judge: { kind: 'human' as const, id: actor.id }, evidence: [firstAsset.id], answers: { good: 'Clear', bad: 'Slow', improvement: 'Baseline', unresolved: 'Ending' } };
    const baseline = await f.service.recordReview(f.space.id, base);
    expect(await f.service.recordReview(f.space.id, base)).toEqual(baseline);
    await expect(f.service.recordReview(f.space.id, { ...base, answers: { ...base.answers, bad: 'Different' } })).rejects.toThrow('conflicts');
    const candidateInput = { ...base, id: 'review-2', runId: second.runId, assetVersionIds: [secondAsset.id], evidence: [secondAsset.id], baselineReviewId: baseline.id };
    const candidate = await f.service.recordReview(f.space.id, candidateInput);
    const comparisonInput = { id: 'comparison-1', baselineReviewId: baseline.id, candidateReviewId: candidate.id, conclusion: 'Better' };
    const comparison = await f.service.compare(f.space.id, comparisonInput);
    expect(await f.service.compare(f.space.id, comparisonInput)).toEqual(comparison);
    await expect(f.service.compare(f.space.id, { ...comparisonInput, conclusion: 'Worse' })).rejects.toThrow('conflicts');
    const iterationInput = { id: 'iteration-1', reviewIds: [baseline.id], hypothesis: 'Improve ending',
      workflowVersionId: 'v1', caseIds: [f.item.id], runIds: [second.runId] };
    const otherHost = new WorkflowSpaceService(pool, new PostgresBlobStore(pool), actor);
    const iterations = await Promise.all([
      f.service.recordIteration(f.space.id, iterationInput),
      otherHost.recordIteration(f.space.id, iterationInput),
    ]);
    expect(iterations[0]).toEqual(iterations[1]);
    await expect(f.service.recordIteration(f.space.id, { ...iterationInput, hypothesis: 'Different' })).rejects.toThrow('conflicts');
    await expect(f.service.recordReview(f.space.id, { ...base, id: 'fake-agent', judge: { kind: 'agent', id: 'writer', sessionId: firstNode.sessionId } }))
      .rejects.toThrow();
    const outsider = new WorkflowSpaceService(pool, new PostgresBlobStore(pool), { id: 'outsider', kind: 'human' });
    await expect(outsider.createCase(f.space.id, f.item)).rejects.toThrow('denied');
    expect((await f.service.overview(f.space.id)).reviews).toHaveLength(2);
    expect((await f.service.overview(f.space.id)).comparisons).toHaveLength(1);
    expect((await f.service.overview(f.space.id)).iterations).toHaveLength(1);
  });
});
