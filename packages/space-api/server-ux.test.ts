import {afterEach,describe,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createWorkflowSpaceApiHandler,type SpaceApiHost} from './server.js';
import type {SpaceOverview,WorkflowSpaceService} from '@signal-room/workflow-spaces';

const space={id:'s',purpose:'Saved history',owner:'alice',status:'active',createdAt:'2026-01-01T00:00:00Z'} as SpaceOverview['space'];
const version={id:'v',spaceId:'s',revision:'1',createdAt:'2026-01-01T00:00:00Z',changeReason:'first',hash:'hash',config:{},entrypoints:{content:{workflowId:'content',codeRevision:'code',storageContract:{nodes:{},schemas:[],hash:'storage'},process:{revision:'1',hash:'process',nodes:[],edges:[],results:[]}}}} as unknown as SpaceOverview['workflows'][number];
const caseValue={id:'c',spaceId:'s',title:'Exact case',objective:'Goal',constraints:[]} as SpaceOverview['cases'][number];
const run={runId:'r',spaceId:'s',workflowVersionId:'v',entrypoint:'content',caseId:'c',inputManifestId:'m',configHash:'config',effectiveConfig:{}} as SpaceOverview['runs'][number];
const asset={id:'a',spaceId:'s',assetId:'asset',version:1,schema:{namespace:'draft',revision:'1',hash:'schema'},payload:{body:'PRIVATE_BODY'},payloadHash:'payload',source:{kind:'node',runId:'r',stepRunId:'step',attemptId:'attempt',nodeId:'author',producer:'agent',sessionId:'session',contextId:'context'},dependencies:[],attachments:[],initialState:'candidate',createdAt:'2026-01-01T00:00:00Z',state:'candidate'} as SpaceOverview['assets'][number];
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
