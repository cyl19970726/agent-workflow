import {describe,it,expect} from 'vitest';
import {processReadingBody,type ProcessSelection} from './process-render.js';
import {resolveWorkbenchRun} from './workbench-model.js';
import type {SpaceOverview} from './types.js';
import type {ProcessOccurrence,ProcessView} from './process-projection.js';
import type {WorkflowPresentation} from './presentation.js';

function fixture(){
  const schema={namespace:'procurement/quote',revision:'1',hash:'a'.repeat(64)};
  const source=(nodeId:string)=>({kind:'node' as const,runId:'run',stepRunId:nodeId,attemptId:nodeId,nodeId,producer:'program' as const,sessionId:nodeId,contextId:nodeId});
  const asset=(id:string,title:string,nodeId='quote')=>({id,spaceId:'space',assetId:id,version:1,schema,payload:{title,text:'Exact business text'},payloadHash:'b'.repeat(64),source:source(nodeId),dependencies:[],attachments:[],initialState:'candidate',state:'candidate',createdAt:'2026-10-05'});
  const binding={runId:'run',spaceId:'space',workflowVersionId:'method',entrypoint:'quote',caseId:'case',inputManifestId:'inputs',effectiveConfig:{},configHash:'c'};
  const data:SpaceOverview={space:{id:'space',purpose:'设备采购',owner:'owner',status:'active',createdAt:''},workflows:[],cases:[{id:'case',spaceId:'space',title:'采购报价',objective:'选择合适设备',constraints:[]}],runs:[binding],assets:[asset('first','初次报价'),asset('second','修订报价'),asset('testA','规格复核','checkA'),asset('testB','价格复核','checkB')],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]};
  const occurrence=(id:string,nodeId:string,round:number,output:string,branch?:string):ProcessOccurrence=>({id,nodeId,round,branch,provenance:'derived',stepRunIds:[id],contextIds:[],attemptIds:[],attemptRecords:[],technicalSteps:[],sessionIds:[],lifecycleEvidence:[],inputBindings:[],outputBindings:[],state:'succeeded',inputs:{},outputs:{result:[output]}});
  const view:ProcessView={run:binding,contractSource:'retrospective',resolverVersion:'procurement-1',coverage:'partial',unmappedStepIds:['unknown-step'],occurrences:[occurrence('q1','quote',1,'first'),occurrence('q2','quote',2,'second'),occurrence('a','checkA',2,'testA','a'),occurrence('b','checkB',2,'testB','b')],routes:[],relations:[{id:'revision',typeId:'revision-of',from:{assetVersionId:'second'},to:{assetVersionId:'first'},provenance:'retrospective',evidence:{kind:'bound-slot'}}],contract:{revision:'1',hash:'d'.repeat(64),nodes:[{id:'quote',kind:'program'},{id:'checkA',kind:'program'},{id:'checkB',kind:'program'}],edges:[{id:'a',from:'quote',to:'checkA',kind:'fork',route:'checks'},{id:'b',from:'quote',to:'checkB',kind:'fork',route:'checks'}],results:[{role:'quote',nodeId:'quote',outputPort:'result'},{role:'check',nodeId:'checkA',outputPort:'result',many:true}]}};
  const run=resolveWorkbenchRun(data,binding,1,{state:'needs_review',primaryAssetVersionId:'second',progress:'等待用户判断'});
  const item={case:data.cases[0]!,runs:[run],acceptedAssets:[]};
  const presentation:WorkflowPresentation={id:'procurement',revision:'1',entrypoint:'quote',label:'报价',spaceId:'space',hash:'e'.repeat(64),createdAt:'',createdBy:'owner',assetViews:[],results:{primary:'quote',supporting:[],assessments:[]},stages:[{id:'quote',label:'形成报价'},{id:'checkA',label:'规格检查'},{id:'checkB',label:'价格检查'}]};
  return{model:{data,cases:[item]},item,run,view,presentation,readings:{},selection:{mode:'execution',round:2,assetVersionId:'second'} as ProcessSelection};
}
describe('shared process-linked reading',()=>{
  it('links selected round, exact revision and parallel nodes for a non-CONTENT business',()=>{
    const html=processReadingBody(fixture());
    expect(html).toContain('历史兼容流程');expect(html).toContain('规格检查 ∥ 价格检查');expect(html).toContain('修订自 · 第 1 轮 形成报价');
    expect(html).toContain('round=2');expect(html).toContain('asset=first');expect(html).toContain('unknown-step');expect(html).not.toContain('CONTENT');
    expect(html).toContain('backAsset=second');expect(html).toContain('backRound=2');
  });
  it('shows declared method possibilities and multiple result roles without pretending branches executed',()=>{
    const input=fixture();input.selection.mode='method';
    const html=processReadingBody(input);expect(html).toContain('方法可能怎样走');expect(html).toContain('没有观测的分支不代表已执行');expect(html).toContain('多份结果');
  });
  it('keeps failed technical attempts attached to their business round',()=>{
    const input=fixture();input.view.occurrences[1]!.technicalSteps=[{id:'failed',key:'quote',kind:'publish',state:'failed',error:'Connection reset'}];
    const html=processReadingBody(input);expect(html).toContain('1 个失败技术步骤');expect(html).toContain('不增加业务轮次');
    expect(html).toContain('节点状态：');expect(html).toContain('/spaces/space/workflows/method/quote');
  });
  it('presents selected intent separately from terminal explanation before long asset text',()=>{
    const input=fixture();input.view.routes=[
      {edgeId:'rewrite',round:2,eventSeq:9,selectionOnly:true,provenance:'observed',reason:'try rewrite'},
      {edgeId:'budget',round:2,eventSeq:9,provenance:'derived',reason:'budget exhausted'},
    ];
    const html=processReadingBody(input);
    expect(html).toContain('判断选择（不代表已执行）');
    expect(html).toContain('记录或推导的路径');
    expect(html.indexOf('budget exhausted')).toBeLessThan(html.indexOf('Exact business text'));
  });
});
