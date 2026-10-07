import { Pool } from 'pg';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { SchemaRegistry,publishStorageContract,JSON_SCHEMA_DIALECT,type SchemaRef,type StorageContractDraft } from '@signal-room/workflow-space-contracts';
import {runWorkflow,workflow,type StepRecord,type AttemptRecord,type WorkflowEvent} from '@signal-room/workflow';
import {createSpaceRuntime} from './runtime.js';
import { publishProcessContract,type ProcessContractDraft } from './process-contract.js';
import { projectProcess } from './process-projection.js';
import { WorkflowSpaceService } from './service.js';
import { PostgresBlobStore } from './blob-store.js';
import { migrateWorkflowSpaces } from './migration.js';
import type { NodeContext,SpaceRun } from './types.js';
const definition={namespace:'test/process',revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:{type:'object',properties:{text:{type:'string'},notes:{type:'array',items:{type:'string'}}},required:['text','notes'],additionalProperties:false}};
const reg=new SchemaRegistry(),schema=reg.registerSchema(definition),ref:SchemaRef={namespace:schema.namespace,revision:schema.revision,hash:schema.hash};
const storage=(r:SchemaRef):StorageContractDraft=>({workflowVersion:'v1',nodes:{writer:{actorKinds:['program','agent'],inputs:{source:{schema:r,states:['imported','candidate']},materials:{schema:r,states:['imported','candidate']}},outputs:{draft:{schema:r,requiredInputs:['source'],appendVersions:false,initialState:'candidate'},summary:{schema:r,requiredInputs:['source'],appendVersions:false,initialState:'candidate'}},actions:['readBoundInput','appendOutputVersion']}},stateRules:[]});
const processDraft=(r=ref):ProcessContractDraft=>({revision:'1',nodes:[{id:'write',kind:'agent',storageNodeId:'writer',inputs:{previous:{slot:'source'},materials:{slot:'materials'}},outputs:{draft:{slot:'draft',max:'many'},summary:{slot:'summary'}}},{id:'route',kind:'decision'},{id:'cold',kind:'program'},{id:'check',kind:'program'},{id:'end',kind:'human'}],edges:[{id:'to-route',from:'write',to:'route',kind:'sequence'},{id:'rewrite',from:'route',to:'write',kind:'rework',route:'rewrite',maxTraversals:2},{id:'pass',from:'route',to:'end',kind:'condition',route:'pass'},{id:'cold-fork',from:'write',to:'cold',kind:'fork',route:'reviews'},{id:'check-fork',from:'write',to:'check',kind:'fork',route:'reviews'},{id:'cold-join',from:'cold',to:'route',kind:'join',route:'reviews'},{id:'check-join',from:'check',to:'route',kind:'join',route:'reviews'}],results:[{role:'final',nodeId:'write',outputPort:'draft',many:true},{role:'summary',nodeId:'write',outputPort:'summary'}],relationTypes:[{id:'revision-of',revision:'1',fromSchemas:[r],toSchemas:[r],maxPerFrom:1,scope:'case'},{id:'cites',revision:'1',fromSchemas:[r],toSchemas:[r],allowFromPointer:true,allowToPointer:true,scope:'run',allowCycle:true},{id:'links',revision:'1',fromSchemas:[r],toSchemas:[r],scope:'case'}],relationMappings:[{id:'revision',typeId:'revision-of',nodeId:'write',outputPort:'draft',inputPort:'previous',required:true},{id:'citations',typeId:'cites',nodeId:'write',outputPort:'draft',inputPort:'materials',policy:'explicit',required:true},{id:'internal-notes',typeId:'cites',nodeId:'write',outputPort:'draft',toOutputPort:'draft',policy:'explicit'}]});

