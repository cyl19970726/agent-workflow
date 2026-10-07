import { describe, expect, it } from 'vitest';
import { methodListBody, methodVersionBody, methodPreviewBody } from './method-render.js';
import type { SpaceOverview, WorkflowVersion } from './types.js';
import { createSpaceConsole, type SpaceConsoleService } from './console.js';

const schema={namespace:'example/draft',revision:'1',hash:'a'.repeat(64)};
const version:WorkflowVersion={id:'v-2',spaceId:'space',revision:'V2',predecessorId:'v-1',changeReason:'Improve routing',hash:'b'.repeat(64),createdAt:'2026-10-05T00:00:00Z',config:{},entrypoints:{content:{workflowId:'example.content',codeRevision:'code',storageContract:{workflowVersion:'v-2',hash:'c'.repeat(64),stateRules:[],nodes:{writer:{inputs:{},outputs:{draft:{schema}}}}},nodeDefinitions:{writer:{purpose:'Write a draft',instructions:'Use evidence',model:'model-x',tools:['lookup']}},process:{revision:'2',hash:'d'.repeat(64),nodes:[{id:'writer',kind:'agent',storageNodeId:'writer',outputs:{draft:{slot:'draft'}}},{id:'review',kind:'decision'}],edges:[{id:'next',from:'writer',to:'review',kind:'sequence'},{id:'again',from:'review',to:'writer',kind:'rework',maxTraversals:2}],results:[{role:'primary',nodeId:'writer',outputPort:'draft'}]}}}};
const data:SpaceOverview={space:{id:'space',purpose:'Create useful content',owner:'owner',status:'active',createdAt:'2026-10-05T00:00:00Z'},workflows:[version],cases:[{id:'case-a',spaceId:'space',title:'Case A',objective:'',constraints:[]}],runs:[{runId:'run-a',spaceId:'space',workflowVersionId:'v-2',entrypoint:'content',caseId:'case-a',inputManifestId:'manifest',effectiveConfig:{},configHash:'hash'},{runId:'run-b',spaceId:'space',workflowVersionId:'v-2',entrypoint:'other',caseId:'case-a',inputManifestId:'manifest',effectiveConfig:{},configHash:'hash'}],assets:[],reviews:[{id:'review-a',runId:'run-a',spaceId:'space',assetVersionIds:[],standard:{id:'s',revision:'1',content:''},judge:{kind:'human',id:'h'},evidence:[],answers:{good:'Good',bad:'Bad',improvement:'Better',unresolved:'Unknown'},createdAt:'2026-10-05T00:00:00Z'},{id:'review-b',runId:'run-b',spaceId:'space',assetVersionIds:[],standard:{id:'s',revision:'1',content:''},judge:{kind:'human',id:'h'},evidence:[],answers:{good:'Other',bad:'',improvement:'',unresolved:''},createdAt:'2026-10-05T00:00:00Z'}],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]};

describe('method workbench rendering',()=>{
 it('shows a zero-run candidate as a directional graph with frozen node details and no execution claim',()=>{
  const empty={...data,runs:[],reviews:[],workflows:[]};
  const list=methodListBody(empty,{workflowId:'example.content',entrypoint:'content'});
  expect(list).toContain('/workbench/workflows/preview');
  const preview=methodPreviewBody(empty,{version,entrypoint:'content'},'<input type="hidden" name="csrf" value="test">','writer');
  expect(preview).toContain('data-workflow-diagram');expect(preview).toContain('sandbox="allow-scripts allow-downloads"');expect(preview).toContain('返工');expect(preview).toContain('Write a draft');expect(preview).toContain('Use evidence');expect(preview).toContain('example/draft');
  expect(preview).toContain('待发布草稿');expect(preview).not.toContain('<button type="submit">启动运行');
 });
 it('scopes runs and reviews to exact version and entrypoint, and distinguishes adoption and availability',()=>{
  const html=methodVersionBody(data,version,'content','writer',{available:false,reason:'Old execution package unavailable'});
  expect(html).toContain('run-a');expect(html).not.toContain('run-b');expect(html).toContain('review-a');expect(html).not.toContain('review-b');
  expect(html).toContain('当前采用：未指定');expect(html).toContain('Old execution package unavailable');
  expect(html).toContain('/spaces/space/workflows/v-2/content');
 });
 it('labels versions without a frozen process as partial history',()=>{
  const old={...version,entrypoints:{content:{...version.entrypoints.content!,process:undefined}}};
  expect(methodVersionBody({...data,workflows:[old]},old,'content',undefined,undefined)).toContain('完整路径未知');
 });
 it('shows distinct exact identity when several revisions share a readable name',()=>{
  const first={...version,id:'creation-content-aaaaaaaaaa',revision:'content-v2'};
  const second={...version,id:'creation-content-bbbbbbbbbb',revision:'content-v2',createdAt:'2026-10-05T00:00:01Z'};
  const html=methodListBody({...data,workflows:[first,second]});
  expect(html).toContain('…aaaaaaaaaa');expect(html).toContain('…bbbbbbbbbb');
 });
 it('serves method routes from the frozen overview even if run projection is unavailable',async()=>{
  const service:SpaceConsoleService={async listSpaces(){return[data.space];},async overview(){return data;},async readAsset(){throw Error('unused');},async readContext(){throw Error('unused');},async sessionEvents(){throw Error('unused');},async readBlob(){throw Error('unused');}};
  const server=createSpaceConsole(service,{businessAdapter:{async resolveRun(){throw Error('runtime projection unavailable');}}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {const address=server.address();if(!address||typeof address==='string')throw Error('no address');const base=`http://127.0.0.1:${address.port}`;
   expect((await fetch(`${base}/spaces/space/workflows`)).status).toBe(200);
   const response=await fetch(`${base}/spaces/space/workflows/v-2/content`);expect(response.status).toBe(200);expect(await response.text()).toContain('完整方法图');
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});
