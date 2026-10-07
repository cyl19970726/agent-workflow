import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createSpaceConsole, type SpaceConsoleService } from './console.js';
import { createInteractiveSpaceConsole, type InteractiveWorkflowHost } from './interactive-console.js';
import { workflowDiagramScript } from './diagram-host.js';
import type { SpaceOverview, WorkflowVersion } from './types.js';
import type { ProcessView } from './process-projection.js';

const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);const a=server.address();if(!a||typeof a==='string')throw Error('Missing address');return `http://127.0.0.1:${a.port}`;}
function fixture(){
 const entry={workflowId:'test.content',codeRevision:'source',storageContract:{workflowVersion:'method',hash:'storage',nodes:{},stateRules:[]},process:{revision:'1',hash:'process',nodes:[{id:'writer',kind:'agent' as const},{id:'gate',kind:'human' as const}],edges:[{id:'forward',from:'writer',to:'gate',kind:'sequence' as const},{id:'revise',from:'gate',to:'writer',kind:'rework' as const,maxTraversals:2}],results:[]},nodeDefinitions:{writer:{purpose:'Write precisely',instructions:'Frozen prompt',model:'frozen-model',tools:['read_asset'],executor:{family:'codex' as const}}}};
 const version:WorkflowVersion={id:'method',spaceId:'allowed',revision:'One',changeReason:'fixture',hash:'hash',createdAt:'2026-10-06',config:{},entrypoints:{content:entry}};
 const run={runId:'run',spaceId:'allowed',workflowVersionId:'method',entrypoint:'content',caseId:'case',inputManifestId:'input',effectiveConfig:{},configHash:'config'};
 const view:ProcessView={run,contract:entry.process,contractSource:'method',coverage:'observed',occurrences:[{id:'occurrence',nodeId:'writer',provenance:'observed',state:'failed',stepRunIds:['step'],contextIds:['context'],attemptIds:[],attemptRecords:[],technicalSteps:[],sessionIds:['session'],lifecycleEvidence:[],inputBindings:[],outputBindings:[],inputs:{},outputs:{}}],routes:[],relations:[],unmappedStepIds:[]};
 const data:SpaceOverview={space:{id:'allowed',purpose:'Test content',owner:'owner',status:'active',createdAt:'2026-10-06'},workflows:[version],cases:[{id:'case',spaceId:'allowed',title:'Case',objective:'Read only',constraints:[]}],runs:[run,{...run,runId:'other',workflowVersionId:'other-method'}],assets:[],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]};
 const service:SpaceConsoleService={listSpaces:async()=>[data.space],overview:async(space)=>{if(space!=='allowed')throw Error('Space access denied');return data;},process:async()=>view,readAsset:async()=>{throw Error('unused');},readContext:async()=>{throw Error('unused');},runtimeContexts:async()=>[],sessionEvents:async()=>({items:[],nextCursor:0,hasMore:false}),readBlob:async()=>new Uint8Array()};
 const publishes=vi.fn(),starts=vi.fn();
 const workflow:InteractiveWorkflowHost={spaceId:'allowed',label:'Content',caseFields:[],runFields:[],createCase:async()=>({id:'case'}),startRun:async()=>{starts();return{runId:'unused'};},saveReview:async()=>({id:'unused'}),runStatus:async()=>({state:'failed'}),isDeliverable:()=>false,methods:{workflowId:'test.content',entrypoint:'content',preview:async()=>({entrypoint:'content',version,presentation:undefined}),publish:async()=>{publishes();return{workflowVersionId:'method',entrypoint:'content'};},availability:async()=>({available:false})}};
 return{service,workflow,version,data,view,publishes,starts};
}

