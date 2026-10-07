import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { defineAgent, runWorkflow, workflow } from '../packages/core/dist/index.js';
import { JSON_SCHEMA_DIALECT } from '../packages/space-contracts/dist/index.js';
import {
  WorkflowSpaceService, PostgresBlobStore, migrateWorkflowSpaces, createSpaceRuntime, nodeReadTools,
} from '../packages/spaces/dist/index.js';
import { SiwcAuth, SiwcResponsesRunner } from '../packages/agent-sdk/dist/index.js';

// Opt-in live storage and independent-evaluation probe. Never part of offline examples.
const { WORKFLOW_DATABASE_URL, WORKFLOW_SIWC_MODEL, WORKFLOW_PROBE_SPACE_ID, WORKFLOW_PROBE_RUN_ID } = process.env;
if (![WORKFLOW_DATABASE_URL, WORKFLOW_SIWC_MODEL, WORKFLOW_PROBE_SPACE_ID, WORKFLOW_PROBE_RUN_ID].every(Boolean)) {
  throw new Error('Set WORKFLOW_DATABASE_URL, WORKFLOW_SIWC_MODEL, WORKFLOW_PROBE_SPACE_ID and WORKFLOW_PROBE_RUN_ID. Run workflow-siwc login first.');
}

const reviewSchemaDefinition = {
  namespace: 'probe/review-answers', revision: '1', dialect: JSON_SCHEMA_DIALECT,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['good', 'bad', 'improvement', 'unresolved'],
    properties: {
      good: { type: 'string', minLength: 1 },
      bad: { type: 'string', minLength: 1 },
      improvement: { type: 'string', minLength: 1 },
      unresolved: { type: 'string', minLength: 1 },
    },
  },
};
const standard = {
  id: 'probe-source-fidelity', revision: '1',
  content: 'Using only the exact bound source and candidate report, assess fidelity, clarity, relative improvement, and any unresolved uncertainty. No prior review is bound, so relative improvement must explicitly say that no baseline is available. This checks independent evaluation and durable evidence binding; it is not a creative-quality acceptance standard.',
};
const schemaRef = (registered) => ({
  namespace: registered.namespace, revision: registered.revision, hash: registered.hash,
});

