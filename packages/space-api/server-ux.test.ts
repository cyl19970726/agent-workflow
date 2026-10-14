import {afterEach,describe,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createWorkflowSpaceApiHandler,type SpaceApiHost} from './server.js';
import type {SpaceOverview,WorkflowSpaceService} from '@signal-room/workflow-spaces';
import {artifactPayloadSha256} from '@signal-room/workflow';

const space={id:'s',purpose:'Saved history',owner:'alice',status:'active',createdAt:'2026-01-01T00:00:00Z'} as SpaceOverview['space'];
const version={id:'v',spaceId:'s',revision:'1',createdAt:'2026-01-01T00:00:00Z',changeReason:'first',hash:'hash',config:{},entrypoints:{content:{workflowId:'content',codeRevision:'code',storageContract:{nodes:{},schemas:[],hash:'storage'},process:{revision:'1',hash:'process',nodes:[],edges:[],results:[]}}}} as unknown as SpaceOverview['workflows'][number];
const caseValue={id:'c',spaceId:'s',title:'Exact case',objective:'Goal',constraints:[]} as SpaceOverview['cases'][number];
const run={runId:'r',spaceId:'s',workflowVersionId:'v',entrypoint:'content',caseId:'c',inputManifestId:'m',configHash:'config',effectiveConfig:{}} as SpaceOverview['runs'][number];
const asset={id:'a',spaceId:'s',assetId:'asset',version:1,schema:{namespace:'draft',revision:'1',hash:'schema'},payload:{body:'PRIVATE_BODY'},payloadHash:'a'.repeat(64),source:{kind:'node',runId:'r',stepRunId:'step',attemptId:'attempt',nodeId:'author',producer:'agent',sessionId:'session',contextId:'context'},dependencies:[],attachments:[],initialState:'candidate',createdAt:'2026-01-01T00:00:00Z',state:'candidate'} as SpaceOverview['assets'][number];
const manifest={id:'m',spaceId:'s',caseId:'c',assets:{opportunity:'a'},hash:'manifest'};
const process={run,contract:version.entrypoints.content.process,contractSource:'method',coverage:'observed',occurrences:[],routes:[],relations:[],unmappedStepIds:[]};
const active:Server[]=[];
async function serve(override:Partial<WorkflowSpaceService>={},host:Partial<SpaceApiHost>={}){
  let overviews=0;
  const base={listSpaces:async()=>[space],overview:async()=>{overviews++;throw Error('full overview forbidden on exact route');},readRun:async()=>run,readWorkflowVersion:async()=>version,readCase:async()=>caseValue,readAsset:async()=>asset,readAssetsByIds:async(_space:string,ids:string[])=>ids.map(()=>asset),runAssets:async()=>[asset],caseRunsPage:async()=>[run],versionRunStats:async()=>({runCount:1,caseCount:1}),versionIterationsPage:async()=>[],getExecutionTask:async()=>undefined,executionTasks:async()=>[],readManifest:async()=>manifest,readContext:async()=>{throw Error('no context');},process:async()=>process,resolvePresentation:async()=>null,validationPlans:async()=>[],validationPlan:async()=>{throw Error('no plan');},validationSummary:async()=>{throw Error('no summary');},assetConsumerRuns:async()=>[],reviewsForAsset:async()=>[],...override} as unknown as WorkflowSpaceService;
  const handler=createWorkflowSpaceApiHandler({cursorSecret:'test-secret-32-bytes-long-123456789',resolveHost:({request})=>({principal:request.headers.authorization?{id:String(request.headers.authorization),kind:'human'}:undefined,cacheScope:request.headers.authorization,service:base,scope:{workflowId:'content',entrypoint:'content'},...host})});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));active.push(server);
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow-spaces/v1/spaces/s`,overviews:()=>overviews};
}
afterEach(async()=>Promise.all(active.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve())))));
const headers={authorization:'alice'};
describe('exact UX read projections',()=>{
  it('permits exact auxiliary run assessment but blocks unknown workflows and cross-Space runs',async()=>{
    const auxiliaryVersion={...version,entrypoints:{content:{...version.entrypoints.content,workflowId:'post.review'}}};
    const standard={id:'review-standard',revision:'1',content:'Assess the saved report'};
    const body={id:'review-aux',runId:'r',assetVersionIds:['a'],standard,judge:{kind:'human' as const,id:'alice'},evidence:[],
      answers:{good:'Good',bad:'Bad',improvement:'Improve',unresolved:'Unknown'}};
    let writes=0;
    const service={readRun:async()=>run,readWorkflowVersion:async()=>auxiliaryVersion,
      recordReview:async()=>{writes++;return {...body,spaceId:'s',createdAt:'2026-10-14T00:00:00Z'};}} as Partial<WorkflowSpaceService>;
    const host={scope:{workflowId:'content',auxiliaryWorkflowIds:['post.review'],assessmentWorkflowIds:['post.review'],entrypoint:'content'},
      reviewStandard:async()=>standard,commandSecurity:{origin:'http://example.test',csrfToken:'csrf',verifyCsrf:async()=>true}} as Partial<SpaceApiHost>;
    const post=async(url:string)=>fetch(`${url}/runs/r/reviews`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':'csrf','content-type':'application/json'},body:JSON.stringify(body)});
    const allowed=await serve(service,host);
    expect((await post(allowed.url)).status).toBe(200);expect(writes).toBe(1);
    const readableOnly=await serve(service,{...host,scope:{workflowId:'content',auxiliaryWorkflowIds:['post.review'],entrypoint:'content'}});
    expect((await post(readableOnly.url)).status).toBe(409);expect(writes).toBe(1);
    const unknown=await serve(service,{...host,scope:{workflowId:'content',assessmentWorkflowIds:['post.review'],entrypoint:'content'}});
    expect((await post(unknown.url)).status).toBe(409);expect(writes).toBe(1);
    const otherSpace=await serve({...service,readRun:async()=>({...run,spaceId:'other'})} as Partial<WorkflowSpaceService>,host);
    expect((await post(otherSpace.url)).status).toBe(409);expect(writes).toBe(1);
  });
  it('authorizes an exact native run and rejects unbounded event queries',async()=>{
    const nativeRun={...run,executionMode:'external-host' as const,externalSource:{workspaceId:'native-source',runId:'r'}};
    let calls=0;
    const page={runId:'r',executionMode:'external-host' as const,items:[{id:'event-1',seq:1,type:'siwc.response',timestamp:'2026-10-14T00:00:00Z',
      stepRunId:'step-1',attemptId:'attempt-1',turn:4,requestAttempt:null,httpStatus:null,transport:null,
      response:{outputItems:1,output:[{type:'function_call',name:'review_tool'}],hasText:false,hasFinalText:false,textHash:null},tool:null}],
      nextCursor:null,hasMore:false,snapshotAt:'2026-10-14T00:00:00Z',sanitized:true as const,
      children:[{runId:'child-1',workflowId:'post.review',state:'failed',parentStepRunId:'step-1',binding:'bound' as const}]};
    const {url,overviews}=await serve({readRun:async()=>nativeRun,nativeRunEvents:async(_space,runId,after,limit)=>{
      expect([runId,after,limit]).toEqual(['r',0,50]);calls++;return page;
    }} as Partial<WorkflowSpaceService>);
    const response=await fetch(`${url}/runs/r/native-events`,{headers});expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({runId:'r',items:[{response:{hasFinalText:false}}],children:[{binding:'bound'}]});
    expect((await fetch(`${url}/runs/r/native-events?limit=101`,{headers})).status).toBe(400);
    expect((await fetch(`${url}/runs/other/native-events`,{headers})).status).toBe(409);
    expect(calls).toBe(1);expect(overviews()).toBe(0);
  });
  it('projects only the saved execution mode on exact Case run lists and run detail',async()=>{
    const calls:string[]=[];
    const trial=await serve({}, {runExecutionMode:async({spaceId,runId})=>{expect(spaceId).toBe('s');calls.push(runId);return 'research-trial';}});
    const list=await fetch(`${trial.url}/cases/c/runs`,{headers});expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({items:[{id:'r',executionMode:'research-trial'}]});
    const detail=await fetch(`${trial.url}/runs/r`,{headers});expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({id:'r',executionMode:'research-trial'});
    expect(calls).toEqual(['r','r']);expect(trial.overviews()).toBe(0);
    const future=await serve({}, {runExecutionMode:async()=> 'future-recorded-mode'});
    expect(await (await fetch(`${future.url}/runs/r`,{headers})).json()).toMatchObject({executionMode:'future-recorded-mode'});
    const absent=await serve();
    expect(await (await fetch(`${absent.url}/runs/r`,{headers})).json()).toMatchObject({executionMode:null});
  });
  it('projects exact run asset IDs on the bounded host path without reading the full overview',async()=>{
    const frozen={...asset,id:'99299633-7ad7-4d31-8457-c56938fd742c',source:{kind:'import' as const,actorId:'alice',description:'source'}};
    const processContract={revision:'1',hash:'process',nodes:[{id:'author',kind:'agent',storageNodeId:'author'}],edges:[],results:[]};
    const exactVersion={...version,entrypoints:{content:{...version.entrypoints.content,process:processContract}}};
    const observed={...process,contract:processContract,occurrences:[{id:'step',nodeId:'author',state:'succeeded',provenance:'observed',stepRunIds:['step'],contextIds:['context'],attemptIds:['attempt'],sessionIds:['session'],technicalSteps:[],attemptRecords:[],lifecycleEvidence:[],inputBindings:[{contextId:'context',slot:'opportunity',assetVersionId:frozen.id}],outputBindings:[{contextId:'context',slot:'draft',assetVersionId:asset.id}],inputs:{opportunity:frozen.id},outputs:{draft:[asset.id]}}]};
    const {url,overviews}=await serve({readWorkflowVersion:async()=>exactVersion as never,
      readManifest:async()=>({...manifest,assets:{opportunity:frozen.id}}),process:async()=>observed as never,
      readAssetsByIds:async(_space,ids)=>ids.map(id=>id===frozen.id?frozen:asset) as never});
    const projected=await (await fetch(`${url}/runs/r/process`,{headers})).json();
    expect(projected.graphAssetIds).toEqual([frozen.id,asset.id]);
    const graph=await fetch(`${url}/runs/r/graph`,{headers});expect(graph.status).toBe(200);
    const html=await graph.text();
    expect(html).toContain(`data-node-id="${frozen.id}"`);
    expect(html).toContain(`data-node-id="${asset.id}"`);
    expect(html).toContain('data-edge-id="actual_produces_0"');
    expect(html).not.toContain('expected_output_');
    expect(overviews()).toBe(0);
  });
  it('limits understanding edits to the trusted design Agent and binds saved provenance',async()=>{
    const actor={id:'cognition-root',sessionId:'codex-thread',role:'design' as const};
    const request={expectedRevisionId:null,idempotencyKey:'understanding-1',title:'Goal',content:'# Accurate goal\n',sources:[{kind:'document' as const,ref:'docs/goal.md',title:'Goal source'}],
      authorship:{kind:'agent' as const,name:actor.id,sessionId:actor.sessionId},changeReason:'New evidence'};
    const revision={id:'understanding-1',assetId:'space-business-understanding',revision:1,payloadHash:'h'.repeat(64),createdAt:'2026-01-01T00:00:00Z',previousRevisionId:null,
      title:request.title,content:request.content,sources:request.sources,authorship:request.authorship,changeReason:request.changeReason,
      recordedBy:'trusted-design-service',confirmation:'unconfirmed' as const};
    let writes=0,wrongRecorder=false;
    const understanding={current:async()=>null,read:async()=>revision,history:async()=>[],save:async()=>{writes++;return wrongRecorder?{...revision,recordedBy:'other-principal'}:revision;}};
    const service={spaceSummary:async()=>({space,versionCount:0,caseCount:0,runCount:0,assetCount:0,latestVersionId:null,adoptedVersionId:null})} as Partial<WorkflowSpaceService>;
    const security={origin:'http://example.test',csrfToken:'csrf',verifyCsrf:async()=>true};
    const design=await serve(service,{principal:{id:'trusted-design-service',kind:'service',externalAgent:actor},understanding,commandSecurity:security});
    const summary=await (await fetch(`${design.url}/summary`,{headers})).json();
    expect(summary).toMatchObject({subject:{externalAgent:actor},capabilities:{understandingWrite:true,methodDesignWrite:false,methodPublish:false},csrfToken:'csrf'});
    const post=(url:string,body:unknown)=>fetch(`${url}/understanding/revisions`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':'csrf','content-type':'application/json'},body:JSON.stringify(body)});
    expect((await post(design.url,{...request,authorship:{...request.authorship,name:'another-agent'}})).status).toBe(403);
    expect((await post(design.url,{...request,authorship:{kind:'human',name:'alice'}})).status).toBe(403);
    expect((await post(design.url,{...request,authorship:{...request.authorship,sessionId:'another-thread'}})).status).toBe(403);
    expect(writes).toBe(0);
    const saved=await post(design.url,request);expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({authorship:request.authorship,recordedBy:'trusted-design-service'});
    expect(writes).toBe(1);
    wrongRecorder=true;
    expect((await post(design.url,{...request,idempotencyKey:'understanding-2'})).status).toBe(409);
    wrongRecorder=false;
    const observer=await serve(service,{principal:{id:'trusted-observer-service',kind:'service',externalAgent:{...actor,role:'observer'}},understanding,commandSecurity:security});
    expect(await (await fetch(`${observer.url}/summary`,{headers})).json()).toMatchObject({subject:{externalAgent:{role:'observer'}},capabilities:{understandingWrite:false}});
    expect((await post(observer.url,request)).status).toBe(403);expect(writes).toBe(2);
  });
  it('lists only exact saved review subjects and keeps assessment records scoped to the run',async()=>{
    const review={id:'review-1',spaceId:'s',runId:'r',assetVersionIds:['a'],standard:{id:'standard',revision:'manifest',content:'Frozen criteria'},judge:{kind:'human',id:'alice'},evidence:['a'],answers:{good:'Evidence',bad:'Gap',improvement:'Revise',unresolved:'Question'},createdAt:'2026-01-02T00:00:00Z'};
    const disposition={id:'disposition-1',assetId:'run-disposition:r',runId:'r',revision:1,payloadHash:'hash',createdAt:'2026-01-03T00:00:00Z',previousRevisionId:null,recordedBy:'alice',author:{id:'alice',kind:'human'},confirmation:'unconfirmed' as const,reviewIds:['review-1'],action:'revise' as const,reason:'Need a stronger opening',unknowns:['Audience fit'],evidenceRefs:[{kind:'asset' as const,assetVersionId:'a'}]};
    const {url,overviews}=await serve({reviewsForRun:async()=>[review],readReview:async()=>review} as Partial<WorkflowSpaceService>,{reviewStandard:async()=>({id:'standard',revision:'manifest',content:'Frozen criteria'}),runDisposition:{current:async()=>disposition,read:async()=>disposition,list:async()=>[disposition]}});
    const subjects=await (await fetch(`${url}/runs/r/review-subjects`,{headers})).json();
    expect(subjects).toMatchObject({runId:'r',standard:{content:'Frozen criteria'},subjects:[{kind:'asset',asset:{id:'a'}}]});
    expect(subjects.subjects).toHaveLength(1);
    expect(await (await fetch(`${url}/runs/r/reviews`,{headers})).json()).toMatchObject({items:[{id:'review-1',answers:{bad:'Gap'}}]});
    expect(await (await fetch(`${url}/runs/r/reviews/review-1`,{headers})).json()).toMatchObject({id:'review-1',runId:'r'});
    expect(await (await fetch(`${url}/runs/r/dispositions`,{headers})).json()).toMatchObject({items:[{id:'disposition-1',confirmation:'unconfirmed',author:{id:'alice',kind:'human'}}]});
    expect(await (await fetch(`${url}/runs/r/dispositions/disposition-1`,{headers})).json()).toMatchObject({id:'disposition-1',action:'revise'});
    expect(overviews()).toBe(0);
  });
  it('offers the exact saved failed response hash as a review subject',async()=>{
    const output={script:{title:'Unpublished draft'}},hash=await artifactPayloadSha256(output);
    const observed={...process,occurrences:[{id:'author',nodeId:'author',state:'failed',stepRunIds:['write'],technicalSteps:[{id:'write',key:'draft:write',kind:'agent',state:'succeeded'}],inputBindings:[],outputBindings:[],contextIds:['context'],sessionIds:['session'],attemptIds:['attempt']}]};
    const context={id:'context',spaceId:'s',runId:'r',stepRunId:'write',attemptId:'attempt',sessionId:'session',nodeId:'author',producer:'agent',instructions:'Write',effectiveConfig:{},inputs:{}};
    const {url}=await serve({runAssets:async()=>[],process:async()=>observed,readContext:async()=>context,sessionEvents:async()=>({items:[{id:'event',sessionId:'session',seq:3,attemptId:'attempt',kind:'message',body:{role:'assistant',output},createdAt:'2026-01-02T00:00:00Z'}],nextCursor:3,hasMore:false}),readSavedResponseTarget:async(_space,target)=>({target,output})} as Partial<WorkflowSpaceService>);
    const response=await fetch(`${url}/runs/r/review-subjects`,{headers});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({subjects:[{kind:'response',target:{runId:'r',occurrenceId:'author',eventId:'event',eventSeq:3,outputHash:hash}}]});
  });
  it('rejects stale saved-response hashes and same-origin failures without saving a review',async()=>{
    let writes=0;
    const {url}=await serve({recordReview:async()=>{writes++;throw new Error('Saved response output hash mismatch');}} as Partial<WorkflowSpaceService>,{
      reviewStandard:async()=>({id:'standard',revision:'manifest',content:'Frozen criteria'}),
      commandSecurity:{origin:'http://example.test',csrfToken:'csrf',verifyCsrf:async()=>true},
    });
    const body={id:'review-1',runId:'r',assetVersionIds:[],responseTarget:{runId:'r',occurrenceId:'author',stepRunId:'write',attemptId:'attempt',sessionId:'session',eventId:'event',eventSeq:3,outputHash:'a'.repeat(64)},standard:{id:'standard',revision:'manifest',content:'Frozen criteria'},judge:{kind:'human',id:'alice'},evidence:[],answers:{good:'Good',bad:'Bad',improvement:'Revise',unresolved:'Unknown'}};
    const post=(csrf:string)=>fetch(`${url}/runs/r/reviews`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':csrf,'content-type':'application/json'},body:JSON.stringify(body)});
    expect((await post('wrong')).status).toBe(403);
    expect(writes).toBe(0);
    const response=await post('csrf');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({error:{code:'RELATION_MISMATCH'}});
    expect(writes).toBe(1);
  });
  it('issues an exact external Agent read receipt only for its trusted identity and complete saved output',async()=>{
    const output={script:{title:'Unpublished draft'}},target={runId:'r',occurrenceId:'author',stepRunId:'write',attemptId:'attempt',sessionId:'producer',eventId:'event',eventSeq:3,outputHash:await artifactPayloadSha256(output)};
    const receipt={id:'receipt-1',assetId:'external-agent-observation:x',payloadHash:'receipt-hash',createdAt:'2026-01-02T00:00:00Z',target,observer:{id:'reader',sessionId:'agent-session',servicePrincipalId:'trusted-service'},delivery:'saved-response-read' as const};
    let observed=0;
    const service={readSavedResponseTarget:async(_space:string,selected:typeof target)=>{if(selected.outputHash!==target.outputHash)throw new Error('Saved response output hash mismatch');return {target:selected,output};},observeSavedResponseTarget:async()=>{observed++;return {receipt,output};},readExternalAgentObservation:async()=>receipt} as Partial<WorkflowSpaceService>;
    const security={origin:'http://example.test',csrfToken:'csrf',verifyCsrf:async()=>true};
    const agent=await serve(service,{principal:{id:'trusted-service',kind:'service',externalAgent:{id:'reader',sessionId:'agent-session'}},commandSecurity:security});
    const post=(url:string,selected:typeof target)=>fetch(`${url}/runs/r/review-observations`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':'csrf','content-type':'application/json'},body:JSON.stringify({target:selected})});
    const response=await post(agent.url,target);expect(response.status).toBe(200);
    const body=await response.json();expect(body).toMatchObject({receipt:{id:'receipt-1',observer:{id:'reader',sessionId:'agent-session'}},response:{publication:'unpublished',coverage:'full'}});
    expect(body.response.output).toContain('Unpublished draft');
    expect((await fetch(`${agent.url}/runs/r/review-observations/receipt-1`,{headers})).status).toBe(200);
    expect((await post(agent.url,{...target,outputHash:'a'.repeat(64)})).status).toBe(409);
    expect(observed).toBe(1);
    const human=await serve(service,{commandSecurity:security});
    expect((await post(human.url,target)).status).toBe(403);
    expect(observed).toBe(1);
    const self=await serve({...service,observeSavedResponseTarget:async()=>{throw new Error('Agent observer must be independent from producer');}} as Partial<WorkflowSpaceService>,{principal:{id:'trusted-service',kind:'service',externalAgent:{id:'writer',sessionId:'producer'}},commandSecurity:security});
    const selfResponse=await post(self.url,target);
    expect(selfResponse.status).toBe(409);
    expect(await selfResponse.json()).toMatchObject({error:{code:'RELATION_MISMATCH'}});
  });
  it('observes only the exact published node asset and keeps its review standard target-specific',async()=>{
    const target={runId:'r',assetVersionId:'a',payloadHash:asset.payloadHash};
    const receipt={id:'asset-receipt',assetId:'external-agent-observation:asset',payloadHash:'receipt-hash',createdAt:'2026-01-02T00:00:00Z',target,
      source:asset.source,observer:{id:'reader',sessionId:'agent-session',servicePrincipalId:'trusted-service'},producerNativeSessionIds:['producer-native'],delivery:'published-asset-read' as const};
    let observations=0,reviews=0;
    const service={readPublishedAssetTarget:async(_space:string,selected:typeof target)=>{if(selected.payloadHash!==target.payloadHash)throw new Error('Published asset payload hash mismatch');return {asset,source:asset.source,producerNativeSessionIds:['producer-native']};},
      observePublishedAsset:async()=>{observations++;return {receipt,asset};},readExternalAgentObservation:async()=>receipt,
      recordReview:async()=>{reviews++;throw new Error('External Agent asset review identity or observed target mismatch');}} as Partial<WorkflowSpaceService>;
    const standard={id:'research-standard',revision:'frozen-research',content:'Judge saved research as draft evidence'},authorStandard={id:'author-standard',revision:'frozen-author',content:'Judge delivered draft'};
    const security={origin:'http://example.test',csrfToken:'csrf',verifyCsrf:async()=>true};
    const {url}=await serve(service,{principal:{id:'trusted-service',kind:'service',externalAgent:{id:'reader',sessionId:'agent-session'}},commandSecurity:security,
      reviewStandard:async({target:selected})=>selected?.kind==='asset'?standard:authorStandard,
      readers:{'draft@1':value=>({title:'Research',sections:[{title:'Body',text:String((value.payload as {body:string}).body)}]})}});
    const subjects=await (await fetch(`${url}/runs/r/review-subjects`,{headers})).json();
    expect(subjects.subjects).toMatchObject([{kind:'asset',target,standard}]);
    expect(subjects.standard).toMatchObject(authorStandard);
    const post=(path:string,body:unknown)=>fetch(`${url}/runs/r/${path}`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':'csrf','content-type':'application/json'},body:JSON.stringify(body)});
    const observed=await post('asset-observations',{target});expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({receipt:{id:'asset-receipt',delivery:'published-asset-read',observer:{id:'reader'}},asset:{target,publication:'published',coverage:'full',reading:{readerStatus:'registered',sections:[{text:'PRIVATE_BODY'}]}}});
    expect((await fetch(`${url}/runs/r/review-observations/asset-receipt`,{headers})).status).toBe(200);
    expect((await post('asset-observations',{target:{...target,payloadHash:'b'.repeat(64)}})).status).toBe(409);
    expect(observations).toBe(1);
    const review={id:'review-asset',runId:'r',assetVersionIds:['a'],observationReceiptId:'asset-receipt',standard:authorStandard,judge:{kind:'agent',id:'reader',sessionId:'agent-session'},evidence:[],answers:{good:'Good',bad:'Bad',improvement:'Improve',unresolved:'Unknown'}};
    expect((await post('reviews',review)).status).toBe(409);
    expect(reviews).toBe(0);
    expect((await post('reviews',{...review,standard})).status).toBe(403);
    expect(reviews).toBe(1);
    const human=await serve(service,{commandSecurity:security});
    const humanResult=await fetch(`${human.url}/runs/r/asset-observations`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':'csrf','content-type':'application/json'},body:JSON.stringify({target})});
    expect(humanResult.status).toBe(403);
  });
  it('reads and saves run-scoped diagnosis revisions without registering a candidate',async()=>{
    const evidence={kind:'review' as const,reviewId:'review-1'};
    const issue={id:'issue-1',title:'Research timing',expected:'Current evidence',observed:'Old date',evidenceRefs:[evidence],
      hypotheses:[{id:'hypothesis-1',category:'handoff' as const,explanation:'Input lost',supportRefs:[evidence],counterRefs:[],unknowns:['Prompt effect'],discriminatingCheck:'Inspect saved context'}],
      unknowns:['Whether source changed'],decision:{route:'defer' as const,reason:'Need another source'}};
    const input={runId:'r',reviewIds:['review-1'],dispositionRevisionId:'disposition-1',dispositionPayloadHash:'d'.repeat(64),issues:[issue],expectedRevisionId:null,idempotencyKey:'diagnose-1'};
    const {expectedRevisionId:_expectedRevisionId,idempotencyKey:_idempotencyKey,...savedInput}=input;
    const revision={...savedInput,id:'diagnosis-1',assetId:'run-diagnosis:r',revision:1,payloadHash:'f'.repeat(64),createdAt:'2026-01-03T00:00:00Z',workflowVersionId:'v',previousRevisionId:null,
      author:{id:'alice',kind:'human' as const},recordedBy:'alice',confirmation:'unconfirmed' as const};
    let writes=0;
    const store={current:async()=>null,read:async()=>revision,list:async()=>[revision],save:async(_space:string,value:typeof input)=>{writes++;
      if(value.idempotencyKey==='bad-hash')throw new Error('Diagnosis asset evidence hash mismatch');
      if(value.idempotencyKey==='wrong-trace-session')throw new Error('Trace session is outside the run');
      if(value.idempotencyKey==='bad-trace-sequence')throw new Error('Trace event sequence is invalid');
      if(value.idempotencyKey==='other-agent')throw new Error('Agent diagnosis requires every selected review to be its own observed review');
      if(value.idempotencyKey==='stale-head')throw new Error('Asset version conflict: expected head required');
      return revision;}};
    const security={origin:'http://example.test',csrfToken:'csrf',verifyCsrf:async()=>true};
    const {url}=await serve({}, {runDiagnosis:store,commandSecurity:security});
    expect(await (await fetch(`${url}/runs/r/diagnosis`,{headers})).json()).toBeNull();
    expect(await (await fetch(`${url}/runs/r/diagnoses`,{headers})).json()).toMatchObject({items:[{id:'diagnosis-1',issues:[{id:'issue-1',hypotheses:[{counterRefs:[]}]}]}]});
    expect(await (await fetch(`${url}/runs/r/diagnoses/diagnosis-1`,{headers})).json()).toMatchObject({id:'diagnosis-1',confirmation:'unconfirmed'});
    const post=(body:unknown,csrf='csrf')=>fetch(`${url}/runs/r/diagnoses`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':csrf,'content-type':'application/json'},body:JSON.stringify(body)});
    expect((await post(input,'wrong')).status).toBe(403);expect(writes).toBe(0);
    expect((await post({...input,runId:'other'})).status).toBe(409);expect(writes).toBe(0);
    expect((await post(input)).status).toBe(200);expect(writes).toBe(1);
    const badHash=await post({...input,idempotencyKey:'bad-hash'});expect(badHash.status).toBe(409);
    expect(await badHash.json()).toMatchObject({error:{code:'RELATION_MISMATCH'}});
    const wrongTraceSession=await post({...input,idempotencyKey:'wrong-trace-session'});expect(wrongTraceSession.status).toBe(409);
    expect(await wrongTraceSession.json()).toMatchObject({error:{code:'RELATION_MISMATCH'}});
    const badTraceSequence=await post({...input,idempotencyKey:'bad-trace-sequence'});expect(badTraceSequence.status).toBe(400);
    expect(await badTraceSequence.json()).toMatchObject({error:{code:'INVALID_REQUEST'}});
    const stale=await post({...input,idempotencyKey:'stale-head'});expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({error:{code:'CONFLICT'}});
    expect((await post({...input,candidateDraft:{predecessorVersionId:'v',issueIds:['issue-1'],hypothesisIds:['hypothesis-1'],changes:[{target:'prompt',before:'old',after:'new',reason:'test'}],expectedBenefits:[],risks:['Risk'],validationPlan:'Test',falsificationConditions:['No improvement'],conditions:[]}})).status).toBe(400);
    const agent=await serve({}, {principal:{id:'service',kind:'service',externalAgent:{id:'reader',sessionId:'session'}},runDiagnosis:store,commandSecurity:security});
    const noReceipt=await fetch(`${agent.url}/runs/r/diagnoses`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':'csrf','content-type':'application/json'},body:JSON.stringify(input)});
    expect(noReceipt.status).toBe(403);expect(writes).toBe(5);
    const otherAgent=await fetch(`${agent.url}/runs/r/diagnoses`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':'csrf','content-type':'application/json'},body:JSON.stringify({...input,idempotencyKey:'other-agent',observationReceiptId:'receipt-1'})});
    expect(otherAgent.status).toBe(403);expect(writes).toBe(6);
  });
  it('exposes diagnosis write on the light summary without requiring an execution command',async()=>{
    const store={current:async()=>null,read:async()=>{throw Error('unused');},list:async()=>[],save:async()=>{throw Error('unused');}};
    const {url,overviews}=await serve({spaceSummary:async()=>({space,versionCount:1,caseCount:1,runCount:1,assetCount:1,latestVersionId:'v',adoptedVersionId:null})} as Partial<WorkflowSpaceService>,
      {runDiagnosis:store,commandSecurity:{origin:'http://example.test',csrfToken:'csrf',verifyCsrf:async()=>true}});
    const summary=await (await fetch(`${url}/summary`,{headers})).json();
    expect(summary).toMatchObject({capabilities:{diagnosisRead:true,diagnosisWrite:true},csrfToken:'csrf'});
    expect(overviews()).toBe(0);
  });
  it('refuses Agent review and disposition writes without the authenticated observed identity',async()=>{
    let reviews=0,dispositions=0;
    const {url}=await serve({recordReview:async()=>{reviews++;throw new Error('must not save');}} as Partial<WorkflowSpaceService>,{
      principal:{id:'trusted-service',kind:'service',externalAgent:{id:'reader',sessionId:'agent-session'}},
      reviewStandard:async()=>({id:'standard',revision:'manifest',content:'Frozen criteria'}),
      runDisposition:{current:async()=>null,read:async()=>{throw Error('not found');},list:async()=>[],save:async()=>{dispositions++;throw Error('must not save');}},
      commandSecurity:{origin:'http://example.test',csrfToken:'csrf',verifyCsrf:async()=>true},
    });
    const request=(path:string,body:unknown)=>fetch(`${url}${path}`,{method:'POST',headers:{...headers,origin:'http://example.test','x-space-csrf':'csrf','content-type':'application/json'},body:JSON.stringify(body)});
    const target={runId:'r',occurrenceId:'author',stepRunId:'write',attemptId:'attempt',sessionId:'producer',eventId:'event',eventSeq:3,outputHash:'a'.repeat(64)};
    const review={id:'review-1',runId:'r',assetVersionIds:[],responseTarget:target,standard:{id:'standard',revision:'manifest',content:'Frozen criteria'},judge:{kind:'agent',id:'other',sessionId:'agent-session'},evidence:[],answers:{good:'Good',bad:'Bad',improvement:'Revise',unresolved:'Unknown'}};
    expect((await request('/runs/r/reviews',review)).status).toBe(403);
    expect((await request('/runs/r/reviews',{...review,judge:{kind:'agent',id:'reader',sessionId:'agent-session'}})).status).toBe(403);
    expect((await request('/runs/r/dispositions',{runId:'r',reviewIds:['review-1'],action:'defer',reason:'Unknown',unknowns:[],evidenceRefs:[],expectedRevisionId:null,idempotencyKey:'key'})).status).toBe(403);
    expect(reviews).toBe(0);expect(dispositions).toBe(0);
  });
  it('returns exact frozen input slots with their asset payload hashes',async()=>{
    const {url,overviews}=await serve();
    const response=await fetch(`${url}/runs/r/inputs`,{headers});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({runId:'r',caseId:'c',versionId:'v',inputManifestId:'m',inputManifestHash:'manifest',slots:[{slot:'opportunity',asset:{id:'a'},payloadHash:asset.payloadHash}]});
    expect(overviews()).toBe(0);
  });
  it('bounds saved session events to an exact run and redacts credentials recursively',async()=>{
    const observed={...process,occurrences:[{id:'occ',nodeId:'author',state:'failed',stepRunIds:['step'],inputBindings:[],outputBindings:[],contextIds:['context'],sessionIds:['session'],attemptIds:['attempt']}]};
    const context={id:'context',spaceId:'s',runId:'r',stepRunId:'step',attemptId:'attempt',sessionId:'session',nodeId:'author',instructions:'Write',effectiveConfig:{},inputs:{}};
    const {url,overviews}=await serve({process:async()=>observed,readContext:async()=>context,sessionEvents:async(_space,_session,after)=>after?{items:[{id:'event-2',sessionId:'session',seq:2,attemptId:'attempt',kind:'trace',body:{message:'Done'},createdAt:'2026-01-01T00:00:01Z'}],nextCursor:2,hasMore:false}:{items:[{id:'event-1',sessionId:'session',seq:1,attemptId:'attempt',kind:'tool',body:{apiKey:'private-key',headers:{authorization:'Bearer topsecret'},details:{text:'Authorization: Bearer topsecret',url:'https://example.test/file?X-Amz-Signature=secret123&safe=1',result:'saved result'}},createdAt:'2026-01-01T00:00:00Z'},{id:'foreign',sessionId:'session',seq:1,attemptId:'another-run',kind:'tool',body:{secret:'foreign'},createdAt:'2026-01-01T00:00:00Z'}],nextCursor:1,hasMore:true}} as Partial<WorkflowSpaceService>);
    const first=await fetch(`${url}/runs/r/sessions/session/events?after=0&limit=2`,{headers});
    expect(first.status).toBe(200);
    const one=await first.json();expect(one).toMatchObject({runId:'r',sessionId:'session',nextCursor:1,hasMore:true,items:[{id:'event-1',kind:'tool'}]});
    expect(JSON.stringify(one)).toContain('saved result');
    expect(JSON.stringify(one)).not.toMatch(/private-key|topsecret|foreign|secret123/u);
    const two=await (await fetch(`${url}/runs/r/sessions/session/events?after=1`,{headers})).json();
    expect(two).toMatchObject({items:[{id:'event-2'}],hasMore:false});
    expect((await fetch(`${url}/runs/r/sessions/other/events`,{headers})).status).toBe(404);
    expect((await fetch(`${url}/runs/r/sessions/session/events?after=-1`,{headers})).status).toBe(400);
    expect((await fetch(`${url}/runs/r/sessions/session/events?limit=101`,{headers})).status).toBe(400);
    expect(overviews()).toBe(0);
  });
  it('reads the exact saved assistant output as unpublished response without exposing unrelated attempts',async()=>{
    const observed={...process,occurrences:[{id:'author',nodeId:'author',state:'failed',stepRunIds:['write'],technicalSteps:[{id:'write',key:'draft:write',kind:'agent',state:'succeeded'}],inputBindings:[],outputBindings:[],contextIds:['context'],sessionIds:['session'],attemptIds:['attempt']}]};
    const context={id:'context',spaceId:'s',runId:'r',stepRunId:'write',attemptId:'attempt',sessionId:'session',nodeId:'author',instructions:'Write',effectiveConfig:{},inputs:{}};
    const events=[{id:'foreign',sessionId:'session',seq:1,attemptId:'other',kind:'message',body:{role:'assistant',output:{secret:'foreign'}},createdAt:'2026-01-01T00:00:00Z'},
      {id:'draft',sessionId:'session',seq:2,attemptId:'attempt',kind:'message',body:{role:'assistant',output:{script:{title:'Saved manuscript'},authorization:'Bearer topsecret'}},createdAt:'2026-01-01T00:00:01Z'}];
    let readerInput:unknown;
    const {url,overviews}=await serve({process:async()=>observed,readContext:async()=>context,sessionEvents:async()=>({items:events,nextCursor:2,hasMore:false})} as Partial<WorkflowSpaceService>,{unpublishedResponseReader:({nodeId,output})=>{readerInput={nodeId,output};return {title:'Saved draft',sections:[{title:'Manuscript',text:(output as {script:{title:string}}).script.title}]};}});
    const response=await fetch(`${url}/runs/r/occurrences/author/responses`,{headers});
    expect(response.status).toBe(200);
    const body=await response.json();expect(body).toMatchObject({runId:'r',occurrenceId:'author',responses:[{stepRunId:'write',attemptId:'attempt',sessionId:'session',eventId:'draft',eventSeq:2,publication:'unpublished',coverage:'full',reading:{title:'Saved draft',readerStatus:'registered',sections:[{title:'Manuscript',text:'Saved manuscript'}],reason:null}}]});
    expect(readerInput).toMatchObject({nodeId:'author',output:{authorization:'[REDACTED]'}});
    expect(body.responses[0].output).toContain('Saved manuscript');
    expect(JSON.stringify(body)).not.toMatch(/foreign|topsecret/u);
    expect(overviews()).toBe(0);
    const fallback=await serve({process:async()=>observed,readContext:async()=>context,sessionEvents:async()=>({items:events,nextCursor:2,hasMore:false})} as Partial<WorkflowSpaceService>);
    expect(await (await fetch(`${fallback.url}/runs/r/occurrences/author/responses`,{headers})).json()).toMatchObject({responses:[{reading:{readerStatus:'fallback',reason:'此方法尚未提供响应阅读器'}}]});
    const large=await serve({process:async()=>observed,readContext:async()=>context,sessionEvents:async()=>({items:[{...events[1],body:{role:'assistant',output:{text:'x'.repeat(1_000_100)}}}],nextCursor:2,hasMore:false})} as Partial<WorkflowSpaceService>,{unpublishedResponseReader:()=>{throw Error('must not render truncated output');}});
    expect(await (await fetch(`${large.url}/runs/r/occurrences/author/responses`,{headers})).json()).toMatchObject({responses:[{coverage:'truncated',reading:{readerStatus:'fallback',reason:'保存的响应超过阅读上限，无法完整解析'}}]});
    const published=await serve({process:async()=>({...observed,occurrences:[{...observed.occurrences[0],outputBindings:[{contextId:'context',slot:'draft',assetVersionId:'a'}]}]}),readContext:async()=>context,sessionEvents:async()=>{throw Error('must not read published response');}} as Partial<WorkflowSpaceService>);
    expect(await (await fetch(`${published.url}/runs/r/occurrences/author/responses`,{headers})).json()).toMatchObject({responses:[]});
  });
  it('polls a scoped light summary without overview and still checks membership on every request',async()=>{
    let reads=0,memberships=0,allowed=true;
    const {url,overviews}=await serve({listSpaces:async()=>{memberships++;return allowed?[space]:[];},spaceSummary:async(_space,scope)=>{
      expect(scope).toEqual({workflowId:'content',entrypoint:'content',adoptionSlot:'published'});reads++;
      return {space,versionCount:2,caseCount:3,runCount:1,assetCount:9,latestVersionId:'v',adoptedVersionId:null};
    }} as Partial<WorkflowSpaceService>,{scope:{workflowId:'content',entrypoint:'content',adoptionSlot:'published'}});
    const first=await fetch(`${url}/summary`,{headers}),value=await first.json();
    expect(value).toMatchObject({latestVersionId:'v',adoptedVersionId:null,counts:{versions:2,cases:3,runs:1,assets:9}});
    expect(first.headers.get('server-timing')).toMatch(/membership;dur=.*subject;dur=.*cache;desc="hit=0 miss=1"/);
    expect((await fetch(`${url}/summary`,{headers})).status).toBe(200);
    expect(reads).toBe(1);expect(memberships).toBe(2);expect(overviews()).toBe(0);
    allowed=false;expect((await fetch(`${url}/summary`,{headers})).status).toBe(403);
  });
  it('keeps run progress, task state and timing separate without loading the full Space',async()=>{
    const {url,overviews}=await serve({getExecutionTask:async()=>({status:'completed',error:null,createdAt:'2026-01-02T00:00:00Z'}),} as Partial<WorkflowSpaceService>,{runSummary:async()=>({state:'needs_review',reason:'awaiting-human-review',progress:'等待创作者评价',primaryAssetVersionId:'a'})});
    const response=await fetch(`${url}/runs/r`,{headers}),value=await response.json();
    expect(response.status).toBe(200);expect(value).toMatchObject({state:'needs_review',taskState:'completed',reason:'awaiting-human-review',progress:'等待创作者评价',primaryAssetId:'a'});
    expect(response.headers.get('x-request-id')).toBeTruthy();expect(response.headers.get('server-timing')).toMatch(/membership;dur=.*subject;dur=.*projection;dur=.*cache;desc="hit=\d+ miss=\d+"/);
    expect(JSON.stringify(value)).not.toContain('PRIVATE_BODY');expect(overviews()).toBe(0);
  });
  it('pages cases before projecting statuses and reads process with only exact bound assets',async()=>{
    let summaryCalls=0,processCalls=0;
    const second={...run,runId:'r2'};
    const {url,overviews}=await serve({caseRunsPage:async(_space,_case,_workflow,_entry,_after,limit)=>{expect(limit).toBe(2);return [run,second];},process:async()=>{processCalls++;return process;}} as Partial<WorkflowSpaceService>,{runSummary:async()=>{summaryCalls++;return {state:'queued',progress:'已派发，准备执行'};}});
    const listing=await (await fetch(`${url}/cases/c/runs?limit=1`,{headers})).json();expect(listing.items).toHaveLength(1);expect(listing.nextCursor).toBeTruthy();expect(summaryCalls).toBe(1);
    const response=await fetch(`${url}/runs/r/process`,{headers});expect(response.status).toBe(200);expect((await response.json()).runId).toBe('r');expect(processCalls).toBe(1);expect(overviews()).toBe(0);
  });
  it('returns only saved version iterations with scoped cursor and no adoption claim',async()=>{
    const iteration={id:'i1',workflowVersionId:'v',hypothesis:'Shorter opening',reviewIds:['review'],caseIds:['c'],runIds:['r']};
    const {url,overviews}=await serve({versionIterationsPage:async(_space,_version,_after,limit)=>{expect(limit).toBe(2);return [iteration,{...iteration,id:'i2'}];}} as Partial<WorkflowSpaceService>);
    const response=await fetch(`${url}/versions/v/iterations?limit=1`,{headers}),value=await response.json();
    expect(response.status).toBe(200);expect(value.items).toEqual([iteration]);expect(value.nextCursor).toBeTruthy();expect(JSON.stringify(value)).not.toContain('adopted');expect(overviews()).toBe(0);
    expect((await fetch(`${url}/versions/v/iterations?cursor=${encodeURIComponent(value.nextCursor)}&limit=1`,{headers:{authorization:'bob'}})).status).toBe(400);
  });
  it('requests version counts for the exact entrypoint and workflow in a multi-entry version',async()=>{
    const multi={...version,entrypoints:{...version.entrypoints,analysis:{...version.entrypoints.content,workflowId:'analysis'}}};
    const calls:Array<unknown[]>=[];
    const {url,overviews}=await serve({readWorkflowVersion:async()=>multi,versionRunStats:async(...args)=>{calls.push(args);return {runCount:1,caseCount:1};}} as Partial<WorkflowSpaceService>);
    const detail=await (await fetch(`${url}/versions/v`,{headers})).json();
    expect(detail).toMatchObject({id:'v',entrypoint:'content',runCount:1,caseCount:1});
    expect(calls).toEqual([['s','v','content','content']]);expect(overviews()).toBe(0);
  });
  it('rejects a process whose saved run identity disagrees with the selected run',async()=>{
    const mismatches=[{spaceId:'other'},{runId:'other'},{workflowVersionId:'other'},{caseId:'other'},{entrypoint:'other'},{inputManifestId:'other'}];
    for(const mismatch of mismatches){
      const {url,overviews}=await serve({process:async()=>({...process,run:{...run,...mismatch}})} as unknown as Partial<WorkflowSpaceService>);
      const response=await fetch(`${url}/runs/r/process`,{headers});
      expect(response.status).toBe(409);expect((await response.json()).error.code).toBe('RELATION_MISMATCH');expect(overviews()).toBe(0);
    }
  });
  it('reads every exact review target and rejects revoked membership',async()=>{
    let member=true;const review={id:'review',spaceId:'s',runId:'r',assetVersionIds:['a'],standard:{id:'standard',revision:'1',content:'four questions'},judge:{kind:'agent',id:'judge'},evidence:[],answers:{good:'Good',bad:'Bad',improvement:'Improve',unresolved:'Unknown'},createdAt:'2026-01-01T00:00:00Z'};
    const {url,overviews}=await serve({listSpaces:async()=>member?[space]:[],readReview:async()=>review} as Partial<WorkflowSpaceService>);
    const response=await fetch(`${url}/reviews/review`,{headers}),value=await response.json();expect(response.status).toBe(200);expect(value).toMatchObject({review:{id:'review'},assets:[{id:'a'}]});expect(JSON.stringify(value)).not.toContain('PRIVATE_BODY');expect(overviews()).toBe(0);
    member=false;expect((await fetch(`${url}/reviews/review`,{headers})).status).toBe(403);
  });
  it('binds both comparison sides to one saved terminal review target and rejects ambiguity',async()=>{
    const otherRun={...run,runId:'r2'},otherAsset={...asset,id:'b',assetId:'asset-b',source:{...asset.source,runId:'r2'}} as SpaceOverview['assets'][number];
    const standard={id:'standard',revision:'1',content:'Trust four answers'};
    const review=(id:string,runId:string,assetId:string)=>({id,spaceId:'s',runId,assetVersionIds:[assetId],standard,judge:{kind:'agent',id:'judge'},evidence:[],answers:{good:'Good',bad:'Bad',improvement:'Improve',unresolved:'Question'},createdAt:'2026-01-01T00:00:00Z'});
    const first=review('baseline-review','r','a'),second=review('candidate-review','r2','b');
    const makeAttempt=(runId:string,value:ReturnType<typeof review>)=>({attempt:1,runId,status:'reviewed',task:{status:'completed'},run:{state:'needs_review'},reviews:[value],judgeEvidence:[{reviewId:value.id,verified:true,differences:{}}]});
    const plan={id:'plan',spaceId:'s',standard};
    const entries=[{entry:{id:'baseline-entry',side:'baseline',caseId:'c',repeat:1,entrypoint:'content',workflowVersionId:'v',inputManifestId:'m'},attempts:[makeAttempt('r',first)]},{entry:{id:'candidate-entry',side:'candidate',caseId:'c',repeat:1,entrypoint:'content',workflowVersionId:'v',inputManifestId:'m'},attempts:[makeAttempt('r2',second)]}];
    const comparison={id:'comparison',baselineEntryId:'baseline-entry',candidateEntryId:'candidate-entry',baselineReviewId:first.id,candidateReviewId:second.id,conclusion:'Candidate helps',comparison:{baselineReviewId:first.id,candidateReviewId:second.id}};
    const saved={plan,entries,pairs:[{caseId:'c',repeat:1,baselineEntryId:'baseline-entry',candidateEntryId:'candidate-entry'}],comparisons:[comparison]};
    const subjectProcess=(selected:typeof run,id:string,round:number)=>({...process,run:selected,occurrences:[{id:`occ-${id}`,nodeId:'author',round,state:'succeeded',inputBindings:[],outputBindings:[{assetVersionId:id}],contextIds:[],sessionIds:[],attemptIds:[]}]});
    const {url,overviews}=await serve({validationSummary:async()=>saved,readRun:async(_space,id)=>id==='r'?run:otherRun,readAsset:async(_space,id)=>id==='a'?asset:otherAsset,process:async(_space,id)=>id==='r'?subjectProcess(run,'a',2):subjectProcess(otherRun,'b',3),resolvePresentation:async()=>({presentation:{assetViews:[{schema:asset.schema,label:'完整稿件'}]}})} as unknown as Partial<WorkflowSpaceService>);
    const reading=await (await fetch(`${url}/validation-plans/plan/comparisons/comparison/reading`,{headers})).json();
    expect(reading).toMatchObject({status:'ready',baseline:{runId:'r',asset:{id:'a',title:'完整稿件',round:2,occurrenceId:'occ-a'}},candidate:{runId:'r2',asset:{id:'b',title:'完整稿件',round:3,occurrenceId:'occ-b'}}});
    expect(JSON.stringify(reading)).not.toContain('PRIVATE_BODY');expect(overviews()).toBe(0);
    saved.entries[0]!.attempts.push(makeAttempt('r',first));
    const ambiguous=await (await fetch(`${url}/validation-plans/plan/comparisons/comparison/reading`,{headers:{authorization:'bob'}})).json();
    expect(ambiguous).toMatchObject({status:'unavailable',baseline:null,candidate:null});
    saved.entries[0]!.attempts.pop();saved.entries[0]!.attempts[0]!.run.state='running';
    const active=await (await fetch(`${url}/validation-plans/plan/comparisons/comparison/reading`,{headers:{authorization:'carol'}})).json();
    expect(active).toMatchObject({status:'unavailable',baseline:null,candidate:null});
  });
  it('reads an exact imported asset without overview and pages consumers across saved run bindings',async()=>{
    const input={...asset,id:'input',assetId:'input',source:{kind:'import' as const,actorId:'alice',description:'frozen'},dependencies:[]};
    const second={...run,runId:'r2'};
    const occurrence=(id:string)=>({id,nodeId:'author',round:1,state:'succeeded',inputBindings:[{contextId:'ctx',slot:'source',assetVersionId:'input'}],outputBindings:[],contextIds:[],sessionIds:[],attemptIds:[]});
    let processes=0,consumerQueries=0;
    const {url,overviews}=await serve({readAsset:async()=>input,readAssetsByIds:async(_space,ids)=>ids.map(()=>input),assetConsumerRuns:async()=>{consumerQueries++;return [run,second];},process:async(_space,id)=>{processes++;return {...process,run:id==='r'?run:second,occurrences:[occurrence(`occ-${id}`)]};}} as unknown as Partial<WorkflowSpaceService>,{readers:{'draft@1':()=>({title:'Original input',sections:[{title:'Source',text:'PRIVATE_BODY'}]})}});
    const reading=await (await fetch(`${url}/assets/input/reading`,{headers})).json();
    expect(reading).toMatchObject({asset:{id:'input',sourceKind:'import'},title:'Original input',readerStatus:'registered'});
    const response=await fetch(`${url}/assets/input/relations?limit=1`,{headers}),first=await response.json();
    expect(response.status).toBe(200);expect(first).toMatchObject({producer:null,consumers:[{runId:'r',occurrenceId:'occ-r'}]});expect(first.nextCursor).toBeTruthy();
    const secondPage=await (await fetch(`${url}/assets/input/relations?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,{headers})).json();
    expect(secondPage.consumers).toMatchObject([{runId:'r2',occurrenceId:'occ-r2'}]);
    expect(processes).toBe(2);expect(consumerQueries).toBe(1);expect(overviews()).toBe(0);
    expect(JSON.stringify(first)).not.toContain('PRIVATE_BODY');
  });
  it('projects exact saved rounds for same-run dependencies and assessments only',async()=>{
    const prior={...asset,id:'prior',assetId:'prior',createdAt:'2025-12-31T00:00:00Z'};
    const selected={...asset,dependencies:['prior']};
    const assessment={...asset,id:'assessment',assetId:'assessment',schema:{namespace:'review',revision:'1',hash:'review-schema'},dependencies:['a']};
    const imported={...asset,id:'imported',assetId:'imported',schema:{namespace:'material',revision:'1',hash:'material-schema'},source:{kind:'import' as const,actorId:'alice',description:'frozen'}};
    selected.dependencies.push('imported');
    const assets=[prior,selected,assessment,imported];
    const occurrence=(id:string,round:number,nodeId:string)=>({id:`occ-${id}`,nodeId,round,state:'succeeded',inputBindings:[],outputBindings:[{contextId:'context',slot:'result',assetVersionId:id}],contextIds:[],sessionIds:[],attemptIds:[]});
    let processReads=0;
    const {url,overviews}=await serve({readAsset:async()=>selected,readAssetsByIds:async(_space,ids)=>ids.map(id=>assets.find(value=>value.id===id)!),runAssets:async()=>[prior,selected,assessment],process:async()=>{processReads++;return {...process,occurrences:[occurrence('prior',2,'author'),occurrence('a',3,'author'),occurrence('assessment',3,'editor')]};}} as unknown as Partial<WorkflowSpaceService>,{adapter:{resolveRun:async()=>({state:'needs_review',primaryAssetVersionId:'a',assessmentAssetVersionIds:['assessment']})}});
    const response=await fetch(`${url}/assets/a/relations`,{headers}),relations=await response.json();
    expect(response.status).toBe(200);
    expect(relations).toMatchObject({producer:{occurrenceId:'occ-a',round:3},previousDraft:{id:'prior',occurrenceId:'occ-prior',round:2},assessments:[{id:'assessment',occurrenceId:'occ-assessment',round:3,nodeId:'editor'}]});
    expect(relations.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({id:'prior',round:2}),expect.objectContaining({id:'imported',runId:null,occurrenceId:null,round:null})]));
    expect(processReads).toBe(1);expect(overviews()).toBe(0);
    expect(JSON.stringify(relations)).not.toContain('PRIVATE_BODY');
  });
});
