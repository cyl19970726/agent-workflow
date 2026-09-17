import assert from 'node:assert/strict';
import {
  defineAgent,
  MemoryRunStore,
  runWorkflow,
  workflow,
} from '@signal-room/workflow';

const defineRole = (id) => defineAgent({
  id,
  revision: '1',
  model: 'fake-model',
  reasoningEffort: 'medium',
  promptRevision: '1',
  skillsRevision: '1',
  permissionsRevision: '1',
});

const contentInspector = defineRole('content-inspector');
const referenceInspector = defineRole('reference-inspector');

const validContentFinding = (value) => ({
  valid: typeof value?.summary === 'string' && Array.isArray(value?.findings),
});
const validReferenceFinding = (value) => ({
  valid: Array.isArray(value?.checked) && Array.isArray(value?.findings),
});

const inspectDocument = workflow(
  'document.inspect',
  { revision: '1' },
  async (ctx, input) => ctx.phase(
    'inspection',
    {
      title: 'Document inspection',
      purpose: 'Independently inspect readable content and its references',
      expectedArtifacts: [
        { role: 'content-findings', title: 'Content findings', required: true },
        { role: 'reference-findings', title: 'Reference findings', required: true },
      ],
    },
    async (phase) => {
      const checks = await phase.parallelSettled(
        'independent-checks',
        {
          content: async () => {
            const finding = await phase.agent('content-role', contentInspector, input);
            const validation = await phase.validate(
              'validate-content', finding, validContentFinding,
              { producerStepKey: 'content-role' },
            );
            if (!validation.valid) throw new Error('Content finding failed its contract');
            const ref = await phase.publish('publish-content', 'content-inspection', finding, {
              schemaVersion: '1', revision: '1', validation: 'valid', review: 'not_applicable',
            });
            return { finding, ref };
          },
          references: async () => {
            const finding = await phase.agent('reference-role', referenceInspector, input);
            const validation = await phase.validate(
              'validate-references', finding, validReferenceFinding,
              { producerStepKey: 'reference-role' },
            );
            if (!validation.valid) throw new Error('Reference finding failed its contract');
            const ref = await phase.publish('publish-references', 'reference-inspection', finding, {
              schemaVersion: '1', revision: '1', validation: 'valid', review: 'not_applicable',
            });
            return { finding, ref };
          },
        },
        { concurrency: 2 },
      );

      // Re-bind after every replay. A successful parallel branch can be reused as
      // a whole, so binding only inside that branch would omit it from the new
      // phase attempt.
      if (checks.content.status === 'fulfilled') {
        await phase.bindArtifact(checks.content.value.ref, {
          role: 'content-findings', title: 'Content findings', order: 1, primary: true,
        });
      }
      if (checks.references.status === 'fulfilled') {
        await phase.bindArtifact(checks.references.value.ref, {
          role: 'reference-findings', title: 'Reference findings', order: 2,
        });
      }

      const failures = Object.entries(checks).filter(([, result]) => result.status === 'rejected');
      if (failures.length) {
        throw new Error(`Temporary inspection failure: ${failures.map(([name]) => name).join(', ')}`);
      }

      // Completing both checks is not a claim that the source document has no findings.
      const report = {
        status: 'completed_with_findings',
        content: checks.content.value.finding,
        references: checks.references.value.finding,
      };
      const reportRef = await phase.publish('publish-report', 'document-inspection-report', report, {
        schemaVersion: '1', revision: '1', validation: 'valid', review: 'not_applicable',
        dependsOn: [checks.content.value.ref, checks.references.value.ref].map((ref) => ({
          artifactId: ref.id, revision: ref.revision, sha256: ref.sha256,
        })),
      });
      await phase.bindArtifact(reportRef, {
        role: 'inspection-report', title: 'Completed inspection', order: 3, primary: true,
      });
      return { ...report, assets: { content: checks.content.value.ref, references: checks.references.value.ref, report: reportRef } };
    },
  ),
);