describe('Process contract and occurrence semantics',()=>{
 it('validates exact ports, parallel controls, bounded rework and multiple results',async()=>{
  const frozen=await publishStorageContract(reg,storage(ref)),contract=await publishProcessContract(processDraft(),frozen);
  expect(contract.results).toHaveLength(2);expect(contract.hash).toMatch(/^[a-f0-9]{64}$/);
  for(const [edge,error] of [[{id:'bad',from:'write',to:'missing',kind:'sequence'},'endpoint'],[{id:'bad',from:'write',to:'write',kind:'sequence'},'unbounded'],[{id:'bad',from:'write',to:'write',kind:'rework'},'budget'],[{id:'single',from:'write',to:'cold',kind:'fork',route:'one'},'at least two']] as const) await expect(publishProcessContract({...processDraft(),edges:[edge]},frozen)).rejects.toThrow(error);
  await expect(publishProcessContract({...processDraft(),relationTypes:[{...processDraft().relationTypes![0]!,toSchemas:[{...ref,hash:'a'.repeat(64)}]}]},frozen)).rejects.toThrow('unknown exact schema');
  await expect(publishProcessContract({...processDraft(),relationMappings:[{...processDraft().relationMappings![0]!,toOutputPort:'draft'}]},frozen)).rejects.toThrow('exactly one');
  await expect(publishProcessContract({...processDraft(),nodes:[{id:'write',kind:'agent',storageNodeId:'writer',outputs:{draft:{slot:'unknown'}}}]},frozen)).rejects.toThrow('unknown storage slot');
  const branches=processDraft().edges.map(edge=>edge.kind==='fork'?{...edge,branch:'duplicate'}:edge);
  await expect(publishProcessContract({...processDraft(),edges:branches},frozen)).rejects.toThrow('duplicate fork:reviews:write branch');
  await expect(publishProcessContract({...processDraft(),edges:processDraft().edges.map(edge=>edge.kind==='sequence'?{...edge,branch:'unexpected'}:edge)},frozen)).rejects.toThrow('unexpected branch');
 });
 it('keeps failed/recovered technical steps inside one round and exact publication origin',async()=>{
  const contract=await publishProcessContract(processDraft(),await publishStorageContract(reg,storage(ref)));
  const steps=['agent','recover','publish'].map((id,i)=>({id,runId:'r',key:id,kind:i===2?'publish':'agent',workflowId:'flow',workflowRevision:'1',inputFingerprint:'',configFingerprint:'',state:i===0?'failed':'succeeded',validation:'valid',...(i===0?{error:'network failure'}:{})})) as StepRecord[];
  const attempts=steps.map(step=>({id:`attempt-${step.id}`,stepRunId:step.id,runId:'r',state:step.state,error:step.error})) as AttemptRecord[];
  const contexts=steps.map(step=>({id:`ctx-${step.id}`,nodeId:'writer',stepRunId:step.id,sessionId:`session-${step.id}`,inputs:{},process:{nodeId:'write',round:2},...(step.id==='publish'?{generatedByContextId:'ctx-recover'}:{})})) as NodeContext[];
  const events=[{id:'e',runId:'r',seq:1,type:'harness.recovery_patch',timestamp:'now',stepRunId:'recover',data:{reason:'changed transport',stream:'private full stream'}}] as WorkflowEvent[];
  const view=projectProcess({run:{runId:'r'} as SpaceRun,contract,contractSource:'method',steps,attempts,contexts,outputs:[{contextId:'ctx-publish',slot:'draft',versionId:'v'}],assets:[],relations:[],events});
  expect(view.occurrences).toHaveLength(1);expect(view.occurrences[0]?.technicalSteps).toHaveLength(3);expect(view.occurrences[0]?.attemptRecords.some(a=>a.error==='network failure')).toBe(true);expect(view.occurrences[0]?.outputs.draft).toEqual(['v']);expect(JSON.stringify(view)).not.toContain('private full stream');
 });
});
const url=process.env.WORKFLOW_TEST_DATABASE_URL,suite=url?describe:describe.skip;
suite('Process and relation atomic PostgreSQL foundation',()=>{
 let pool:Pool,blobs:PostgresBlobStore;
 beforeAll(async()=>{pool=new Pool({connectionString:url});await migrateWorkflowSpaces(pool);blobs=new PostgresBlobStore(pool);});
 afterAll(async()=>{await pool?.end();});
 async function fixture(withProcess=true){
  const service=new WorkflowSpaceService(pool,blobs,{id:'process-owner',kind:'human'}),space=await service.createSpace({purpose:'Isolated process foundation validation'});
  const [registered]=await service.registerSchemas(space.id,[definition]),r={namespace:registered!.namespace,revision:registered!.revision,hash:registered!.hash};
  const version=await service.publishWorkflow(space.id,{id:'v1',revision:'1',changeReason:'Process fixture',config:{},entrypoints:{write:{workflowId:'flow',codeRevision:'1',storageContract:storage(r),...(withProcess?{process:processDraft(r)}:{})}}});
  await service.createCase(space.id,{id:'case',title:'Test',objective:'Exact facts',constraints:[]});
  const source=await service.importAsset(space.id,{schema:r,payload:{text:'source',notes:['previous']},description:'Test source',idempotencyKey:'source'});
  const materials=await service.importAsset(space.id,{schema:r,payload:{text:'material',notes:['material']},description:'Frozen materials outside dependencies',idempotencyKey:'materials'}),manifest=await service.freezeInputs(space.id,'case',{source:source.id,materials:materials.id});
  const run=await service.startRun(space.id,{workflowVersionId:'v1',entrypoint:'write',inputManifestId:manifest.id,idempotencyKey:'run'});
  const context=await service.startNode(space.id,{runId:run.runId,nodeId:'writer',key:'write',inputs:{source:source.id,materials:materials.id},producer:'program',instructions:'Fixture',effectiveConfig:{},...(withProcess?{process:{nodeId:'write',round:1}}:{})});
  const commit={idempotencyKey:'publish',outputs:[{slot:'draft',payload:{text:'draft',notes:['own-note']},dependencySlots:['source']}],relations:[{typeId:'cites',from:{outputSlot:'draft',pointer:'/text'},to:{inputSlot:'materials',pointer:'/notes/0'}},{typeId:'cites',from:{outputSlot:'draft',pointer:'/text'},to:{outputSlot:'draft',pointer:'/notes/0'}}]};
  return {service,space,version,source,materials,run,context,commit,manifest,r};
 }
 it('does not repeat Space migration DDL while a workflow write holds its table lock',async()=>{
  const f=await fixture();
  const writer=await pool.connect(),migrator=new Pool({connectionString:url!,options:'-c lock_timeout=750ms'});
  try {
   await writer.query('BEGIN');
   await writer.query('UPDATE ws_workflows SET document=document WHERE space_id=$1 AND id=$2',[f.space.id,f.version.id]);
   await migrateWorkflowSpaces(migrator);
  } finally {
   await writer.query('ROLLBACK');
   writer.release();
   await migrator.end();
  }
 });
 it('freezes new process hashes and keeps retrospective old runs unchanged',async()=>{
  const old=await fixture(false),modern=await fixture();expect(old.run.process).toBeUndefined();expect(modern.run.process?.hash).toBe(modern.version.entrypoints.write?.process?.hash);expect(await old.service.runtimeProcessContract(old.space.id,old.run.runId)).toBeUndefined();
  const service=new WorkflowSpaceService(pool,blobs,{id:'process-owner',kind:'human'},{processResolvers:{flow:()=>({resolverVersion:'retro-1',contract:processDraft(old.r),mappings:[{stepRunId:old.context.stepRunId,annotation:{nodeId:'write',round:1},evidence:'Exact fixture node'}]})}});
  expect((await service.process(old.space.id,old.run.runId)).contractSource).toBe('retrospective');
  expect((await pool.query('SELECT document FROM ws_runs WHERE space_id=$1 AND run_id=$2',[old.space.id,old.run.runId])).rows[0].document.process).toBeUndefined();
  const drift=new WorkflowSpaceService(pool,blobs,{id:'process-owner',kind:'human'},{processResolvers:{flow:()=>({resolverVersion:'bad',contract:{...processDraft(modern.r),revision:'2'},mappings:[]})}});
  await expect(drift.process(modern.space.id,modern.run.runId)).rejects.toThrow('differs from frozen');
 });
 it('rolls back all publication effects on missing or invalid required dynamic citations; successful retries reconcile',async()=>{
  const f=await fixture(),client=await f.service.nodeClient(f.space.id,f.context.id);
  await expect(client.submit({...f.commit,relations:[]})).rejects.toThrow('Required explicit');
  await expect(client.submit({...f.commit,relations:[{...f.commit.relations[0]!,to:{inputSlot:'materials',pointer:'/notes/999'}}]})).rejects.toThrow('pointer');
  expect((await f.service.overview(f.space.id)).assets).toHaveLength(2);expect((await pool.query('SELECT count(*)::int AS count FROM ws_relation_events WHERE space_id=$1',[f.space.id])).rows[0].count).toBe(0);
  expect((await pool.query('SELECT document FROM aw_attempts WHERE workspace_id=$1 AND id=$2',[f.space.id,f.context.attemptId])).rows[0].document.state).toBe('running');
  const receipt=await client.submit(f.commit);expect(await client.submit(f.commit)).toEqual(receipt);await expect(client.submit({...f.commit,result:'drift'})).rejects.toThrow('Idempotency conflict');
  expect(receipt.versions[0]!.dependencies).not.toContain(f.materials.id);
  const links=(await f.service.process(f.space.id,f.run.runId)).relations;expect(links.some(l=>l.typeId==='cites'&&l.to.assetVersionId===f.materials.id)).toBe(true);expect(links.filter(l=>l.typeId==='cites')).toHaveLength(2);expect(links.filter(l=>l.typeId==='revision-of')).toHaveLength(1);expect(links.find(l=>l.typeId==='cites'&&l.to.assetVersionId===receipt.versions[0]!.id)?.to.pointer).toBe('/notes/0');
  const first=await f.service.assetNeighborhood(f.space.id,receipt.versions[0]!.id,{limit:1,runId:f.run.runId}),second=await f.service.assetNeighborhood(f.space.id,receipt.versions[0]!.id,{limit:1,runId:f.run.runId,cursor:first.nextCursor});expect(first.hasMore).toBe(true);expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  const outsider=new WorkflowSpaceService(pool,blobs,{id:'outsider',kind:'human'});await expect(outsider.process(f.space.id,f.run.runId)).rejects.toThrow('denied');
  await f.service.grant(f.space.id,'other-operator','operator');const operator=new WorkflowSpaceService(pool,blobs,{id:'other-operator',kind:'service'});await expect(operator.submitNode(f.space.id,f.context.id,f.commit)).rejects.toThrow('Execution binding access denied');
 });
 it('enforces case/cardinality/cycle boundaries and append-only human corrections',async()=>{
  const f=await fixture(),receipt=await f.service.submitNode(f.space.id,f.context.id,f.commit),draft=receipt.versions[0]!;
  const relation={runId:f.run.runId,typeId:'links',from:{assetVersionId:draft.id},to:{assetVersionId:f.source.id},evidence:'Exact inputs',idempotencyKey:'link'};
  const link=await f.service.recordRelation(f.space.id,relation);expect(await f.service.recordRelation(f.space.id,relation)).toEqual(link);
  await expect(f.service.recordRelation(f.space.id,{...relation,from:relation.to,to:relation.from,idempotencyKey:'cycle'})).rejects.toThrow('cycle');await expect(f.service.recordRelation(f.space.id,{...relation,typeId:'revision-of',idempotencyKey:'cardinality'})).rejects.toThrow('cardinality');
  const other=await f.service.importAsset(f.space.id,{schema:f.r,payload:{text:'unbound',notes:[]},description:'Other case',idempotencyKey:'unbound'});await f.service.createCase(f.space.id,{id:'other',title:'Other',objective:'Separate',constraints:[]});const m=await f.service.freezeInputs(f.space.id,'other',{source:other.id});await f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'write',inputManifestId:m.id,idempotencyKey:'other-run'});
  await expect(f.service.recordRelation(f.space.id,{...relation,to:{assetVersionId:other.id},idempotencyKey:'cross-case'})).rejects.toThrow('scope');
  await expect(f.service.recordRelation(f.space.id,{...relation,replacesId:link.id,to:{assetVersionId:f.source.id,pointer:'/missing'},idempotencyKey:'invalid-correction'})).rejects.toThrow('pointer');
  expect((await f.service.process(f.space.id,f.run.runId)).relations.some(i=>i.id===link.id)).toBe(true);
  const updated=await f.service.recordRelation(f.space.id,{...relation,replacesId:link.id,evidence:'Corrected',idempotencyKey:'correction'}),active=(await f.service.process(f.space.id,f.run.runId)).relations;expect(active.some(i=>i.id===link.id)).toBe(false);expect(active.some(i=>i.id===updated.id)).toBe(true);expect((await pool.query('SELECT count(*)::int AS count FROM ws_relation_events WHERE space_id=$1 AND (id=$2 OR previous_id=$2)',[f.space.id,link.id])).rows[0].count).toBe(3);
  await f.service.grant(f.space.id,'viewer','viewer');const viewer=new WorkflowSpaceService(pool,blobs,{id:'viewer',kind:'human'});await expect(viewer.recordRelation(f.space.id,{...relation,idempotencyKey:'viewer'})).rejects.toThrow('denied');
  const [wrong]=await f.service.registerSchemas(f.space.id,[{...definition,namespace:'test/wrong-process-schema'}]);
  const wrongAsset=await f.service.importAsset(f.space.id,{schema:{namespace:wrong!.namespace,revision:wrong!.revision,hash:wrong!.hash},payload:{text:'wrong',notes:[]},description:'Wrong schema fixture',idempotencyKey:'wrong-schema'});
  await expect(f.service.recordRelation(f.space.id,{...relation,to:{assetVersionId:wrongAsset.id},idempotencyKey:'wrong-schema-link'})).rejects.toThrow('schema mismatch');
  const foreign=await fixture();await expect(f.service.recordRelation(f.space.id,{...relation,to:{assetVersionId:foreign.source.id},idempotencyKey:'foreign'})).rejects.toThrow('not found');
 });
 it('atomically records new decision selections with exact route/source/payload validation and idempotent receipt',async()=>{
  const f=await fixture(),ledger=await f.service.runtimeLedger(f.space.id);
  const step=await ledger.createStep({runId:f.run.runId,key:'decide',kind:'decision',workflowId:'flow',workflowRevision:'1',inputFingerprint:'',configFingerprint:'',state:'running',validation:'pending'});
  const attempt=await ledger.createAttempt({runId:f.run.runId,stepRunId:step.id,state:'running'}),output={route:'rewrite',round:0};
  const event=await ledger.appendEvent({runId:f.run.runId,stepRunId:step.id,attemptId:attempt.id,type:'decision.recorded',data:output});
  const commit={stepRunId:step.id,attemptId:attempt.id,idempotencyKey:'decision',state:'succeeded' as const,validation:'valid' as const,output,events:[{runId:f.run.runId,stepRunId:step.id,attemptId:attempt.id,type:'step.completed'}]},binding={nodeId:'route',edgeId:'rewrite',round:1};
  await expect(f.service.commitRuntimeDecision(f.space.id,commit,{...binding,edgeId:'pass'})).rejects.toThrow('payload/route');
  await expect(f.service.commitRuntimeDecision(f.space.id,{...commit,output:{route:'pass',round:0}},binding)).rejects.toThrow('payload/route');
  await expect(f.service.commitRuntimeDecision(f.space.id,{...commit,stepRunId:f.context.stepRunId,attemptId:f.context.attemptId},binding)).rejects.toThrow('source/receipt');
  await expect(f.service.commitRuntimeDecision(f.space.id,{...commit,events:[{...commit.events[0]!,runId:'wrong-run'}]},binding)).rejects.toThrow('provenance mismatch');
  expect((await pool.query('SELECT count(*)::int AS count FROM ws_process_decisions WHERE space_id=$1',[f.space.id])).rows[0].count).toBe(0);
  expect((await ledger.listAttempts(step.id))[0]?.state).toBe('running');
  const receipt=await f.service.commitRuntimeDecision(f.space.id,commit,binding);expect(await f.service.commitRuntimeDecision(f.space.id,commit,binding)).toEqual(receipt);
  await expect(f.service.commitRuntimeDecision(f.space.id,commit,{...binding,round:2})).rejects.toThrow('Idempotency conflict');
  const view=await f.service.process(f.space.id,f.run.runId);
  expect(view.routes).toContainEqual({edgeId:'rewrite',eventSeq:event.seq,stepRunId:step.id,round:1,reason:undefined,selectionOnly:true,provenance:'observed'});
  expect(view.occurrences.find(item=>item.nodeId==='route')?.provenance).toBe('observed');
 });
 it('routes actual core decision commits through the adapter and preserves legacy execution',async()=>{
  for(const modern of [true,false]) {
   const f=await fixture(modern),runtime=await createSpaceRuntime(f.service,f.space.id,{workflowVersionId:'v1',entrypoint:'write',inputManifestId:f.manifest.id},{
    underlyingRunner:{run:async()=>{throw new Error('No model invocation in decision fixture');}},
    resolveAgent:()=>{throw new Error('No Agent step');},resolvePublication:()=>{throw new Error('No publication step');},
    resolveDecision:async(commit,api)=>{
      if(!await api.frozenProcess(commit.events[0]!.runId))return undefined;
      return {nodeId:'route',edgeId:'rewrite',round:1,observation:{route:'pass',round:0},reason:'Recorded pass failed program guard; select rewrite'};
    }
   });
   const flow=workflow('flow',{revision:'1'},async ctx=>{ctx.decide('route',{route:'pass',round:0,failures:['program-guard']});return {done:true};});
   const result=await runWorkflow({workflow:flow,input:{},...runtime});
   const view=await f.service.process(f.space.id,result.run.id);
   expect(view.routes.filter(route=>route.provenance==='observed')).toHaveLength(modern?1:0);
   if(modern) {expect(view.routes[0]?.edgeId).toBe('rewrite');expect(view.occurrences.find(item=>item.nodeId==='route')?.route).toBe('pass');}
   expect(view.contractSource).toBe(modern?'method':'unknown');
  }
 });
 it('rejects route annotations and historical route evidence unsupported by exact decisions',async()=>{
  const f=await fixture();await expect(f.service.startNode(f.space.id,{runId:f.run.runId,nodeId:'writer',key:'fake-route',inputs:{source:f.source.id,materials:f.source.id},producer:'program',instructions:'fixture',effectiveConfig:{},process:{nodeId:'write',round:1,route:'rewrite',decisionEventSeq:1}})).rejects.toThrow('recorded decision');
  const ledger=await f.service.runtimeLedger(f.space.id),event=await ledger.appendEvent({runId:f.run.runId,type:'arbitrary',data:{route:'rewrite',round:1}});const service=new WorkflowSpaceService(pool,blobs,{id:'process-owner',kind:'human'},{processResolvers:{flow:()=>({resolverVersion:'invented',contract:processDraft(f.r),mappings:[],routes:[{edgeId:'rewrite',eventSeq:event.seq,round:1}]})}});await expect(service.process(f.space.id,f.run.runId)).rejects.toThrow('matching recorded decision');
  const step=await ledger.createStep({runId:f.run.runId,key:'decide',kind:'decision',workflowId:'flow',workflowRevision:'1',inputFingerprint:'',configFingerprint:'',state:'succeeded',validation:'valid',output:{route:'rewrite',round:0}});
  const recorded=await ledger.appendEvent({runId:f.run.runId,stepRunId:step.id,type:'decision.recorded',data:{route:'rewrite',round:0}});
  const honest=new WorkflowSpaceService(pool,blobs,{id:'process-owner',kind:'human'},{processResolvers:{flow:()=>({resolverVersion:'exact-1',contract:processDraft(f.r),mappings:[{stepRunId:step.id,annotation:{nodeId:'route',round:1,route:'rewrite'},evidence:'Exact decision step'}],routes:[{edgeId:'rewrite',stepRunId:step.id,eventSeq:recorded.seq,round:1}]})}});
  expect((await honest.process(f.space.id,f.run.runId)).routes).toContainEqual({edgeId:'rewrite',stepRunId:step.id,eventSeq:recorded.seq,round:1,provenance:'derived'});
 });
});
