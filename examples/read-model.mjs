import assert from 'node:assert/strict';
import { defineAgent, MemoryRunStore, runWorkflow, workflow } from '@signal-room/workflow';
import { createWorkflowReadService } from '@signal-room/workflow-read-model';

// A deterministic fake runner exercises the real workflow runtime; no model or SDK is used.
const repair = process.argv.includes('--repair');
const role = id => defineAgent({ id, revision: '1', model: 'fake-model', reasoningEffort: 'medium', promptRevision: '1', skillsRevision: '1', permissionsRevision: '1' });
const builder = role('builder'), reviewer = role('reviewer');
const dependency = ref => ({ artifactId: ref.id, revision: ref.revision, sha256: ref.sha256 });
const exact = ref => ({ id: ref.id, revision: ref.revision, sha256: ref.sha256 });
const published = {};
const calls = [];
let reviewerAvailable = false;
const agentRunner = { async run({ definition }) {
  calls.push(definition.id);
  if (definition.id === 'reviewer') {
    if (!reviewerAvailable) throw new Error('SIMPLE_REVIEW_LOCATION_MISSING: private raw output');
    return { output: { findings: repair ? ['Clarify one sentence.'] : [] } };
  }
  return { output: { text: calls.filter(id => id === 'builder').length === 1 ? 'Initial draft' : 'Revised draft' } };
} };

const processDocument = workflow('example.read-model', { revision: '1' }, async (ctx, input) => {
  const built = await ctx.phase('build', { title: 'Builder', purpose: 'Produce a readable candidate', expectedArtifacts: [{ role: 'candidate', required: true }] }, async phase => {
    const output = await phase.agent('builder', builder, input);
    const ref = await phase.publish('candidate', 'candidate', output, { schemaVersion: '1', revision: '1', validation: 'valid', review: 'pending' });
    await phase.bindArtifact(ref, { role: 'candidate', primary: true });
    published.initial = ref;
    return ref;
  });
  const reviewed = await ctx.phase('review', { title: 'Independent Reviewer', purpose: 'Review the exact candidate', expectedArtifacts: [{ role: 'review', required: true }] }, async phase => {
    const output = await phase.agent('reviewer', reviewer, { candidate: built });
    const ref = await phase.publish('review', 'review', output, { schemaVersion: '1', revision: '1', validation: 'valid', review: output.findings.length ? 'findings' : 'passed', dependsOn: [dependency(built)] });
    await phase.bindArtifact(ref, { role: 'review', primary: true });
    published.review = ref;
    return output;
  });
  if (!reviewed.findings.length) return { candidate: built };
  const revised = await ctx.phase('repair', { title: 'Optional repair', purpose: 'Apply the review once', expectedArtifacts: [{ role: 'candidate', required: true }] }, async phase => {
    const output = await phase.agent('repair-builder', builder, { candidate: built, findings: reviewed.findings });
    const ref = await phase.publish('revision', 'candidate', output, { schemaVersion: '1', revision: '2', validation: 'valid', review: 'pending', dependsOn: [dependency(built), dependency(published.review)] });
    await phase.bindArtifact(ref, { role: 'candidate', primary: true });
    published.revised = ref;
    return ref;
  });
  return { candidate: revised };
});

const store = new MemoryRunStore();
const input = { documentId: 'demo-1' };
let failed;
try { await runWorkflow({ workflow: processDocument, input, store, agentRunner }); }
catch (error) { failed = error; }
assert.match(failed?.message ?? '', /SIMPLE_REVIEW_LOCATION_MISSING/);
const [root] = await store.listRuns();
assert.equal(root.state, 'failed');
const firstSteps = await store.listSteps(root.id);
const failedReviewer = firstSteps.find(step => step.kind === 'agent' && step.key.endsWith(':reviewer') && step.state === 'failed');
assert.ok(failedReviewer, `failed reviewer call must remain in the ledger: ${JSON.stringify(firstSteps.map(step => [step.key, step.kind, step.state]))}`);
const beforeResume = calls.length;
reviewerAvailable = true;
const resumed = await runWorkflow({ workflow: processDocument, input, store, agentRunner, resumeRunId: root.id });
assert.equal(resumed.run.state, 'succeeded');
assert.equal(calls.slice(beforeResume)[0], 'reviewer');
assert.equal(calls.filter(id => id === 'builder').length, repair ? 2 : 1, 'validated Builder output is reused');
const steps = await store.listSteps(root.id);
const successfulReviewer = steps.filter(step => step.kind === 'agent' && step.key.endsWith(':reviewer') && step.state === 'succeeded').at(-1);
assert.ok(successfulReviewer);
// The business retry crosses durable step records; record its explicit relationship.
await store.appendEvent({ runId: root.id, stepRunId: successfulReviewer.id, type: 'read-model.retry', data: { retryOf: failedReviewer.id, reason: 'Review output location failed validation' } });

const selected = repair ? published.revised : published.initial;
assert.ok(selected && published.review);
const read = createWorkflowReadService({ store, adapters: {
  title: (kind, id, step) => kind === 'phase' ? step.phaseDefinition?.title : step.kind === 'agent' ? 'Model call' : 'Child workflow',
  error: (_id, error) => error.startsWith('SIMPLE_REVIEW_LOCATION_MISSING') ? 'Output location invalid; this attempt was not accepted.' : 'Execution failed.',
  isDeliverable: artifact => artifact.type === 'candidate',
  plan: () => ({ closed: true, planned: repair ? 3 : 2 }),
  relations: artifact => {
    if (artifact.id === published.review.id) return [{ kind: 'reviews', from: exact(published.review), to: exact(published.initial) }];
    if (repair && artifact.id === published.revised.id) return [
      { kind: 'revises', from: exact(published.revised), to: exact(published.initial) },
      { kind: 'selected', from: exact(published.revised), to: exact(published.revised) },
    ];
    if (!repair && artifact.id === published.initial.id) return [{ kind: 'selected', from: exact(published.initial), to: exact(published.initial) }];
    return [];
  },
} });
const snapshot = await read.getSnapshot({ rootRunId: root.id });
assert.equal(snapshot.stages.length, repair ? 3 : 2);
assert.equal(snapshot.delivery.state, 'selected');
assert.deepEqual(snapshot.delivery.artifactIds, [selected.id]);
assert.equal(snapshot.calls.filter(call => call.role === 'agent' && call.state === 'failed').length, 1);
assert.equal(snapshot.calls.find(call => call.id === successfulReviewer.id)?.retryOf, failedReviewer.id);
assert.equal(snapshot.artifacts.find(asset => asset.identity.id === selected.id)?.effectiveReview, repair ? 'unknown' : 'passed');
assert.equal(snapshot.relations.some(relation => relation.kind === 'reviews' && relation.validity === 'valid'), true);
assert.equal(snapshot.relations.some(relation => relation.kind === 'revises' && relation.validity === 'valid'), repair);
assert.equal(JSON.stringify(snapshot).includes('private raw output'), false);
const detail = await read.getStageDetails({ rootRunId: root.id, phaseId: snapshot.stages.find(stage => stage.title === 'Independent Reviewer').id });
assert.ok(detail.calls.some(call => call.id === successfulReviewer.id));
console.log(JSON.stringify({ mode: repair ? 'repair' : 'no-repair', state: resumed.run.state, stages: snapshot.stages.map(stage => stage.title), modelCalls: calls, failedReviewerRetained: true, retryLinked: true, selectedRevision: selected.revision, selectedReview: repair ? 'unknown (not re-reviewed)' : 'passed' }));
