import {afterEach, describe, expect, it} from 'vitest';
import {createServer, type Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {runInNewContext} from 'node:vm';
import {bridgeWorkflowDiagram, createWorkflowSpaceApiHandler, type SpaceApiHost} from './server.js';
import {nodeDto, occurrenceDto, runDto, versionDto} from './read-model.js';
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
describe('read-only Space API',()=>{
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
    const occurrence=occurrenceDto(data,{id:'st1',nodeId:'author',round:2,state:'succeeded',inputBindings:[],outputBindings:[{contextId:'co1',slot:'draft',assetVersionId:'a1'}],contextIds:['co1'],sessionIds:['se1'],attemptIds:['at1']} as unknown as Awaited<ReturnType<WorkflowSpaceService['process']>>['occurrences'][number],'作者');
    expect(occurrence.label).toBe('第 2 轮 · 作者');expect(occurrence.outputs[0]).toMatchObject({occurrenceId:'st1',round:2});
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
    workflow.entrypoints.content={...original,process:{revision:'1',hash:'process',nodes:[{id:'author',kind:'agent'}],edges:[],results:[]},nodeDefinitions:{author:{purpose:'Write',instructions:'Prompt body',model:'model-1',tools:['web'],configuration:{stageDeclaration:{reasoningEffort:'high',password:'nested-secret'},executor:{capability:'hidden-secret'},apiKey:'hidden-secret'}}}} as typeof original;
    try{
      const url=await start(),headers={authorization:'alice'};
      const detail=await (await fetch(`${url}/versions/v1/nodes/author`,{headers})).text();
      expect(detail).toContain('Prompt body');expect(detail).toContain('reasoningEffort');expect(detail).not.toContain('hidden-secret');expect(detail).not.toContain('nested-secret');
      const graph=await fetch(`${url}/versions/v1/graph`,{headers});const html=await graph.text();
      expect(graph.status).toBe(200);expect(graph.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(graph.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-downloads');
      expect(html).toContain('workflow-node-select');expect(html).toContain('space-node-focus');
      expect(html).toContain('space-viewer-adapter');expect(html).toContain('data-present="true"');
    }finally{workflow.entrypoints.content=original;}
  });
  it('accepts only parent focus messages for graph node IDs and suppresses the focus echo',()=>{
    const raw='<html><head></head><body><script>window.parent.postMessage({type:\'workflow-node-select\',nodeId:id}, \'*\')</script></body></html>';
    const html=bridgeWorkflowDiagram(raw,['author']);
    expect(html).toContain("if(window.__spaceFocusNode!==id)window.parent.postMessage");
    const bridge=html.match(/<script>\(function\(\)\{var ids=new Set[\s\S]*?<\/script>/)?.[0];
    expect(bridge).toBeTruthy();
    let listener:(event:{source:unknown;data:unknown})=>void=()=>{};const focused:string[]=[];
    const parent={};const window={parent,addEventListener:(_name:string,fn:typeof listener)=>{listener=fn;},Archify:{focus:{set:(id:string)=>focused.push(id)}}};
    runInNewContext(bridge!.replace(/^<script>|<\/script>$/g,''),{window,Archify:window.Archify,setTimeout:()=>0});
    listener({source:{},data:{type:'space-node-focus',nodeId:'author'}});
    listener({source:parent,data:{type:'space-node-focus',nodeId:'unknown'}});
    listener({source:parent,data:{type:'space-node-focus',nodeId:'author'}});
    expect(focused).toEqual(['author']);
  });
});
