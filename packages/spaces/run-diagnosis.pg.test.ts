import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {beforeAll,afterAll,describe,expect,it} from 'vitest';
import {artifactPayloadSha256} from '@signal-room/workflow';
import {PostgresWorkflowRunStore} from '@signal-room/workflow-postgres';
import {JSON_SCHEMA_DIALECT,type StorageContractDraft} from '@signal-room/workflow-space-contracts';
import {PostgresBlobStore} from './blob-store.js';
import {migrateWorkflowSpaces} from './migration.js';
import {WorkflowSpaceService} from './service.js';
import {createExternalAgentObservationStore} from './external-agent-observation.js';
import {createRunDispositionStore} from './run-disposition.js';
import {createRunDiagnosisStore,type RunDiagnosisSave} from './run-diagnosis.js';
import type {ReviewDraft,SavedResponseTarget} from './types.js';

const databaseUrl=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=databaseUrl?describe:describe.skip;

suite('run diagnosis revision and exact evidence (isolated PostgreSQL database)',()=>{
  let pool:Pool;
  let blobs:PostgresBlobStore;
  beforeAll(async()=>{pool=new Pool({connectionString:databaseUrl!,max:12});await migrateWorkflowSpaces(pool);blobs=new PostgresBlobStore(pool);});
  afterAll(async()=>{await pool?.end();});

  it('preserves two reviewed targets and a disposition through diagnosis CAS history without executing a model',async()=>{
    const owner=new WorkflowSpaceService(pool,blobs,{id:'diagnosis-test-owner',kind:'human'});
    const space=await owner.createSpace({id:`run-diagnosis-test-${randomUUID()}`,purpose:'Isolated diagnosis regression'});
    const [schema]=await owner.registerSchemas(space.id,[{namespace:'test/diagnosis-output',revision:'1',dialect:JSON_SCHEMA_DIALECT,
      schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]);
    const ref={namespace:schema!.namespace,revision:schema!.revision,hash:schema!.hash};
    const storage:StorageContractDraft={workflowVersion:'v1',nodes:{research:{actorKinds:['agent'],
      inputs:{source:{schema:ref,states:['imported']}},outputs:{notes:{schema:ref,requiredInputs:['source'],appendVersions:false,initialState:'candidate'}},
      actions:['readBoundInput','appendOutputVersion']},author:{actorKinds:['agent'],
      inputs:{source:{schema:ref,states:['imported']}},outputs:{draft:{schema:ref,requiredInputs:['source'],appendVersions:false,initialState:'candidate'}},
      actions:['readBoundInput','appendOutputVersion']}},stateRules:[]};
    await owner.publishWorkflow(space.id,{id:'v1',revision:'1',changeReason:'Fixture',config:{},entrypoints:{content:{workflowId:'test.diagnosis',
      codeRevision:'fixture',storageContract:storage,process:{revision:'1',nodes:[
        {id:'research',kind:'agent',storageNodeId:'research',inputs:{source:{slot:'source'}},outputs:{notes:{slot:'notes'}}},
        {id:'author',kind:'agent',storageNodeId:'author',inputs:{source:{slot:'source'}},outputs:{draft:{slot:'draft'}}}],
        edges:[],results:[{role:'primary',nodeId:'author',outputPort:'draft'}]}}}});
    const source=await owner.importAsset(space.id,{schema:ref,payload:{text:'Frozen input'},description:'Fixture input',idempotencyKey:'input'});
    await owner.createCase(space.id,{id:'case-1',title:'Fixture',objective:'Observe diagnosis',constraints:[]});
    const manifest=await owner.freezeInputs(space.id,'case-1',{source:source.id});
    const run=await owner.startRun(space.id,{workflowVersionId:'v1',entrypoint:'content',inputManifestId:manifest.id,idempotencyKey:'run'});
    const research=await owner.startNode(space.id,{runId:run.runId,nodeId:'research',key:'research-1',inputs:{source:source.id},
      producer:'agent',instructions:'Fixture; no model',effectiveConfig:{},process:{nodeId:'research',round:1}});
    await owner.recordSessionEvent(space.id,research.id,'research-native-thread','trace',{type:'research.observed'});
    const researchAsset=(await (await owner.nodeClient(space.id,research.id)).submit({idempotencyKey:'notes',
      outputs:[{slot:'notes',payload:{text:'Research note'},dependencySlots:['source']}]})).versions[0]!;
    const otherRun=await owner.startRun(space.id,{workflowVersionId:'v1',entrypoint:'content',inputManifestId:manifest.id,idempotencyKey:'other-run'});
    const otherResearch=await owner.startNode(space.id,{runId:otherRun.runId,nodeId:'research',key:'other-research',inputs:{source:source.id},
      producer:'agent',instructions:'Fixture; no model',effectiveConfig:{},process:{nodeId:'research',round:1}});
    const otherAsset=(await (await owner.nodeClient(space.id,otherResearch.id)).submit({idempotencyKey:'other-notes',
      outputs:[{slot:'notes',payload:{text:'Other run note'},dependencySlots:['source']}]})).versions[0]!;
    const author=await owner.startNode(space.id,{runId:run.runId,nodeId:'author',key:'author-1',inputs:{source:source.id},
      producer:'agent',instructions:'Fixture; no model',effectiveConfig:{},process:{nodeId:'author',round:1}});
    await owner.recordSessionEvent(space.id,author.id,'author-native-thread','trace',{type:'author.observed'});
    const invalidOutput={text:42};
    await expect(owner.completeObservedAgent(space.id,author.id,invalidOutput)).rejects.toThrow();
    const ledger=new PostgresWorkflowRunStore(pool,{workspaceId:space.id});
    await ledger.updateRun(run.runId,{state:'failed',error:'Fixture invalid output'});
    await ledger.appendEvent({runId:run.runId,type:'workflow.failed',data:{error:'Fixture invalid output'}});
    const process=await owner.process(space.id,run.runId);
    const occurrence=process.occurrences.find(item=>item.contextIds.includes(author.id))!;
    const event=(await owner.sessionEvents(space.id,author.sessionId,0,100)).items.find(item=>
      item.kind==='message'&&(item.body as {role?:string}).role==='assistant')!;
    const responseTarget:SavedResponseTarget={runId:run.runId,occurrenceId:occurrence.id,stepRunId:author.stepRunId,
      attemptId:author.attemptId,sessionId:author.sessionId,eventId:event.id,eventSeq:event.seq,
      outputHash:await artifactPayloadSha256(invalidOutput)};
    await createExternalAgentObservationStore(owner).ensure(space.id);
    await createRunDispositionStore(owner).ensure(space.id);
    const diagnosisStore=createRunDiagnosisStore(owner);
    await diagnosisStore.ensure(space.id);
    await owner.grant(space.id,'diagnosis-agent-service','operator');
    const principal={id:'diagnosis-agent-service',kind:'service' as const,
      externalAgent:{id:'codex-diagnostician',sessionId:'independent-codex-thread'}};
    const agent=new WorkflowSpaceService(pool,blobs,principal);
    const responseObserved=await agent.observeSavedResponseTarget(space.id,responseTarget);
    const assetObserved=await agent.observePublishedAsset(space.id,{runId:run.runId,assetVersionId:researchAsset.id,payloadHash:researchAsset.payloadHash});
    const answers={good:'Saved evidence',bad:'Insufficient quality',improvement:'Revise',unresolved:'Causal account remains open'};
    const common={runId:run.runId,standard:{id:'fixture-standard',revision:'1',content:'Four questions'},
      judge:{kind:'agent' as const,id:'codex-diagnostician',sessionId:'independent-codex-thread'},evidence:[],answers};
    const responseReview:ReviewDraft={...common,id:'author-review',assetVersionIds:[],responseTarget,
      observationReceiptId:responseObserved.receipt.id};
    const assetReview:ReviewDraft={...common,id:'research-review',assetVersionIds:[researchAsset.id],
      observationReceiptId:assetObserved.receipt.id};
    await agent.recordReview(space.id,responseReview);
    await agent.recordReview(space.id,assetReview);
    const disposition=await createRunDispositionStore(agent).save(space.id,{runId:run.runId,
      reviewIds:[responseReview.id,assetReview.id],action:'revise',reason:'Investigate both quality findings',unknowns:['Root cause'],
      evidenceRefs:[{kind:'asset',assetVersionId:researchAsset.id},{kind:'response',target:responseTarget}],
      expectedRevisionId:null,idempotencyKey:'disposition-1',observationReceiptId:responseObserved.receipt.id});
    const issue={id:'citation-issue',title:'Citation fails',expected:'Valid publication',observed:'Failed output',
      evidenceRefs:[{kind:'response' as const,target:responseTarget,pointer:'/text'},
        {kind:'review' as const,reviewId:responseReview.id,pointer:'/answers/bad'},
        {kind:'trace' as const,sessionId:author.sessionId,eventId:event.id,eventSeq:event.seq,pointer:'/output/text'}],
      hypotheses:[{id:'handoff-hypothesis',category:'handoff' as const,explanation:'Evidence handoff lost detail',
        supportRefs:[{kind:'asset' as const,assetVersionId:researchAsset.id,payloadHash:researchAsset.payloadHash,pointer:'/text'}],
        counterRefs:[{kind:'inputs' as const,manifestId:manifest.id,payloadHash:manifest.hash,pointer:'/assets/source'}],
        unknowns:['Which instruction caused loss?'],discriminatingCheck:'Compare exact handed-off input'}],
      unknowns:['Failure category remains unconfirmed'],decision:{route:'change-method' as const,reason:'Test a bounded handoff change',nextCheck:'Inspect producer input'}};
    const candidateDraft={predecessorVersionId:'v1',issueIds:[issue.id],hypothesisIds:['handoff-hypothesis'],
      changes:[{target:'author input handoff',before:'Current handoff',after:'Include cited research evidence',reason:'Test lost-detail hypothesis'}],
      expectedBenefits:['Retain research evidence'],risks:['Longer context'],validationPlan:'Compare same frozen input',
      falsificationConditions:['No citation improvement'],conditions:['Deployment fingerprint must be checked']};
    const input:RunDiagnosisSave={runId:run.runId,reviewIds:[responseReview.id,assetReview.id],
      dispositionRevisionId:disposition.id,dispositionPayloadHash:disposition.payloadHash,
      issues:[issue],candidateDraft,expectedRevisionId:null,idempotencyKey:'diagnosis-1',observationReceiptId:responseObserved.receipt.id};
    const store=createRunDiagnosisStore(agent);
    await expect(store.save(space.id,{...input,dispositionPayloadHash:'wrong'})).rejects.toThrow('hash mismatch');
    await expect(store.save(space.id,{...input,issues:[{...issue,evidenceRefs:[{kind:'asset',assetVersionId:researchAsset.id,
      payloadHash:'wrong'}]}]})).rejects.toThrow('asset evidence hash mismatch');
    await expect(store.save(space.id,{...input,issues:[{...issue,evidenceRefs:[{kind:'asset',assetVersionId:otherAsset.id,
      payloadHash:otherAsset.payloadHash}]}]})).rejects.toThrow('outside the run');
    await expect(store.save(space.id,{...input,issues:[{...issue,evidenceRefs:[{kind:'trace',sessionId:author.sessionId,
      eventId:event.id,eventSeq:event.seq+1}]}]})).rejects.toThrow('Trace event');
    await expect(store.save(space.id,{...input,candidateDraft:{...candidateDraft,predecessorVersionId:'wrong'}}))
      .rejects.toThrow('predecessor');
    await expect(store.save(space.id,{...input,issues:[{...issue,decision:{route:'defer',reason:'Not ready'}}]}))
      .rejects.toThrow('change-method issue');
    await expect(store.save(space.id,{...input,issues:[{...issue,hypotheses:[{...issue.hypotheses[0]!,supportRefs:[]}]}]}))
      .rejects.toThrow('supporting evidence');
    await expect(store.save(space.id,{...input,candidateDraft:{...candidateDraft,changes:[{...candidateDraft.changes[0]!,after:'Current handoff'}]}}))
      .rejects.toThrow('must differ');
    const first=await store.save(space.id,input);
    expect(first).toMatchObject({workflowVersionId:'v1',previousRevisionId:null,
      author:{kind:'agent',id:'codex-diagnostician'},candidateStatus:'unregistered-unvalidated-unadopted'});
    expect((await owner.readAsset(space.id,first.id)).dependencies)
      .toEqual(expect.arrayContaining([disposition.id,responseObserved.receipt.id,assetObserved.receipt.id,researchAsset.id,source.id]));
    const second=await store.save(space.id,{...input,candidateDraft:undefined,issues:[{...issue,
      decision:{route:'defer',reason:'Need further evidence'}}],expectedRevisionId:first.id,idempotencyKey:'diagnosis-2'});
    expect(second.previousRevisionId).toBe(first.id);
    expect(second.candidateStatus).toBeUndefined();
    const {observationReceiptId:_agentReceipt,candidateDraft:_candidate,...humanBase}=input;
    const third=await createRunDiagnosisStore(owner).save(space.id,{...humanBase,issues:[{...issue,
      decision:{route:'no-change',reason:'Retain observations while checking the exact cause'}}],
      expectedRevisionId:second.id,idempotencyKey:'diagnosis-human-3'});
    expect(third.author).toEqual({id:'diagnosis-test-owner',kind:'human'});
    expect(third.previousRevisionId).toBe(second.id);
    await expect(store.save(space.id,{...input,expectedRevisionId:first.id,idempotencyKey:'stale'}))
      .rejects.toThrow('Asset version conflict');
    const reopened=createRunDiagnosisStore(new WorkflowSpaceService(pool,blobs,principal));
    expect((await reopened.list(space.id,run.runId)).map(item=>item.id)).toEqual([first.id,second.id,third.id]);
    expect((await reopened.read(space.id,first.id)).candidateDraft).toEqual(candidateDraft);
    expect((await reopened.read(space.id,first.id)).payloadHash).toBe(first.payloadHash);
    expect((await reopened.current(space.id,run.runId))?.id).toBe(third.id);
    expect((await reopened.save(space.id,input)).id).toBe(first.id);
    expect((await createRunDispositionStore(agent).read(space.id,disposition.id)).payloadHash).toBe(disposition.payloadHash);
    expect((await agent.readExternalAgentObservation(space.id,responseObserved.receipt.id)).target).toEqual(responseTarget);
    expect((await agent.readReview(space.id,assetReview.id)).observationReceiptId).toBe(assetObserved.receipt.id);
    const other=new WorkflowSpaceService(pool,blobs,{...principal,externalAgent:{id:'other-agent',sessionId:'other-thread'}});
    await expect(createRunDiagnosisStore(other).save(space.id,{...input,idempotencyKey:'other-agent'}))
      .rejects.toThrow('credential or run mismatch');
    const producer=new WorkflowSpaceService(pool,blobs,{...principal,externalAgent:{id:'producer',sessionId:'author-native-thread'}});
    await expect(createRunDiagnosisStore(producer).save(space.id,{...input,idempotencyKey:'producer'}))
      .rejects.toThrow('credential or run mismatch');
  },20_000);
});
