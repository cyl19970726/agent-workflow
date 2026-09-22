import assert from 'node:assert/strict';
import { defineAgent, MemoryRunStore, runWorkflow, workflow } from '@signal-room/workflow';

// Deterministic example: same frozen cases, one changed prompt revision, independent oracle.
// This demonstrates an experiment shape; it is not a model benchmark.
const cases = Object.freeze([
  Object.freeze({
    id: 'case-team',
    sourceSha256: 'source-team-v1',
    expected: Object.freeze(['Cornell departure', 'NASA robotics', 'Berkeley and UCLA engineers']),
  }),
  Object.freeze({
    id: 'case-constraint',
    sourceSha256: 'source-constraint-v1',
    expected: Object.freeze(['flight uses high power', 'structure is complex']),
  }),
]);

const answers = Object.freeze({
  baseline: Object.freeze({
    'case-team': ['Cornell departure'],
    'case-constraint': ['flight increases cost', 'structure is complex'],
  }),
  candidate: Object.freeze({
    'case-team': ['Cornell departure', 'NASA robotics', 'Berkeley and UCLA engineers'],
    'case-constraint': ['flight uses high power', 'structure is complex'],
  }),
});

function createWorkflow(variant) {
  const builder = defineAgent({
    id: 'extract-claims',
    revision: variant,
    model: 'fake-deterministic-runner',
    reasoningEffort: 'medium',
    promptRevision: variant,
    skillsRevision: 'frozen-method-v1',
    permissionsRevision: 'no-tools-v1',
  });

  return workflow('example.extract-claims', { revision: variant }, async (ctx, input) => {
    const result = await ctx.agent('builder', builder, input);
    const checked = await ctx.validate('claims-contract', result, value => ({
      valid: Array.isArray(value?.claims) && value.claims.every(claim => typeof claim === 'string'),
    }));
    if (!checked.valid) return ctx.needsReview({ reason: 'invalid-claims-output' });
    return result;
  });
}

function scoreIndependently(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const truePositives = [...actualSet].filter(claim => expectedSet.has(claim)).length;
  return {
    expectedCount: expectedSet.size,
    observedCount: actualSet.size,
    supportedCount: truePositives,
    missedCount: [...expectedSet].filter(claim => !actualSet.has(claim)).length,
    unsupportedClaims: [...actualSet].filter(claim => !expectedSet.has(claim)),
    recall: expectedSet.size ? truePositives / expectedSet.size : null,
    precision: actualSet.size ? truePositives / actualSet.size : null,
  };
}

async function runVariant(variant) {
  const store = new MemoryRunStore();
  let agentCalls = 0;
  const agentRunner = {
    async run({ definition, input }) {
      assert.equal(definition.promptRevision, variant);
      agentCalls += 1;
      return { output: { claims: [...answers[variant][input.caseId]] } };
    },
  };

  const results = [];
  for (const testCase of cases) {
    const frozenInput = Object.freeze({
      caseId: testCase.id,
      sourceSha256: testCase.sourceSha256,
    });
    const { run, output } = await runWorkflow({
      workflow: createWorkflow(variant),
      input: frozenInput,
      store,
      agentRunner,
    });
    const score = output?.claims
      ? scoreIndependently(testCase.expected, output.claims)
      : null;
    results.push({ caseId: testCase.id, runId: run.id, state: run.state, score });
  }
  return { variant, agentCalls, results };
}

const baseline = await runVariant('baseline');
const candidate = await runVariant('candidate');
assert.deepEqual(baseline.results.map(result => result.caseId), candidate.results.map(result => result.caseId));
assert.equal(baseline.agentCalls, cases.length);
assert.equal(candidate.agentCalls, cases.length);

console.log(JSON.stringify({
  note: 'Deterministic illustration only; two cases do not establish real-world effectiveness.',
  changedVariable: 'prompt/workflow revision',
  frozenCases: cases.map(({ id, sourceSha256 }) => ({ id, sourceSha256 })),
  baseline,
  candidate,
}, null, 2));
