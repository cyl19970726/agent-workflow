import { describe, expect, it } from 'vitest';
import { renderWorkflowDiagram } from './archify-render.js';
import type { WorkflowEntrypoint } from './types.js';
import type { ProcessView } from './process-projection.js';

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
});
