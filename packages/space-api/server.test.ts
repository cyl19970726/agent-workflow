import {afterEach, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {runInNewContext} from 'node:vm';
import {bridgeWorkflowDiagram, createWorkflowSpaceApiHandler, type SpaceApiHost} from './server.js';
import {agentDeclarationDto, nodeDto, occurrenceDto, runDto, versionDto} from './read-model.js';
import type {SpaceOverview, WorkflowSpaceService} from '@signal-room/workflow-spaces';

const body='LARGE_PRIVATE_BODY_'.repeat(10000);
const workflow={id:'v1',spaceId:'s1',revision:'1',changeReason:'first method',hash:'h',createdAt:'2026-01-01T00:00:00Z',config:{},entrypoints:{content:{workflowId:'content',codeRevision:'abc',storageContract:{nodes:{},schemas:[],hash:'storage'},process:{revision:'1',hash:'process',nodes:[],edges:[],results:[]}}}} as unknown as SpaceOverview['workflows'][number];
const run={runId:'r1',spaceId:'s1',workflowVersionId:'v1',entrypoint:'content',caseId:'c1',inputManifestId:'m1',effectiveConfig:{},configHash:'config'};
const asset={id:'a1',spaceId:'s1',assetId:'asset-1',version:1,schema:{namespace:'content/draft',revision:'1',hash:'schema'},payload:{title:'Draft',body},payloadHash:'payload',source:{kind:'node',runId:'r1',stepRunId:'st1',attemptId:'at1',nodeId:'author',producer:'agent',sessionId:'se1',contextId:'co1'},dependencies:[],attachments:[],initialState:'candidate',createdAt:'2026-01-01T00:00:00Z',state:'candidate'} as SpaceOverview['assets'][number];
const data:SpaceOverview={space:{id:'s1',purpose:'CONTENT production',owner:'owner',status:'active',createdAt:'2026-01-01T00:00:00Z'},workflows:[workflow],cases:[{id:'c1',spaceId:'s1',title:'Case',objective:'Goal',constraints:[]}],runs:[run],assets:[asset],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]};
const service={listSpaces:async()=>[data.space],overview:async()=>data,readAsset:async()=>asset,readContext:async()=>{throw Error('no context')},process:async()=>({run,contractSource:'unknown',coverage:'unknown',occurrences:[],routes:[],relations:[],unmappedStepIds:[]}),validationPlans:async()=>[],validationPlan:async()=>{throw Error('no plan')},validationSummary:async()=>{throw Error('no summary')},executionTasks:async()=>[],readManifest:async()=>({id:'m1',spaceId:'s1',caseId:'c1',assets:{},hash:'manifest'}),resolvePresentation:async()=>null} as unknown as WorkflowSpaceService;
const active:Server[]=[];
async function start(overrides:Partial<WorkflowSpaceService>={},hostExtras:Partial<SpaceApiHost>={},now?:()=>Date){
  const activeService={...service,...overrides} as WorkflowSpaceService;
  const handler=createWorkflowSpaceApiHandler({cursorSecret:'test-secret-32-bytes-long-123456789',now,resolveHost:({request})=>({principal:request.headers.authorization?{id:request.headers.authorization,kind:request.headers['x-principal-kind']==='service'?'service':'human'}:undefined,cacheScope:(request.headers['x-cache-scope'] as string|undefined)??request.headers.authorization,service:activeService,scope:{workflowId:'content',entrypoint:'content'},...hostExtras})});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));active.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workflow-spaces/v1/spaces/s1`;
}
afterEach(async()=>{await Promise.all(active.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
describe('Space attachment routes',()=>{
  const bytes=Buffer.from('representative synthetic source file\n');
  const sha256='a'.repeat(64);
  const blob={id:sha256,spaceId:'s1',sha256,size:bytes.length,mediaType:'text/plain',key:'private-storage-key'};
  const exactAsset={...asset,id:'attachment-version',assetId:'source-document',version:2,source:{kind:'import' as const,actorId:'alice',description:'Source document'},attachments:[blob]};
  const commandSecurity={origin:'http://localhost',csrfToken:'csrf',verifyCsrf:async()=>true};
  it('reads metadata and bytes only through the exact bound asset version',async()=>{
    let blobReads=0;
    const url=await start({readAsset:async()=>exactAsset as never,readBlob:async()=>{blobReads++;return bytes;}},{commandSecurity});
    const headers={authorization:'alice'};
    const metadata=await fetch(`${url}/assets/attachment-version/attachments`,{headers});
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({assetVersionId:'attachment-version',assetId:'source-document',version:2,items:[{id:sha256,sha256,size:bytes.length,mediaType:'text/plain'}]});
    const content=await fetch(`${url}/assets/attachment-version/attachments/${sha256}/content`,{headers});
    expect(content.status).toBe(200);expect(content.headers.get('content-type')).toBe('text/plain');
    expect(content.headers.get('x-content-sha256')).toBe(sha256);expect(Buffer.from(await content.arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${url}/assets/attachment-version/attachments/${'b'.repeat(64)}/content`,{headers})).status).toBe(404);
    expect((await fetch(`${url}/assets/wrong-version/attachments/${sha256}/content`,{headers})).status).toBe(409);
    expect(blobReads).toBe(1);
  });
  it('requires a scoped writer and explicit registered-schema import request',async()=>{
    let uploaded=0,imported=0;
    const url=await start({uploadBlob:async(_space,value)=>{uploaded++;expect(Buffer.from(value)).toEqual(bytes);return blob;},
      importAsset:async(_space,input)=>{imported++;expect(input).toMatchObject({assetId:'source-document',schema:{namespace:'evidence/source',revision:'1',hash:'registered-schema-hash'},blobIds:[sha256],idempotencyKey:'source-v2',expectedHead:'old-version'});return exactAsset as never;}},{commandSecurity,attachmentWrites:true});
    const headers={authorization:'alice',origin:'http://localhost','x-space-csrf':'csrf'};
    const denied=await fetch(`${url}/attachments/blobs`,{method:'POST',headers:{authorization:'alice','content-type':'text/plain'},body:bytes});expect(denied.status).toBe(403);
    const uploadedResponse=await fetch(`${url}/attachments/blobs`,{method:'POST',headers:{...headers,'content-type':'text/plain'},body:bytes});
    expect(uploadedResponse.status).toBe(200);expect(await uploadedResponse.json()).toEqual({id:sha256,sha256,size:bytes.length,mediaType:'text/plain'});
    const request={assetId:'source-document',expectedHead:'old-version',schema:{namespace:'evidence/source',revision:'1',hash:'registered-schema-hash'},payload:{title:'Source'},description:'A genuine source',blobIds:[sha256],idempotencyKey:'source-v2'};
    const importedResponse=await fetch(`${url}/attachments/imports`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(request)});
    expect(importedResponse.status).toBe(200);expect(await importedResponse.json()).toMatchObject({assetVersionId:'attachment-version',attachments:[{id:sha256}]});
    const invalid=await fetch(`${url}/attachments/imports`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({...request,expectedHead:undefined})});
    expect(invalid.status).toBe(400);expect(uploaded).toBe(1);expect(imported).toBe(1);
    const tooLarge=await fetch(`${url}/attachments/blobs`,{method:'POST',headers:{...headers,'content-type':'text/plain'},body:Buffer.alloc(16*1024*1024+1)});
    expect(tooLarge.status).toBe(413);expect(uploaded).toBe(1);
  });
  it('keeps attachment mutations disabled unless the host explicitly opts in',async()=>{
    let writes=0;
    const url=await start({uploadBlob:async()=>{writes++;return blob;},importAsset:async()=>{writes++;return exactAsset as never;}},{commandSecurity});
    const summary=await (await fetch(`${url}/summary`,{headers:{authorization:'alice'}})).json();
    expect(summary.capabilities.attachmentWrite).toBe(false);
    const response=await fetch(`${url}/attachments/blobs`,{method:'POST',headers:{authorization:'alice',origin:'http://localhost','x-space-csrf':'csrf','content-type':'text/plain'},body:bytes});
    expect(response.status).toBe(405);expect(writes).toBe(0);
  });
  it('does not let an observer credential upload even on a write-enabled host',async()=>{
    let writes=0;
    const url=await start({uploadBlob:async()=>{writes++;return blob;}},{commandSecurity,attachmentWrites:true,
      principal:{id:'observer-service',kind:'service',externalAgent:{id:'observer',sessionId:'session',role:'observer'}}});
    const response=await fetch(`${url}/attachments/blobs`,{method:'POST',headers:{authorization:'observer-service',origin:'http://localhost','x-space-csrf':'csrf','content-type':'text/plain'},body:bytes});
    expect(response.status).toBe(403);expect(writes).toBe(0);
  });
});
describe('read-only Space API',()=>{
  it('keeps latest observation distinct from a validated default primary method',async()=>{
    const observed={...workflow,id:'observed-later',createdAt:'2026-02-01T00:00:00Z',config:{observedNativeRun:true,methodKind:'auxiliary'}};
    const scope={workflowId:'content',entrypoint:'content',defaultVersionId:'v1'};
    const fast=await start({spaceSummary:async()=>({space:data.space,versionCount:2,caseCount:1,runCount:1,assetCount:1,latestVersionId:observed.id,adoptedVersionId:null}),
      readWorkflowVersion:async(_space,id)=>id==='v1'?workflow:observed,
      overview:async()=>{throw Error('light summary must not read overview');}}, {scope});
    expect(await (await fetch(`${fast}/summary`,{headers:{authorization:'alice'}})).json()).toMatchObject({adoptedVersionId:null,defaultVersionId:'v1',latestVersionId:'observed-later'});
    const full=await start({overview:async()=>({...data,workflows:[workflow,observed]})},{scope});
    expect(await (await fetch(`${full}/summary`,{headers:{authorization:'alice'}})).json()).toMatchObject({adoptedVersionId:null,defaultVersionId:'v1',latestVersionId:'observed-later'});
  });
  it('rejects a host default outside the primary method boundary',async()=>{
    for(const invalid of [
      {...workflow,id:'wrong-space',spaceId:'other-space'},
      {...workflow,id:'wrong-workflow',entrypoints:{content:{...workflow.entrypoints.content!,workflowId:'other'}}},
      {...workflow,id:'historical',config:{historical:true}},
      {...workflow,id:'observation',config:{observedNativeRun:true}},
      {...workflow,id:'auxiliary',config:{methodKind:'auxiliary'}}
    ]){
      const url=await start({spaceSummary:async()=>({space:data.space,versionCount:1,caseCount:1,runCount:1,assetCount:1,latestVersionId:invalid.id,adoptedVersionId:null}),
        readWorkflowVersion:async()=>invalid},{scope:{workflowId:'content',entrypoint:'content',defaultVersionId:invalid.id}});
      expect((await fetch(`${url}/summary`,{headers:{authorization:'alice'}})).status).toBe(409);
    }
  });
  it('reads bounded Case frozen inputs before a run, with exact manifest selection and Case isolation',async()=>{
    const source={...asset,id:'frozen-source',assetId:'source',source:{kind:'import' as const,actorId:'owner',description:'input'},payload:{title:'Private source',text:'SECRET_SOURCE_BODY'}};
    const manifests=['manifest-a','manifest-b'].map(id=>({id,spaceId:'s1',caseId:'c1',assets:{opportunity:'frozen-source'},hash:`hash-${id}`}));
    const wrongCase={...manifests[0]!,id:'foreign-case',caseId:'other-case'};
    const wrongSpace={...manifests[0]!,id:'foreign-space',spaceId:'other-space'};
    let assetReads=0;
    const overrides={
      overview:async()=>({...data,assets:[source]}),
      inputManifests:async(spaceId:string)=>{expect(spaceId).toBe('s1');return [...manifests,wrongCase,wrongSpace]},
      readManifest:async(_spaceId:string,id:string)=>[...manifests,wrongCase,wrongSpace].find(value=>value.id===id)??manifests[0]!,
      readAssetsByIds:async()=>{assetReads++;return [source]}
    } as Partial<WorkflowSpaceService>;
    const url=await start(overrides),headers={authorization:'alice'};
    const first=await fetch(url+'/cases/c1/inputs?limit=1',{headers});
    expect(first.status).toBe(200);
    const page=await first.json();
    expect(page).toMatchObject({caseId:'c1',hasMore:true,nextCursor:'manifest-a',manifests:[{id:'manifest-a',hash:'hash-manifest-a',slots:[{
      slot:'opportunity',asset:{id:'frozen-source',schema:source.schema,sourceKind:'import'},payloadHash:source.payloadHash,
      readingUrl:'/api/workflow-spaces/v1/spaces/s1/assets/frozen-source/reading'}]}]});
    expect(JSON.stringify(page)).not.toContain('SECRET_SOURCE_BODY');
    const second=await fetch(url+'/cases/c1/inputs?after=manifest-a&limit=1',{headers});
    expect(await second.json()).toMatchObject({hasMore:false,nextCursor:null,manifests:[{id:'manifest-b'}]});
    const exact=await fetch(url+'/cases/c1/inputs?manifestId=manifest-b',{headers});
    expect(await exact.json()).toMatchObject({manifests:[{id:'manifest-b'}],hasMore:false,nextCursor:null});
    const before=assetReads;
    expect((await fetch(url+'/cases/c1/inputs?manifestId=foreign-case',{headers})).status).toBe(404);
    expect((await fetch(url+'/cases/c1/inputs?manifestId=foreign-space',{headers})).status).toBe(404);
    expect((await fetch(url+'/cases/other-case/inputs',{headers})).status).toBe(404);
    expect(assetReads).toBe(before);
    expect((await fetch(url+'/cases/c1/inputs?manifestId=manifest-b&after=manifest-a',{headers})).status).toBe(400);
    const outsider=await start({...overrides,listSpaces:async()=>[]});
    expect((await fetch(outsider+'/cases/c1/inputs',{headers})).status).toBe(403);
  });
  it('shares exact saved asset IDs between run process and graph selection',async()=>{
    const original=workflow.entrypoints.content;
    const imported={...asset,id:'frozen-source',assetId:'source',source:{kind:'import' as const,actorId:'alice',description:'saved'},payload:{title:'Source'}};
    data.assets.push(imported);
    workflow.entrypoints.content={...original,process:{revision:'1',hash:'process',nodes:[{id:'author',kind:'agent',storageNodeId:'author',inputs:{materials:{slot:'materials'}},outputs:{draft:{slot:'draft'}}}],edges:[],results:[]}} as typeof original;
    try{
      const view={run,contract:workflow.entrypoints.content.process,contractSource:'method',coverage:'observed',occurrences:[{id:'st1',nodeId:'author',state:'succeeded',provenance:'observed',stepRunIds:['st1'],contextIds:['co1'],attemptIds:['at1'],sessionIds:['se1'],technicalSteps:[],attemptRecords:[],lifecycleEvidence:[],inputBindings:[{contextId:'co1',slot:'materials',assetVersionId:'frozen-source'}],outputBindings:[{contextId:'co1',slot:'draft',assetVersionId:'a1'}],inputs:{materials:'frozen-source'},outputs:{draft:['a1']}}],routes:[],relations:[],unmappedStepIds:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>;
      const url=await start({process:async()=>view,readManifest:async()=>({id:'m1',spaceId:'s1',caseId:'c1',assets:{materials:'frozen-source'},hash:'manifest'})});
      const headers={authorization:'alice'};
      const processResponse=await fetch(`${url}/runs/r1/process`,{headers});expect(processResponse.status).toBe(200);
      const projected=await processResponse.json();expect(projected.graphAssetIds).toEqual(['frozen-source','a1']);
      const graphResponse=await fetch(`${url}/runs/r1/graph`,{headers});expect(graphResponse.status).toBe(200);
      const html=await graphResponse.text();
      for(const id of projected.graphAssetIds)expect(html).toContain(`data-node-id="${id}"`);
      expect(html).toContain('data-edge-id="actual_produces_0"');
      expect(html).toContain('data-edge-id="actual_consumes_1"');
      expect(html).not.toContain('expected_output_');
    }finally{workflow.entrypoints.content=original;data.assets.pop();}
  });
  it('reads only bounded exact-attempt runner evidence and preserves incomplete scan state',async()=>{
    const context={id:'co1',spaceId:'s1',runId:'r1',stepRunId:'st1',attemptId:'at1',nodeId:'author',sessionId:'se1',producer:'agent',instructions:'Context prompt',effectiveConfig:{model:'model-1',apiKey:'private-secret'},inputs:{}};
    const occurrence={id:'occ1',nodeId:'author',attemptIds:['at1'],stepRunIds:['st1'],contextIds:['co1'],sessionIds:['se1']};
    const events=[{id:'event-1',sessionId:'se1',attemptId:'at1',seq:1,kind:'trace',body:{type:'siwc.started',data:{model:'provider-model',instructions:'Provider instructions',toolDefinitions:[{name:'read_bound_asset',description:'Allowed materials',parameters:{enum:['materials','opportunity','research']}}]}},createdAt:'2026-10-10T00:00:01Z'},
      {id:'event-2',sessionId:'se1',attemptId:'at1',seq:2,kind:'trace',body:{type:'siwc.tool_call',data:{turn:1,name:'read_bound_asset',callId:'call-1',arguments:{slot:'materials'}}},createdAt:'2026-10-10T00:00:02Z'},
      {id:'event-3',sessionId:'se1',attemptId:'at1',seq:3,kind:'trace',body:{type:'siwc.tool_result',data:{turn:1,name:'read_bound_asset',callId:'call-1',output:{text:'Evidence'}}},createdAt:'2026-10-10T00:00:03Z'}];
    const original=workflow.entrypoints.content;
    workflow.entrypoints.content={...original,nodeDefinitions:{author:{instructions:'Frozen method prompt'}}};
    try{
      const url=await start({readContext:async()=>context as never,process:async()=>({run,occurrences:[occurrence]} as never),
        runtimeEvents:async(_space,_session,after,limit)=>({items:events.filter(event=>event.seq>after).slice(0,limit) as never,
          nextCursor:events.filter(event=>event.seq>after).slice(0,limit).at(-1)?.seq??after,hasMore:events.filter(event=>event.seq>after).length>limit})},{});
      const headers={authorization:'alice'},path=`${url}/runs/r1/occurrences/occ1/runtime?attemptId=at1`;
      const first=await fetch(`${path}&limit=2`,{headers});expect(first.status).toBe(200);
      const page1=await first.json();
      expect(page1).toMatchObject({runId:'r1',attemptId:'at1',frozenPrompt:'Frozen method prompt',contextInstructions:'Context prompt',
        effectiveConfig:{model:'model-1'},hasMore:true,scanComplete:false,observedCallCount:null,
        events:[{type:'siwc.started',providerInstructions:'Provider instructions',toolDefinitions:[{name:'read_bound_asset',description:'Allowed materials',parameters:{enum:['materials','opportunity','research']},outputSchema:null,outputSchemaCoverage:'not-recorded'}]},{type:'siwc.tool_call'}],
        calls:[{callId:'call-1',status:'pending-or-later-page'}]});
      expect(JSON.stringify(page1)).not.toContain('private-secret');
      const page2=await (await fetch(`${path}&after=${page1.nextCursor}&limit=2`,{headers})).json();
      expect(page2).toMatchObject({hasMore:false,scanComplete:true,observedCallCount:null,calls:[{callId:'call-1',status:'returned',callEventId:null}]});
      expect((await fetch(`${url}/runs/r1/occurrences/occ1/runtime?attemptId=wrong`,{headers})).status).toBe(404);
    }finally{workflow.entrypoints.content=original;}
  });
  it('keeps merged Agent and program contexts distinct and leaves missing Agent start evidence unknown',async()=>{
    const contexts=[
      {id:'agent-1',spaceId:'s1',runId:'r1',stepRunId:'step-agent-1',attemptId:'attempt-agent-1',nodeId:'author',sessionId:'session-agent-1',producer:'agent',instructions:'Write',effectiveConfig:{model:'model-1',reasoningEffort:'high'}},
      {id:'program',spaceId:'s1',runId:'r1',stepRunId:'step-publish',attemptId:'attempt-program',nodeId:'author',sessionId:'session-program',producer:'program',instructions:'Publish author',effectiveConfig:{model:'inherited-run-config'}},
      {id:'agent-2',spaceId:'s1',runId:'r1',stepRunId:'step-agent-2',attemptId:'attempt-agent-2',nodeId:'author',sessionId:'session-agent-2',producer:'agent',instructions:'Revise',effectiveConfig:{model:'model-2'}},
    ];
    const occurrence={id:'merged',nodeId:'author',state:'succeeded',provenance:'observed',inputBindings:[],outputBindings:[],
      stepRunIds:contexts.map(value=>value.stepRunId),attemptIds:contexts.map(value=>value.attemptId),contextIds:contexts.map(value=>value.id),sessionIds:contexts.map(value=>value.sessionId),
      technicalSteps:[],attemptRecords:[]};
    let eventReads=0;
    const url=await start({readContext:async(_space,id)=>contexts.find(value=>value.id===id) as never,
      process:async()=>({run,occurrences:[occurrence],contractSource:'unknown',coverage:'observed',unmappedStepIds:[],routes:[],relations:[]} as never),
      runtimeEvents:async(_space,session,after)=>{eventReads++;return {items:[],nextCursor:after??0,hasMore:false};}});
    const headers={authorization:'alice'};
    const detail=await fetch(`${url}/runs/r1/occurrences/merged`,{headers});expect(detail.status).toBe(200);
    const payload=await detail.json();
    expect(payload.contexts).toMatchObject([{producer:'agent',model:'model-1'},{producer:'program',model:null,reasoningEffort:null},{producer:'agent',model:'model-2'}]);
    const program=await fetch(`${url}/runs/r1/occurrences/merged/runtime?attemptId=attempt-program`,{headers});
    expect(program.status).toBe(409);expect((await program.json()).error.code).toBe('RELATION_MISMATCH');expect(eventReads).toBe(0);
    const agent=await fetch(`${url}/runs/r1/occurrences/merged/runtime?attemptId=attempt-agent-2`,{headers});
    expect(agent.status).toBe(200);expect(await agent.json()).toMatchObject({attemptId:'attempt-agent-2',events:[],calls:[],scanComplete:true,observedCallCount:0,evidenceScope:'saved-runner-events-only'});
    expect(eventReads).toBe(1);
  });
  it('reads only frozen Agent declarations and reports historic tool detail as unrecorded',()=>{
    const node={id:'author',kind:'agent'} as NonNullable<typeof workflow.entrypoints.content.process>['nodes'][number];
    const entry={...workflow.entrypoints.content,nodeDefinitions:{author:{instructions:'Frozen prompt',model:'model-1',tools:['read_bound_asset'],
      toolDefinitions:[{name:'read_bound_asset',description:'Read a bound input',parameters:{type:'object',properties:{slot:{type:'string'}},required:['slot']},outputSchema:{type:'object',required:['content']}}],
      skills:[{name:'method',sourceRef:'skill://method@v1',revision:'v1'}],executor:{family:'agent-sdk'},
      configuration:{stageDeclaration:{reasoningEffort:'high',timeoutMs:900000,permissionsRevision:'p1',outputSchema:{type:'object',required:['draft']},
        threadOptions:{sandboxMode:'read-only',approvalPolicy:'never',additionalDirectories:['private-path']}},
        executor:{maxTurns:4,maxToolCalls:9,outputFormat:'json'},webSearchMode:'run-input-dependent',
        whenWebResearchTrue:{permissionsRevision:'p2',threadOptions:{webSearchMode:'live'}}}}}} as unknown as typeof workflow.entrypoints.content;
    expect(agentDeclarationDto(entry,node)).toMatchObject({reasoningEffort:'high',timeoutMs:900000,maxTurns:4,maxToolCalls:9,outputFormat:'json',
      outputSchema:{type:'object',required:['draft']},skills:[{name:'method',sourceRef:'skill://method@v1',revision:'v1'}],
      tools:[{name:'read_bound_asset',description:'Read a bound input',parameters:{required:['slot']},required:['slot'],outputSchema:{required:['content']},coverage:'recorded'}],
      permissions:{revision:'p1',sandboxMode:'read-only',approvalPolicy:'never',webSearchMode:'run-input-dependent',conditionalWebSearchMode:'live',conditionalPermissionsRevision:'p2',additionalDirectoryCount:1}});
    expect(JSON.stringify(agentDeclarationDto(entry,node))).not.toContain('private-path');
    const historic={...entry,nodeDefinitions:{author:{instructions:'Frozen prompt',tools:['read_bound_asset'],executor:{family:'agent-sdk'}}}} as typeof entry;
    expect(agentDeclarationDto(historic,node)).toMatchObject({reasoningEffort:null,outputSchema:null,skills:null,
      tools:[{name:'read_bound_asset',description:null,parameters:null,required:null,outputSchema:null,coverage:'name-only'}]});
    expect(agentDeclarationDto({...entry,nodeDefinitions:undefined},node)).toMatchObject({tools:null,skills:null,outputSchema:null});
    expect(agentDeclarationDto(entry,{id:'decision',kind:'decision'} as typeof node)).toBeNull();
  });
  it('projects frozen first-round and later-round input provenance without guessing',()=>{
    const schema={namespace:'draft',revision:'1',hash:'hash'};
    const methodEntry={workflowId:'content',codeRevision:'1',storageContract:{nodes:{author:{inputs:{draft:{schema,states:['candidate'],optional:true}},outputs:{result:{schema,requiredInputs:['draft'],appendVersions:true,initialState:'candidate'}}}},schemas:[],hash:'storage'},process:{revision:'1',hash:'process',nodes:[{id:'author',kind:'agent',storageNodeId:'author',inputs:{draft:{slot:'draft'}},outputs:{result:{slot:'result',min:1}}}],edges:[],results:[],dataBindings:[{id:'initial',from:{runInput:'priorDraft'},to:{node:'author',port:'draft'},selection:'frozen-input',when:'initial-round'},{id:'rework',from:{node:'author',port:'result'},to:{node:'author',port:'draft'},selection:'previous-business-round',when:'later-rounds'}]}} as unknown as SpaceOverview['workflows'][number]['entrypoints'][string];
    const value=nodeDto(methodEntry,methodEntry.process!.nodes[0]!);
    expect(value.inputs[0]).toMatchObject({optional:true,states:['candidate'],sources:[{kind:'run-input',source:'priorDraft',when:'initial-round'},{kind:'node',source:'author',selection:'previous-business-round',when:'later-rounds'}]});
    expect(value.outputs[0]).toMatchObject({optional:false,requiredInputs:['draft'],states:['candidate']});
  });
  it('uses saved time and identity in method and run labels, and distinguishes business rounds',()=>{
    const method=versionDto(data,workflow,'content',{state:'unknown',reason:null});
    expect(method).toMatchObject({labelSource:'derived'});expect(method.label).toContain('2026-01-01');expect(method.label).toContain('v1');
    const named=versionDto(data,workflow,'content',{state:'unknown',reason:null},[],undefined,'形成完整内容');
    expect(named).toMatchObject({label:'形成完整内容 · 2026-01-01 00:00:00 UTC',labelSource:'saved-presentation',id:'v1',revision:'1'});
    const secondsLater=versionDto(data,{...workflow,id:'v2',createdAt:'2026-01-01T00:00:02Z'},'content',{state:'unknown',reason:null},[],undefined,'形成完整内容');
    expect(secondsLater.label).toBe('形成完整内容 · 2026-01-01 00:00:02 UTC');
    expect(secondsLater.label).not.toBe(named.label);
    expect(versionDto(data,workflow,'content',{state:'unknown',reason:null},[],undefined,'形成完整内容','Asia/Taipei').label).toBe('形成完整内容 · 2026-01-01 08:00:00 Asia/Taipei');
    expect(()=>versionDto(data,workflow,'content',{state:'unknown',reason:null},[],undefined,'形成完整内容','Not/A_Zone')).toThrow();
    expect(runDto(data,run,{status:'completed',createdAt:'2026-01-02T08:30:00Z'}).label).toBe('2026-01-02 08:30 · r1');
    expect(runDto(data,run,undefined,undefined,'research-trial').executionMode).toBe('research-trial');
    expect(runDto(data,run,undefined,undefined,'case').executionMode).toBe('case');
    expect(runDto(data,run,undefined,undefined,'future-recorded-mode').executionMode).toBe('future-recorded-mode');
    expect(runDto(data,run).executionMode).toBeNull();
    const occurrence=occurrenceDto(data,{id:'st1',nodeId:'author',round:2,state:'succeeded',inputBindings:[],outputBindings:[{contextId:'co1',slot:'draft',assetVersionId:'a1'}],contextIds:['co1'],sessionIds:['se1'],attemptIds:['at1']} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>['occurrences'][number],'作者');
    expect(occurrence.label).toBe('第 2 轮 · 作者');expect(occurrence.outputs[0]).toMatchObject({occurrenceId:'st1',round:2});
  });
  it('uses only the trusted mode read for fallback Case run list and detail',async()=>{
    const calls:string[]=[];
    const url=await start({}, {runExecutionMode:async({spaceId,runId})=>{expect(spaceId).toBe('s1');calls.push(runId);return 'research-trial';}});
    const headers={authorization:'alice'};
    const list=await fetch(url+'/cases/c1/runs',{headers});
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({items:[{executionMode:'research-trial'}]});
    const detail=await fetch(url+'/runs/r1',{headers});
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({executionMode:'research-trial'});
    expect(calls).toEqual(['r1','r1']);
    const absent=await start();
    expect(await (await fetch(absent+'/runs/r1',{headers})).json()).toMatchObject({executionMode:null});
  });
  it('uses the same saved presentation label in version list and exact detail',async()=>{
    const presentation={presentation:{id:'presentation',spaceId:'s1',revision:'1',hash:'presentation-hash',createdAt:'2026-01-01T00:00:00Z',createdBy:'owner',entrypoint:'content',label:'形成完整内容',purpose:'Write content',assetViews:[],results:{primary:'draft',supporting:[],assessments:[]}},binding:{id:'binding',spaceId:'s1',workflowVersionId:'v1',entrypoint:'content',presentationId:'presentation',presentationRevision:'1',presentationHash:'presentation-hash',actorId:'owner',createdAt:'2026-01-01T00:00:00Z'},history:[]};
    const url=await start({resolvePresentation:async()=>presentation,readWorkflowVersion:async()=>workflow,versionRunStats:async()=>({runCount:1,caseCount:1})} as Partial<WorkflowSpaceService>,{displayTimeZone:'Asia/Taipei'}),headers={authorization:'alice'};
    const list=await (await fetch(url+'/versions',{headers})).json();
    const detail=await (await fetch(url+'/versions/v1',{headers})).json();
    expect(list.items[0]).toMatchObject({label:'形成完整内容 · 2026-01-01 08:00:00 Asia/Taipei',labelSource:'saved-presentation',revision:'1',id:'v1'});
    expect(detail).toMatchObject({label:list.items[0].label,labelSource:list.items[0].labelSource,revision:'1',id:'v1'});
    const fallbackUrl=await start(),fallbackList=await (await fetch(fallbackUrl+'/versions',{headers})).json(),fallbackDetail=await (await fetch(fallbackUrl+'/versions/v1',{headers})).json();
    expect(fallbackList.items[0]).toMatchObject({labelSource:'derived',label:fallbackDetail.label});
    expect(fallbackDetail.label).toContain('v1');
    const versions=[{...workflow,id:'version-a',createdAt:'2026-10-06T17:53:50.327Z'},{...workflow,id:'version-b',createdAt:'2026-10-06T17:53:52.360Z'}];
    const twoUrl=await start({overview:async()=>({...data,workflows:versions}),resolvePresentation:async()=>presentation} as Partial<WorkflowSpaceService>,{displayTimeZone:'Asia/Taipei'});
    const two=await (await fetch(twoUrl+'/versions',{headers})).json();
    expect(two.items.map((item:{label:string})=>item.label)).toEqual(['形成完整内容 · 2026-10-07 01:53:50 Asia/Taipei','形成完整内容 · 2026-10-07 01:53:52 Asia/Taipei']);
  });
  it('reads exact method expectations without runs and uses current adoption heads rather than historical decisions',async()=>{
    const schema={namespace:'draft',revision:'1',hash:'exact-schema'};
    const method={...workflow,changeReason:'',predecessorId:'saved-predecessor',entrypoints:{content:{...workflow.entrypoints.content!,storageContract:{nodes:{author:{inputs:{material:{schema,states:['candidate']}},outputs:{draft:{schema,initialState:'candidate',requiredInputs:['material'],appendVersions:true}}}},schemas:[schema],hash:'storage'},process:{revision:'1',hash:'process',nodes:[{id:'author',kind:'agent',storageNodeId:'author',inputs:{material:{slot:'material'}},outputs:{draft:{slot:'draft'}}}],edges:[],results:[{role:'primary',nodeId:'author',outputPort:'draft'}],runInputs:{material:schema},dataBindings:[{id:'material-author',from:{runInput:'material'},to:{node:'author',port:'material'},selection:'frozen-input'}]}}}} as unknown as typeof workflow;
    const snapshot={...data,workflows:[method],runs:[],assets:[],adoptions:[{slot:'production',target:{kind:'workflow',id:'v1'}}]} as unknown as SpaceOverview;
    const common={overview:async()=>snapshot,adoptionHeads:async()=>[]} as Partial<WorkflowSpaceService>;
    const url=await start(common,{availability:()=>({state:'unavailable',reason:'retained deployment missing'})});
    const get=async(path:string)=>fetch(path,{headers:{authorization:'alice'}}).then(r=>r.json());
    const detail=await get(url+'/versions/v1');
    expect(detail).toMatchObject({id:'v1',changeReason:'',predecessorId:'saved-predecessor',runCount:0,caseCount:0,adoptionStatus:'recorded',adoptionSlots:[],availability:{state:'unavailable'}});
    expect(detail.expectedAssets.assets).toHaveLength(2);
    expect(detail.expectedAssets.assets.find((a:{source:{kind:string}})=>a.source.kind==='node-output')).toMatchObject({schema,producer:{nodeId:'author',port:'draft'},resultRoles:['primary']});
    expect(detail.expectedAssets.gaps).toEqual([]);
    expect(JSON.stringify(detail.expectedAssets)).not.toContain('LARGE_PRIVATE_BODY');
    const optimized=await start({...common,readWorkflowVersion:async()=>method,versionRunStats:async()=>({runCount:0,caseCount:0})});
    expect((await get(optimized+'/versions/v1')).expectedAssets).toEqual(detail.expectedAssets);
    const graph=await fetch(url+'/versions/v1/graph',{headers:{authorization:'alice'}}).then(r=>r.text());
    expect(graph).toContain(detail.expectedAssets.assets[0].id);
    expect(graph).toContain('预期资产');
  });
  it('awaits asynchronous availability in version list and both exact detail paths',async()=>{
    const unavailable={state:'unavailable' as const,reason:'Frozen release is missing'};
    const options={availability:async(versionId:string)=>{expect(versionId).toBe('v1');return unavailable;}};
    const headers={authorization:'alice'};
    const legacy=await start({},options);
    const list=await fetch(legacy+'/versions',{headers});
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({items:[{availability:unavailable}]});
    const legacyDetail=await fetch(legacy+'/versions/v1',{headers});
    expect(legacyDetail.status).toBe(200);
    expect(await legacyDetail.json()).toMatchObject({availability:unavailable});
    const optimized=await start({readWorkflowVersion:async()=>workflow,versionRunStats:async()=>({runCount:0,caseCount:0})},options);
    const optimizedDetail=await fetch(optimized+'/versions/v1',{headers});
    expect(optimizedDetail.status).toBe(200);
    expect(await optimizedDetail.json()).toMatchObject({availability:unavailable});
  });
  it('preserves unknown adoption coverage and missing historic process instead of reconstructing it',async()=>{
    const historical={...workflow,changeReason:'',entrypoints:{content:{...workflow.entrypoints.content!,process:undefined}}};
    const url=await start({overview:async()=>({...data,workflows:[historical],runs:[],assets:[]})}),headers={authorization:'alice'};
    const detail=await (await fetch(url+'/versions/v1',{headers})).json();
    expect(detail).toMatchObject({id:'v1',changeReason:'',definitionAvailability:'missing',graphUrl:null,adoptionStatus:'unknown',adoptionSlots:[],expectedAssets:{assets:[],dependencies:[],gaps:[{code:'missing-process'}]}});
    expect((await fetch(url+'/versions/v1/graph',{headers})).status).toBe(404);
  });
  it('counts only recorded Agent attempts and preserves recovered technical failures',()=>{
    const base={id:'round-2',nodeId:'coldReader',round:2,branch:'cold',route:'review',provenance:'observed',state:'succeeded',inputBindings:[],outputBindings:[],contextIds:[],sessionIds:[],attemptIds:['attempt-agent','attempt-publish'],attemptRecords:[{id:'attempt-agent',stepRunId:'agent',runId:'r1',state:'succeeded'},{id:'attempt-publish',stepRunId:'publish',runId:'r1',state:'succeeded'}],technicalSteps:[{id:'agent',key:'cold-read',kind:'agent',state:'succeeded'},{id:'publish',key:'save',kind:'publish',state:'succeeded'}]} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>['occurrences'][number];
    expect(occurrenceDto(data,base)).toMatchObject({attemptCount:2,agentAttemptCount:1,technicalStepCount:2,branch:'cold',route:'review',provenance:'observed',failureDetails:[]});
    const recovered={...base,attemptIds:['attempt-failed','attempt-retry','attempt-publish'],attemptRecords:[{id:'attempt-failed',stepRunId:'agent-failed',runId:'r1',state:'failed',error:'upstream transport refused'},{id:'attempt-retry',stepRunId:'agent-retry',runId:'r1',state:'succeeded'},{id:'attempt-publish',stepRunId:'publish',runId:'r1',state:'succeeded'}],technicalSteps:[{id:'agent-failed',key:'cold-read',kind:'agent',state:'failed',error:'upstream transport refused'},{id:'agent-retry',key:'cold-read-retry',kind:'agent',state:'succeeded'},{id:'publish',key:'save',kind:'publish',state:'succeeded'}]} as unknown as typeof base;
    expect(occurrenceDto(data,recovered)).toMatchObject({state:'succeeded',attemptCount:3,agentAttemptCount:2,technicalStepCount:3,failureDetails:[{id:'agent-failed',kind:'agent',error:'upstream transport refused'}]});
    const retried={...base,attemptIds:['agent-try-1','agent-try-2','publish-try'],attemptRecords:[{id:'agent-try-1',stepRunId:'agent',runId:'r1',state:'failed'},{id:'agent-try-2',stepRunId:'agent',runId:'r1',state:'succeeded'},{id:'publish-try',stepRunId:'publish',runId:'r1',state:'succeeded'}]} as unknown as typeof base;
    expect(occurrenceDto(data,retried)).toMatchObject({agentAttemptCount:2,technicalStepCount:2,attemptCount:3});
    expect(occurrenceDto(data,{...base,attemptRecords:[],technicalSteps:[]})).toMatchObject({agentAttemptCount:null,technicalStepCount:0});
    expect(occurrenceDto(data,{...base,attemptRecords:[],technicalSteps:[{id:'agent',key:'cold-read',kind:'agent',state:'failed'}]} as typeof base)).toMatchObject({agentAttemptCount:null,failureDetails:[{id:'agent',error:null}]});
  });
  it('rejects unauthenticated and mutation requests',async()=>{
    const url=await start();
    expect((await fetch(`${url}/summary`)).status).toBe(401);
    const post=await fetch(`${url}/summary`,{method:'POST',headers:{authorization:'alice'}});
    expect(post.status).toBe(405);expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
  it('checks membership for every request while deduplicating concurrent overview reads',async()=>{
    let memberships=0,overviews=0;
    const url=await start({listSpaces:async()=>{memberships++;return [data.space];},overview:async()=>{overviews++;await new Promise(resolve=>setTimeout(resolve,30));return structuredClone(data);}}),headers={authorization:'alice'};
    const results=await Promise.all(['/summary','/versions','/cases','/assets'].map(path=>fetch(url+path,{headers})));
    expect(results.map(value=>value.status)).toEqual([200,200,200,200]);
    expect(memberships).toBe(4);expect(overviews).toBe(1);
  });
  it('evicts reads after membership revocation and checks again after restoration',async()=>{
    let allowed=true,overviews=0;
    const url=await start({listSpaces:async()=>allowed?[data.space]:[],overview:async()=>{overviews++;return structuredClone(data);}}),headers={authorization:'alice'};
    expect((await fetch(`${url}/summary`,{headers})).status).toBe(200);
    allowed=false;
    expect((await fetch(`${url}/summary`,{headers})).status).toBe(403);
    allowed=true;
    expect((await fetch(`${url}/summary`,{headers})).status).toBe(200);
    expect(overviews).toBe(2);
  });
  it('isolates reads by principal identity, kind, and authorization cache scope',async()=>{
    let overviews=0;
    const url=await start({overview:async()=>{overviews++;return structuredClone(data);}});
    const requests=[
      {authorization:'alice','x-cache-scope':'session-A'},
      {authorization:'alice','x-cache-scope':'session-A'},
      {authorization:'alice','x-cache-scope':'session-B'},
      {authorization:'bob','x-cache-scope':'session-A'},
      {authorization:'alice','x-cache-scope':'session-A','x-principal-kind':'service'}
    ];
    for(const headers of requests)expect((await fetch(`${url}/summary`,{headers})).status).toBe(200);
    expect(overviews).toBe(4);
  });
  it('expires a short overview snapshot so later status changes are visible',async()=>{
    let tick=Date.parse('2026-01-01T00:00:00Z'),overviews=0,extra=false;
    const url=await start({overview:async()=>{overviews++;const snapshot=structuredClone(data);if(extra)snapshot.cases.push({id:'c2',spaceId:'s1',title:'New',objective:'Goal',constraints:[]});return snapshot;}},{},()=>new Date(tick));
    const headers={authorization:'alice'};
    expect((await (await fetch(`${url}/summary`,{headers})).json()).counts.cases).toBe(1);
    extra=true;tick+=3_999;
    expect((await (await fetch(`${url}/summary`,{headers})).json()).counts.cases).toBe(1);
    tick+=2;
    expect((await (await fetch(`${url}/summary`,{headers})).json()).counts.cases).toBe(2);
    expect(overviews).toBe(2);
  });
  it('does not cache failed overview reads',async()=>{
    let attempts=0;
    const url=await start({overview:async()=>{attempts++;if(attempts===1)throw new Error('temporary read failure');return structuredClone(data);}}),headers={authorization:'alice'};
    expect((await fetch(`${url}/summary`,{headers})).status).toBe(500);
    expect((await fetch(`${url}/summary`,{headers})).status).toBe(200);
    expect(attempts).toBe(2);
  });
  it('omits asset body from directory and reads it on demand',async()=>{
    const url=await start(),headers={authorization:'alice'};
    const directory=await (await fetch(`${url}/assets`,{headers})).text();
    expect(directory).toContain('Draft');expect(directory).not.toContain('LARGE_PRIVATE_BODY_');
    const reading=await (await fetch(`${url}/assets/a1/reading`,{headers})).text();
    expect(reading).toContain('LARGE_PRIVATE_BODY_');
  });
  it('adds exact producer rounds only to paged asset items and shares one process read per run',async()=>{
    const second={...asset,id:'a2',assetId:'asset-2',payload:{title:'Draft 2',body}};
    const unmapped={...asset,id:'a3',assetId:'asset-3',payload:{title:'Unknown draft',body}};
    data.assets.push(second,unmapped);
    let processReads=0;
    const process={run,contractSource:'method',coverage:'observed',occurrences:[
      {id:'author-2',nodeId:'author',round:2,state:'succeeded',inputBindings:[],outputBindings:[{contextId:'co1',slot:'draft',assetVersionId:'a1'}],contextIds:[],sessionIds:[],attemptIds:[]},
      {id:'author-3',nodeId:'author',round:3,state:'succeeded',inputBindings:[],outputBindings:[{contextId:'co2',slot:'draft',assetVersionId:'a2'}],contextIds:[],sessionIds:[],attemptIds:[]}
    ],routes:[],relations:[],unmappedStepIds:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>;
    try{
      const url=await start({process:async()=>{processReads++;return process;}}),headers={authorization:'alice'};
      const directory=await (await fetch(`${url}/assets?limit=3`,{headers})).json();
      expect(directory.items).toMatchObject([
        {id:'a1',occurrenceId:'author-2',round:2},
        {id:'a2',occurrenceId:'author-3',round:3},
        {id:'a3',occurrenceId:null,round:null}
      ]);
      expect(JSON.stringify(directory)).not.toContain('LARGE_PRIVATE_BODY_');
      expect(processReads).toBe(1);
      const reading=await (await fetch(`${url}/assets/a1/reading`,{headers})).json();
      expect(reading.asset).toMatchObject({occurrenceId:directory.items[0].occurrenceId,round:directory.items[0].round});
      expect(processReads).toBe(1);
    }finally{data.assets.splice(-2);}
  });
  it('keeps a transformed asset in the directory without inventing a node producer',async()=>{
    const transformed={...asset,id:'transformed',assetId:'transformed',source:{kind:'transform' as const,actorId:'alice',description:'revision',fromVersionIds:['a1'],operation:'edit'},payload:{title:'Edited'}};
    data.assets.push(transformed);
    try{
      const url=await start(),response=await fetch(`${url}/assets`,{headers:{authorization:'alice'}});
      expect(response.status).toBe(200);
      const listing=await response.json();
      expect(listing.items.find((value:{id:string})=>value.id==='transformed')).toMatchObject({sourceKind:'transform',runId:null,occurrenceId:null,round:null});
    }finally{data.assets.pop();}
  });
  it('binds signed cursors to the principal and rejects changed filters',async()=>{
    const url=await start(),headers={authorization:'alice'};
    const first=await (await fetch(`${url}/assets?limit=1`,{headers})).json();
    // One result has no next page; add a second immutable version for this test only.
    data.assets.push({...asset,id:'a2',assetId:'asset-2',version:1});
    try{
      const page=await (await fetch(`${url}/assets?limit=1`,{headers})).json();
      expect(page.nextCursor).toBeTruthy();
      const cursor=encodeURIComponent(page.nextCursor);
      expect((await fetch(`${url}/assets?limit=1&cursor=${cursor}`,{headers:{authorization:'bob'}})).status).toBe(400);
      expect((await fetch(`${url}/assets?limit=1&cursor=${cursor}&schema=other`,{headers})).status).toBe(400);
      expect((await fetch(`${url}/assets?limit=1&cursor=${cursor}`,{headers})).status).toBe(200);
    }finally{data.assets.pop();}
    expect(first.nextCursor).toBeNull();
  });
  it('uses the same binary order for page sorting and keyset advancement',async()=>{
    const url=await start(),headers={authorization:'alice'};
    data.assets.push({...asset,id:'Z',assetId:'asset-Z'},{...asset,id:'a',assetId:'asset-a'});
    try{
      let cursor:string|null=null;const seen:string[]=[];
      do {const page=await (await fetch(`${url}/assets?limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,{headers})).json();seen.push(...page.items.map((item:{id:string})=>item.id));cursor=page.nextCursor;}while(cursor);
      expect(seen).toEqual(['Z','a','a1']);
    }finally{data.assets.splice(-2);}
  });
  it('includes frozen imported inputs in a run asset directory without exposing their body',async()=>{
    const imported={...asset,id:'import-1',assetId:'input-1',source:{kind:'import' as const,actorId:'alice',description:'source'},schema:{namespace:'content/materials',revision:'1',hash:'schema'},payload:{title:'Original material',body}};
    data.assets.push(imported);
    try{
      const url=await start({readManifest:async()=>({id:'m1',spaceId:'s1',caseId:'c1',assets:{materials:'import-1'},hash:'manifest'})}),headers={authorization:'alice'};
      const response=await (await fetch(`${url}/assets?runId=r1`,{headers})).text();
      expect(response).toContain('import-1');expect(response).not.toContain('LARGE_PRIVATE_BODY_');
    }finally{data.assets.pop();}
  });
  it('finds imported asset consumers from exact occurrence bindings without inventing a producer',async()=>{
    const imported={...asset,id:'input-unbound',assetId:'input-unbound',source:{kind:'import' as const,actorId:'alice',description:'source'},schema:{namespace:'content/materials',revision:'1',hash:'schema'},payload:{text:'Original'}};
    data.assets.push(imported);
    try{
      const process={run,contractSource:'method',coverage:'observed',occurrences:[{id:'author-round-2',nodeId:'author',round:2,state:'succeeded',inputBindings:[{contextId:'co1',slot:'materials',assetVersionId:'input-unbound'}],outputBindings:[],contextIds:[],sessionIds:[],attemptIds:[]}],routes:[],relations:[],unmappedStepIds:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>;
      const url=await start({process:async()=>process}),headers={authorization:'alice'};
      const relations=await (await fetch(`${url}/assets/input-unbound/relations`,{headers})).json();
      expect(relations.producer).toBeNull();
      expect(relations.consumers).toMatchObject([{runId:'r1',caseId:'c1',nodeId:'author',occurrenceId:'author-round-2',round:2}]);
    }finally{data.assets.pop();}
  });
  it('uses exact reader source refs and fragment pointers; unresolved refs receive no invented link',async()=>{
    const imported={...asset,id:'source-1',assetId:'input-1',source:{kind:'import' as const,actorId:'alice',description:'source'},schema:{namespace:'content/materials',revision:'1',hash:'schema'},payload:{text:'Original paragraph'}};
    const oldDependencies=asset.dependencies,oldPayload=asset.payload;
    asset.dependencies=['source-1'];asset.payload={body};data.assets.push(imported);
    const presentation={presentation:{id:'p',revision:'1',entrypoint:'content',label:'CONTENT',assetViews:[{schema:asset.schema,label:'完整稿件',reader:'draft',sections:[]}]},binding:{},history:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['resolvePresentation']>>;
    try{
      const url=await start({resolvePresentation:async()=>presentation,readContext:async()=>({spaceId:'s1',runId:'r1',inputs:{}} as unknown as Awaited<ReturnType<WorkflowSpaceService['readContext']>>)},
        {readers:{draft:()=>({title:'可阅读的稿件',sections:[{title:'正文',text:'Draft text',view:'body',sourceRefs:['source-ref','unresolved-ref']}]})},
          adapter:{resolveRun:async()=>({state:'recorded'}),resolveSources:async()=>[
            {ref:'source-ref',label:'原始段落',resolved:true,assetVersionId:'source-1',pointer:'/text'},
            {ref:'unresolved-ref',label:'未解析材料',resolved:false}
          ]}});
      const headers={authorization:'alice'};
      const list=await (await fetch(`${url}/assets`,{headers})).json();
      expect(list.items.find((value:{id:string})=>value.id==='a1').title).toBe('完整稿件');
      const reading=await (await fetch(`${url}/assets/a1/reading`,{headers})).json();
      expect(reading.title).toBe('可阅读的稿件');
      expect(reading.sections[0].sourceRefs).toEqual(['source-ref','unresolved-ref']);
      expect(reading.sections[0].view).toBe('body');
      expect(reading.sourceLinks).toMatchObject([{ref:'source-ref',asset:{id:'source-1'},pointer:'/text'}]);
      expect(reading.sourceLinks).toHaveLength(1);
    }finally{asset.dependencies=oldDependencies;asset.payload=oldPayload;data.assets.pop();}
  });
  it('keeps the exact producer occurrence and frozen display label in process and reading details',async()=>{
    const oldPayload=asset.payload;asset.payload={body};
    const presentation={presentation:{id:'p',revision:'1',entrypoint:'content',label:'CONTENT',assetViews:[{schema:asset.schema,label:'完整稿件',sections:[]}]},binding:{},history:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['resolvePresentation']>>;
    const process={run,contractSource:'method',coverage:'observed',occurrences:[{id:'author-round-2',nodeId:'author',round:2,state:'succeeded',inputBindings:[],outputBindings:[{contextId:'co1',slot:'draft',assetVersionId:'a1'}],contextIds:[],sessionIds:[],attemptIds:[]}],routes:[],relations:[],unmappedStepIds:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>;
    try{
      const url=await start({resolvePresentation:async()=>presentation,process:async()=>process}),headers={authorization:'alice'};
      const processDto=await (await fetch(`${url}/runs/r1/process`,{headers})).json();
      expect(processDto.occurrences[0].outputs[0]).toMatchObject({id:'a1',title:'完整稿件',occurrenceId:'author-round-2',round:2});
      const occurrence=await (await fetch(`${url}/runs/r1/occurrences/author-round-2`,{headers})).json();
      expect(occurrence.outputs[0]).toMatchObject({title:'完整稿件',round:2});
      const reading=await (await fetch(`${url}/assets/a1/reading`,{headers})).json();
      expect(reading.asset).toMatchObject({id:'a1',occurrenceId:'author-round-2',round:2});
    }finally{asset.payload=oldPayload;}
  });
  it('serves saved failure reasons without confusing Agent retries with publication steps',async()=>{
    const view={run,contractSource:'method',coverage:'observed',occurrences:[{id:'cold-round-1',nodeId:'coldReader',round:1,branch:'cold',route:'review',provenance:'observed',state:'succeeded',stepRunIds:['agent-failed','agent-recovered','publish'],inputBindings:[],outputBindings:[],contextIds:[],sessionIds:[],attemptIds:['a-failed','a-recovered','a-publish'],attemptRecords:[{id:'a-failed',stepRunId:'agent-failed',state:'failed',error:'transport closed'},{id:'a-recovered',stepRunId:'agent-recovered',state:'succeeded'},{id:'a-publish',stepRunId:'publish',state:'succeeded'}],technicalSteps:[{id:'agent-failed',key:'cold-read',kind:'agent',state:'failed',error:'transport closed'},{id:'agent-recovered',key:'cold-read-retry',kind:'agent',state:'succeeded'},{id:'publish',key:'save-review',kind:'publish',state:'succeeded'}]}],routes:[],relations:[],unmappedStepIds:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>;
    const url=await start({process:async()=>view}),headers={authorization:'alice'};
    const processDto=await (await fetch(`${url}/runs/r1/process`,{headers})).json();
    expect(processDto.occurrences[0]).toMatchObject({state:'succeeded',branch:'cold',provenance:'observed',attemptCount:3,agentAttemptCount:2,technicalStepCount:3,failureDetails:[{id:'agent-failed',kind:'agent',error:'transport closed'}]});
    const exact=await (await fetch(`${url}/runs/r1/occurrences/cold-round-1`,{headers})).json();
    expect(exact.failureDetails).toMatchObject([{id:'agent-failed',error:'transport closed'}]);
  });
  it('returns a graph state snapshot bound to the exact process run and version',async()=>{
    const view={run,contract:{revision:'1',hash:'process-hash',nodes:[{id:'author',kind:'agent'}],edges:[],results:[]},contractSource:'method',coverage:'observed',occurrences:[{id:'author-round-2',nodeId:'author',round:2,provenance:'observed',state:'succeeded',branch:'main',stepRunIds:['step'],inputBindings:[],outputBindings:[],contextIds:[],sessionIds:[],attemptIds:['attempt'],attemptRecords:[{id:'attempt',stepRunId:'step',state:'succeeded'}],technicalSteps:[{id:'step',key:'author',kind:'agent',state:'succeeded'}]}],routes:[],relations:[],unmappedStepIds:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>;
    const url=await start({process:async()=>view}),headers={authorization:'alice'};
    const response=await fetch(`${url}/runs/r1/process`,{headers}),value=await response.json();
    expect(response.status).toBe(200);
    expect(value.graphState).toMatchObject({schemaVersion:1,spaceId:'s1',runId:'r1',versionId:'v1',nodes:[{id:'author',state:'succeeded',round:2,occurrences:[{id:'author-round-2',branch:'main',provenance:'observed'}]}],edges:[],truncated:false});
    expect(value.graphState.digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('uses frozen presentation labels in exact dependency, previous draft, and assessment relations',async()=>{
    const oldPayload=asset.payload,oldDependencies=asset.dependencies;asset.payload={body};asset.dependencies=['previous','research'];
    const previous={...asset,id:'previous',assetId:'another-draft',payload:{body:'Earlier'},createdAt:'2025-12-31T00:00:00Z',dependencies:[]};
    const research={...asset,id:'research',assetId:'research',schema:{namespace:'content/research',revision:'1',hash:'research'},payload:{body:'Evidence'},source:{kind:'import' as const,actorId:'alice',description:'source'},dependencies:[]};
    const assessment={...asset,id:'assessment',assetId:'assessment',schema:{namespace:'content/review',revision:'1',hash:'review'},payload:{body:'Opinion'},dependencies:['a1']};
    data.assets.push(previous,research,assessment);
    const presentation={presentation:{id:'p',revision:'1',entrypoint:'content',label:'CONTENT',assetViews:[{schema:asset.schema,label:'完整稿件',sections:[]},{schema:research.schema,label:'研究依据',sections:[]},{schema:assessment.schema,label:'主编意见',sections:[]}]},binding:{},history:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['resolvePresentation']>>;
    const process={run,contractSource:'method',coverage:'observed',occurrences:[],routes:[],relations:[],unmappedStepIds:[]} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>;
    try{
      const url=await start({resolvePresentation:async()=>presentation,process:async()=>process},{adapter:{resolveRun:async()=>({state:'recorded',process:[{label:'稿件',assetVersionId:'a1',assessmentAssetVersionIds:['assessment']} ]})}});
      const relation=await (await fetch(`${url}/assets/a1/relations`,{headers:{authorization:'alice'}})).json();
      expect(relation.dependencies.map((value:{title:string})=>value.title)).toEqual(['完整稿件','研究依据']);
      expect(relation.previousDraft).toMatchObject({id:'previous',title:'完整稿件'});
      expect(relation.assessments).toMatchObject([{id:'assessment',title:'主编意见'}]);
    }finally{asset.payload=oldPayload;asset.dependencies=oldDependencies;data.assets.splice(-3);}
  });
  it('checks exact case/run relation',async()=>{
    const url=await start(),headers={authorization:'alice'};
    const response=await fetch(`${url}/assets?caseId=c1&runId=wrong`,{headers});
    expect(response.status).toBe(404);
  });
  it('maps service membership denial and missing records without leaking internals',async()=>{
    const url=await start({overview:async()=>{throw new Error('Space access denied');}}),headers={authorization:'alice'};
    const denied=await fetch(`${url}/summary`,{headers});
    expect(denied.status).toBe(403);expect((await denied.json()).error.code).toBe('FORBIDDEN');
  });
  it('rejects oversized pages and maps an exact service read miss to 404',async()=>{
    const url=await start({readAsset:async()=>{throw new Error('Record not found in authorized space');}}),headers={authorization:'alice'};
    expect((await fetch(`${url}/assets?limit=101`,{headers})).status).toBe(400);
    const missing=await fetch(`${url}/assets/a1/reading`,{headers});
    expect(missing.status).toBe(404);expect((await missing.json()).error.code).toBe('NOT_FOUND');
  });
  it('only exposes declared, safe configuration and serves a sandboxed graph',async()=>{
    const original=workflow.entrypoints.content;
    workflow.entrypoints.content={...original,process:{revision:'1',hash:'process',nodes:[{id:'author',kind:'agent'}],edges:[],results:[]},nodeDefinitions:{author:{purpose:'Write',instructions:'Prompt body',model:'model-1',tools:['web'],toolDefinitions:[{name:'web',description:'Call web; Authorization: Bearer description-secret',parameters:{type:'object',properties:{query:{type:'string',description:'Search terms'},apiKey:{type:'string',default:'sk-secretinschema1234567890'}}},outputSchema:{type:'object',description:'access_token=output-secret'}}],skills:[{name:'research',sourceRef:'https://example.test/skill?X-Amz-Signature=source-secret'}],configuration:{stageDeclaration:{reasoningEffort:'high',password:'nested-secret'},executor:{capability:'hidden-secret'},apiKey:'hidden-secret'}}}} as typeof original;
    try{
      const url=await start(),headers={authorization:'alice'};
      const detail=await (await fetch(`${url}/versions/v1/nodes/author`,{headers})).text();
      expect(detail).toContain('Prompt body');expect(detail).toContain('reasoningEffort');expect(detail).not.toContain('hidden-secret');expect(detail).not.toContain('nested-secret');
      const parsed=JSON.parse(detail);
      expect(parsed.agentDeclarationCoverage).toBe('full');
      expect(parsed.agentDeclaration).toMatchObject({reasoningEffort:'high',tools:[{name:'web',coverage:'recorded',parameters:{type:'object',properties:{query:{type:'string',description:'Search terms'},apiKey:'[REDACTED]'}},required:[]}],skills:[{name:'research'}],outputSchema:null});
      expect(detail).not.toMatch(/description-secret|secretinschema|output-secret|source-secret/u);
      expect(parsed.agentDeclaration.skills[0].sourceRef).toContain('[REDACTED]');
      const graph=await fetch(`${url}/versions/v1/graph`,{headers});const html=await graph.text();
      expect(graph.status).toBe(200);expect(graph.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(graph.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-downloads');
      expect(html).toContain('workflow-node-select');expect(html).toContain('space-node-focus');
      expect(html).toContain('space-viewer-adapter');expect(html).toContain('data-present="true"');
    }finally{workflow.entrypoints.content=original;}
  });
  it('marks every frozen Agent declaration sanitizer limit without silently claiming full coverage',async()=>{
    const original=workflow.entrypoints.content;
    const nested=Array.from({length:10}).reduce<Record<string,unknown>>(value=>({next:value}),{type:'string'});
    const cases=[
      {parameters:{type:'object',description:'P'.repeat(16_385)},outputSchema:{type:'object',description:'O'.repeat(16_385)},verify:(tool:Record<string,unknown>)=>{
        expect((tool.parameters as {description:string}).description).toHaveLength(16_384);
        expect((tool.outputSchema as {description:string}).description).toHaveLength(16_384);
      }},
      {parameters:{type:'object',enum:Array.from({length:101},(_,index)=>index)},outputSchema:{type:'object'},verify:(tool:Record<string,unknown>)=>expect((tool.parameters as {enum:number[]}).enum).toHaveLength(100)},
      {parameters:{type:'object',properties:Object.fromEntries(Array.from({length:101},(_,index)=>[`field${index}`,{type:'string'}]))},outputSchema:{type:'object'},verify:(tool:Record<string,unknown>)=>expect(Object.keys((tool.parameters as {properties:Record<string,unknown>}).properties)).toHaveLength(100)},
      {parameters:{type:'object',properties:{deep:nested}},outputSchema:{type:'object'},verify:(tool:Record<string,unknown>)=>expect(JSON.stringify(tool.parameters)).toContain('[truncated depth]')},
    ];
    try{
      const url=await start(),headers={authorization:'alice'};
      for(const testCase of cases){
        workflow.entrypoints.content={...original,process:{revision:'1',hash:'process',nodes:[{id:'author',kind:'agent'}],edges:[],results:[]},nodeDefinitions:{author:{tools:['web'],toolDefinitions:[{name:'web',description:'Search',parameters:testCase.parameters,outputSchema:testCase.outputSchema}]}}} as typeof original;
        const response=await fetch(`${url}/versions/v1/nodes/author`,{headers});expect(response.status).toBe(200);
        const detail=await response.json();expect(detail.agentDeclarationCoverage).toBe('truncated');
        testCase.verify(detail.agentDeclaration.tools[0]);
      }
      workflow.entrypoints.content={...original,process:{revision:'1',hash:'process',nodes:[{id:'manual',kind:'human'}],edges:[],results:[]}} as typeof original;
      const manual=await (await fetch(`${url}/versions/v1/nodes/manual`,{headers})).json();
      expect(manual).toMatchObject({agentDeclaration:null,agentDeclarationCoverage:null});
    }finally{workflow.entrypoints.content=original;}
  });
  it('accepts only parent focus messages for graph node IDs and suppresses the focus echo',()=>{
    const raw='<html><head></head><body><script>window.parent.postMessage({type:\'workflow-node-select\',nodeId:id}, \'*\')</script></body></html>';
    const html=bridgeWorkflowDiagram(raw,['author']);
    expect(html).toContain("if(window.__spaceFocusNode!==id)window.parent.postMessage");
    const bridge=html.match(/<script>\(function\(\)\{var ids=new Set[\s\S]*?<\/script>/)?.[0];
    expect(bridge).toBeTruthy();
    let listener:(event:{source:unknown;data:unknown})=>void=()=>{};const focused:string[]=[];
    const parent={};const window={parent,addEventListener:(_name:string,fn:typeof listener)=>{listener=fn;},Archify:{focus:{set:(id:string)=>focused.push(id),clear:()=>focused.push('clear')}}};
    runInNewContext(bridge!.replace(/^<script>|<\/script>$/g,''),{window,Archify:window.Archify,setTimeout:()=>0});
    listener({source:{},data:{type:'space-node-focus',nodeId:'author'}});
    listener({source:{},data:{type:'space-node-focus',nodeId:null}});
    listener({source:parent,data:{type:'space-node-focus',nodeId:'unknown'}});
    listener({source:parent,data:{type:'space-node-focus',nodeId:'author'}});
    listener({source:parent,data:{type:'space-node-focus',nodeId:null}});
    expect(focused).toEqual(['author','clear']);
  });
});