describe('authorized Archify diagram host',()=>{
 it('isolates viewer scripts while preserving authenticated exact method/run details',async()=>{
  const f=fixture(),base=await listen(createSpaceConsole(f.service));const route='/spaces/allowed/workflows/method/content';
  const parent=await fetch(base+route+'?run=run&node=writer');const html=await parent.text();
  expect(parent.status).toBe(200);expect(parent.headers.get('content-security-policy')).toContain("frame-src 'self'");
  expect(html).toContain('sandbox="allow-scripts allow-downloads"');expect(html).toContain('/diagram?run=run&amp;node=writer');expect(html).toContain('Frozen prompt');expect(html).toContain('/contexts/context');expect(html).toContain('/sessions/session');
  const frame=await fetch(base+route+'/diagram?run=run');const rendered=await frame.text();
  expect(frame.status).toBe(200);expect(frame.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");expect(frame.headers.get('content-security-policy')).toContain('sandbox allow-scripts allow-downloads');expect(frame.headers.get('x-frame-options')).toBe('SAMEORIGIN');expect(frame.headers.get('cache-control')).toBe('no-store');
  expect(rendered.includes('data-edge-id="revise"')).toBe(true);expect(rendered.includes('data-workflow-status="failed"')).toBe(true);expect(rendered.includes('data-workflow-status="none"')).toBe(true);expect(rendered.includes('Frozen prompt')).toBe(false);
  expect((await fetch(base+'/spaces/denied/workflows/method/content/diagram')).status).toBe(403);
  for(const query of ['node=missing','run=other','run=missing'])expect((await fetch(base+route+'/diagram?'+query)).status).toBe(400);
  f.view.run={...f.view.run,workflowVersionId:'mismatched'};expect((await fetch(base+route+'/diagram?run=run')).status).toBe(400);
 });
 it('pins preview details and viewer to the expected candidate without publishing or running',async()=>{
  const f=fixture(),base=await listen(createInteractiveSpaceConsole(f.service,{workflow:f.workflow}));
  const parent=await fetch(base+'/workbench/workflows/preview');expect(parent.status).toBe(200);expect(await parent.text()).toContain('/preview/diagram?version=method');
  const response=await fetch(base+'/workbench/workflows/preview/diagram?version=method');expect(response.status).toBe(200);expect((await response.text()).includes('archify 3.0.1')).toBe(true);
  for(const path of ['/preview/diagram?version=stale','/preview?version=stale'])expect((await fetch(base+'/workbench/workflows'+path)).status).toBe(409);
  expect((await fetch(base+'/workbench/workflows/preview/diagram?node=missing')).status).toBe(400);
  expect(f.publishes).not.toHaveBeenCalled();expect(f.starts).not.toHaveBeenCalled();
 });
 it('uses a historical explanation contract without changing the saved method or claiming full coverage',async()=>{
  const f=fixture();delete f.version.entrypoints.content!.process;delete f.version.entrypoints.content!.nodeDefinitions;
  f.view.contractSource='retrospective';f.view.coverage='partial';f.view.unmappedStepIds=['unmapped'];f.view.occurrences[0]!.provenance='derived';
  const original=JSON.stringify(f.version);const base=await listen(createSpaceConsole(f.service));
  const path='/spaces/allowed/workflows/method/content';
  const html=await(await fetch(base+path+'?run=run&node=writer')).text();
  expect(html).toContain('历史兼容图');expect(html).toContain('历史推导');expect(html).toContain('1 个技术步骤未映射');expect(html).toContain('执行类型：未声明');expect(html).toContain('工具：</strong>未记录');
  const frame=await fetch(base+path+'/diagram?run=run&node=writer');expect(frame.status).toBe(200);expect((await frame.text()).includes('c-unknown-agent')).toBe(true);
  expect(JSON.stringify(f.version)).toBe(original);
  expect(await(await fetch(base+path)).text()).toContain('完整路径未知');
 });
 it('accepts node selections only from its iframe and preserves exact run/version in detail fetches',async()=>{
  const source={},frame={contentWindow:source,src:'http://localhost/preview/diagram?version=exact',dataset:{nodeIds:'["writer"]'}};
  const replaced=vi.fn(),focused=vi.fn();const detail={setAttribute:vi.fn(),focus:focused};
  const fetcher=vi.fn(async()=>({ok:true,text:async()=>'<section id="node-detail"></section>'}));let handler:(event:unknown)=>Promise<void>=async()=>{};
  const history={replaceState:vi.fn()};
  runInNewContext(workflowDiagramScript,{window:{addEventListener:(_name:string,callback:typeof handler)=>{handler=callback;}},document:{querySelectorAll:()=>[frame],querySelector:()=>({replaceWith:replaced})},location:{href:'http://localhost/preview?run=run',assign:vi.fn()},history,fetch:fetcher,URL,AbortController,DOMParser:class{parseFromString(){return{querySelector:()=>detail};}},matchMedia:()=>({matches:false})});
  await handler({source:{},data:{type:'workflow-node-select',nodeId:'writer'}});await handler({source,data:{type:'workflow-node-select',nodeId:'missing'}});expect(fetcher).not.toHaveBeenCalled();
  await handler({source,data:{type:'workflow-node-select',nodeId:'writer'}});expect(fetcher).toHaveBeenCalledOnce();expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://localhost/preview?run=run&version=exact&node=writer#node-detail');expect(replaced).toHaveBeenCalledWith(detail);expect(focused).toHaveBeenCalledOnce();
 });
});
