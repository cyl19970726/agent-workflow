import assert from 'node:assert/strict';
import { defineAgent, MemoryRunStore, runWorkflow, workflow } from '@signal-room/workflow';

// No SDK or model is invoked. The fake model deliberately exercises both routes.
const role = id => defineAgent({
  id, revision: '1', model: 'fake-model', reasoningEffort: 'medium',
  promptRevision: '1', skillsRevision: '1', permissionsRevision: '1',
});
const builder = role('builder');
const reviewer = role('reviewer');
const dependency = ref => ({ artifactId: ref.id, revision: ref.revision, sha256: ref.sha256 });
const candidateValid = value => ({ valid: typeof value?.text === 'string' && value.text.length > 0 });
const reviewValid = value => ({ valid: Array.isArray(value?.findings) && value.findings.every(x => typeof x === 'string') });

const reviewCandidate = workflow('document.review', { revision: '1' }, async (ctx, input) => {
  const review = await ctx.agent('review', reviewer, input);
  const checked = await ctx.validate('validate-review', review, reviewValid);
  if (!checked.valid) return ctx.needsReview({ reason: 'invalid-review', candidate: input.candidateRef });
  const ref = await ctx.publish('review-record', 'document-review', review, {
    validation: 'valid', review: 'not_applicable', dependsOn: [dependency(input.candidateRef)],
  });
  return { review, ref };
});

// One revision is this example's business policy, not a library-wide limit.
const reviewedDocument = workflow('document.reviewed', { revision: '1' }, async (ctx, input) => {
  const initial = await ctx.phase('build', {
    title: 'Write candidate', purpose: 'Produce a readable draft before review',
    expectedArtifacts: [{ role: 'candidate', required: true }],
  }, async phase => {
    const candidate = await phase.agent('builder', builder, input);
    const checked = await phase.validate('validate-candidate', candidate, candidateValid);
    if (!checked.valid) return phase.needsReview({ reason: 'invalid-candidate' });
    const ref = await phase.publish('candidate', 'document', candidate, { validation: 'valid', review: 'pending' });
    await phase.bindArtifact(ref, { role: 'candidate', primary: true });
    return { candidate, ref };
  });
  if (initial.ok === false) return initial;
  let { candidate, ref } = initial;

  for (let round = 0; round <= 1; round++) {
    const result = await ctx.phase(`review-${round}`, {
      title: `Review version ${round + 1}`, purpose: 'Read this exact candidate independently',
      expectedArtifacts: [{ role: 'review', required: true }],
    }, async phase => {
      const review = await phase.call('independent-review', reviewCandidate, { candidate, candidateRef: ref });
      if (review.ok === false) return review;
      await phase.bindArtifact(review.ref, { role: 'review', primary: true });
      return review;
    });
    if (result.ok === false) return result;
    const route = ctx.decide(`route-${round}`, result.review.findings.length ? 'revise' : 'deliver');
    if (route === 'deliver') {
      return ctx.publish('delivery', 'reviewed-document', candidate, {
        validation: 'valid', review: 'passed', dependsOn: [dependency(ref), dependency(result.ref)],
      });
    }
    if (round === 1) return ctx.needsReview({ candidate: ref, review: result.ref, reason: 'revision-budget-exhausted' });
    const revised = await ctx.agent('revise-1', builder, { ...input, candidate, findings: result.review.findings });
    const checked = await ctx.validate('validate-revision-1', revised, candidateValid);
    if (!checked.valid) return ctx.needsReview({ candidate: ref, reason: 'invalid-revision' });
    candidate = revised;
    ref = await ctx.publish('revision-1', 'document', candidate, {
      validation: 'valid', review: 'pending', dependsOn: [dependency(ref), dependency(result.ref)],
    });
    // The new candidate must be reviewed; it never inherits the old review flag.
  }
});

async function scenario(mode) {
  const calls = [];
  const agentRunner = {
    async run({ definition, input }) {
      calls.push(definition.id);
      if (definition.id === 'reviewer') {
        return { output: { findings: input.candidate.text.endsWith('.') ? [] : ['End with a period.'] } };
      }
      const text = mode === 'ready' ? 'Ready.' : input.candidate && mode !== 'unresolved' ? 'Revised.' : 'Draft';
      return { output: { text } };
    },
  };
  const store = new MemoryRunStore();
  const input = { topic: 'A short document', mode };
  const first = await runWorkflow({ workflow: reviewedDocument, input, store, agentRunner });
  const countBeforeResume = calls.length;
  const resumed = await runWorkflow({ workflow: reviewedDocument, input, store, agentRunner, resumeRunId: first.run.id });
  assert.equal(calls.length, countBeforeResume, 'Validated model steps must not execute again');
  assert.equal(first.run.state, mode === 'unresolved' ? 'needs_review' : 'succeeded');
  assert.equal(resumed.run.state, first.run.state);
  assert.equal(calls.filter(x => x === 'builder').length, mode === 'ready' ? 1 : 2);
  assert.equal(calls.filter(x => x === 'reviewer').length, mode === 'ready' ? 1 : 2);
  const artifacts = await store.listArtifacts(first.run.id);
  assert.equal(artifacts.filter(x => x.review === 'passed').length, mode === 'unresolved' ? 0 : 1);
  const reviewRuns = await store.listRuns({ parentRunId: first.run.id });
  const reviews = await Promise.all(reviewRuns.map(run => store.listArtifacts(run.id)));
  for (const review of reviews.flat()) {
    assert.equal(review.dependsOn.length, 1);
    const target = await store.getArtifact(review.dependsOn[0].artifactId);
    assert.equal(target.sha256, review.dependsOn[0].sha256);
    assert.equal(target.review, 'pending');
  }
  console.log(JSON.stringify({ mode, state: resumed.run.state, calls, replayedWithoutAgentCalls: true }));
}

await scenario('ready');
await scenario('revise');
await scenario('unresolved');
