import {afterEach, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createWorkflowSpaceApiHandler, type SpaceApiHost} from './server.js';
import type {SpaceOverview, WorkflowSpaceService} from '@signal-room/workflow-spaces';

const imported={id:'input-a',spaceId:'space',assetId:'input',version:1,schema:{namespace:'case/opportunity',revision:'1',hash:'sch'},payload:{title:'Original five questions',text:'SECRET_ORIGINAL_BODY'},payloadHash:'input-hash',source:{kind:'import',actorId:'owner',description:'original'},dependencies:[],attachments:[],initialState:'accepted',createdAt:'2026-01-01T00:00:00Z',state:'accepted'} as SpaceOverview['assets'][number];
const version={id:'v1',spaceId:'space',revision:'1',changeReason:'frozen',hash:'version-hash',createdAt:'2026-01-01T00:00:00Z',config:{},entrypoints:{content:{workflowId:'content',codeRevision:'code',storageContract:{nodes:{},schemas:[],hash:'storage'}}}} as unknown as SpaceOverview['workflows'][number];
const overview:SpaceOverview={space:{id:'space',purpose:'Content',owner:'owner',status:'active',createdAt:'2026-01-01T00:00:00Z'},workflows:[version],cases:[{id:'case',spaceId:'space',title:'MiMo',objective:'Original goal',constraints:['Keep original questions']}],runs:[],assets:[imported],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]};
const entry={id:'baseline-entry',side:'baseline',caseId:'case',inputManifestId:'manifest',repeat:1,workflowVersionId:'v1',entrypoint:'content'} as const;
const candidate={...entry,id:'candidate-entry',side:'candidate' as const};
const plan={id:'plan',spaceId:'space',kind:'prospective',question:'Which author method works?',hypothesis:'Try one change',baseline:{workflowVersionId:'v1',entrypoint:'content'},candidate:{workflowVersionId:'v1',entrypoint:'content'},cases:[{caseId:'case',inputManifestId:'manifest',repeats:1}],standard:{id:'standard',revision:'1',content:'Trust the four questions'},judges:[{kind:'agent',id:'Agent A'}],expectedVariables:['author prompt'],exclusionRules:[],status:'frozen',createdAt:'2026-01-01T00:00:00Z',frozenAt:'2026-01-01T00:00:00Z',entries:[entry,candidate]} as unknown as Awaited<ReturnType<WorkflowSpaceService['validationPlan']>>;
const manifest={id:'manifest',spaceId:'space',caseId:'case',assets:{opportunity:'input-a'},hash:'manifest-hash'};
type Summary=Awaited<ReturnType<WorkflowSpaceService['validationSummary']>>;
function summary(attempts:Summary['entries'][number]['attempts']=[]):Summary{return {plan,entries:[{entry,status:attempts.length?'queued':'missing',requiredJudgeCoverage:[{kind:'agent',id:'Agent A',reviewIds:[],unverifiedReviewIds:[]}],attempts},{entry:candidate,status:'missing',requiredJudgeCoverage:[{kind:'agent',id:'Agent A',reviewIds:[],unverifiedReviewIds:[]}],attempts:[]}],cases:[{caseId:'case',baselineEntryIds:[entry.id],candidateEntryIds:[candidate.id],status:'incomplete'}],pairs:[{caseId:'case',repeat:1,baselineEntryId:entry.id,candidateEntryId:candidate.id,status:'pending',comparisonIds:[],requiredJudgeCoverage:[],changedConditions:{}}],totals:{cases:1,plannedPairs:1,entries:2,attempts:attempts.length,byStatus:{missing:attempts.length?1:2,queued:attempts.length?1:0,excluded:0,pending:0,running:0,cancel_requested:0,interrupted:0,completed:0,failed:0,canceled:0,needs_review:0,reviewed:0}},issues:[],comparisons:[]};}
const active:Server[]=[];
async function serve(input:{service?:Partial<WorkflowSpaceService>;host?:Partial<SpaceApiHost>;member?:()=>boolean}={}){
  const current={value:summary()};let reads=0;
  const service={listSpaces:async()=>input.member?.()===false?[]:[overview.space],overview:async()=>structuredClone(overview),validationPlans:async()=>[plan],validationPlan:async()=>plan,validationSummary:async()=>{reads++;return structuredClone(current.value);},readManifest:async()=>manifest,readAsset:async()=>imported,readContext:async()=>{throw Error('none');},process:async()=>{throw Error('none');},executionTasks:async()=>[],resolvePresentation:async()=>({presentation:{id:'p',revision:'1',entrypoint:'content',label:'Content',assetViews:[{schema:imported.schema,label:'Original input',reader:'input',sections:[]}]},binding:{},history:[]}),...input.service} as unknown as WorkflowSpaceService;
  const handler=createWorkflowSpaceApiHandler({cursorSecret:'test-secret-32-bytes-long-123456789',resolveHost:({request})=>({principal:request.headers.authorization?{id:String(request.headers.authorization),kind:'human'}:undefined,cacheScope:request.headers.authorization,service,scope:{workflowId:'content',entrypoint:'content'},availability:()=>({state:'available',reason:null}),readers:{input:()=>({title:'Original input',sections:[{title:'Five questions',text:'What should the reader learn?',view:'body'}]})},...input.host})});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));active.push(server);
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow-spaces/v1/spaces/space`,current,reads:()=>reads};
}
afterEach(async()=>Promise.all(active.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve())))));
const root='/validation-plans/plan/entries/baseline-entry';
const secured={origin:'http://workbench.test',csrfToken:'session-token',verifyCsrf:async(request:Parameters<NonNullable<SpaceApiHost['commandSecurity']>['verifyCsrf']>[0])=>request.headers['x-space-csrf']==='session-token'};
const postHeaders={authorization:'alice',origin:'http://workbench.test','x-space-csrf':'session-token','content-type':'application/json'};

describe('validation plan API',()=>{
  it('reads the exact frozen entry and manifest with bounded safe queue data',async()=>{
    const service={executionTasks:async()=>[{spaceId:'space',runId:'unlinked',workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest',caseId:'case',executorKey:'runner',status:'queued',owner:'secret-owner',claimToken:'SECRET_CLAIM',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}]};
    const {url}=await serve({service:service as Partial<WorkflowSpaceService>});
    const response=await fetch(url+root,{headers:{authorization:'alice'}}),value=await response.json();
    expect(response.status).toBe(200);
    expect(value).toMatchObject({entryId:'baseline-entry',caseId:'case',manifest:{id:'manifest',hash:'manifest-hash',slots:[{slot:'opportunity',asset:{id:'input-a'},payloadHash:'input-hash'}]},inputSections:[{title:'opportunity · Five questions'}],inputSummary:[],actions:{start:false,resume:false,resumeTarget:null},queue:[{runId:'unlinked',planId:null,entryId:null}]});
    expect(JSON.stringify(value)).not.toContain('SECRET_ORIGINAL_BODY');expect(JSON.stringify(value)).not.toContain('SECRET_CLAIM');
  });
  it('uses an exact schema-revision reader when the frozen presentation has no asset view',async()=>{
    const noView={presentation:{id:'p',revision:'1',entrypoint:'content',label:'Content',assetViews:[]},binding:{},history:[]};
    const reader=()=>({title:'Original questions',sections:[{title:'Goal and five questions',text:'The saved reader goal and questions',view:'body' as const}]});
    const correct=await serve({service:{resolvePresentation:async()=>noView} as Partial<WorkflowSpaceService>,host:{readers:{'case/opportunity@1':reader}}});
    const headers={authorization:'alice'};
    const detail=await (await fetch(correct.url+root,{headers})).json();
    expect(detail.inputSections).toMatchObject([{title:'opportunity · Goal and five questions',text:'The saved reader goal and questions'}]);
    const reading=await (await fetch(`${correct.url}/assets/input-a/reading`,{headers})).json();
    expect(reading).toMatchObject({title:'Original questions',readerStatus:'registered',sections:[{title:'Goal and five questions'}]});
    const wrong=await serve({service:{resolvePresentation:async()=>noView} as Partial<WorkflowSpaceService>,host:{readers:{'case/opportunity@2':reader}}});
    const unmatched=await (await fetch(wrong.url+root,{headers})).json();
    expect(unmatched.inputSections).toEqual([]);
    const fallback=await (await fetch(`${wrong.url}/assets/input-a/reading`,{headers})).json();
    expect(fallback.readerStatus).toBe('fallback');expect(fallback.sections[0].text).toContain('SECRET_ORIGINAL_BODY');
    const explicit=await serve({host:{readers:{input:()=>({title:'Declared reader',sections:[{title:'Configured',text:'Configured section'}]}),'case/opportunity@1':reader}}});
    const preferred=await (await fetch(`${explicit.url}/assets/input-a/reading`,{headers})).json();
    expect(preferred.title).toBe('Declared reader');expect(preferred.sections[0].title).toBe('Configured');
  });
  it('orders frozen input slots from host display preferences without changing their identities',async()=>{
    const material={...imported,id:'input-b',assetId:'materials',schema:{namespace:'case/materials',revision:'1',hash:'materials'},payloadHash:'materials-hash'};
    const snapshot={...overview,assets:[imported,material]};
    const saved={...manifest,assets:{materials:'input-b',opportunity:'input-a'}};
    const {url}=await serve({service:{overview:async()=>snapshot,readManifest:async()=>saved,readAsset:async(_spaceId:string,id:string)=>id==='input-a'?imported:material,resolvePresentation:async()=>null} as Partial<WorkflowSpaceService>,host:{inputSlotOrder:['opportunity','materials'],inputSummary:({assets})=>{expect(assets.map(value=>[value.slot,value.asset.id,value.asset.payloadHash])).toEqual([['opportunity','input-a','input-hash'],['materials','input-b','materials-hash']]);return ['原目标与五问已冻结','2 份输入资产'];},readers:{'case/opportunity@1':()=>({title:'Questions',sections:[{title:'Five questions',text:'Goal'}]}),'case/materials@1':()=>({title:'Materials',sections:[{title:'Source',text:'Evidence'}]})}}});
    const detail=await (await fetch(url+root,{headers:{authorization:'alice'}})).json();
    expect(detail.manifest.slots.map((value:{slot:string;asset:{id:string}})=>[value.slot,value.asset.id])).toEqual([['opportunity','input-a'],['materials','input-b']]);
    expect(detail.inputSections.map((value:{title:string})=>value.title)).toEqual(['opportunity · Five questions','materials · Source']);
    expect(detail.inputSummary).toEqual(['原目标与五问已冻结','2 份输入资产']);
  });
  it('returns trusted review evidence and exact comparison/issue pages without raw profile differences',async()=>{
    const {url,current}=await serve();
    const review={id:'review',spaceId:'space',runId:'run-1',assetVersionIds:['draft-1'],standard:plan.standard,judge:{kind:'agent' as const,id:'Agent A',sessionId:'trusted-session'},evidence:['draft-1'],answers:{good:'Good',bad:'Bad',improvement:'Revise',unresolved:'Question'},createdAt:'2026-01-01T02:00:00Z'};
    current.value=summary([{attempt:1,runId:'run-1',status:'completed',task:{status:'completed'},run:{state:'needs_review'},reviews:[review],judgeEvidence:[{reviewId:'review',verified:true,expectedProfileHash:'expected-hash',observedProfileHash:'observed-hash',differences:{instructions:{expected:'SECRET_PROMPT',observed:'SECRET_PROMPT'},model:{expected:'model-a',observed:'model-a'}}}]}]);
    current.value.entries[1]!.attempts=[{attempt:1,runId:'candidate-run',status:'completed',task:{status:'completed'},run:{state:'needs_review'},reviews:[{...review,id:'other-review',runId:'candidate-run'}],judgeEvidence:[{reviewId:'other-review',verified:true,differences:{}}]}];
    current.value.comparisons=[{id:'comparison',baselineEntryId:entry.id,candidateEntryId:candidate.id,baselineReviewId:'review',candidateReviewId:'other-review',conclusion:'Needs revision',comparison:{id:'comparison',spaceId:'space',baselineReviewId:'review',candidateReviewId:'other-review',conclusion:'Needs revision',changedConditions:{workflowVersion:{baseline:'v1',candidate:'v2'},apiKey:{baseline:'SECRET_KEY',candidate:'SECRET_KEY'}}}}];
    current.value.issues=[{id:'issue',spaceId:'space',planId:'plan',kind:'observation',category:'clarity',text:'Revise the draft',evidence:[{entryId:entry.id,caseId:'case',runId:'run-1'}],createdAt:'2026-01-01T03:00:00Z'}];
    const headers={authorization:'alice'};
    const attempt=await (await fetch(`${url}${root}/attempts/1`,{headers})).json();
    expect(attempt).toMatchObject({runId:'run-1',reviews:[{judge:{kind:'agent',id:'Agent A'},evidence:['draft-1']}],judgeEvidence:[{verified:true,expectedProfileHash:'expected-hash',differences:{model:{expected:'model-a'}}}]});
    expect(JSON.stringify(attempt)).not.toContain('SECRET_PROMPT');
    const comparisons=await (await fetch(`${url}/validation-plans/plan/comparisons?limit=1`,{headers})).json();
    expect(comparisons.items[0]).toMatchObject({id:'comparison',changedConditions:{workflowVersion:{baseline:'v1',candidate:'v2'}}});expect(JSON.stringify(comparisons)).not.toContain('SECRET_KEY');
    const issues=await (await fetch(`${url}/validation-plans/plan/issues`,{headers})).json();
    expect(issues.items[0]).toMatchObject({id:'issue',evidence:[{entryId:entry.id,caseId:'case',runId:'run-1',nodeId:null}]});
    expect((await fetch(`${url}${root}/attempts/2`,{headers})).status).toBe(404);
  });
  it('rejects unsafe command requests before delegation and keeps a read-only host GET-only',async()=>{
    let calls=0,member=true;
    const commands={entryActions:async()=>({start:true,resume:false,reason:null,resumeTarget:null}),startPlanEntry:async()=>{calls++;throw Error('should not run');},dispatchRun:async()=>{calls++;throw Error('should not run');}};
    const {url}=await serve({host:{commands,commandSecurity:secured},member:()=>member});
    const target=`${url}${root}/attempts/1/start`;
    const send=(headers:Record<string,string>,body:string)=>fetch(target,{method:'POST',headers,body});
    expect((await send({...postHeaders,origin:'http://evil.test'},JSON.stringify({inputManifestId:'manifest'}))).status).toBe(403);
    expect((await send({...postHeaders,'x-space-csrf':'wrong'},JSON.stringify({inputManifestId:'manifest'}))).status).toBe(403);
    expect((await send({...postHeaders,authorization:''},JSON.stringify({inputManifestId:'manifest'}))).status).toBe(401);
    member=false;expect((await send(postHeaders,JSON.stringify({inputManifestId:'manifest'}))).status).toBe(403);member=true;
    expect((await send(postHeaders,JSON.stringify({inputManifestId:'manifest',judge:'human'}))).status).toBe(400);
    expect((await send(postHeaders,JSON.stringify({inputManifestId:'other'}))).status).toBe(409);
    expect(calls).toBe(0);
    const readOnly=await serve();
    const denied=await fetch(`${readOnly.url}${root}/attempts/1/start`,{method:'POST',headers:postHeaders,body:JSON.stringify({inputManifestId:'manifest'})});
    expect(denied.status).toBe(405);expect(denied.headers.get('allow')).toBe('GET, HEAD');
  });
  it('accepts a resume target only when the exact plan attempt has a queued task',async()=>{
    const queued=summary([{attempt:1,runId:'run-1',status:'queued',task:{status:'queued'},run:{state:'queued'},reviews:[],judgeEvidence:[]}]);
    const tasks=async()=>[{spaceId:'space',runId:'run-1',workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest',caseId:'case',executorKey:'runner',status:'queued',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}];
    const commands=(runId:string)=>({entryActions:async()=>({start:false,resume:true,reason:null,resumeTarget:{attempt:1,runId}}),startPlanEntry:async()=>{throw Error('not used');},dispatchRun:async()=>{throw Error('not used');}});
    const wrong=await serve({service:{validationSummary:async()=>queued,executionTasks:tasks} as Partial<WorkflowSpaceService>,host:{commands:commands('other-run'),commandSecurity:secured}});
    expect((await fetch(wrong.url+root,{headers:{authorization:'alice'}})).status).toBe(409);
    const valid=await serve({service:{validationSummary:async()=>queued,executionTasks:tasks} as Partial<WorkflowSpaceService>,host:{commands:commands('run-1'),commandSecurity:secured}});
    const entryDto=await (await fetch(valid.url+root,{headers:{authorization:'alice'}})).json();
    expect(entryDto.actions).toMatchObject({resume:true,resumeTarget:{attempt:1,runId:'run-1'}});
  });
  it('delegates exact start and dispatch, preserves approved errors, and invalidates cached reads',async()=>{
    let starts=0,dispatches=0,readCount=0;let state=summary();
    const receipt={requestId:'request-1',planId:'plan',entryId:entry.id,attempt:1,runId:'run-1',caseId:'case',versionId:'v1',inputManifestId:'manifest',inputManifestHash:'manifest-hash',status:'queued',dispatched:false,dispatchError:'Queue unavailable'};
    const commands={entryActions:async()=>({start:true,resume:false,reason:null,resumeTarget:null}),startPlanEntry:async(input:unknown)=>{expect(input).toEqual({spaceId:'space',planId:'plan',entryId:entry.id,attempt:1,inputManifestId:'manifest'});starts++;state=summary([{attempt:1,runId:'run-1',status:'queued',task:{status:'queued'},run:{state:'queued'},reviews:[],judgeEvidence:[]}]);return receipt;},dispatchRun:async(input:unknown)=>{expect(input).toEqual({spaceId:'space',planId:'plan',entryId:entry.id,attempt:1,runId:'run-1'});dispatches++;return {...receipt,dispatched:true,dispatchError:null,status:'running'};}};
    const {url}=await serve({service:{validationSummary:async()=>{readCount++;return structuredClone(state);},executionTasks:async()=>state.entries[0]!.attempts.length?[{spaceId:'space',runId:'run-1',workflowVersionId:'v1',entrypoint:'content',inputManifestId:'manifest',caseId:'case',executorKey:'runner',status:'queued',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'}]:[]} as Partial<WorkflowSpaceService>,host:{commands,commandSecurity:secured}});
    const list=await (await fetch(`${url}${root}`,{headers:{authorization:'alice'}})).json();expect(list.status).toBe('missing');const before=readCount;
    const start=await fetch(`${url}${root}/attempts/1/start`,{method:'POST',headers:postHeaders,body:JSON.stringify({inputManifestId:'manifest'})});expect(start.status).toBe(200);expect((await start.json()).runId).toBe('run-1');
    const after=await (await fetch(`${url}${root}`,{headers:{authorization:'alice'}})).json();expect(after.status).toBe('queued');expect(readCount).toBeGreaterThan(before);
    const repeat=await fetch(`${url}${root}/attempts/1/start`,{method:'POST',headers:postHeaders,body:JSON.stringify({inputManifestId:'manifest'})});expect(repeat.status).toBe(200);expect((await repeat.json()).runId).toBe('run-1');
    expect((await fetch(`${url}${root}/attempts/1/runs/wrong/dispatch`,{method:'POST',headers:postHeaders,body:'{}'})).status).toBe(409);
    const dispatch=await fetch(`${url}${root}/attempts/1/runs/run-1/dispatch`,{method:'POST',headers:postHeaders,body:'{}'});expect(dispatch.status).toBe(200);expect((await dispatch.json()).dispatched).toBe(true);
    expect(starts).toBe(2);expect(dispatches).toBe(1);expect(state.entries[0]!.attempts).toHaveLength(1);
    const errorUrl=await serve({host:{commandSecurity:secured,commands:{...commands,startPlanEntry:async()=>{throw {status:409,code:'CONFLICT',message:'Same key, conflicting input'};}}}});
    const conflict=await fetch(`${errorUrl.url}${root}/attempts/1/start`,{method:'POST',headers:postHeaders,body:JSON.stringify({inputManifestId:'manifest'})});expect(conflict.status).toBe(409);expect((await conflict.json()).error).toMatchObject({code:'CONFLICT',message:'Same key, conflicting input'});
  });
  it('times exact command preflight, delegation and receipt checks without loading a full Space',async()=>{
    let state=summary(),overviews=0,versions=0;
    const receipt={requestId:'request-timed',planId:'plan',entryId:entry.id,attempt:1,runId:'run-timed',caseId:'case',versionId:'v1',inputManifestId:'manifest',inputManifestHash:'manifest-hash',status:'queued',dispatched:false,dispatchError:null};
    const {url}=await serve({service:{overview:async()=>{overviews++;throw Error('full overview forbidden');},readWorkflowVersion:async()=>{versions++;return version;},validationSummary:async()=>state} as Partial<WorkflowSpaceService>,host:{commandSecurity:secured,commands:{entryActions:async()=>({start:true,resume:false,reason:null,resumeTarget:null}),startPlanEntry:async()=>{state=summary([{attempt:1,runId:'run-timed',status:'queued',task:{status:'queued'},run:{state:'queued'},reviews:[],judgeEvidence:[]}]);return receipt;},dispatchRun:async()=>{throw Error('unused');}}}});
    const response=await fetch(`${url}${root}/attempts/1/start`,{method:'POST',headers:postHeaders,body:JSON.stringify({inputManifestId:'manifest'})});
    expect(response.status).toBe(200);expect((await response.json()).runId).toBe('run-timed');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(response.headers.get('server-timing')).toMatch(/membership;dur=.*preflight;dur=.*command;dur=.*receipt;dur=.*total;dur=/);
    expect(versions).toBe(1);expect(overviews).toBe(0);
  });
});
