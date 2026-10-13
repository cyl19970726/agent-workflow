import {afterEach, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {z} from 'zod';
import {createWorkflowSpaceApiHandler, type SpaceApiHost} from './server.js';

const revision={id:'rev-1',assetId:'space-business-understanding',revision:1,payloadHash:'hash',createdAt:'2026-10-09T00:00:00Z',previousRevisionId:null,changeReason:'New evidence',title:'Audience',content:'# Audience\nCreators need clarity.',sources:[{kind:'document' as const,ref:'docs/a.md',title:'Interview'}],authorship:{kind:'agent' as const,name:'Research agent',sessionId:'session'},recordedBy:'alice',confirmation:'unconfirmed' as const};
const input={expectedRevisionId:null,idempotencyKey:'save-1',title:revision.title,content:revision.content,sources:revision.sources,authorship:revision.authorship,changeReason:revision.changeReason};
const active:Server[]=[];
async function serve(options:{member?:boolean;security?:boolean;optimizedSummary?:boolean;understanding?:SpaceApiHost['understanding'];methodCapability?:SpaceApiHost['methodCapability'];methodDesign?:SpaceApiHost['methodDesign'];methodExecution?:SpaceApiHost['methodExecution'];principal?:SpaceApiHost['principal']}={}){
  const space={id:'s',purpose:'Content'};
  const service={listSpaces:async()=>options.member===false?[]:[space],overview:async()=>({space,workflows:[],cases:[],runs:[],assets:[],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]}),
    readWorkflowVersion:async()=>({id:'candidate',spaceId:'s',entrypoints:{content:{workflowId:'content'}}}),
    ...(options.optimizedSummary?{spaceSummary:async()=>({space,adoptedVersionId:null,latestVersionId:null,versionCount:0,caseCount:0,runCount:0,assetCount:0})}:{})};
  const handler=createWorkflowSpaceApiHandler({cursorSecret:'test-secret-32-bytes-long-123456789',resolveHost:({request})=>({principal:request.headers.authorization?(options.principal??{id:'alice',kind:'human' as const}):undefined,cacheScope:String(request.headers.authorization??''),service:service as SpaceApiHost['service'],scope:{workflowId:'content',entrypoint:'content'},understanding:options.understanding??{current:async()=>revision,read:async(_spaceId,id)=>{if(id!==revision.id)throw Error('Record not found in authorized space');return revision},history:async()=>[revision],save:async()=>revision},methodCapability:options.methodCapability,methodDesign:options.methodDesign,methodExecution:options.methodExecution,commandSecurity:options.security===false?undefined:{origin:'http://workbench.test',csrfToken:'csrf',verifyCsrf:async()=>true}})});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));active.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow-spaces/v1/spaces/s`;
}
afterEach(async()=>Promise.all(active.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve())))));
const headers={authorization:'alice',origin:'http://workbench.test','x-space-csrf':'csrf','content-type':'application/json'};
const post=(url:string,body:unknown,h=headers)=>fetch(url,{method:'POST',headers:h,body:JSON.stringify(body)});

it('reads current, exact and paged immutable understanding revisions',async()=>{
  const base=await serve();
  expect(await (await fetch(base+'/understanding',{headers})).json()).toMatchObject(revision);
  expect(await (await fetch(base+'/understanding?revision=rev-1',{headers})).json()).toMatchObject(revision);
  expect((await fetch(base+'/understanding?revision=missing',{headers})).status).toBe(404);
  const wrong=await serve({understanding:{current:async()=>revision,read:async()=>revision,history:async()=>[revision]}});
  expect((await fetch(wrong+'/understanding?revision=other',{headers})).status).toBe(409);
  const history=await (await fetch(base+'/understanding/revisions',{headers})).json();
  expect(history).toMatchObject({items:[revision],nextCursor:null});
});

it('checks membership, CSRF and revision request validation before saving',async()=>{
  let saves=0;
  const understanding={current:async()=>revision,read:async()=>revision,history:async()=>[revision],save:async(_spaceId:string,received:typeof input)=>{saves++;expect(received.content).toBe(input.content+'\n');return revision}};
  const base=await serve({understanding});
  expect((await post(base+'/understanding/revisions',input,{...headers,origin:'http://other.test'})).status).toBe(403);
  expect((await post(base+'/understanding/revisions',input,{...headers,'x-space-csrf':'wrong'})).status).toBe(403);
  expect((await post(base+'/understanding/revisions',{...input,sources:[]})).status).toBe(400);
  expect((await post(base+'/understanding/revisions',{...input,title:'  '})).status).toBe(400);
  expect((await post(base+'/understanding/revisions',{...input,content:input.content+'\n'})).status).toBe(200);
  expect(saves).toBe(1);
  const outsider=await serve({member:false,understanding});
  expect((await post(outsider+'/understanding/revisions',input)).status).toBe(403);
  const readonly=await serve({security:false,understanding});
  expect((await post(readonly+'/understanding/revisions',input)).status).toBe(405);
});

it('returns 409 for an optimistic revision conflict',async()=>{
  const base=await serve({understanding:{current:async()=>revision,read:async()=>revision,history:async()=>[revision],save:async()=>{throw Error('Asset version conflict: expected head required')}}});
  const response=await post(base+'/understanding/revisions',input);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('CONFLICT');
  const firstCreationRace=await serve({understanding:{current:async()=>null,read:async()=>revision,history:async()=>[],save:async()=>{throw {code:'23505'}}}});
  expect((await post(firstCreationRace+'/understanding/revisions',input)).status).toBe(409);
});

it.each([true,false])('offers understanding-only writes in the %s summary path',async optimizedSummary=>{
  const base=await serve({optimizedSummary});
  const response=await fetch(base+'/summary',{headers});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({capabilities:{read:true,write:true,understandingWrite:true},csrfToken:'csrf'});
});

const design={...revision,id:'design-1',assetId:'method-design:content',workflowId:'content',entrypoint:'content',understanding:{revisionId:'rev-1',payloadHash:'hash'}};
const designInput={...input,workflowId:'content',entrypoint:'content',understanding:design.understanding};
const preview={versionId:'candidate',workflowId:'content',entrypoint:'content',designRevisionId:'design-1',designHash:'hash',understandingRevisionId:'rev-1',understandingHash:'hash',availability:'unavailable' as const,blockers:['No executor']};
const methodDesign:NonNullable<SpaceApiHost['methodDesign']>={current:async()=>design,read:async()=>design,history:async()=>[design],basis:async()=>({design,understanding:revision}),save:async()=>design,preview:async()=>preview,publish:async()=>({versionId:'candidate',designRevisionId:'design-1',understandingRevisionId:'rev-1'})};

it('reads exact capability revisions and gates capability saves by scope, CSRF and Agent identity',async()=>{
  const content={content:'{"type":"object"}',sha256:'a'.repeat(64)};
  const capability={id:'cap-1',assetId:'method-capability:content',revision:1,payloadHash:'cap-hash',createdAt:'2026-10-11T00:00:00Z',previousRevisionId:null,
    workflowId:'content',entrypoint:'content',understanding:design.understanding,provider:{id:'provider',contractRevision:'1'},
    nodes:{author:{instructions:{content:'Write complete prose',sha256:'b'.repeat(64)},outputSchema:content,model:'model-1',reasoningEffort:'high'}},
    validation:content,predecessorVersionId:null,changeReason:'First capability',authorship:{kind:'agent' as const,name:'designer',sessionId:'session-1'},recordedBy:'external-agent:session-1'};
  const principal={id:'external-agent:session-1',kind:'service' as const,externalAgent:{id:'designer',sessionId:'session-1',role:'design' as const}};
  let saves=0;
  const store:NonNullable<SpaceApiHost['methodCapability']>={current:async()=>capability,read:async()=>capability,history:async()=>[capability],save:async()=>{saves++;return capability}};
  const base=await serve({principal,methodCapability:store});
  expect(await (await fetch(base+'/method-capability',{headers})).json()).toMatchObject(capability);
  expect(await (await fetch(base+'/method-capability/revisions',{headers})).json()).toMatchObject({items:[capability],nextCursor:null});
  expect((await fetch(base+'/method-capability?revision=other',{headers})).status).toBe(409);
  const {id:_id,assetId:_assetId,revision:_revision,payloadHash:_payloadHash,createdAt:_createdAt,previousRevisionId:_previousRevisionId,recordedBy:_recordedBy,...draft}=capability;
  const request={...draft,expectedRevisionId:null,idempotencyKey:'save-capability'};
  expect((await post(base+'/method-capability/revisions',{...request,workflowId:'other'})).status).toBe(409);
  expect((await post(base+'/method-capability/revisions',request,{...headers,'x-space-csrf':'wrong'})).status).toBe(403);
  expect((await post(base+'/method-capability/revisions',{...request,authorship:{...request.authorship,sessionId:'other'}})).status).toBe(403);
  expect((await post(base+'/method-capability/revisions',request)).status).toBe(200);
  expect(saves).toBe(1);
  const observer=await serve({principal:{...principal,externalAgent:{...principal.externalAgent,role:'observer'}},methodCapability:store});
  expect((await post(observer+'/method-capability/revisions',request)).status).toBe(403);
});

it('returns a complete exact design definition with a diagram link',async()=>{
  const withCapability={...design,capability:{revisionId:'cap-1',payloadHash:'cap-hash'}};
  const definition={candidateId:'candidate',workflowId:'content',entrypoint:'content',designRevisionId:'design-1',designPayloadHash:'hash',
    understandingRevisionId:'rev-1',understandingPayloadHash:'hash',capabilityRevisionId:'cap-1',capabilityPayloadHash:'cap-hash',
    provider:{id:'provider',contractRevision:'1',fingerprint:'fingerprint'},
    version:{id:'candidate',entrypoints:{content:{workflowId:'content',codeRevision:'1',process:{revision:'1',hash:'a'.repeat(64),nodes:[{id:'author',kind:'agent'}],edges:[],results:[]},nodeDefinitions:{author:{instructions:'Full private prompt'}}}}},
    schemas:[{namespace:'deep',schema:{properties:{secret:{description:'Full schema'}}}}],presentation:null,
    availability:{state:'unknown' as const,reason:null}};
  const base=await serve({methodDesign:{...methodDesign,read:async()=>withCapability,definition:async()=>definition}});
  const response=await fetch(base+'/method-design/definition?revision=design-1',{headers});
  expect(response.status).toBe(200);
  const result=await response.json();
  expect(result.version.entrypoints.content.nodeDefinitions.author.instructions).toBe('Full private prompt');
  expect(result.schemas[0].schema.properties.secret.description).toBe('Full schema');
  expect(result.diagramUrl).toBe('/api/workflow-spaces/v1/spaces/s/method-design/diagram?revision=design-1&expectedCandidateId=candidate&embed=1');
  expect(result.expectedAssets).toMatchObject({assets:[],dependencies:[],gaps:[]});
  const diagram=await fetch(base+'/method-design/diagram?revision=design-1&expectedCandidateId=candidate&embed=1',{headers});
  expect(diagram.status).toBe(200);
  expect(diagram.headers.get('x-method-candidate-id')).toBe('candidate');
  expect(await diagram.text()).toContain('data-node-id="author"');
  expect((await fetch(base+'/method-design/diagram?revision=design-1',{headers})).status).toBe(400);
  expect((await fetch(base+'/method-design/diagram?revision=design-1&expectedCandidateId=other&embed=1',{headers})).status).toBe(409);
  expect((await fetch(base+'/method-design/diagram?revision=design-1&expectedCandidateId=candidate&embed=0',{headers})).status).toBe(400);
  expect((await fetch(base+'/method-design/definition?revision=other',{headers})).status).toBe(409);
});

it('rejects a graph when the provider candidate changes after the definition read',async()=>{
  const withCapability={...design,capability:{revisionId:'cap-1',payloadHash:'cap-hash'}};
  let candidateId='candidate';
  const definition=()=>({candidateId,workflowId:'content',entrypoint:'content',designRevisionId:'design-1',designPayloadHash:'hash',
    understandingRevisionId:'rev-1',understandingPayloadHash:'hash',capabilityRevisionId:'cap-1',capabilityPayloadHash:'cap-hash',
    provider:{id:'provider',contractRevision:'1',fingerprint:'fingerprint'},
    version:{id:candidateId,entrypoints:{content:{workflowId:'content',codeRevision:'1',process:{revision:'1',hash:'a'.repeat(64),nodes:[{id:'author',kind:'agent'}],edges:[],results:[]}}}},
    schemas:[],presentation:null,availability:{state:'unknown' as const,reason:null}});
  const base=await serve({methodDesign:{...methodDesign,read:async()=>withCapability,definition:async()=>definition()}});
  const first=await (await fetch(base+'/method-design/definition?revision=design-1',{headers})).json();
  candidateId='changed-candidate';
  const graph=await fetch(new URL(first.diagramUrl,new URL(base).origin),{headers});
  expect(graph.status).toBe(409);
  expect(graph.headers.get('x-method-candidate-id')).toBeNull();
});

it('exposes execution status and design-only, CSRF-protected domain commands',async()=>{
  const principal={id:'external-agent:session-1',kind:'service' as const,externalAgent:{id:'designer',sessionId:'session-1',role:'design' as const}};
  const state={spaceId:'s',workflowId:'content',stage:'ready',privateDetails:{full:'Untruncated domain status'}};
  const received:unknown[]=[];
  const methodExecution:NonNullable<SpaceApiHost['methodExecution']>={status:async()=>state,command:async(spaceId,input)=>{received.push({spaceId,input});return {operation:input.operation,receipt:{full:'Untruncated command result'}};}};
  const base=await serve({principal,methodExecution});
  expect(await (await fetch(base+'/method-execution',{headers})).json()).toEqual(state);
  expect((await fetch(base+'/method-execution?revision=other',{headers})).status).toBe(400);
  expect(await (await fetch(base+'/summary',{headers})).json()).toMatchObject({capabilities:{methodExecutionRead:true,methodExecutionWrite:true}});
  const body={operation:'release',input:{candidateId:'candidate'}};
  expect((await post(base+'/method-execution/commands',body,{...headers,origin:'http://wrong.test'})).status).toBe(403);
  expect((await post(base+'/method-execution/commands',body,{...headers,'x-space-csrf':'wrong'})).status).toBe(403);
  expect((await post(base+'/method-execution/commands',{...body,process:{arbitrary:true}})).status).toBe(400);
  expect((await post(base+'/method-execution/commands',{operation:'arbitrary',input:{}})).status).toBe(400);
  expect(await (await post(base+'/method-execution/commands',body)).json()).toEqual({operation:'release',receipt:{full:'Untruncated command result'}});
  expect(received).toEqual([{spaceId:'s',input:body}]);
  const human=await serve({principal:{id:'alice',kind:'human'},methodExecution});
  expect(await (await fetch(human+'/summary',{headers})).json()).toMatchObject({capabilities:{methodExecutionRead:true,methodExecutionWrite:false}});
  expect((await post(human+'/method-execution/commands',body)).status).toBe(403);
  const observer=await serve({principal:{...principal,externalAgent:{...principal.externalAgent,role:'observer'}},methodExecution});
  expect((await post(observer+'/method-execution/commands',body)).status).toBe(403);
});

it('returns safe field and type issues for domain input validation without exposing submitted values',async()=>{
  const principal={id:'external-agent:session-1',kind:'service' as const,externalAgent:{id:'designer',sessionId:'session-1',role:'design' as const}};
  let writes=0;
  const methodExecution:NonNullable<SpaceApiHost['methodExecution']>={status:async()=>({stage:'ready'}),command:async(_spaceId,request)=>{
    const parsed=z.object({input:z.object({topicId:z.string(),materials:z.array(z.string()).min(1)}).strict()}).strict().parse({input:request.input});
    writes++;
    return parsed;
  }};
  const base=await serve({principal,methodExecution});
  const secret='private submitted value 123';
  const response=await post(base+'/method-execution/commands',{operation:'inputs-freeze',input:{topicId:{secret},materials:[],unknownSecret:secret}});
  expect(response.status).toBe(400);
  const body=await response.json();
  expect(body.error).toMatchObject({code:'INVALID_REQUEST',message:'Invalid request data',details:{issues:[
    {path:'input.topicId',code:'invalid_type',expected:'string'},
    {path:'input.materials',code:'too_small'},
    {path:'input',code:'unrecognized_keys'}
  ]}});
  expect(JSON.stringify(body)).not.toContain(secret);
  expect(writes).toBe(0);
});

it('reads exact design drafts, preview and frozen version basis',async()=>{
  const base=await serve({methodDesign});
  expect(await (await fetch(base+'/method-design',{headers})).json()).toMatchObject(design);
  expect(await (await fetch(base+'/method-design?revision=design-1',{headers})).json()).toMatchObject(design);
  expect(await (await fetch(base+'/method-design/revisions',{headers})).json()).toMatchObject({items:[design],nextCursor:null});
  expect(await (await fetch(base+'/method-design/preview?revision=design-1',{headers})).json()).toMatchObject(preview);
  expect(await (await fetch(base+'/versions/candidate/design',{headers})).json()).toMatchObject({design,understanding:revision});
  expect((await fetch(base+'/method-design?revision=other',{headers})).status).toBe(409);
});
it.each(['available','unknown'] as const)('returns current %s preview availability',async availability=>{
  const base=await serve({methodDesign:{...methodDesign,preview:async()=>({...preview,availability})}});
  const response=await fetch(base+'/method-design/preview?revision=design-1',{headers});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({availability,designRevisionId:'design-1'});
});

it.each([true,false])('checks design scope, CSRF, publication identity and %s summary capabilities',async optimizedSummary=>{
  let saves=0,publishes=0;
  const base=await serve({optimizedSummary,methodDesign:{...methodDesign,save:async()=>{saves++;return design},publish:async()=>{publishes++;return {versionId:'candidate',designRevisionId:'design-1',understandingRevisionId:'rev-1'}}}});
  expect(await (await fetch(base+'/summary',{headers})).json()).toMatchObject({capabilities:{methodDesignRead:true,methodDesignWrite:true,methodPublish:true},csrfToken:'csrf'});
  expect((await post(base+'/method-design/revisions',{...designInput,workflowId:'other'})).status).toBe(409);
  expect((await post(base+'/method-design/revisions',designInput,{...headers,origin:'http://other.test'})).status).toBe(403);
  expect((await post(base+'/method-design/revisions',designInput)).status).toBe(200);
  expect(saves).toBe(1);
  expect((await post(base+'/method-design/publications',{designRevisionId:'design-1',expectedCandidateId:'other'})).status).toBe(409);
  expect((await post(base+'/method-design/publications',{designRevisionId:'design-1',expectedCandidateId:'candidate'})).status).toBe(200);
  expect(publishes).toBe(2);
});

it.each([true,false])('requires trusted design role and exact Agent draft ownership in the %s summary path',async optimizedSummary=>{
  const principal={id:'external-agent:session-1',kind:'service' as const,
    externalAgent:{id:'designer',sessionId:'session-1',role:'design' as const}};
  const own={...design,recordedBy:principal.id,authorship:{kind:'agent' as const,name:'designer',sessionId:'session-1'}};
  const ownInput={...designInput,authorship:own.authorship};
  let saves=0,publishes=0;
  const agentMethod={...methodDesign,read:async(_spaceId:string,id:string)=>id==='design-1'?own:design,
    save:async()=>{saves++;return own},publish:async()=>{publishes++;return {versionId:'candidate',designRevisionId:'design-1',understandingRevisionId:'rev-1'}}};
  const base=await serve({optimizedSummary,principal,methodDesign:agentMethod});
  expect(await (await fetch(base+'/summary',{headers})).json()).toMatchObject({capabilities:{methodDesignWrite:true,methodPublish:true}});
  expect((await post(base+'/method-design/revisions',designInput)).status).toBe(403);
  expect((await post(base+'/method-design/revisions',ownInput)).status).toBe(200);
  expect(saves).toBe(1);
  expect((await post(base+'/method-design/publications',{designRevisionId:'other',expectedCandidateId:'candidate'})).status).toBe(409);
  expect((await post(base+'/method-design/publications',{designRevisionId:'design-1',expectedCandidateId:'candidate'})).status).toBe(200);
  expect(publishes).toBe(1);
  const oldDraft=await serve({principal,methodDesign:{...agentMethod,read:async()=>design}});
  expect((await post(oldDraft+'/method-design/publications',{designRevisionId:'design-1',expectedCandidateId:'candidate'})).status).toBe(403);
  const wrongSession=await serve({principal,methodDesign:{...agentMethod,read:async()=>({...own,authorship:{...own.authorship,sessionId:'other-session'}})}});
  expect((await post(wrongSession+'/method-design/publications',{designRevisionId:'design-1',expectedCandidateId:'candidate'})).status).toBe(403);
  const observer=await serve({optimizedSummary,principal:{...principal,externalAgent:{...principal.externalAgent,role:'observer'}},methodDesign:agentMethod});
  expect(await (await fetch(observer+'/summary',{headers})).json()).toMatchObject({capabilities:{methodDesignRead:true,methodDesignWrite:false,methodPublish:false}});
  expect((await post(observer+'/method-design/revisions',ownInput)).status).toBe(403);
  expect((await post(observer+'/method-design/publications',{designRevisionId:'design-1',expectedCandidateId:'candidate'})).status).toBe(403);
});