const calls = [];
let referencesAvailable = false;
const fakeAgentRunner = {
  async run({ definition }) {
    calls.push(definition.id);
    if (definition.id === 'content-inspector') {
      return { output: { summary: 'The document is clear.', findings: ['Clarify the conclusion.'] } };
    }
    if (!referencesAvailable) throw new Error('temporary reference service outage');
    return { output: { checked: ['ref-1', 'ref-2'], findings: [] } };
  },
};

const store = new MemoryRunStore();
const input = { documentId: 'doc-42', text: 'A readable document.', references: ['ref-1', 'ref-2'] };

let firstError;
try {
  await runWorkflow({ workflow: inspectDocument, input, store, agentRunner: fakeAgentRunner });
} catch (error) {
  firstError = error;
}
const [firstRun] = await store.listRuns();
const first = { run: firstRun };
const callsBeforeResume = [...calls];
const firstArtifacts = await store.listArtifacts(first.run.id);
const firstSteps = await store.listSteps(first.run.id);
const firstPhase = firstSteps.filter((step) => step.kind === 'phase').at(-1);
const partialStatus = firstArtifacts.some((artifact) => artifact.type === 'content-inspection')
  ? 'partial_findings'
  : 'failed_without_findings';

assert.equal(first.run.state, 'failed');
assert.match(firstError.message, /Temporary inspection failure: references/);
assert.equal(partialStatus, 'partial_findings');
assert.deepEqual(callsBeforeResume, ['content-inspector', 'reference-inspector']);
assert.equal(firstArtifacts.filter((artifact) => artifact.type === 'content-inspection').length, 1);
assert.equal(firstArtifacts.filter((artifact) => artifact.type === 'reference-inspection').length, 0);
assert.equal(firstPhase.artifactBindings.length, 1);
assert.equal(firstPhase.artifactBindings[0].role, 'content-findings');

referencesAvailable = true;
const resumed = await runWorkflow({
  workflow: inspectDocument,
  input,
  store,
  agentRunner: fakeAgentRunner,
  resumeRunId: first.run.id,
});
const callsAfterResume = [...calls];
const allArtifacts = await store.listArtifacts(first.run.id);
const allSteps = await store.listSteps(first.run.id);
const completedPhase = allSteps.filter((step) => step.kind === 'phase' && step.state === 'succeeded').at(-1);

assert.equal(resumed.run.id, first.run.id);
assert.equal(resumed.run.state, 'succeeded');
assert.equal(resumed.output.status, 'completed_with_findings');
assert.deepEqual(callsAfterResume, ['content-inspector', 'reference-inspector', 'reference-inspector']);
assert.equal(callsAfterResume.filter((id) => id === 'content-inspector').length, 1);
assert.equal(callsAfterResume.filter((id) => id === 'reference-inspector').length, 2);
assert.equal(allArtifacts.filter((artifact) => artifact.type === 'content-inspection').length, 1);
assert.equal(allArtifacts.filter((artifact) => artifact.type === 'reference-inspection').length, 1);
assert.equal(allArtifacts.filter((artifact) => artifact.type === 'document-inspection-report').length, 1);
assert.deepEqual(completedPhase.artifactBindings.map((binding) => binding.role), [
  'content-findings', 'reference-findings', 'inspection-report',
]);
assert.equal(resumed.output.assets.report.dependsOn.length, 2);

console.log(JSON.stringify({
  beforeResume: {
    runState: first.run.state,
    deliveryStatus: partialStatus,
    exactAgentCalls: callsBeforeResume,
    boundRoles: firstPhase.artifactBindings.map((binding) => binding.role),
  },
  afterResume: {
    runState: resumed.run.state,
    deliveryStatus: resumed.output.status,
    exactAgentCalls: callsAfterResume,
    newlyExecutedCalls: callsAfterResume.slice(callsBeforeResume.length),
    boundRoles: completedPhase.artifactBindings.map((binding) => binding.role),
    artifactTypes: allArtifacts.map((artifact) => artifact.type),
  },
}, null, 2));
