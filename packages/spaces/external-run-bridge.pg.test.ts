import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {artifactPayloadSha256,workflowFingerprint} from '@signal-room/workflow';
import {PostgresWorkflowRunStore} from '@signal-room/workflow-postgres';
import {JSON_SCHEMA_DIALECT} from '@signal-room/workflow-space-contracts';
import {PostgresBlobStore} from './blob-store.js';
import {migrateWorkflowSpaces} from './migration.js';
import {WorkflowSpaceService} from './service.js';
import {createExternalAgentObservationStore} from './external-agent-observation.js';

const url=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;

suite('external native execution bridge (isolated PostgreSQL)',()=>{
  let pool:Pool;
  beforeAll(async()=>{pool=new Pool({connectionString:url!,max:8});await migrateWorkflowSpaces(pool);});
  afterAll(async()=>{await pool?.end();});

  it('prebinds a running native root, incrementally syncs exact children/evidence, and observes its asset',async()=>{
    const sourceWorkspaceId=`external-${randomUUID()}`,ownerId=`owner-${randomUUID()}`;
    const blobs=new PostgresBlobStore(pool);
    const service=new WorkflowSpaceService(pool,blobs,{id:ownerId,kind:'human'},
      {historicalSourceWorkspaceIds:[sourceWorkspaceId]});
    const space=await service.createSpace({purpose:'External bridge fixture'});
    const [schema]=await service.registerSchemas(space.id,[{namespace:`test/external-${randomUUID()}`,revision:'1',
      dialect:JSON_SCHEMA_DIALECT,schema:{$schema:JSON_SCHEMA_DIALECT,type:'object'}}]);
    const ref={namespace:schema!.namespace,revision:schema!.revision,hash:schema!.hash};
    await service.publishWorkflow(space.id,{id:'current-v1',revision:'1',changeReason:'Native external identity fixture',config:{declaredModel:'test-only'},
      entrypoints:{main:{workflowId:'native.workflow',codeRevision:'1',storageContract:{workflowVersion:'current-v1',
        nodes:{work:{actorKinds:['program'],inputs:{},outputs:{out:{schema:ref,requiredInputs:[],appendVersions:false,initialState:'candidate'}},
          actions:['appendOutputVersion']}},stateRules:[]}}}});
    await service.createCase(space.id,{id:'case',title:'External execution',objective:'Track exact native run',constraints:[]});
    const manifest=await service.freezeInputs(space.id,'case',{});
    const source=new PostgresWorkflowRunStore(pool,{workspaceId:sourceWorkspaceId});
    const alreadyFinished=await source.createRun({workflowId:'native.workflow',workflowRevision:'1',inputFingerprint:'old',state:'succeeded'});
    const bind=(runId:string)=>({runId,workflowVersionId:'current-v1',entrypoint:'main',inputManifestId:manifest.id});
    await expect(service.bindExternalRun(space.id,{sourceWorkspaceId,runs:[bind(alreadyFinished.id)]}))
      .rejects.toThrow('must be linked while native execution is active');
    const alreadyStarted=await source.createRun({workflowId:'native.workflow',workflowRevision:'1',inputFingerprint:'late',state:'running'});
    await source.appendEvent({runId:alreadyStarted.id,type:'native.started'});
    await expect(service.bindExternalRun(space.id,{sourceWorkspaceId,runs:[bind(alreadyStarted.id)]}))
      .rejects.toThrow('must be linked before native work begins');
    const root=await source.createRun({workflowId:'native.workflow',workflowRevision:'1',inputFingerprint:'native',state:'running'});
    const initial=await service.bindExternalRun(space.id,{sourceWorkspaceId,runs:[bind(root.id)]});
    expect(initial).toMatchObject({runId:root.id,caseId:'case',executionMode:'external-host',externalSource:{workspaceId:sourceWorkspaceId,runId:root.id}});
    expect(await (await service.runtimeEvidence(space.id)).getRun(root.id)).toEqual(root);
    const rootStep=await source.createStep({runId:root.id,key:'work',kind:'task',workflowId:'native.workflow',workflowRevision:'1',
      inputFingerprint:'native',configFingerprint:'native',state:'running',validation:'pending'});
    const rootAttempt=await source.createAttempt({runId:root.id,stepRunId:rootStep.id,state:'running'});
    await source.appendEvent({runId:root.id,stepRunId:rootStep.id,attemptId:rootAttempt.id,type:'native.started',data:{source:'real-host'}});
    await source.appendEvent({runId:root.id,stepRunId:rootStep.id,attemptId:rootAttempt.id,type:'siwc.response_headers',
      data:{turn:4,requestAttempt:1,status:200,requestId:'private-request-id',headers:{authorization:'Bearer secret'}}});
    await source.appendEvent({runId:root.id,stepRunId:rootStep.id,attemptId:rootAttempt.id,type:'siwc.response',
      data:{turn:4,outputItems:1,visibleOutput:[{type:'function_call',name:'review_tool',arguments:'private-arguments'}]}});
    await source.appendEvent({runId:root.id,stepRunId:rootStep.id,attemptId:rootAttempt.id,type:'siwc.transport_error',
      data:{turn:5,requestAttempt:2,phase:'fetch',status:503,errorName:'TypeError',causeCode:'ECONNRESET',requestId:'private-request-id',message:'private-error'}});
    await service.syncExternalRuns(space.id,{sourceWorkspaceId,runs:[bind(root.id)]});
    expect((await (await service.runtimeEvidence(space.id)).listEvents(root.id)).map(event=>event.type)).toContain('native.started');
    const firstPage=await service.nativeRunEvents(space.id,root.id,0,2);
    expect(firstPage).toMatchObject({runId:root.id,executionMode:'external-host',hasMore:true,sanitized:true,children:[]});
    const secondPage=await service.nativeRunEvents(space.id,root.id,firstPage.nextCursor!,2);
    expect(secondPage.items[0]).toMatchObject({type:'siwc.response',turn:4,response:{hasText:false,hasFinalText:false,output:[{type:'function_call',name:'review_tool'}]}});
    expect(secondPage.items[1]).toMatchObject({type:'siwc.transport_error',turn:5,requestAttempt:2,httpStatus:503,
      transport:{phase:'fetch',errorName:'TypeError',causeCode:'ECONNRESET'}});
    expect(JSON.stringify(secondPage)).not.toMatch(/private-|Bearer secret/u);
    const child=await source.createRun({workflowId:'native.workflow',workflowRevision:'1',inputFingerprint:'child',state:'running',
      parentRunId:root.id,parentStepRunId:rootStep.id});
    const childStep=await source.createStep({runId:child.id,key:'work',kind:'task',workflowId:'native.workflow',workflowRevision:'1',
      inputFingerprint:'child',configFingerprint:'native',state:'running',validation:'pending'});
    const childAttempt=await source.createAttempt({runId:child.id,stepRunId:childStep.id,state:'running'});
    const payload={text:'native result'},artifact=await source.publishArtifact({type:'result',schemaVersion:'1',revision:'1',
      sha256:await artifactPayloadSha256(payload),uri:'artifact://native-result',payload,
      producedBy:{workflowRunId:child.id,stepRunId:childStep.id,attemptId:childAttempt.id},dependsOn:[],validation:'valid',review:'pending'});
    await source.updateAttempt(childAttempt.id,{state:'succeeded'});
    await source.updateStep(childStep.id,{state:'succeeded',validation:'valid'});
    await source.updateRun(child.id,{state:'succeeded'});
    await source.updateAttempt(rootAttempt.id,{state:'succeeded'});
    await source.updateStep(rootStep.id,{state:'succeeded',validation:'valid'});
    await source.updateRun(root.id,{state:'succeeded'});
    const request={sourceWorkspaceId,runs:[bind(child.id),bind(root.id)]};
    expect(await service.syncExternalRuns(space.id,request)).toHaveLength(2);
    expect(await service.syncExternalRuns(space.id,request)).toHaveLength(2);
    expect((await service.nativeRunEvents(space.id,root.id)).children).toEqual([{runId:child.id,workflowId:'native.workflow',state:'succeeded',parentStepRunId:rootStep.id,binding:'bound'}]);
    const evidence=await service.runtimeEvidence(space.id);
    expect(await evidence.getRun(root.id)).toEqual(await source.getRun(root.id));
    expect(await evidence.listArtifacts(child.id)).toEqual([artifact]);
    const published=await service.publishExternalArtifact(space.id,{artifactId:artifact.id,schema:ref,idempotencyKey:'native-result'});
    expect(published.source).toMatchObject({kind:'external-artifact',runId:child.id,artifactId:artifact.id,
      sourceWorkspaceId,originalSha256:artifact.sha256});
    expect((await service.runAssets(space.id,child.id)).map(asset=>asset.id)).toContain(published.id);
    await createExternalAgentObservationStore(service).ensure(space.id);
    const observerId=`observer-${randomUUID()}`;await service.grant(space.id,observerId,'operator');
    const observer=new WorkflowSpaceService(pool,blobs,{id:observerId,kind:'service',
      externalAgent:{id:'independent-reviewer',sessionId:`review-${randomUUID()}`}});
    const observed=await observer.observePublishedAsset(space.id,{runId:child.id,assetVersionId:published.id,payloadHash:published.payloadHash});
    expect(observed.receipt.source.kind).toBe('external-artifact');
    expect((await observer.readExternalAgentObservation(space.id,observed.receipt.id)).target.assetVersionId).toBe(published.id);
    const review=await observer.recordReview(space.id,{id:`review-${randomUUID()}`,runId:child.id,assetVersionIds:[published.id],
      standard:{id:'native-standard',revision:'1',content:'Inspect exact native evidence'},judge:{kind:'agent',id:'independent-reviewer',sessionId:observed.receipt.observer.sessionId},
      observationReceiptId:observed.receipt.id,evidence:[],answers:{good:'Exact native result',bad:'No business assessment',improvement:'Assess content',unresolved:'Source quality'}});
    expect(review.assetVersionIds).toEqual([published.id]);
    await expect(service.syncExternalRuns(space.id,{...request,runs:[{...bind(root.id),effectiveConfig:{changed:true}}]})).rejects.toThrow('conflicts');
    await expect(new WorkflowSpaceService(pool,blobs,{id:ownerId,kind:'human'}).syncExternalRuns(space.id,request)).rejects.toThrow('not authorized');
    await pool.query("UPDATE aw_events SET document=jsonb_set(document,'{type}','\"tampered\"'::jsonb) WHERE workspace_id=$1 AND id=$2",
      [space.id,(await source.listEvents(root.id))[0]!.id]);
    await expect(service.syncExternalRuns(space.id,request)).rejects.toThrow('diverged from native source');
  },20_000);

  it('links only a completed program run that directly produced the bound root native input',async()=>{
    const sourceWorkspaceId=`external-input-${randomUUID()}`,ownerId=`owner-${randomUUID()}`;
    const service=new WorkflowSpaceService(pool,new PostgresBlobStore(pool),{id:ownerId,kind:'human'},
      {historicalSourceWorkspaceIds:[sourceWorkspaceId]});
    const space=await service.createSpace({purpose:'Exact native input producer fixture'});
    const [schema]=await service.registerSchemas(space.id,[{namespace:`test/native-input-${randomUUID()}`,revision:'1',
      dialect:JSON_SCHEMA_DIALECT,schema:{$schema:JSON_SCHEMA_DIALECT,type:'object'}}]);
    const ref={namespace:schema!.namespace,revision:schema!.revision,hash:schema!.hash};
    for(const [id,workflowId] of [['root-v1','native.paid'],['prep-v1','native.prepare']] as const)
      await service.publishWorkflow(space.id,{id,revision:'1',changeReason:'Exact external identity',config:{},
        entrypoints:{main:{workflowId,codeRevision:'1',storageContract:{workflowVersion:id,
          nodes:{work:{actorKinds:['program'],inputs:{},outputs:{},actions:[]}},stateRules:[]}}}});
    await service.createCase(space.id,{id:'case',title:'Current execution',objective:'Exact input producers',constraints:[]});
    const source=new PostgresWorkflowRunStore(pool,{workspaceId:sourceWorkspaceId});
    const prep=await source.createRun({workflowId:'native.prepare',workflowRevision:'1',inputFingerprint:'prepare',state:'running'});
    const step=await source.createStep({runId:prep.id,key:'produce-evidence',kind:'task',workflowId:'native.prepare',
      workflowRevision:'1',inputFingerprint:'prepare',configFingerprint:'prepare',state:'running',validation:'pending'});
    const attempt=await source.createAttempt({runId:prep.id,stepRunId:step.id,state:'running'});
    const payload={exact:'evidence'},evidence=await source.publishArtifact({type:'evidence',schemaVersion:'1',revision:'1',
      sha256:await artifactPayloadSha256(payload),uri:'artifact://exact-input',payload,
      producedBy:{workflowRunId:prep.id,stepRunId:step.id,attemptId:attempt.id},dependsOn:[],validation:'valid',review:'not_applicable'});
    await source.updateAttempt(attempt.id,{state:'succeeded'});await source.updateStep(step.id,{state:'succeeded',validation:'valid'});
    await source.updateRun(prep.id,{state:'succeeded'});
    const nativeInput={evidence};
    const inputAsset=await service.importAsset(space.id,{schema:ref,payload:nativeInput,description:'Exact source input',idempotencyKey:'exact-source-input'});
    const manifest=await service.freezeInputs(space.id,'case',{nativeRunInput:inputAsset.id});
    const root=await source.createRun({workflowId:'native.paid',workflowRevision:'1',
      inputFingerprint:workflowFingerprint(nativeInput),state:'running'});
    const bind=(runId:string,workflowVersionId:string)=>({runId,workflowVersionId,entrypoint:'main',inputManifestId:manifest.id});
    await service.bindExternalRun(space.id,{sourceWorkspaceId,runs:[bind(root.id,'root-v1')]});
    const wrongRoot=await source.createRun({workflowId:'native.paid',workflowRevision:'1',inputFingerprint:'wrong-input',state:'running'});
    await service.bindExternalRun(space.id,{sourceWorkspaceId,runs:[bind(wrongRoot.id,'root-v1')]});
    await expect(service.syncExternalRuns(space.id,{sourceWorkspaceId,
      runs:[{...bind(prep.id,'prep-v1'),supportingOf:wrongRoot.id}]}))
      .rejects.toThrow('native input fingerprint mismatch');
    await expect(service.syncExternalRuns(space.id,{sourceWorkspaceId,runs:[bind(prep.id,'prep-v1')]}))
      .rejects.toThrow('must be linked while native execution is active');
    const supporting={...bind(prep.id,'prep-v1'),supportingOf:root.id};
    const linked=await service.syncExternalRuns(space.id,{sourceWorkspaceId,runs:[supporting]});
    expect(linked[0]?.externalSource).toMatchObject({workspaceId:sourceWorkspaceId,runId:prep.id,inputProducerForRunId:root.id});
    expect((await service.syncExternalRuns(space.id,{sourceWorkspaceId,runs:[bind(prep.id,'prep-v1')]}))[0])
      .toEqual(linked[0]);
    expect((await (await service.runtimeEvidence(space.id)).listArtifacts(prep.id))[0]?.id).toBe(evidence.id);
    const unrelated=await source.createRun({workflowId:'native.prepare',workflowRevision:'1',inputFingerprint:'other',state:'succeeded'});
    await expect(service.syncExternalRuns(space.id,{sourceWorkspaceId,runs:[{...bind(unrelated.id,'prep-v1'),supportingOf:root.id}]}))
      .rejects.toThrow('not an exact candidate or evidence source');
    await expect(service.syncExternalRuns(space.id,{sourceWorkspaceId,runs:[{...bind(unrelated.id,'prep-v1'),supportingOf:'unknown-root'}]}))
      .rejects.toThrow('already bound execution');
  },20_000);
});
