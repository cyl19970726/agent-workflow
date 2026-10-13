import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {beforeAll,afterAll,describe,expect,it} from 'vitest';
import {artifactPayloadSha256} from '@signal-room/workflow';
import {PostgresWorkflowRunStore} from '@signal-room/workflow-postgres';
import {JSON_SCHEMA_DIALECT,type StorageContractDraft} from '@signal-room/workflow-space-contracts';
import {PostgresBlobStore} from './blob-store.js';
import {migrateWorkflowSpaces} from './migration.js';
import {WorkflowSpaceService} from './service.js';
import {createRunDispositionStore,RUN_DISPOSITION_SCHEMA_REF} from './run-disposition.js';
import {createExternalAgentObservationStore} from './external-agent-observation.js';
import type {ReviewDraft,SavedResponseTarget} from './types.js';

const databaseUrl=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=databaseUrl?describe:describe.skip;

suite('external Agent exact saved-response observation (isolated PostgreSQL database)',()=>{
  let pool:Pool;
  let blobs:PostgresBlobStore;
  beforeAll(async()=>{
    pool=new Pool({connectionString:databaseUrl!,max:12});
    await migrateWorkflowSpaces(pool);
    blobs=new PostgresBlobStore(pool);
  });
  afterAll(async()=>{await pool?.end();});

  it('persists observation → Agent review → record-only disposition and reopens exact receipts',async()=>{
    expect(RUN_DISPOSITION_SCHEMA_REF.revision).toBe('2');
    const owner=new WorkflowSpaceService(pool,blobs,{id:'observation-test-owner',kind:'human'});
    const space=await owner.createSpace({id:`external-agent-test-${randomUUID()}`,purpose:'Isolated Agent observation regression'});
    const [schema]=await owner.registerSchemas(space.id,[{namespace:'test/external-agent-output',revision:'1',dialect:JSON_SCHEMA_DIALECT,
      schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]);
    const ref={namespace:schema!.namespace,revision:schema!.revision,hash:schema!.hash};
    const storage:StorageContractDraft={workflowVersion:'v1',nodes:{research:{actorKinds:['agent'],
      inputs:{source:{schema:ref,states:['imported']}},outputs:{notes:{schema:ref,requiredInputs:['source'],appendVersions:false,initialState:'candidate'}},
      actions:['readBoundInput','appendOutputVersion']},author:{actorKinds:['agent'],
      inputs:{source:{schema:ref,states:['imported']}},outputs:{draft:{schema:ref,requiredInputs:['source'],appendVersions:false,initialState:'candidate'}},
      actions:['readBoundInput','appendOutputVersion']}},stateRules:[]};
    await owner.publishWorkflow(space.id,{id:'v1',revision:'1',changeReason:'Fixture',config:{},entrypoints:{content:{workflowId:'test.external-agent',
      codeRevision:'fixture',storageContract:storage,process:{revision:'1',nodes:[
        {id:'research',kind:'agent',storageNodeId:'research',inputs:{source:{slot:'source'}},outputs:{notes:{slot:'notes'}}},
        {id:'author',kind:'agent',storageNodeId:'author',inputs:{source:{slot:'source'}},outputs:{draft:{slot:'draft'}}}],
        edges:[],results:[{role:'primary',nodeId:'author',outputPort:'draft'}]}}}});
    const source=await owner.importAsset(space.id,{schema:ref,payload:{text:'Source'},description:'Fixture source',idempotencyKey:'source'});
    await owner.createCase(space.id,{id:'case-1',title:'Fixture',objective:'Test observation',constraints:[]});
    const manifest=await owner.freezeInputs(space.id,'case-1',{source:source.id});
    const run=await owner.startRun(space.id,{workflowVersionId:'v1',entrypoint:'content',inputManifestId:manifest.id,idempotencyKey:'run'});
    const research=await owner.startNode(space.id,{runId:run.runId,nodeId:'research',key:'research-1',inputs:{source:source.id},
      producer:'agent',instructions:'Fixture only; no model call',effectiveConfig:{},process:{nodeId:'research',round:1}});
    await owner.recordSessionEvent(space.id,research.id,'research-producer-thread','trace',{type:'agent.completed',data:{threadId:'research-producer-thread'}});
    const researchAsset=(await (await owner.nodeClient(space.id,research.id)).submit({idempotencyKey:'research-publish',
      outputs:[{slot:'notes',payload:{text:'Verified research'},dependencySlots:['source']}]})).versions[0]!;
    const context=await owner.startNode(space.id,{runId:run.runId,nodeId:'author',key:'author-1',inputs:{source:source.id},
      producer:'agent',instructions:'Fixture only; no model call',effectiveConfig:{},process:{nodeId:'author',round:1}});
    await owner.recordSessionEvent(space.id,context.id,'producer-thread','trace',{type:'agent.completed',data:{threadId:'producer-thread'}});
    const invalidOutput={text:42};
    await expect(owner.completeObservedAgent(space.id,context.id,invalidOutput)).rejects.toThrow();
    const ledger=new PostgresWorkflowRunStore(pool,{workspaceId:space.id});
    await ledger.updateRun(run.runId,{state:'failed',error:'Fixture invalid output'});
    await ledger.appendEvent({runId:run.runId,type:'workflow.failed',data:{error:'Fixture invalid output'}});
    const process=await owner.process(space.id,run.runId);
    const occurrence=process.occurrences.find(item=>item.contextIds.includes(context.id));
    expect(occurrence?.state).toBe('failed');
    expect(occurrence?.outputBindings).toEqual([]);
    const events=(await owner.sessionEvents(space.id,context.sessionId,0,100)).items;
    const event=events.find(item=>item.kind==='message'&&(item.body as {role?:string}).role==='assistant');
    expect(event).toBeTruthy();
    const target:SavedResponseTarget={runId:run.runId,occurrenceId:occurrence!.id,stepRunId:context.stepRunId,attemptId:context.attemptId,
      sessionId:context.sessionId,eventId:event!.id,eventSeq:event!.seq,outputHash:await artifactPayloadSha256(invalidOutput)};
    await createExternalAgentObservationStore(owner).ensure(space.id);
    await createRunDispositionStore(owner).ensure(space.id);
    await owner.grant(space.id,'agent-service-member','operator');
    const principal={id:'agent-service-member',kind:'service' as const,externalAgent:{id:'codex-judge',sessionId:'independent-codex-thread'}};
    const agent=new WorkflowSpaceService(pool,blobs,principal);
    await expect(agent.observeSavedResponseTarget(space.id,{...target,outputHash:'wrong'})).rejects.toThrow('hash mismatch');
    const observed=await agent.observeSavedResponseTarget(space.id,target);
    expect(observed.output).toEqual(invalidOutput);
    expect(observed.receipt).toMatchObject({target,observer:{id:'codex-judge',sessionId:'independent-codex-thread'},
      producerNativeSessionId:'producer-thread',delivery:'saved-response-read'});
    const review:ReviewDraft={id:'agent-review-1',runId:run.runId,assetVersionIds:[],responseTarget:target,
      observationReceiptId:observed.receipt.id,evidencePointers:['/text'],standard:{id:'fixture',revision:'1',content:'Four questions'},
      judge:{kind:'agent',id:'codex-judge',sessionId:'independent-codex-thread'},evidence:[],
      answers:{good:'Evidence saved',bad:'Wrong schema',improvement:'Correct output shape',unresolved:'Model quality not tested'}};
    await expect(agent.recordReview(space.id,{...review,id:'missing-receipt',observationReceiptId:undefined})).rejects.toThrow('observation receipt');
    expect((await agent.recordReview(space.id,review)).judge.kind).toBe('agent');
    const humanReview=await owner.recordReview(space.id,{...review,id:'human-review-1',judge:{kind:'human',id:'observation-test-owner'},observationReceiptId:undefined});
    const dispositionInput={runId:run.runId,reviewIds:[review.id],action:'revise' as const,reason:'Correct schema mismatch',
      unknowns:['Will a later run meet the standard?'],evidenceRefs:[{kind:'response' as const,target,pointer:'/text'}],
      expectedRevisionId:null,idempotencyKey:'decision-1',observationReceiptId:observed.receipt.id};
    const disposition=await createRunDispositionStore(agent).save(space.id,dispositionInput);
    expect(disposition).toMatchObject({author:{kind:'agent',id:'codex-judge',sessionId:'independent-codex-thread'},confirmation:'unconfirmed'});
    expect(disposition.observationReceiptIds).toEqual([observed.receipt.id]);
    const assetTarget={runId:run.runId,assetVersionId:researchAsset.id,payloadHash:researchAsset.payloadHash};
    await expect(agent.observePublishedAsset(space.id,{...assetTarget,payloadHash:'wrong'})).rejects.toThrow('hash mismatch');
    await expect(agent.observePublishedAsset(space.id,{runId:run.runId,assetVersionId:source.id,payloadHash:source.payloadHash}))
      .rejects.toThrow('node output');
    const assetObserved=await agent.observePublishedAsset(space.id,assetTarget);
    expect(assetObserved.asset.payload).toEqual({text:'Verified research'});
    expect(assetObserved.receipt).toMatchObject({target:assetTarget,source:researchAsset.source,
      producerNativeSessionIds:['research-producer-thread'],delivery:'published-asset-read'});
    const assetReview:ReviewDraft={id:'agent-asset-review-1',runId:run.runId,assetVersionIds:[researchAsset.id],
      observationReceiptId:assetObserved.receipt.id,standard:{id:'fixture',revision:'1',content:'Research quality'},
      judge:{kind:'agent',id:'codex-judge',sessionId:'independent-codex-thread'},evidence:[],
      answers:{good:'Source noted',bad:'Limited evidence',improvement:'Add citations',unresolved:'No model-quality claim'}};
    expect((await agent.recordReview(space.id,assetReview)).assetVersionIds).toEqual([researchAsset.id]);
    await expect(agent.recordReview(space.id,{...assetReview,id:'wrong-asset-receipt',observationReceiptId:observed.receipt.id}))
      .rejects.toThrow('asset review identity or observed target mismatch');
    const second=await createRunDispositionStore(agent).save(space.id,{...dispositionInput,
      expectedRevisionId:disposition.id,idempotencyKey:'decision-2',reviewIds:[review.id,assetReview.id],
      evidenceRefs:[{kind:'response',target,pointer:'/text'},{kind:'asset',assetVersionId:researchAsset.id,pointer:'/text'}]});
    expect(second.observationReceiptIds).toEqual([observed.receipt.id,assetObserved.receipt.id]);
    expect(second.previousRevisionId).toBe(disposition.id);
    expect((await owner.readAsset(space.id,second.id)).dependencies)
      .toEqual([disposition.id,observed.receipt.id,assetObserved.receipt.id]);
    await expect(createRunDispositionStore(agent).save(space.id,{...dispositionInput,reviewIds:[humanReview.id],idempotencyKey:'not-agent-review'}))
      .rejects.toThrow('own observed review');
    const reopened=new WorkflowSpaceService(pool,blobs,principal);
    expect((await reopened.readExternalAgentObservation(space.id,observed.receipt.id)).target).toEqual(target);
    expect((await reopened.readReview(space.id,review.id)).observationReceiptId).toBe(observed.receipt.id);
    expect((await reopened.readExternalAgentObservation(space.id,assetObserved.receipt.id)).target).toEqual(assetTarget);
    expect((await createRunDispositionStore(reopened).list(space.id,run.runId)).map(item=>item.id)).toEqual([disposition.id,second.id]);
    expect((await createRunDispositionStore(reopened).read(space.id,disposition.id)).observationReceiptIds).toEqual([observed.receipt.id]);
    expect((await createRunDispositionStore(reopened).current(space.id,run.runId))?.observationReceiptIds)
      .toEqual([observed.receipt.id,assetObserved.receipt.id]);
    expect((await reopened.observeSavedResponseTarget(space.id,target)).receipt.id).toBe(observed.receipt.id);
    expect((await reopened.recordReview(space.id,review)).id).toBe(review.id);
    expect((await createRunDispositionStore(reopened).save(space.id,dispositionInput)).id).toBe(disposition.id);
    await expect(owner.recordReview(space.id,{...review,id:'forged-by-human'})).rejects.toThrow('credential required');
    const self=new WorkflowSpaceService(pool,blobs,{...principal,externalAgent:{id:'codex-judge',sessionId:'producer-thread'}});
    await expect(self.observeSavedResponseTarget(space.id,target)).rejects.toThrow('independent');
    const researchSelf=new WorkflowSpaceService(pool,blobs,{...principal,externalAgent:{id:'codex-judge',sessionId:'research-producer-thread'}});
    await expect(researchSelf.observePublishedAsset(space.id,assetTarget)).rejects.toThrow('independent');
    const other=new WorkflowSpaceService(pool,blobs,{...principal,externalAgent:{id:'other-agent',sessionId:'other-thread'}});
    await expect(other.recordReview(space.id,{...assetReview,id:'cross-actor-review'})).rejects.toThrow('credential or run mismatch');
  });
});
