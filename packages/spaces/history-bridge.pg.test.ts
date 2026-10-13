import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {artifactPayloadSha256} from '@signal-room/workflow';
import {PostgresWorkflowRunStore} from '@signal-room/workflow-postgres';
import {JSON_SCHEMA_DIALECT} from '@signal-room/workflow-space-contracts';
import {PostgresBlobStore} from './blob-store.js';
import {migrateWorkflowSpaces} from './migration.js';
import {WorkflowSpaceService} from './service.js';
import {createExternalAgentObservationStore} from './external-agent-observation.js';

const url=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;

suite('historical ledger bridge (isolated PostgreSQL)',()=>{
  let pool:Pool;
  beforeAll(async()=>{pool=new Pool({connectionString:url!,max:8});await migrateWorkflowSpaces(pool);});
  afterAll(async()=>{await pool?.end();});

  it('copies a bounded parent/child set and exact cross-run artifacts, then safely replays',async()=>{
    const sourceWorkspaceId=`legacy-${randomUUID()}`;
    const ownerId=`owner-${randomUUID()}`;
    const blobs=new PostgresBlobStore(pool);
    const service=new WorkflowSpaceService(pool,blobs,{id:ownerId,kind:'human'},
      {historicalSourceWorkspaceIds:[sourceWorkspaceId]});
    const space=await service.createSpace({purpose:'Historical bridge fixture'});
    const [schema]=await service.registerSchemas(space.id,[{namespace:`test/history-${randomUUID()}`,revision:'1',
      dialect:JSON_SCHEMA_DIALECT,schema:{$schema:JSON_SCHEMA_DIALECT,type:'object'}}]);
    const ref={namespace:schema!.namespace,revision:schema!.revision,hash:schema!.hash};
    await service.publishWorkflow(space.id,{id:'legacy-v1',revision:'1',changeReason:'Historical identity fixture',config:{},
      entrypoints:{main:{workflowId:'legacy.workflow',codeRevision:'1',storageContract:{workflowVersion:'legacy-v1',
        nodes:{main:{actorKinds:['program'],inputs:{},outputs:{out:{schema:ref,requiredInputs:[],appendVersions:false,initialState:'candidate'}},
          actions:['appendOutputVersion']}},stateRules:[]}}}});
    await service.createCase(space.id,{id:'case',title:'History',objective:'Read exact evidence',constraints:[]});
    const manifest=await service.freezeInputs(space.id,'case',{});
    const source=new PostgresWorkflowRunStore(pool,{workspaceId:sourceWorkspaceId});
    const make=async(parentRunId?:string,parentStepRunId?:string)=>{
      const run=await source.createRun({workflowId:'legacy.workflow',workflowRevision:'1',inputFingerprint:'original',state:'running',
        ...(parentRunId?{parentRunId,parentStepRunId}:{})});
      const step=await source.createStep({runId:run.id,key:'work',kind:'task',workflowId:'legacy.workflow',workflowRevision:'1',
        inputFingerprint:'original',configFingerprint:'original',state:'running',validation:'pending'});
      const attempt=await source.createAttempt({runId:run.id,stepRunId:step.id,state:'running'});
      return {run,step,attempt};
    };
    const root=await make();
    const firstPayload={text:'source evidence'};
    const first=await source.publishArtifact({type:'evidence',schemaVersion:'1',revision:'1',
      sha256:await artifactPayloadSha256(firstPayload),uri:'artifact://historical-source',payload:firstPayload,
      producedBy:{workflowRunId:root.run.id,stepRunId:root.step.id,attemptId:root.attempt.id},
      dependsOn:[],validation:'valid',review:'pending'});
    const child=await make(root.run.id,root.step.id);
    const childPayload={text:'child result'};
    const second=await source.publishArtifact({type:'result',schemaVersion:'1',revision:'1',
      sha256:await artifactPayloadSha256(childPayload),uri:'artifact://historical-child',payload:childPayload,
      producedBy:{workflowRunId:child.run.id,stepRunId:child.step.id,attemptId:child.attempt.id},
      dependsOn:[{artifactId:first.id,revision:first.revision,sha256:first.sha256}],validation:'valid',review:'pending'});
    for(const item of [root,child]){
      await source.updateAttempt(item.attempt.id,{state:'succeeded'});
      await source.updateStep(item.step.id,{state:'succeeded',validation:'valid'});
      await source.appendEvent({runId:item.run.id,stepRunId:item.step.id,attemptId:item.attempt.id,type:'step.completed'});
      await source.updateRun(item.run.id,{state:'succeeded'});
    }
    const bindings=[child,root].map(item=>({runId:item.run.id,workflowVersionId:'legacy-v1',entrypoint:'main',inputManifestId:manifest.id}));
    const request={sourceWorkspaceId,runs:bindings};
    expect((await service.importHistoricalRuns(space.id,request)).every(binding=>binding.executionMode==='imported')).toBe(true);
    expect(await service.importHistoricalRuns(space.id,request)).toHaveLength(2);
    const evidence=await service.runtimeEvidence(space.id);
    expect(await evidence.getRun(child.run.id)).toEqual(await source.getRun(child.run.id));
    expect(await evidence.listSteps(child.run.id)).toEqual(await source.listSteps(child.run.id));
    expect(await evidence.listEvents(child.run.id)).toEqual(await source.listEvents(child.run.id));
    expect(await evidence.listArtifacts(child.run.id)).toEqual([second]);
    expect(await evidence.getArtifactPayload(second.id)).toEqual(childPayload);
    expect((await service.process(space.id,child.run.id)).unmappedStepIds).toContain(child.step.id);
    const published=await service.publishHistoricalArtifact(space.id,{artifactId:second.id,schema:ref,idempotencyKey:'publish-child'});
    expect(published.source).toMatchObject({kind:'historical-artifact',runId:child.run.id,artifactId:second.id,
      originalSha256:second.sha256,sourceWorkspaceId});
    expect(await service.publishHistoricalArtifact(space.id,{artifactId:second.id,schema:ref,idempotencyKey:'publish-child'})).toEqual(published);
    expect((await service.runAssets(space.id,child.run.id)).map(asset=>asset.id)).toContain(published.id);
    await createExternalAgentObservationStore(service).ensure(space.id);
    const observerId=`observer-${randomUUID()}`;
    await service.grant(space.id,observerId,'operator');
    const observer=new WorkflowSpaceService(pool,blobs,{id:observerId,kind:'service',
      externalAgent:{id:'independent-reviewer',sessionId:`review-session-${randomUUID()}`}});
    const observed=await observer.observePublishedAsset(space.id,{runId:child.run.id,assetVersionId:published.id,payloadHash:published.payloadHash});
    expect(observed.receipt.source.kind).toBe('historical-artifact');
    expect((await observer.readExternalAgentObservation(space.id,observed.receipt.id)).target.assetVersionId).toBe(published.id);
    const review=await observer.recordReview(space.id,{id:`review-${randomUUID()}`,runId:child.run.id,
      assetVersionIds:[published.id],standard:{id:'historical-standard',revision:'1',content:'Inspect exact evidence'},
      judge:{kind:'agent',id:'independent-reviewer',sessionId:observed.receipt.observer.sessionId},
      observationReceiptId:observed.receipt.id,evidence:[],answers:{good:'Readable original evidence',bad:'No business mapping',
        improvement:'Add retrospective mapping',unresolved:'Original session unavailable'}});
    expect(review.assetVersionIds).toEqual([published.id]);
    await expect(service.importHistoricalRuns(space.id,{...request,runs:[{...bindings[0]!,effectiveConfig:{changed:true}}]}))
      .rejects.toThrow('conflicts');
    const stranger=new WorkflowSpaceService(pool,blobs,{id:`other-${randomUUID()}`,kind:'human'},
      {historicalSourceWorkspaceIds:[sourceWorkspaceId]});
    await expect(stranger.importHistoricalRuns(space.id,request)).rejects.toThrow('Space access denied');
    const unauthorized=new WorkflowSpaceService(pool,blobs,{id:ownerId,kind:'human'});
    await expect(unauthorized.importHistoricalRuns(space.id,request)).rejects.toThrow('not authorized');
  },20_000);
});
