import { describe, expect, it } from 'vitest';
import {
  AtomicStepReconciliationRequiredError, MemoryRunStore, defineAgent, runWorkflow, workflow,
  type AgentRunner, type ArtifactRef, type RunStore, type StepResultCommit, type StepResultReceipt,
} from '@signal-room/workflow';
import { createSpaceRuntime, type SpaceRuntimeResolverApi, type SpaceRuntimeService } from './runtime.js';
import { InvalidObservedOutputError } from './errors.js';
import type { AssetVersion, NodeContext, NodeStart } from './types.js';

function harness() {
  const memory = new MemoryRunStore();
  const receipts = new Map<string, StepResultReceipt>();
  const base = memory as RunStore;
  base.commitStepResult = async (commit: StepResultCommit): Promise<StepResultReceipt> => {
    const prior = receipts.get(commit.idempotencyKey);
    if (prior) return prior;
    let artifact: ArtifactRef | undefined;
    if (commit.artifact) artifact = await memory.publishArtifact(commit.artifact);
    const result: StepResultReceipt = { output: commit.output ?? artifact, ...(artifact ? { artifact } : {}) };
    await memory.updateStep(commit.stepRunId, { state: commit.state, validation: commit.validation, output: result.output });
    await memory.updateAttempt(commit.attemptId, { state: commit.state });
    for (const event of commit.events) await memory.appendEvent(event);
    receipts.set(commit.idempotencyKey, result);
    return result;
  };
  const contexts: NodeContext[] = [];
  const starts: NodeStart[] = [];
  const versions = new Map<string, AssetVersion>();
  const artifactVersions = new Map<string, AssetVersion>();
  const rawOutputs: unknown[] = [];
  const traces: unknown[] = [];
  let runnerCalls = 0;
  const service: SpaceRuntimeService = {
    async runtimeLedger(spaceId) { expect(spaceId).toBe('space-1'); return base; },
    async bindRuntimeRun(_spaceId, binding, draft) {
      expect(binding).toEqual({workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'});
      return memory.createRun(draft);
    },
    async startNode(_spaceId, input) {
      if (contexts.some((item) => item.attemptId === input.existingAttempt?.attemptId && item.producer === input.producer)) {
        throw new Error('Duplicate context');
      }
      starts.push(input);
      const context: NodeContext = {
        id: `context-${starts.length}`, spaceId: 'space-1', runId: input.runId,
        stepRunId: input.existingAttempt!.stepRunId, attemptId: input.existingAttempt!.attemptId,
        nodeId: input.nodeId, sessionId: `session-${starts.length}`, producer: input.producer,
        inputs: Object.fromEntries(Object.entries(input.inputs).map(([slot, id]) =>
          [slot, {assetVersionId:id,payloadHash:'hash',schema:{namespace:'test/input',revision:'1',hash:'a'.repeat(64)},viewVersion:'full',deliveredHash:'hash',payload:{}}])),
        instructions: input.instructions, effectiveConfig: input.effectiveConfig, knowledge: [], hash: 'context-hash',
        actualInput: input.actualInput, generatedByContextId: input.generatedByContextId,
      };
      contexts.push(context);
      return context;
    },
    async completeObservedAgent(_spaceId, _contextId, output) { rawOutputs.push(output); },
    async commitRuntimePublication(_spaceId, contextId, runtimeCommit, nodeCommit) {
      const context = contexts.find((item) => item.id === contextId)!;
      expect(context.producer).toBe('program');
      expect(nodeCommit.outputs).toHaveLength(1);
      expect(nodeCommit.outputs[0]!.slot).toBe('draft');
      const result = await base.commitStepResult!(runtimeCommit);
      if (result.artifact && !artifactVersions.has(result.artifact.id)) {
        const version: AssetVersion = {
          id:'version-1',spaceId:'space-1',assetId:'draft',version:1,
          schema:{namespace:'test/draft',revision:'1',hash:'b'.repeat(64)},
          payload: nodeCommit.outputs[0]!.payload,payloadHash:'payload-hash',
          source:{kind:'node',runId:context.runId,stepRunId:context.stepRunId,attemptId:context.attemptId,
            nodeId:context.nodeId,producer:'program',sessionId:context.sessionId,contextId,
            generatedByContextId:context.generatedByContextId},
          dependencies:[],attachments:[],initialState:'candidate',createdAt:'2026-10-04T00:00:00Z',
        };
        versions.set(version.id, version);
        artifactVersions.set(result.artifact.id, version);
      }
      return result;
    },
    async resolveRuntimeArtifact(_spaceId, artifactId) {
      const version = artifactVersions.get(artifactId);
      if (!version) throw new Error('Runtime artifact has no domain publication');
      return version;
    },
    async runtimeContexts(_spaceId, runId) { return contexts.filter((item) => item.runId === runId); },
    async readManifest() { return {id:'manifest-1',spaceId:'space-1',caseId:'case-1',assets:{},hash:'hash'}; },
    async readAsset(_spaceId, versionId) {
      const version = versions.get(versionId);
      if (!version) throw new Error('Missing asset');
      return {...version,state:'candidate'};
    },
    async recordSessionEvent(_spaceId, _contextId, _key, kind, body) { traces.push({kind,body}); },
  };
  const underlyingRunner: AgentRunner = {
    async run(request) {
      runnerCalls++;
      await request.emit('model.output', { tokenCount: 3 });
      return { output: { text: 'Draft from model' }, validation: 'valid' };
    },
  };
  return { service, base, contexts, starts, versions, rawOutputs, traces, underlyingRunner,
    get runnerCalls() { return runnerCalls; } };
}

const agent = defineAgent<{prompt:string}, {text:string}>({
  id:'writer',revision:'1',model:'test',reasoningEffort:'low',promptRevision:'1',skillsRevision:'1',permissionsRevision:'1',
});
const contentWorkflow = workflow('content', {revision:'1'}, async (ctx, input: {prompt:string}) => {
  const draft = await ctx.agent('writer', agent, input);
  return ctx.publish('draft', 'test/draft', {text:draft.text}, {validation:'valid'});
});

describe('Space runtime bridge', () => {
  it('runs the existing core workflow, records agent output separately, and publishes a domain asset', async () => {
    const h = harness();
    let resolverApi: SpaceRuntimeResolverApi | undefined;
    const runtime = await createSpaceRuntime(h.service, 'space-1',
      {workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'}, {
        underlyingRunner:h.underlyingRunner,
        resolveAgent(request, api) {
          resolverApi = api;
          expect(request.definition.id).toBe('writer');
          return {nodeId:'author',inputs:{},instructions:'Write a draft'};
        },
        async resolvePublication(artifact, api) {
          expect(artifact.type).toBe('test/draft');
          const prior = (await api.contexts(artifact.producedBy.workflowRunId)).find((item) => item.producer==='agent');
          return {nodeId:'author',inputs:{},outputSlot:'draft',generatedByContextId:prior?.id};
        },
      });
    const result = await runWorkflow({workflow:contentWorkflow,input:{prompt:'Topic'},
      store:runtime.store,agentRunner:runtime.agentRunner});
    expect(result.run.state).toBe('succeeded');
    expect(h.runnerCalls).toBe(1);
    expect(h.rawOutputs).toEqual([{text:'Draft from model'}]);
    expect(h.contexts.map((item) => item.producer)).toEqual(['agent','program']);
    expect(h.contexts[1]!.generatedByContextId).toBe(h.contexts[0]!.id);
    expect(h.starts[0]!.actualInput).toEqual({prompt:'Topic'});
    expect(h.traces).toHaveLength(1);
    const coreArtifact = result.output!;
    expect((await runtime.store.getArtifact(coreArtifact.id))?.id).toBe(coreArtifact.id);
    expect((await h.service.resolveRuntimeArtifact('space-1', coreArtifact.id)).payload).toEqual({text:'Draft from model'});
    expect((await resolverApi!.artifacts(result.run.id))[0]).toMatchObject({
      artifact: {id:coreArtifact.id}, version: {id:'version-1'},
    });
    const resumed = await runWorkflow({workflow:contentWorkflow,input:{prompt:'Topic'},
      store:runtime.store,agentRunner:runtime.agentRunner,resumeRunId:result.run.id});
    expect(resumed.run.state).toBe('succeeded');
    expect(h.runnerCalls).toBe(1);
    expect(h.starts).toHaveLength(2);
  });

  it('reuses the persisted publication context on a repeated commit', async () => {
    const h = harness();
    const runtime = await createSpaceRuntime(h.service, 'space-1',
      {workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'}, {
        underlyingRunner:h.underlyingRunner,
        resolveAgent() { return {nodeId:'author',inputs:{},instructions:'Write'}; },
        resolvePublication() { return {nodeId:'author',inputs:{},outputSlot:'draft'}; },
      });
    const run = await runtime.store.createRun({workflowId:'content',workflowRevision:'1',inputFingerprint:'input',state:'running'});
    const step = await runtime.store.createStep({runId:run.id,key:'draft',kind:'publish',workflowId:'content',workflowRevision:'1',
      inputFingerprint:'input',configFingerprint:'config',state:'running',validation:'valid'});
    const attempt = await runtime.store.createAttempt({runId:run.id,stepRunId:step.id,state:'running'});
    const artifact = {type:'test/draft',schemaVersion:'1',revision:'1',sha256:'hash',uri:'workflow-artifact://test',
      payload:{text:'Draft'},producedBy:{workflowRunId:run.id,stepRunId:step.id,attemptId:attempt.id},
      dependsOn:[],validation:'valid' as const,review:'pending' as const};
    const commit: StepResultCommit = {stepRunId:step.id,attemptId:attempt.id,idempotencyKey:'same-commit',state:'succeeded',
      validation:'valid',artifact,events:[]};
    const first = await runtime.store.commitStepResult!(commit);
    const restartedRuntime = await createSpaceRuntime(h.service, 'space-1',
      {workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'}, {
        underlyingRunner:h.underlyingRunner,
        resolveAgent() { return {nodeId:'author',inputs:{},instructions:'Write'}; },
        resolvePublication() { return {nodeId:'author',inputs:{},outputSlot:'draft'}; },
      });
    const second = await restartedRuntime.store.commitStepResult!(commit);
    expect(second.artifact?.id).toBe(first.artifact?.id);
    expect(h.starts).toHaveLength(1);
    const driftedRuntime = await createSpaceRuntime(h.service, 'space-1',
      {workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'}, {
        underlyingRunner:h.underlyingRunner,
        resolveAgent() { return {nodeId:'author',inputs:{},instructions:'Write'}; },
        resolvePublication() { return {nodeId:'author',inputs:{},outputSlot:'draft',instructions:'Changed publication instructions'}; },
      });
    await expect(driftedRuntime.store.commitStepResult!(commit)).rejects.toThrow(/conflicts with current/);
    expect(h.starts).toHaveLength(1);
  });

  it('preserves uncertain agent persistence and reports known runner failures', async () => {
    const h = harness();
    const runtime = await createSpaceRuntime(h.service, 'space-1',
      {workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'}, {
        underlyingRunner:h.underlyingRunner,
        resolveAgent() { return {nodeId:'author',inputs:{},instructions:'Write'}; },
        resolvePublication() { return {nodeId:'author',inputs:{},outputSlot:'draft'}; },
      });
    const run = await runtime.store.createRun({workflowId:'content',workflowRevision:'1',inputFingerprint:'input',state:'running'});
    const step = await runtime.store.createStep({runId:run.id,key:'writer',kind:'agent',workflowId:'content',workflowRevision:'1',
      inputFingerprint:'input',configFingerprint:'config',state:'running',validation:'pending'});
    const attempt = await runtime.store.createAttempt({runId:run.id,stepRunId:step.id,state:'running'});
    const request = {runId:run.id,stepRunId:step.id,attemptId:attempt.id,definition:agent,input:{prompt:'Topic'},
      signal:new AbortController().signal,emit:async () => {}};
    h.service.recordSessionEvent = async () => { throw new Error('Session storage failed'); };
    await expect(runtime.agentRunner.run(request)).rejects.toBeInstanceOf(AtomicStepReconciliationRequiredError);
    expect((await runtime.store.listAttempts(step.id))[0]!.state).toBe('running');

    const h2 = harness();
    const known = new Error('Model rejected request');
    let failedContext = '';
    h2.service.failNode = async (_spaceId, contextId) => { failedContext = contextId; };
    const failedRuntime = await createSpaceRuntime(h2.service, 'space-1',
      {workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'}, {
        underlyingRunner: { async run() { throw known; } },
        resolveAgent() { return {nodeId:'author',inputs:{},instructions:'Write'}; },
        resolvePublication() { return {nodeId:'author',inputs:{},outputSlot:'draft'}; },
      });
    const failedRun = await failedRuntime.store.createRun({workflowId:'content',workflowRevision:'1',inputFingerprint:'input',state:'running'});
    const failedStep = await failedRuntime.store.createStep({runId:failedRun.id,key:'writer',kind:'agent',workflowId:'content',workflowRevision:'1',
      inputFingerprint:'input',configFingerprint:'config',state:'running',validation:'pending'});
    const failedAttempt = await failedRuntime.store.createAttempt({runId:failedRun.id,stepRunId:failedStep.id,state:'running'});
    await expect(failedRuntime.agentRunner.run({...request,runId:failedRun.id,stepRunId:failedStep.id,attemptId:failedAttempt.id}))
      .rejects.toBe(known);
    expect(failedContext).toBe(h2.contexts[0]!.id);

    const h3 = harness();
    h3.service.completeObservedAgent = async () => { throw new Error('Result receipt uncertain'); };
    const uncertainRuntime = await createSpaceRuntime(h3.service, 'space-1',
      {workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'}, {
        underlyingRunner:h3.underlyingRunner,
        resolveAgent() { return {nodeId:'author',inputs:{},instructions:'Write'}; },
        resolvePublication() { return {nodeId:'author',inputs:{},outputSlot:'draft'}; },
      });
    const uncertainRun = await uncertainRuntime.store.createRun({workflowId:'content',workflowRevision:'1',inputFingerprint:'input',state:'running'});
    const uncertainStep = await uncertainRuntime.store.createStep({runId:uncertainRun.id,key:'writer',kind:'agent',workflowId:'content',workflowRevision:'1',
      inputFingerprint:'input',configFingerprint:'config',state:'running',validation:'pending'});
    const uncertainAttempt = await uncertainRuntime.store.createAttempt({runId:uncertainRun.id,stepRunId:uncertainStep.id,state:'running'});
    await expect(uncertainRuntime.agentRunner.run({...request,runId:uncertainRun.id,stepRunId:uncertainStep.id,attemptId:uncertainAttempt.id}))
      .rejects.toBeInstanceOf(AtomicStepReconciliationRequiredError);

    const h4 = harness();
    h4.service.completeObservedAgent = async (_spaceId, contextId) => {
      throw new InvalidObservedOutputError(contextId, ['/public must be string']);
    };
    const invalidRuntime = await createSpaceRuntime(h4.service, 'space-1',
      {workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest-1'}, {
        underlyingRunner:h4.underlyingRunner,
        resolveAgent() { return {nodeId:'author',inputs:{},instructions:'Write'}; },
        resolvePublication() { return {nodeId:'author',inputs:{},outputSlot:'draft'}; },
      });
    const invalidRun = await invalidRuntime.store.createRun({workflowId:'content',workflowRevision:'1',inputFingerprint:'input',state:'running'});
    const invalidStep = await invalidRuntime.store.createStep({runId:invalidRun.id,key:'writer',kind:'agent',workflowId:'content',workflowRevision:'1',
      inputFingerprint:'input',configFingerprint:'config',state:'running',validation:'pending'});
    const invalidAttempt = await invalidRuntime.store.createAttempt({runId:invalidRun.id,stepRunId:invalidStep.id,state:'running'});
    await expect(invalidRuntime.agentRunner.run({...request,runId:invalidRun.id,stepRunId:invalidStep.id,attemptId:invalidAttempt.id}))
      .rejects.toBeInstanceOf(InvalidObservedOutputError);
  });
});
