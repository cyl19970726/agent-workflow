import {afterEach, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createWorkflowSpaceApiHandler, type SpaceApiHost} from './server.js';
import type {WorkflowSpaceService} from '@signal-room/workflow-spaces';

const space={id:'s',purpose:'Content',owner:'alice',status:'active' as const,createdAt:'2026-01-01T00:00:00Z'};
const method={id:'v',spaceId:'s',revision:'1',hash:'vhash',createdAt:'2026-01-01T00:00:00Z',changeReason:'method',config:{},entrypoints:{content:{workflowId:'content',codeRevision:'1',storageContract:{hash:'storage',nodes:{},schemas:[]}}}};
const caseValue={id:'c',spaceId:'s',title:'New brief',objective:'Explain the idea',constraints:[]};
const manifest={id:'m',spaceId:'s',caseId:'c',assets:{material:'input'},hash:'mhash'};
const input={id:'input',spaceId:'s',assetId:'input',version:1,schema:{namespace:'content/material',revision:'1',hash:'schema'},payload:{text:'source'},payloadHash:'hash',source:{kind:'import' as const,actorId:'alice',description:'source'},dependencies:[],attachments:[],initialState:'imported',createdAt:'2026-01-01T00:00:00Z',state:'imported'};
const draft={...input,id:'draft',assetId:'draft',schema:{namespace:'content/draft',revision:'1',hash:'draft-schema'},source:{kind:'node' as const,runId:'r',stepRunId:'step',attemptId:'attempt',nodeId:'author',producer:'agent' as const,sessionId:'session',contextId:'context'}};
const run={runId:'r',spaceId:'s',workflowVersionId:'v',entrypoint:'content',caseId:'c',inputManifestId:'m',effectiveConfig:{},configHash:'config'};
const prepared={caseId:'c',caseTitle:'New brief',objective:'Explain the idea',versionId:'v',versionLabel:'Method',inputManifestId:'m',inputManifestHash:'mhash',inputs:[{id:'input',title:'Material',kind:'material',state:'imported',createdAt:input.createdAt,schema:input.schema,payloadHash:input.payloadHash,sourceKind:'import' as const,runId:null,caseId:null,versionId:null,nodeId:null,occurrenceId:null,round:null}],sections:[{title:'Source',text:'source'}],conditions:['No web'],runs:[],actions:{start:true,dispatch:false,reason:null}};
const receipt={requestId:'request',caseId:'c',versionId:'v',inputManifestId:'m',inputManifestHash:'mhash',runId:'r',status:'queued',dispatched:false,dispatchError:null};
const note={id:'note',caseId:'c',runId:'r',subjectAssetId:'draft',createdAt:'2026-01-01T00:00:00Z',author:{kind:'external-agent' as const,name:'Cognition',threadId:'thread'},importedBy:'alice',verification:'declared-external' as const,answers:{good:'Clear',bad:'Gap',improvement:'Revise',unresolved:'Evidence'},recommendation:'needs_revision' as const,nextStep:'Revise draft',referencedAssetIds:[]};
const body={key:'note-key',author:note.author,answers:note.answers,recommendation:note.recommendation,nextStep:note.nextStep,referencedAssetIds:[]};
const active:Server[]=[];
async function serve(options:{member?:boolean;business?:Partial<NonNullable<SpaceApiHost['business']>>;service?:Partial<WorkflowSpaceService>;security?:boolean;host?:Partial<SpaceApiHost>}={}){
  let starts=0,dispatches=0,prepares=0,notes=0;
  const service={listSpaces:async()=>options.member===false?[]:[space],overview:async()=>({space,workflows:[method],cases:[caseValue],runs:[run],assets:[input,draft],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]}),readWorkflowVersion:async()=>method,readCase:async()=>caseValue,readManifest:async()=>manifest,readRun:async()=>run,readAsset:async(_spaceId:string,id:string)=>id==='draft'?draft:input,validationPlans:async()=>{throw Error('plan must not be read')},validationPlan:async()=>{throw Error('plan must not be read')},validationSummary:async()=>{throw Error('plan must not be read')},readContext:async()=>{throw Error('unused')},process:async()=>{throw Error('unused')},executionTasks:async()=>[],resolvePresentation:async()=>null,...options.service} as unknown as WorkflowSpaceService;
  const business={form:async()=>({title:'New work',description:'Prepare inputs',fields:[{key:'objective',label:'Goal',kind:'multiline' as const,required:true}],conditions:[]}),prepare:async()=>{prepares++;return prepared},preparation:async()=>prepared,start:async()=>{starts++;return receipt},dispatch:async()=>{dispatches++;return {...receipt,dispatched:true,status:'running'}},handlingNotes:async()=>[note],readHandlingNote:async()=>note,addHandlingNote:async()=>{notes++;return note},...options.business} as NonNullable<SpaceApiHost['business']>;
  const handler=createWorkflowSpaceApiHandler({cursorSecret:'test-secret-32-bytes-long-123456789',resolveHost:({request})=>({principal:request.headers.authorization?{id:String(request.headers.authorization),kind:'human'}:undefined,cacheScope:String(request.headers.authorization??''),service,scope:{workflowId:'content',entrypoint:'content'},availability:()=>({state:'available',reason:null}),business,commandSecurity:options.security===false?undefined:{origin:'http://workbench.test',csrfToken:'csrf',verifyCsrf:async()=>true},...options.host})});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));active.push(server);
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow-spaces/v1/spaces/s`,counts:()=>({starts,dispatches,prepares,notes})};
}
afterEach(async()=>Promise.all(active.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve())))));
const headers={authorization:'alice',origin:'http://workbench.test','x-space-csrf':'csrf','content-type':'application/json'};
const post=(url:string,value:unknown,h=headers)=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(value)});

it('prepares and reads an ordinary brief without a validation plan',async()=>{
  const app=await serve();
  expect((await fetch(app.url+'/business/form',{headers})).status).toBe(200);
  expect((await post(app.url+'/business/preparations',{key:'key',versionId:'v',values:{objective:'Explain'}})).status).toBe(200);
  const read=await (await fetch(app.url+'/cases/c/preparation',{headers})).json();
  expect(read).toMatchObject({caseId:'c',inputManifestId:'m',inputs:[{id:'input'}],actions:{start:true}});
  expect(app.counts().prepares).toBe(1);
});

it('requires the exact unique frozen asset set and true schema and payload hashes',async()=>{
  const second={...input,id:'second',assetId:'second',payloadHash:'hash-second'};
  const twoSlots={...manifest,assets:{first:'input',second:'second'}};
  const service={readManifest:async()=>twoSlots,readAsset:async(_spaceId:string,id:string)=>id==='second'?second:input} as Partial<WorkflowSpaceService>;
  const duplicate=await serve({service,business:{preparation:async()=>({...prepared,inputs:[prepared.inputs[0]!,prepared.inputs[0]!]})}});
  expect((await fetch(duplicate.url+'/cases/c/preparation',{headers})).status).toBe(409);
  const missing=await serve({service,business:{preparation:async()=>prepared}});
  expect((await fetch(missing.url+'/cases/c/preparation',{headers})).status).toBe(409);
  const wrongSchema=await serve({business:{preparation:async()=>({...prepared,inputs:[{...prepared.inputs[0]!,schema:{...input.schema,hash:'wrong'}}]})}});
  expect((await fetch(wrongSchema.url+'/cases/c/preparation',{headers})).status).toBe(409);
  const wrongPayload=await serve({business:{preparation:async()=>({...prepared,inputs:[{...prepared.inputs[0]!,payloadHash:'wrong'}]})}});
  expect((await fetch(wrongPayload.url+'/cases/c/preparation',{headers})).status).toBe(409);
  const reused=await serve({service:{readManifest:async()=>({...manifest,assets:{first:'input',second:'input'}})} as Partial<WorkflowSpaceService>});
  expect((await fetch(reused.url+'/cases/c/preparation',{headers})).status).toBe(200);
});

it('requires membership and same-origin CSRF for business writes',async()=>{
  const app=await serve();const url=app.url+'/business/preparations',body={key:'key',versionId:'v',values:{}};
  expect((await post(url,body,{...headers,origin:'http://other.test'})).status).toBe(403);
  expect((await post(url,body,{...headers,'x-space-csrf':'wrong'})).status).toBe(403);
  expect((await post(url,body,{...headers,authorization:''})).status).toBe(401);
  expect((await post(url,{...body,actor:'human'})).status).toBe(400);
  expect((await post(url,body)).status).toBe(200);
  expect(app.counts().prepares).toBe(1);
  const outsider=await serve({member:false});expect((await post(outsider.url+'/business/preparations',body)).status).toBe(403);
  const readonly=await serve({security:false});expect((await post(readonly.url+'/business/preparations',body)).status).toBe(405);
});

it('binds start and dispatch to the exact case, version, manifest and run',async()=>{
  const app=await serve();
  expect((await post(app.url+'/cases/c/runs',{versionId:'v',inputManifestId:'wrong',key:'start'})).status).toBe(409);
  expect((await post(app.url+'/cases/c/runs',{versionId:'v',inputManifestId:'m',key:'start'})).status).toBe(200);
  expect((await post(app.url+'/cases/c/runs/r/dispatch',{versionId:'v',inputManifestId:'m'})).status).toBe(200);
  expect(app.counts()).toMatchObject({starts:1,dispatches:1});
  const mismatch=await serve({business:{start:async()=>({...receipt,runId:'other'})}});
  expect((await post(mismatch.url+'/cases/c/runs',{versionId:'v',inputManifestId:'m',key:'start'})).status).toBe(409);
});

it('maps only an approved structured domain relation mismatch to 409',async()=>{
  const mismatch=await serve({business:{start:async()=>{throw {status:409,code:'RELATION_MISMATCH',message:'Saved manifest does not match the selected Case',details:{secret:'hidden'}}}}});
  const response=await post(mismatch.url+'/cases/c/runs',{versionId:'v',inputManifestId:'m',key:'start'});
  expect(response.status).toBe(409);
  const result=await response.json();
  expect(result.error).toMatchObject({code:'RELATION_MISMATCH',message:'Saved manifest does not match the selected Case'});
  expect(JSON.stringify(result)).not.toContain('hidden');
  const unknown=await serve({business:{start:async()=>{throw {status:409,code:'UNRECOGNIZED',message:'SECRET_INTERNAL_DETAIL'}}}});
  const hidden=await post(unknown.url+'/cases/c/runs',{versionId:'v',inputManifestId:'m',key:'start'});
  expect(hidden.status).toBe(500);
  expect(JSON.stringify(await hidden.json())).not.toContain('SECRET_INTERNAL_DETAIL');
});

it('maps only structured NOT_FOUND from the domain to 404',async()=>{
  const unsupported=await serve({business:{handlingNotes:async()=>{throw {status:404,code:'NOT_FOUND',message:'Handling notes are unavailable for this asset',details:{secret:'hidden'}}}}});
  const response=await fetch(unsupported.url+'/runs/r/assets/draft/handling-notes',{headers});
  expect(response.status).toBe(404);
  const result=await response.json();
  expect(result.error).toMatchObject({code:'NOT_FOUND',message:'Handling notes are unavailable for this asset'});
  expect(JSON.stringify(result)).not.toContain('hidden');
  const unknown=await serve({business:{handlingNotes:async()=>{throw {status:404,code:'OTHER_MISSING',message:'SECRET_INTERNAL_DETAIL'}}}});
  const hidden=await fetch(unknown.url+'/runs/r/assets/draft/handling-notes',{headers});
  expect(hidden.status).toBe(500);
  expect(JSON.stringify(await hidden.json())).not.toContain('SECRET_INTERNAL_DETAIL');
});

it('keeps external notes bound to the exact produced asset and authenticated importer',async()=>{
  const app=await serve();const url=app.url+'/runs/r/assets/draft/handling-notes';
  expect((await post(url,{...body,importedBy:'fake'})).status).toBe(400);
  expect((await post(url,{...body,author:{kind:'human',name:'Fake',threadId:'thread'}})).status).toBe(400);
  expect((await post(app.url+'/runs/r/assets/input/handling-notes',body)).status).toBe(409);
  expect((await post(url,body)).status).toBe(200);
  const list=await (await fetch(url,{headers})).json();expect(list.items).toMatchObject([{id:'note',importedBy:'alice',verification:'declared-external'}]);
  expect(app.counts().notes).toBe(1);
});

it('marks a capped handling-note list without claiming pagination',async()=>{
  const rows=Array.from({length:101},(_,index)=>({...note,id:`note-${index}`}));
  const app=await serve({business:{handlingNotes:async(input)=>{expect(input.limit).toBe(101);return rows}}});
  const response=await fetch(app.url+'/runs/r/assets/draft/handling-notes',{headers});
  expect(response.status).toBe(200);
  const list=await response.json();
  expect(list.items).toHaveLength(100);expect(list.truncated).toBe(true);expect(list.nextCursor).toBeNull();
  expect((await post(app.url+'/runs/r/assets/draft/handling-notes',body)).status).toBe(200);
  const missing=await serve({business:{handlingNotes:async()=>rows,readHandlingNote:async()=>null}});
  expect((await post(missing.url+'/runs/r/assets/draft/handling-notes',body)).status).toBe(409);
  const wrong=await serve({business:{handlingNotes:async()=>rows,readHandlingNote:async()=>({...note,subjectAssetId:'other'})}});
  expect((await post(wrong.url+'/runs/r/assets/draft/handling-notes',body)).status).toBe(409);
});

it('shows verified imported business ownership without inventing a node producer',async()=>{
  const prep={...input,id:'prep',assetId:'prep',schema:{namespace:'creation/preparation',revision:'1',hash:'prep'},payload:{title:'Preparation'},dependencies:[]};
  const importedNote={...input,id:'imported-note',assetId:'imported-note',schema:{namespace:'creation/handling-note',revision:'1',hash:'note'},payload:{title:'Handling note'},dependencies:['draft']};
  let calls=0,processReads=0;
  const app=await serve({
    service:{overview:async()=>({space,workflows:[method],cases:[caseValue],runs:[run],assets:[input,draft,prep,importedNote],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]}),readAsset:async(_spaceId:string,id:string)=>id==='prep'?prep:id==='imported-note'?importedNote:id==='draft'?draft:input,process:async()=>{processReads++;throw Error('imported asset must not request producer process')}} as Partial<WorkflowSpaceService>,
    host:{importedAssetScope:async({asset})=>{calls++;return asset.id==='prep'?{caseId:'c',runId:null,versionId:'v'}:asset.id==='imported-note'?{caseId:'c',runId:'r',versionId:'v'}:null}}
  });
  const caseList=await (await fetch(app.url+'/assets?caseId=c&schema=creation%2Fpreparation',{headers})).json();
  expect(caseList.items).toMatchObject([{id:'prep',caseId:'c',runId:null,versionId:'v',sourceKind:'import',nodeId:null,occurrenceId:null,round:null}]);
  expect(calls).toBe(3); // Each imported candidate checked once; display reuses the result.
  const runList=await (await fetch(app.url+'/assets?runId=r&schema=creation%2Fhandling-note',{headers})).json();
  expect(runList.items).toMatchObject([{id:'imported-note',caseId:'c',runId:'r',versionId:'v',sourceKind:'import',nodeId:null,occurrenceId:null,round:null}]);
  const reading=await (await fetch(app.url+'/assets/imported-note/reading',{headers})).json();
  expect(reading.asset).toMatchObject({caseId:'c',runId:'r',sourceKind:'import',nodeId:null,occurrenceId:null,round:null});
  expect(processReads).toBe(0);
});

it('rejects imported ownership outside the saved case, run or workflow scope',async()=>{
  const wrongCase=await serve({host:{importedAssetScope:async()=>({caseId:'elsewhere',runId:null,versionId:null})}});
  expect((await fetch(wrongCase.url+'/assets?schema=content%2Fmaterial',{headers})).status).toBe(409);
  const wrongVersion=await serve({host:{importedAssetScope:async()=>({caseId:'c',runId:'r',versionId:'other'})}});
  expect((await fetch(wrongVersion.url+'/assets/input/reading',{headers})).status).toBe(409);
  const noVersion=await serve({host:{importedAssetScope:async()=>({caseId:'c',runId:'r',versionId:null})}});
  expect((await fetch(noVersion.url+'/assets?schema=content%2Fmaterial',{headers})).status).toBe(409);
  const otherWorkflow={...method,id:'other',entrypoints:{content:{...method.entrypoints.content,workflowId:'other-workflow'}}};
  const outOfScope=await serve({service:{readWorkflowVersion:async(_spaceId:string,id:string)=>id==='other'?otherWorkflow:method} as Partial<WorkflowSpaceService>,host:{importedAssetScope:async()=>({caseId:'c',runId:null,versionId:'other'})}});
  expect((await fetch(outOfScope.url+'/assets?schema=content%2Fmaterial',{headers})).status).toBe(409);
  const wrongRun=await serve({service:{readRun:async()=>({...run,caseId:'different'})} as Partial<WorkflowSpaceService>,host:{importedAssetScope:async()=>({caseId:'c',runId:'r',versionId:'v'})}});
  expect((await fetch(wrongRun.url+'/assets?schema=content%2Fmaterial',{headers})).status).toBe(409);
});

it('keeps imported assets unassociated when the host has no ownership seam',async()=>{
  const app=await serve();
  const response=await fetch(app.url+'/assets?schema=content%2Fmaterial',{headers});const list=await response.json();
  expect(response.status).toBe(200);
  expect(list.items).toMatchObject([{id:'input',sourceKind:'import',caseId:null,runId:null,versionId:null,nodeId:null}]);
});
