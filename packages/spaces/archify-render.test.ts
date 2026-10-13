import { describe, expect, it } from 'vitest';
import { renderWorkflowDiagram } from './archify-render.js';
import type { WorkflowEntrypoint } from './types.js';
import type { ProcessView } from './process-projection.js';
import { projectExpectedAssets } from './expected-assets.js';
import type {RunGraphAssets} from './run-graph-assets.js';

const contract = {
  revision:'1',hash:'x'.repeat(64),results:[],nodes:[
    {id:'start',kind:'agent'}, {id:'check',kind:'decision'}, {id:'alpha',kind:'program'},
    {id:'beta',kind:'human'}, {id:'merge',kind:'agent'},
  ],edges:[
    {id:'e1',from:'start',to:'check',kind:'sequence'},
    {id:'e2',from:'check',to:'alpha',kind:'condition',route:'yes'},
    {id:'e3',from:'check',to:'beta',kind:'condition',route:'no'},
    {id:'e4',from:'alpha',to:'merge',kind:'fork',route:'branches'},
    {id:'e5',from:'beta',to:'merge',kind:'join',route:'branches'},
    {id:'e6',from:'merge',to:'check',kind:'rework',maxTraversals:2},
  ],
} as unknown as NonNullable<WorkflowEntrypoint['process']>;
const entry = {workflowId:'test-workflow',codeRevision:'r1',process:contract,nodeDefinitions:{start:{executor:{family:'agent-sdk',adapter:'SIWC Responses'}},merge:{executor:{family:'codex'}}}} as WorkflowEntrypoint;

