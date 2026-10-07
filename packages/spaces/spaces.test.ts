import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { AtomicStepReconciliationRequiredError, defineAgent, runWorkflow, type AgentRunner } from '@signal-room/workflow';
import { createSpaceRuntime } from './runtime.js';
import { InvalidObservedOutputError } from './errors.js';
import { JSON_SCHEMA_DIALECT, type SchemaRef, type StorageContractDraft } from '@signal-room/workflow-space-contracts';
import { WorkflowSpaceService } from './service.js';
import { PostgresBlobStore } from './blob-store.js';
import { migrateWorkflowSpaces } from './migration.js';

const url=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
let pool:Pool, blobs:PostgresBlobStore;
const actor={id:'owner',kind:'human' as const};
const definition=(revision='1')=>({namespace:'test/report',revision,dialect:JSON_SCHEMA_DIALECT,schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{public:{type:'string'},decision:{type:'string'}},required:['public','decision'],additionalProperties:false}} as const);
const reference=(schema:SchemaRef):SchemaRef=>({namespace:schema.namespace,revision:schema.revision,hash:schema.hash});
const contract=(ref:SchemaRef,version='v1'):StorageContractDraft=>({workflowVersion:version,nodes:{
  writer:{actorKinds:['agent'],inputs:{source:{schema:ref,states:['imported','candidate']}},outputs:{result:{schema:ref,requiredInputs:['source'],appendVersions:true,initialState:'candidate'}},actions:['readBoundInput','appendOutputVersion']},
  reader:{actorKinds:['agent'],inputs:{source:{schema:ref,states:['candidate'],projection:{version:'viewer-v1',fields:['/public']}}},outputs:{result:{schema:ref,requiredInputs:['source'],appendVersions:false,initialState:'candidate'}},actions:['readBoundInputProjection','appendOutputVersion']},
  creator:{actorKinds:['human'],inputs:{source:{schema:ref,states:['candidate']}},outputs:{},actions:['readBoundInput','accept']},
  producer:{actorKinds:['program'],inputs:{source:{schema:ref,states:['accepted']}},outputs:{result:{schema:ref,requiredInputs:['source'],appendVersions:false,initialState:'candidate'}},actions:['readBoundInput','appendOutputVersion']},
},stateRules:[{schema:ref,from:'candidate',to:'accepted',action:'accept',actorKinds:['human'],nodeId:'creator'}]});
async function fixture(){
 const service=new WorkflowSpaceService(pool,blobs,actor), space=await service.createSpace({purpose:'Compare useful reports'});
 const registered=await service.registerSchemas(space.id,[definition()]),ref=reference(registered[0]!);
 const version=await service.publishWorkflow(space.id,{id:'v1',revision:'1',changeReason:'Baseline',config:{model:'deterministic-test'},entrypoints:{content:{workflowId:'reports',codeRevision:'1',storageContract:contract(ref)},production:{workflowId:'production',codeRevision:'1',storageContract:contract(ref)}}});
 const source=await service.importAsset(space.id,{schema:ref,payload:{public:'Source bytes',decision:'Source note'},description:'Uploaded by owner before run',idempotencyKey:'import'});
 await service.createCase(space.id,{id:'case',title:'Report case',objective:'Produce an understandable report',constraints:[]});
 const manifest=await service.freezeInputs(space.id,'case',{source:source.id});
 const run=await service.startRun(space.id,{workflowVersionId:'v1',entrypoint:'content',inputManifestId:manifest.id,idempotencyKey:'run'});
 return {service,space,ref,version,source,manifest,run};
}
const node=(runId:string,source:string,key='write')=>({runId,nodeId:'writer',key,inputs:{source},producer:'agent' as const,instructions:'Write with supplied source',effectiveConfig:{model:'deterministic-test'}});
const commit=(key='result',text='First report')=>({idempotencyKey:key,outputs:[{slot:'result',payload:{public:text,decision:'Private author rationale'},dependencySlots:['source']}]});