const pool = new Pool({ connectionString: WORKFLOW_DATABASE_URL });
try {
  await migrateWorkflowSpaces(pool);
  const blobs = new PostgresBlobStore(pool);
  await blobs.migrate();
  const service = new WorkflowSpaceService(pool, blobs, { id: 'local-owner', kind: 'human' });
  const spaceId = WORKFLOW_PROBE_SPACE_ID;
  const overview = await service.overview(spaceId);
  const sourceRun = overview.runs.find((run) => run.runId === WORKFLOW_PROBE_RUN_ID);
  if (!sourceRun || sourceRun.workflowVersionId !== 'probe-v1' || sourceRun.entrypoint !== 'probe') {
    throw new Error('Selected run is not the probe-v1 producer run in this Space');
  }
  const candidates = overview.assets.filter((asset) =>
    asset.source.kind === 'node' && asset.source.runId === sourceRun.runId &&
    asset.schema.namespace === 'probe/report' && asset.state === 'candidate');
  if (candidates.length !== 1) throw new Error(`Expected one exact candidate report in selected run; found ${candidates.length}`);
  const candidate = await service.readAsset(spaceId, candidates[0].id);
  const originalManifest = await service.readManifest(spaceId, sourceRun.inputManifestId);
  const sourceId = originalManifest.assets.source;
  if (!sourceId) throw new Error('Selected run has no frozen source asset');
  const source = await service.readAsset(spaceId, sourceId);
  if (source.state !== 'imported' || candidate.state !== 'candidate' ||
      source.schema.namespace !== candidate.schema.namespace ||
      source.schema.revision !== candidate.schema.revision ||
      source.schema.hash !== candidate.schema.hash) {
    throw new Error('Source and candidate are not the expected exact probe/report revisions and states');
  }

  const previous = overview.workflows.find((version) => version.id === 'probe-v1');
  const probeEntry = previous?.entrypoints.probe;
  if (!previous || !probeEntry || probeEntry.workflowId !== 'space.siwc-probe' || probeEntry.codeRevision !== '1') {
    throw new Error('Cannot retain the exact probe-v1 entrypoint');
  }
  const [reviewSchema] = await service.registerSchemas(spaceId, [reviewSchemaDefinition]);
  const reviewRef = schemaRef(reviewSchema);
  const reportRef = schemaRef(candidate.schema);
  const reviewContract = {
    workflowVersion: 'probe-v2',
    nodes: {
      reviewer: {
        actorKinds: ['agent', 'program'], sessionPolicy: 'new',
        inputs: {
          source: { schema: reportRef, states: ['imported'] },
          candidate: { schema: reportRef, states: ['candidate'] },
        },
        outputs: {
          assessment: {
            schema: reviewRef, agentOutputSchema: reviewRef,
            requiredInputs: ['source', 'candidate'], appendVersions: false, initialState: 'candidate',
          },
        },
        actions: ['readBoundInput', 'appendOutputVersion', 'evaluate'],
      },
    },
    stateRules: [],
  };
  const priorContract = probeEntry.storageContract;
  await service.publishWorkflow(spaceId, {
    id: 'probe-v2', revision: '2', predecessorId: 'probe-v1',
    changeReason: 'Add an independent four-question SIWC review of an exact probe report',
    config: { ...previous.config, reviewerModel: WORKFLOW_SIWC_MODEL },
    entrypoints: {
      probe: {
        workflowId: probeEntry.workflowId, codeRevision: probeEntry.codeRevision,
        storageContract: { workflowVersion: 'probe-v2', nodes: priorContract.nodes, stateRules: priorContract.stateRules },
      },
      review: { workflowId: 'space.siwc-review', codeRevision: '1', storageContract: reviewContract },
    },
  });
  const manifest = await service.freezeInputs(spaceId, sourceRun.caseId, {
    source: source.id, candidate: candidate.id,
  });

  const runner = new SiwcResponsesRunner({
    auth: new SiwcAuth(), maxTurns: 3, maxToolCalls: 2,
    tools: async (request) => {
      const context = (await service.runtimeContexts(spaceId, request.runId))
        .find((item) => item.attemptId === request.attemptId && item.producer === 'agent');
      if (!context) throw new Error('Independent reviewer context is missing');
      return nodeReadTools(await service.nodeClient(spaceId, context.id));
    },
  });
  const runtime = await createSpaceRuntime(service, spaceId, {
    workflowVersionId: 'probe-v2', entrypoint: 'review', inputManifestId: manifest.id,
  }, {
    underlyingRunner: runner,
    resolveAgent: () => ({
      nodeId: 'reviewer', inputs: { source: source.id, candidate: candidate.id },
      instructions: 'Read both frozen inputs and give an independent four-question assessment.',
    }),
    resolvePublication: async (artifact, api) => {
      const origins = (await api.contexts(artifact.producedBy.workflowRunId))
        .filter((item) => item.producer === 'agent' && item.nodeId === 'reviewer');
      if (origins.length !== 1) throw new Error('Assessment must identify one observed reviewer Agent context');
      return {
        nodeId: 'reviewer', inputs: { source: source.id, candidate: candidate.id },
        outputSlot: 'assessment', dependencySlots: ['source', 'candidate'],
        generatedByContextId: origins[0].id,
      };
    },
  });
  const reviewer = defineAgent({
    id: 'independent-reviewer', revision: '1', model: WORKFLOW_SIWC_MODEL, reasoningEffort: 'low',
    promptRevision: '1', skillsRevision: '1', permissionsRevision: 'read-bound-source-and-candidate-v1',
    config: {
      outputFormat: 'json',
      instructions: 'You are an independent reviewer of a short storage probe. First call read_bound_asset for slot source and for slot candidate. Compare the exact candidate to the exact source. Return only one JSON object with exactly four nonempty string keys: good, bad, improvement, unresolved. Base each answer on what you read. In improvement, explicitly state that this is the first review and no baseline is available; do not invent a previous outcome. If you find no concrete error, say so in bad instead of inventing one. Do not accept, adopt, or publish anything.',
    },
  });
  let rawAnswers;
  const reviewWorkflow = workflow('space.siwc-review', { revision: '1' }, async (ctx) => {
    rawAnswers = await ctx.agent('independent-review', reviewer, 'Read both bound slots with the tool, then answer the four review questions as strict JSON.');
    return ctx.publish('assessment', 'probe/review-answers', rawAnswers, { validation: 'valid' });
  });
  const result = await runWorkflow({
    workflow: reviewWorkflow, input: { requestId: randomUUID(), sourceRunId: sourceRun.runId,
      sourceVersionId: source.id, candidateVersionId: candidate.id },
    ...runtime, signal: AbortSignal.timeout(120_000),
  });
  if (result.run.state !== 'succeeded' || !rawAnswers) throw new Error('Independent review run did not produce a validated result');
  const reviewerContexts = (await service.runtimeContexts(spaceId, result.run.id))
    .filter((item) => item.producer === 'agent' && item.nodeId === 'reviewer');
  if (reviewerContexts.length !== 1 ||
      reviewerContexts[0].sessionId === candidate.source.sessionId) {
    throw new Error('Review requires exactly one fresh independent Agent session');
  }
  const readSlots = new Set();
  let cursor = 0;
  for (let page = 0; page < 20; page++) {
    const events = await service.sessionEvents(spaceId, reviewerContexts[0].sessionId, cursor, 1000);
    for (const event of events.items) {
      if (event.kind === 'trace' && event.body?.operation === 'asset.read') readSlots.add(event.body.slot);
    }
    if (!events.hasMore) break;
    cursor = events.nextCursor;
    if (page === 19) throw new Error('Reviewer session history exceeded verification page limit');
  }
  if (!readSlots.has('source') || !readSlots.has('candidate')) {
    throw new Error('Reviewer did not read both exact bound asset versions');
  }
  const client = await service.nodeClient(spaceId, reviewerContexts[0].id);
  const review = await client.act('evaluate', {
    id: randomUUID(), runId: sourceRun.runId, assetVersionIds: [candidate.id],
    standard, evidence: [source.id, candidate.id], answers: rawAnswers,
  });
  if (review.answers.good !== rawAnswers.good || review.answers.bad !== rawAnswers.bad ||
      review.answers.improvement !== rawAnswers.improvement || review.answers.unresolved !== rawAnswers.unresolved) {
    throw new Error('Stored review does not match the observed raw Agent output');
  }
  console.log(JSON.stringify({
    spaceId, sourceRunId: sourceRun.runId, reviewRunId: result.run.id, reviewId: review.id,
    candidateVersionId: candidate.id, reviewerSessionId: reviewerContexts[0].sessionId,
    state: result.run.state, independentAgentReview: true, humanAccepted: false, adopted: false,
  }, null, 2));
} finally {
  await pool.end();
}