describe('Archify workflow renderer', () => {
  it('renders every declared node and edge in a standalone viewer', async () => {
    const html = await renderWorkflowDiagram({entry,detailBase:'/detail',selectedNodeId:'check'});
    for (const node of contract.nodes) expect(html).toContain(`data-node-id="${node.id}"`);
    for (const edge of contract.edges) expect(html).toContain(`data-edge-id="${edge.id}"`);
    expect(html).toContain('data-workflow-selected');
    expect(html).toContain('workflow-node-select');
    expect(html).toContain('data-space-initial-fit');
    expect(html).toContain('Archify.view.centerAt(');
    expect(html).toContain('archify 3.0.1');
  });
  it('keeps hostile display text inert', async () => {
    const evil = '</script><script>globalThis.pwned=1</script>';
    const html = await renderWorkflowDiagram({entry:{...entry,workflowId:evil},detailBase:'/detail',presentation:{id:'p',revision:'1',entrypoint:'x',label:evil,assetViews:[],results:{primary:'x',supporting:[],assessments:[]}}});
    expect(html).not.toContain(evil);
    expect(html).toContain('&lt;/script&gt;');
  });
  it('keeps stage labels and run evidence distinct from method structure', async () => {
    const view = {run:{spaceId:'s',runId:'r',workflowVersionId:'v'},contract, routes:[],occurrences:[{id:'a',nodeId:'start',round:1,state:'failed',provenance:'observed'},{id:'b',nodeId:'start',round:2,state:'succeeded',provenance:'observed'}]} as unknown as ProcessView;
    const presentation = {id:'p',revision:'1',entrypoint:'x',label:'CONTENT',assetViews:[],results:{primary:'x',supporting:[],assessments:[]},stages:[{id:'start',label:'研究者'}]};
    const html = await renderWorkflowDiagram({entry,detailBase:'/detail',view,presentation});
    expect(html).toContain('研究者');
    expect(html).toContain('第2轮 · 成功');
    expect(html).toContain('无执行证据');
    expect(html).toContain('data-workflow-status="succeeded"');
    expect(html).toContain('space-graph-state');
    expect(html).toContain('space-graph-ready');
    expect(html).toContain('data-space-initial-fit');
    expect(html).toContain('data-workflow-status="none"');
    expect(html).toContain('class="c-agent-sdk"');
    expect(html).toContain('class="c-codex"');
    expect(html).toContain('class="c-decision"');
    expect(html).toContain('data-animation="none"');
  });
  it('renders only exact run assets and their recorded producer and consumer edges', async()=>{
    const frozenId='99299633-7ad7-4d31-8457-c56938fd742c';
    const actualAssets:RunGraphAssets={assets:[
      {id:frozenId,kind:'frozen-input',slots:['opportunity'],schema:{namespace:'test/input',revision:'1',hash:'a'.repeat(64)}},
      {id:'published-research',kind:'published-output',slots:['research'],schema:{namespace:'test/research',revision:'1',hash:'b'.repeat(64)},producerNodeId:'start'},
    ],relations:[
      {assetId:frozenId,nodeId:'start',kind:'consumes',occurrenceIds:['first']},
      {assetId:'published-research',nodeId:'start',kind:'produces',occurrenceIds:['first']},
      {assetId:'published-research',nodeId:'merge',kind:'consumes',occurrenceIds:['second']},
    ],gaps:[]};
    const view={run:{spaceId:'s',runId:'r',workflowVersionId:'v'},contract,routes:[],occurrences:[]} as unknown as ProcessView;
    const html=await renderWorkflowDiagram({entry,view,actualAssets,detailBase:'/detail'});
    expect(html).toContain(`data-node-id="${frozenId}"`);
    expect(html).toContain(`var ids = new Set(["start","check","alpha","beta","merge","${frozenId}"`);
    expect(html).toContain('data-node-id="published-research"');
    expect(html).toContain('data-actual-asset');
    expect(html).toContain('data-edge-id="actual_produces_1"');
    expect(html).toContain('data-edge-id="actual_consumes_2"');
    expect(html).toContain('data-handoff-node-id="merge"');
    expect(html).toContain('已发布资产：research；点击阅读真实资产');
    expect(html).toContain('未发布响应在执行记录中');
    expect(html).not.toContain('data-node-id="manuscript"');
  });
  it('shows declared expected asset handoffs only in definition mode and selects them through the node bridge', async () => {
    const schema = {namespace:'test/draft',revision:'1',hash:'a'.repeat(64)};
    const withAssets = {...entry,
      storageContract:{nodes:{start:{outputs:{draft:{schema}}},alpha:{inputs:{draft:{schema}}}}},
      process:{...contract,nodes:contract.nodes.map(node=>node.id==='start'
        ? {...node,storageNodeId:'start',outputs:{draft:{slot:'draft'}}}
        : node.id==='alpha' ? {...node,storageNodeId:'alpha',inputs:{draft:{slot:'draft'}}} : node),
      results:[{role:'primary',nodeId:'start',outputPort:'draft'}],
      dataBindings:[{id:'draft-to-alpha',from:{node:'start',port:'draft'},to:{node:'alpha',port:'draft'},selection:'current-business-round'}]},
    } as unknown as WorkflowEntrypoint;
    const assetId = projectExpectedAssets(withAssets).assets[0].id;
    const definition = await renderWorkflowDiagram({entry:withAssets,detailBase:'/detail',selectedNodeId:assetId});
    expect(definition).toContain(`data-node-id="${assetId}"`);
    expect(definition).toContain('data-expected-asset');
    expect(definition).toContain(`data-edge-id="expected_producer_${assetId}"`);
    expect(definition).toContain(`data-edge-id="expected_dependency_${Buffer.from('draft-to-alpha').toString('hex')}"`);
    expect(definition).toContain('预期输出 · 方法合同');
    expect(definition).toContain('预期输出：draft；点击阅读资产合同');
    expect(definition).toContain('data-handoff-node-id="start"');
    expect(definition).toContain('workflow-node-select');
    const view = {run:{spaceId:'s',runId:'r',workflowVersionId:'v'},contract:withAssets.process,routes:[],occurrences:[]} as unknown as ProcessView;
    const runtime = await renderWorkflowDiagram({entry:withAssets,detailBase:'/detail',view});
    expect(runtime).not.toContain(`data-node-id="${assetId}"`);
    expect(runtime).not.toContain('expected_dependency_');
    const incomplete = {...withAssets, process: {...withAssets.process!, dataBindings: []}} as WorkflowEntrypoint;
    const incompleteHtml = await renderWorkflowDiagram({entry:incomplete,detailBase:'/detail'});
    expect(incompleteHtml).toContain('alpha.draft 未声明数据来源');
    expect(incompleteHtml).not.toContain('expected_dependency_');
    const colliding = structuredClone(withAssets);
    colliding.process!.nodes.push({id: assetId, kind: 'group'});
    const shiftedAssetId = projectExpectedAssets(colliding).assets[0].id;
    const collisionHtml = await renderWorkflowDiagram({entry:colliding,detailBase:'/detail',selectedNodeId:shiftedAssetId});
    expect(shiftedAssetId).not.toBe(assetId);
    expect(collisionHtml).toContain(`data-node-id="${assetId}"`);
    expect(collisionHtml).toContain(`data-node-id="${shiftedAssetId}"`);
    expect(collisionHtml).toContain(`var selected = "${shiftedAssetId}"`);
  });
  it('separates run inputs, method nodes and producer-aligned outputs in readable lanes', async () => {
    const schema = {namespace:'test/input',revision:'1',hash:'a'.repeat(64)};
    const producers = new Set(['start','check','alpha','merge']);
    const layoutEntry = {...entry,
      storageContract:{nodes:Object.fromEntries([...producers].map(id=>[id,{outputs:{out:{schema}}}]))},
      process:{...contract,
        nodes:contract.nodes.map(node=>producers.has(node.id)
          ? {...node,storageNodeId:node.id,outputs:{out:{slot:'out'}}} : node),
        runInputs:{one:schema,two:schema,three:schema,four:schema}},
    } as unknown as WorkflowEntrypoint;
    const assets = projectExpectedAssets(layoutEntry).assets;
    const html = await renderWorkflowDiagram({entry:layoutEntry,detailBase:'/detail'});
    const rect = (id:string):{x:number;y:number;width:number;height:number} => {
      const match = html.match(new RegExp(`data-node-id="${id}"[\\s\\S]*?<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"`));
      expect(match).toBeTruthy();
      return {x:Number(match![1]),y:Number(match![2]),width:Number(match![3]),height:Number(match![4])};
    };
    const inputRects = assets.filter(asset=>asset.source.kind==='run-input').map(asset=>rect(asset.id));
    const outputAssets=assets.filter(asset=>asset.source.kind==='node-output');
    const outputRects=outputAssets.map(asset=>rect(asset.id));
    const inputXs = [...new Set(inputRects.map(item=>item.x))];
    expect(inputXs).toHaveLength(2);
    for (const x of inputXs) {
      const inColumn = inputRects.filter(item=>item.x===x).sort((a,b)=>a.y-b.y);
      expect(inColumn).toHaveLength(2);
      expect(inColumn[0]!.y+inColumn[0]!.height).toBeLessThan(inColumn[1]!.y);
    }
    const methodRects=contract.nodes.map(node=>rect(node.id));
    expect(Math.max(...inputRects.map(item=>item.y+item.height))).toBeLessThan(Math.min(...methodRects.map(item=>item.y)));
    expect(Math.max(...methodRects.map(item=>item.y+item.height))).toBeLessThan(Math.min(...outputRects.map(item=>item.y)));
    for(const asset of outputAssets){
      const output=rect(asset.id),producer=rect(asset.producer!.nodeId);
      expect(Math.abs(output.x+output.width/2-producer.x-producer.width/2)).toBeLessThan(1);
    }
  });
});