suite('Workflow Spaces: real PostgreSQL domain and capability contracts',()=>{
 beforeAll(async()=>{pool=new Pool({connectionString:url!,max:12});await Promise.all([migrateWorkflowSpaces(pool),migrateWorkflowSpaces(pool)]);blobs=new PostgresBlobStore(pool);await blobs.migrate();});
 afterAll(async()=>{await pool?.end();});
 it('persists pre-run imports, definitions and unrelated schemas; rejects identity overwrite and invalid payload',async()=>{
   const f=await fixture();expect(f.source.source.kind).toBe('import');
   await expect(f.service.importAsset(f.space.id,{schema:f.ref,payload:{public:42},description:'bad',idempotencyKey:'bad'})).rejects.toThrow();
   await expect(f.service.registerSchemas(f.space.id,[{...definition(),schema:{type:'string'}}])).rejects.toThrow();
   await expect(f.service.publishWorkflow(f.space.id,{id:'v1',revision:'1',changeReason:'overwrite',config:{},entrypoints:{content:{workflowId:'different',codeRevision:'2',storageContract:contract(f.ref)}}})).rejects.toThrow('immutable');
   const unrelated=await f.service.registerSchemas(f.space.id,[{namespace:'inventory/counts',revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:{type:'array',items:{type:'integer',minimum:0}}}]);
   const counts=await f.service.importAsset(f.space.id,{schema:reference(unrelated[0]!),payload:[1,2,3],description:'Inventory',idempotencyKey:'counts'});
   expect((await f.service.readAsset(f.space.id,counts.id)).payload).toEqual([1,2,3]);
   await f.service.registerSchemas(f.space.id,[definition('2')]);expect((await f.service.readAsset(f.space.id,f.source.id)).schema.revision).toBe('1');
 });
 it('rejects unauthorized space access and cross-space references at service and database',async()=>{
   const a=await fixture(),b=await fixture(), outsider=new WorkflowSpaceService(pool,blobs,{id:'outsider',kind:'human'});
   await expect(outsider.readAsset(a.space.id,a.source.id)).rejects.toThrow('denied');
   await expect(a.service.readAsset(a.space.id,b.source.id)).rejects.toThrow('not found');
   await expect(a.service.freezeInputs(a.space.id,'case',{foreign:b.source.id})).rejects.toThrow('not found');
   await expect(pool.query('INSERT INTO ws_asset_dependencies(space_id,version_id,dependency_id) VALUES($1,$2,$3)',[a.space.id,a.source.id,b.source.id])).rejects.toThrow();
 });
 it('rejects credentials in workflow, run and observed node configuration snapshots',async()=>{
   const f=await fixture();
   await expect(f.service.publishWorkflow(f.space.id,{id:'secret-version',revision:'2',changeReason:'Invalid configuration',config:{provider:{apiKey:'test-placeholder'}},entrypoints:{content:{workflowId:'reports',codeRevision:'2',storageContract:contract(f.ref,'secret-version')}}})).rejects.toThrow('protected references');
   await expect(f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'content',inputManifestId:f.manifest.id,idempotencyKey:'secret-run',effectiveConfig:{access_token:'test-placeholder'}})).rejects.toThrow('protected references');
   await expect(f.service.startNode(f.space.id,{...node(f.run.runId,f.source.id),effectiveConfig:{provider:{clientSecret:'test-placeholder'}}})).rejects.toThrow('protected references');
   const snapshot=await f.service.overview(f.space.id);expect(snapshot.runs).toHaveLength(1);expect(snapshot.workflows).toHaveLength(1);expect(snapshot.sessions).toHaveLength(0);
 });
 it('requires explicit conversion when a logical asset changes schema revision',async()=>{
   const f=await fixture();const [nextSchema]=await f.service.registerSchemas(f.space.id,[definition('2')]);
   const draft={schema:reference(nextSchema!),payload:f.source.payload,assetId:f.source.assetId,expectedHead:f.source.id,description:'Upgrade source schema',idempotencyKey:'upgrade'};
   await expect(f.service.importAsset(f.space.id,draft)).rejects.toThrow('explicit transformation');
   const converted=await f.service.transformAsset(f.space.id,{...draft,operation:'test/report@1-to-2',dependencies:[f.source.id]});
   expect(converted.version).toBe(2);expect(converted.dependencies).toEqual([f.source.id]);expect(converted.source.kind).toBe('transform');expect((await f.service.readAsset(f.space.id,f.source.id)).schema.revision).toBe('1');
 });
 it('binds cold-reader projection, records actual delivered view and denies full read or creator action',async()=>{
   const f=await fixture(),context=await f.service.startNode(f.space.id,node(f.run.runId,f.source.id));
   const writer=await f.service.nodeClient(f.space.id,context.id),receipt=await writer.submit(commit()),draft=receipt.versions[0]!;
   const cold=await f.service.startNode(f.space.id,{...node(f.run.runId,draft.id,'read'),nodeId:'reader'}),reader=await f.service.nodeClient(f.space.id,cold.id);
   expect((await reader.read('source')).payload).toEqual({public:'First report'});
   await expect(reader.readFull('source')).rejects.toThrow('denied');await expect(reader.read('unbound')).rejects.toThrow('denied');
   await expect(writer.act('accept',{assetVersionId:draft.id})).rejects.toThrow('denied');
   const messages=await f.service.sessionEvents(f.space.id,cold.sessionId);expect(JSON.stringify(messages)).not.toContain('Private author rationale');
   expect(cold.inputs.source!.viewVersion).toBe('viewer-v1');expect(cold.inputs.source!.assetVersionId).toBe(draft.id);
   const badConfig={...cold.inputs.source!,payload:{decision:'tampered'}};
   cold.inputs.source=badConfig;expect((await reader.read('source')).payload).toEqual({public:'First report'});
 });
 it('commits multiple outputs and ledger completion atomically, reconciles duplicates and conflicts',async()=>{
   const f=await fixture(),context=await f.service.startNode(f.space.id,node(f.run.runId,f.source.id)),client=await f.service.nodeClient(f.space.id,context.id);
   await expect(client.submit({...commit(),outputs:[...commit().outputs,{slot:'forbidden',payload:{},dependencySlots:[]}]})).rejects.toThrow();
   expect((await f.service.overview(f.space.id)).assets).toHaveLength(1);
   const receipt=await client.submit(commit());expect(await client.submit(commit())).toEqual(receipt);
   await expect(client.submit(commit('result','Changed'))).rejects.toThrow('Idempotency conflict');
   await expect(client.submit(commit('another'))).rejects.toThrow('not running');
   const attempt=await pool.query('SELECT document FROM aw_attempts WHERE workspace_id=$1 AND id=$2',[f.space.id,context.attemptId]);expect(attempt.rows[0].document.state).toBe('succeeded');
   expect((await f.service.overview(f.space.id)).assets).toHaveLength(2);
 });
 it('serializes concurrent versions and records exact dependencies without overwriting the winner',async()=>{
   const f=await fixture(),c=await f.service.startNode(f.space.id,node(f.run.runId,f.source.id));
   const initial=(await (await f.service.nodeClient(f.space.id,c.id)).submit(commit())).versions[0]!;
   const contexts=await Promise.all(['a','b'].map(key=>f.service.startNode(f.space.id,node(f.run.runId,initial.id,key))));
   const results=await Promise.allSettled(contexts.map(async(c,i)=>(await f.service.nodeClient(f.space.id,c.id)).submit({idempotencyKey:'next',outputs:[{...commit().outputs[0]!,assetId:initial.assetId,expectedHead:initial.id,payload:{public:`v${i}`,decision:'why'}}]})));
   expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
   expect((await f.service.readAsset(f.space.id,initial.id)).payload).toEqual(commit().outputs[0]!.payload);
 });
 it('freezes independent production input despite a new draft and preserves human acceptance',async()=>{
   const f=await fixture(),c=await f.service.startNode(f.space.id,node(f.run.runId,f.source.id)),first=(await (await f.service.nodeClient(f.space.id,c.id)).submit(commit())).versions[0]!;
   await expect(f.service.startNode(f.space.id,{...node(f.run.runId,first.id,'too-early'),nodeId:'producer',producer:'program'})).rejects.toThrow('state not allowed');
   await f.service.transition(f.space.id,{workflowVersionId:'v1',entrypoint:'content',nodeId:'creator',assetVersionId:first.id,to:'accepted',action:'accept',reason:'Exact draft approved',idempotencyKey:'accept'});
   const manifest=await f.service.freezeInputs(f.space.id,'case',{source:first.id}),run=await f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'production',inputManifestId:manifest.id,idempotencyKey:'production'});
   const production=await f.service.startNode(f.space.id,{...node(run.runId,first.id,'build'),nodeId:'producer',producer:'program'});
   const blob=await f.service.uploadBlob(f.space.id,Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>First report</text></svg>'),'image/svg+xml');
   const product=(await (await f.service.nodeClient(f.space.id,production.id)).submit({idempotencyKey:'build',outputs:[{...commit().outputs[0]!,blobIds:[blob.id]}]})).versions[0]!;
   await f.service.finishRun(f.space.id,run.runId);
   const newer=await f.service.importAsset(f.space.id,{schema:f.ref,payload:{public:'New report',decision:'new'},description:'Explicit external revision',idempotencyKey:'new'});
   expect(newer.id).not.toBe(first.id);expect(product.dependencies).toEqual([first.id]);expect((await f.service.readContext(f.space.id,production.id)).inputs.source!.assetVersionId).toBe(first.id);
   expect(Buffer.from(await f.service.readBlob(f.space.id,blob.id)).toString()).toContain('First report');
 });
 it('persists sessions, knowledge, two-version feedback/comparison and adoption after fresh connection',async()=>{
   const f=await fixture(),c=await f.service.startNode(f.space.id,node(f.run.runId,f.source.id)),first=(await (await f.service.nodeClient(f.space.id,c.id)).submit(commit())).versions[0]!;
   const event=await f.service.recordSessionEvent(f.space.id,c.id,'observed','trace',{test:'Actual deterministic tool event'});
   const knowledge=await f.service.saveKnowledge(f.space.id,{id:'k1',entryId:'lesson',content:'Explain the first term',classification:'inference',scope:{caseId:'case',roles:['writer']},sourceAssetIds:[first.id],sourceMessageIds:[event.id],status:'active'});
   const review={id:'r1',runId:f.run.runId,assetVersionIds:[first.id],standard:{id:'usefulness',revision:'1',content:'Understandable'},judge:{kind:'human' as const,id:'owner'},evidence:[first.id],answers:{good:'Specific',bad:'Jargon',improvement:'First run, no baseline',unresolved:'Opening'}};
   await f.service.recordReview(f.space.id,review);
   await f.service.publishWorkflow(f.space.id,{id:'v2',revision:'2',predecessorId:'v1',changeReason:'Based on r1: define first term',config:{model:'deterministic-test'},entrypoints:{content:{workflowId:'reports',codeRevision:'2',storageContract:contract(f.ref,'v2')}}});
   const nextRun=await f.service.startRun(f.space.id,{workflowVersionId:'v2',entrypoint:'content',inputManifestId:f.manifest.id,idempotencyKey:'run2'}),next=await f.service.startNode(f.space.id,{...node(nextRun.runId,f.source.id),knowledgeIds:[knowledge.id]});
   const second=(await (await f.service.nodeClient(f.space.id,next.id)).submit(commit('result','Explained report'))).versions[0]!;
   await f.service.recordReview(f.space.id,{...review,id:'r2',runId:nextRun.runId,assetVersionIds:[second.id],evidence:[second.id],baselineReviewId:'r1',answers:{...review.answers,improvement:'Opening term explained'}});
   const comparison=await f.service.compare(f.space.id,{id:'cmp',baselineReviewId:'r1',candidateReviewId:'r2',conclusion:'Clearer opening'});expect(Object.keys(comparison.changedConditions)).toEqual(['workflowVersion']);
   await f.service.recordIteration(f.space.id,{id:'iteration',reviewIds:['r1'],hypothesis:'Define first term',workflowVersionId:'v2',caseIds:['case'],runIds:[nextRun.runId]});
   const adoption=await f.service.adopt(f.space.id,{idempotencyKey:'adopt',slot:'workflow',target:{kind:'workflow',id:'v2'},comparisonId:'cmp',reason:'Clearer'});
   await expect(f.service.adopt(f.space.id,{idempotencyKey:'race',slot:'workflow',target:{kind:'workflow',id:'v1'},reason:'No expected pointer'})).rejects.toThrow('conflict');
   const reopenedPool=new Pool({connectionString:url!});try {
     const reopened=new WorkflowSpaceService(reopenedPool,new PostgresBlobStore(reopenedPool),actor),snapshot=await reopened.overview(f.space.id);
     expect(snapshot.workflows).toHaveLength(2);expect(snapshot.comparisons[0]?.candidateReviewId).toBe('r2');expect(snapshot.adoptions[0]?.id).toBe(adoption.id);
     expect(snapshot.knowledge[0]?.sourceMessageIds).toEqual([event.id]);expect((await reopened.readContext(f.space.id,next.id)).knowledge[0]?.content).toBe('Explain the first term');
     const page=await reopened.sessionEvents(f.space.id,c.sessionId,0,1);expect(page.hasMore).toBe(true);expect((await reopened.sessionEvents(f.space.id,c.sessionId,page.nextCursor)).items.length).toBeGreaterThan(0);
   } finally {await reopenedPool.end();}
 });
 it('verifies blob bytes after upload and rejects missing referenced content without publishing',async()=>{
   const f=await fixture(),blob=await f.service.uploadBlob(f.space.id,Buffer.from('real bytes'),'text/plain');
   await pool.query('UPDATE ws_blob_bytes SET bytes=$2 WHERE key=$1',[blob.key,Buffer.from('tampered')]);
   await expect(f.service.importAsset(f.space.id,{schema:f.ref,payload:{public:'x',decision:'y'},blobIds:[blob.id],description:'bad blob',idempotencyKey:'bad-blob'})).rejects.toThrow('integrity');
   expect((await f.service.overview(f.space.id)).assets).toHaveLength(1);
 });
 it('rejects unfrozen input, other execution principal and extending a finished run',async()=>{
   const f=await fixture();
   const other=await f.service.importAsset(f.space.id,{schema:f.ref,payload:{public:'Unselected',decision:'x'},description:'Not in manifest',idempotencyKey:'unselected'});
   await expect(f.service.startNode(f.space.id,node(f.run.runId,other.id))).rejects.toThrow('frozen manifest');
   const c=await f.service.startNode(f.space.id,node(f.run.runId,f.source.id));
   expect(await f.service.startNode(f.space.id,node(f.run.runId,f.source.id))).toEqual(c);
   await expect(f.service.startNode(f.space.id,{...node(f.run.runId,f.source.id),instructions:'changed'})).rejects.toThrow('idempotency conflict');
   await f.service.grant(f.space.id,'different-host','operator');
   const otherHost=new WorkflowSpaceService(pool,blobs,{id:'different-host',kind:'service'});
   await expect(otherHost.nodeClient(f.space.id,c.id)).rejects.toThrow('Execution binding');
   await expect(otherHost.recordSessionEvent(f.space.id,c.id,'forge','trace',{forged:true})).rejects.toThrow('Execution binding');
   await (await f.service.nodeClient(f.space.id,c.id)).submit(commit());await f.service.finishRun(f.space.id,f.run.runId);
   await expect(f.service.startNode(f.space.id,node(f.run.runId,f.source.id,'after'))).rejects.toThrow('not running');
 });
 it('reconciles a real committed result after the acknowledgement is lost',async()=>{
   const f=await fixture(),c=await f.service.startNode(f.space.id,node(f.run.runId,f.source.id));
   let lose=true;
   const uncertainPool=new Proxy(pool,{get(target,key){
     if(key==='connect') return async()=>{
       const db=await target.connect();
       return new Proxy(db,{get(client,member){
         if(member==='query') return async(...args:unknown[])=>{
           const result=await (client.query as (...args:unknown[])=>Promise<unknown>).apply(client,args);
           if(args[0]==='COMMIT'&&lose){lose=false;throw new Error('Lost COMMIT acknowledgement');}
           return result;
         };
         const value=Reflect.get(client,member);return typeof value==='function'?value.bind(client):value;
       }});
     };
     const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
   }});
   const service=new WorkflowSpaceService(uncertainPool,blobs,actor),client=await service.nodeClient(f.space.id,c.id);
   await expect(client.submit(commit())).rejects.toThrow('Lost COMMIT');
   const recovered=await client.submit(commit());expect(recovered.versions).toHaveLength(1);
   expect((await f.service.overview(f.space.id)).assets).toHaveLength(2);
   expect(await client.submit(commit())).toEqual(recovered);
 });
 it('rejects a corrupted frozen contract before binding an execution',async()=>{
   const f=await fixture();
   await pool.query("UPDATE ws_workflows SET document=jsonb_set(document,'{config}', $3::jsonb) WHERE space_id=$1 AND id=$2",[f.space.id,'v1',JSON.stringify({model:'changed'})]);
   await expect(f.service.startNode(f.space.id,node(f.run.runId,f.source.id))).rejects.toThrow('integrity');
 });

 it('replays a durable observed Agent result after the harness loses its acknowledgement without invoking the model again',async()=>{
   const f=await fixture();let calls=0,lose=true,firstRunId="";
   const runner:AgentRunner={async run<Input,Output>(_request){calls++;firstRunId=_request.runId;return {output:{public:'Observed response',decision:'Recorded'} as Output};}};
   const uncertainService=new Proxy(f.service,{get(target,key){
     if(key==='completeObservedAgent') return async(...args:Parameters<WorkflowSpaceService['completeObservedAgent']>)=>{
       await target.completeObservedAgent(...args);if(lose){lose=false;throw new Error('Lost response receipt');}
     };
     const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
   }});
   const runtime=await createSpaceRuntime(uncertainService,f.space.id,{workflowVersionId:'v1',entrypoint:'content',inputManifestId:f.manifest.id},{underlyingRunner:runner,
     resolveAgent:()=>({nodeId:'writer',inputs:{source:f.source.id},instructions:'Write'}),resolvePublication:()=>{throw new Error('No publication expected');}});
   const definition=defineAgent({id:'writer',revision:'1',model:'deterministic-test',reasoningEffort:'low',promptRevision:'1',skillsRevision:'1',permissionsRevision:'1'});
   const workflow={id:'reports',revision:'1',execute:async(ctx)=>ctx.agent('write',definition,{source:'Source bytes'})};
   await expect(runWorkflow({workflow,input:{},...runtime})).rejects.toThrow('reconciliation');expect(calls).toBe(1);
   const second=await runWorkflow({workflow,input:{},...runtime,resumeRunId:firstRunId});expect(second.run.state).toBe('succeeded');expect(calls).toBe(1);
   expect(second.output).toEqual({public:'Observed response',decision:'Recorded'});
 });

 it('records a malformed observed Agent response and schema error before failing the core attempt',async()=>{
   const f=await fixture();let calls=0,observedRunId='';
   const runner:AgentRunner={async run<Input,Output>(request){calls++;observedRunId=request.runId;
     return {output:{public:42,decision:'Complete but malformed response'} as Output};}};
   const runtime=await createSpaceRuntime(f.service,f.space.id,{workflowVersionId:'v1',entrypoint:'content',inputManifestId:f.manifest.id},{underlyingRunner:runner,
     resolveAgent:()=>({nodeId:'writer',inputs:{source:f.source.id},instructions:'Write'}),
     resolvePublication:()=>{throw new Error('No publication expected');}});
   const agent=defineAgent({id:'writer',revision:'1',model:'deterministic-test',reasoningEffort:'low',promptRevision:'1',skillsRevision:'1',permissionsRevision:'1'});
   const workflow={id:'reports',revision:'1',execute:async(ctx)=>ctx.agent('write',agent,{source:'Source bytes'})};
   await expect(runWorkflow({workflow,input:{},...runtime})).rejects.toBeInstanceOf(InvalidObservedOutputError);
   expect(calls).toBe(1);
   const contexts=await f.service.runtimeContexts(f.space.id,observedRunId);
   expect(contexts).toHaveLength(1);
   const session=(await f.service.overview(f.space.id)).sessions.find(item=>item.id===contexts[0]!.sessionId);
   expect(session?.completeness).toBe('complete');
   const events=(await f.service.sessionEvents(f.space.id,contexts[0]!.sessionId)).items;
   expect(events.find(item=>item.kind==='message' && (item.body as {role?:string}).role==='assistant')?.body)
     .toMatchObject({output:{public:42,decision:'Complete but malformed response'},validation:'invalid'});
   expect(events.find(item=>item.kind==='error')?.body).toMatchObject({issues:[expect.stringContaining('string')]});
   const steps=await runtime.store.listSteps(observedRunId);
   expect(steps).toHaveLength(1);
   expect(steps[0]!.state).toBe('failed');
   expect((await runtime.store.listAttempts(steps[0]!.id))[0]!.state).toBe('failed');
   expect((await runtime.store.getRun(observedRunId))?.state).toBe('failed');
 });

 it('requires reconciliation if storing the malformed response fails before its failure receipt commits',async()=>{
   const f=await fixture();let observedRunId='',calls=0;
   const faultyPool=new Proxy(pool,{get(target,key){
     if(key==='connect') return async()=>{
       const db=await target.connect();
       return new Proxy(db,{get(client,member){
         if(member==='query') return async(...args:unknown[])=>{
           const params=args[1] as unknown[]|undefined;
           if(typeof args[0]==='string' && args[0].startsWith('INSERT INTO ws_session_events') && params?.[5]==='agent-result') {
             throw new Error('Test session write failed');
           }
           return (client.query as (...args:unknown[])=>Promise<unknown>).apply(client,args);
         };
         const value=Reflect.get(client,member);return typeof value==='function'?value.bind(client):value;
       }});
     };
     const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
   }});
   const service=new WorkflowSpaceService(faultyPool,blobs,actor);
   const runner:AgentRunner={async run<Input,Output>(request){calls++;observedRunId=request.runId;
     return {output:{public:42,decision:'Malformed response'} as Output};}};
   const runtime=await createSpaceRuntime(service,f.space.id,{workflowVersionId:'v1',entrypoint:'content',inputManifestId:f.manifest.id},{underlyingRunner:runner,
     resolveAgent:()=>({nodeId:'writer',inputs:{source:f.source.id},instructions:'Write'}),
     resolvePublication:()=>{throw new Error('No publication expected');}});
   const agent=defineAgent({id:'writer',revision:'1',model:'deterministic-test',reasoningEffort:'low',promptRevision:'1',skillsRevision:'1',permissionsRevision:'1'});
   const workflow={id:'reports',revision:'1',execute:async(ctx)=>ctx.agent('write',agent,{source:'Source bytes'})};
   await expect(runWorkflow({workflow,input:{},...runtime})).rejects.toBeInstanceOf(AtomicStepReconciliationRequiredError);
   expect(calls).toBe(1);
   const context=(await f.service.runtimeContexts(f.space.id,observedRunId))[0]!;
   const events=(await f.service.sessionEvents(f.space.id,context.sessionId)).items;
   expect(events.some(item=>item.kind==='message' && (item.body as {role?:string}).role==='assistant')).toBe(false);
   const step=(await runtime.store.listSteps(observedRunId))[0]!;
   expect(step.state).toBe('running');
   expect((await runtime.store.listAttempts(step.id))[0]!.state).toBe('running');
 });

});
