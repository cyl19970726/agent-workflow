import { describe, expect, it } from 'vitest';
import { assetReading, comparisonBody, caseBody, overviewBody, iterationsBody } from './workbench-render.js';
import type { AssetVersion, SpaceOverview, SpaceRun } from './types.js';
import type { WorkflowPresentation } from './presentation.js';
import { resolveWorkbenchRun, type SpaceWorkbench } from './workbench-model.js';
const hash='a'.repeat(64);
const asset:AssetVersion={id:'quote-v3',assetId:'quote',spaceId:'quote-space',version:1,schema:{namespace:'sales/quote',revision:'1',hash},payload:{title:'设备报价',summary:'方案一\n\n方案二',lines:[{product:'机器 <img src=x>',amount:100}],sources:['material-1','missing']},payloadHash:hash,source:{kind:'node',runId:'run1',nodeId:'pricing',contextId:'ctx1',sessionId:'session1'},dependencies:['material-v1'],attachments:[],initialState:'candidate',createdAt:'2026-10-05'};
const presentation:WorkflowPresentation={id:'sales-workbench',spaceId:'quote-space',revision:'1',hash,createdBy:'owner',createdAt:'2026-10-05',entrypoint:'quote',label:'形成报价',results:{primary:'quote',supporting:[],assessments:[]},assetViews:[{schema:asset.schema,label:'报价单',titlePath:'/title',sections:[{path:'/summary',label:'方案说明',component:'paragraphs'},{component:'items',path:'/lines',label:'报价项目',headingPath:'/product',fields:[{path:'/amount',label:'金额',component:'status'}]},{component:'source-links',path:'/sources',label:'采购依据'}],compare:{fields:['/summary','/lines']}}]};
const run:SpaceRun={spaceId:'quote-space',runId:'run1',caseId:'case1',workflowVersionId:'method1',entrypoint:'quote',inputManifestId:'manifest1',effectiveConfig:{},configHash:hash};
const data:SpaceOverview={space:{id:'quote-space',purpose:'为客户形成设备报价',owner:'owner',status:'active',createdAt:'2026-10-05'},cases:[{id:'case1',spaceId:'quote-space',title:'客户甲采购',objective:'采购十台设备',constraints:[]}],runs:[run],assets:[{...asset,state:'candidate'}],workflows:[],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]};
describe('shared business document rendering',()=>{
  it('renders a non-content quote with safe paragraphs, items and exact source parents',()=>{
    const reading=assetReading(asset,{presentation,sources:[{ref:'material-1',label:'冻结采购资料',assetVersionId:'material-v1',resolved:true,excerpt:'价格依据 <script>x</script>'}]});
    expect(reading.title).toBe('设备报价');expect(reading.body).toContain('<p>方案一</p><p>方案二</p>');expect(reading.body).toContain('报价项目');
    expect(reading.body).toContain('/spaces/quote-space/assets/material-v1');expect(reading.body).toContain('来源未解析');
    expect(reading.body).toContain('&lt;img src=x&gt;');expect(reading.body).not.toContain('<img');expect(reading.body).not.toContain('<pre>');
  });
  it('requires the full schema hash with a contract and falls back for absent or broken readers',()=>{
    const readers={'sales/quote@1':()=>({title:'UNSAFE WRONG HASH',sections:[]})};
    const wrong={...asset,schema:{...asset.schema,hash:'b'.repeat(64)}};
    const result=assetReading(wrong,{presentation,readers});expect(result.body).toContain('此类型尚未配置专用视图');expect(result.body).toContain('<dt>title</dt>');expect(result.title).not.toContain('UNSAFE');
    const dedicated={...presentation,assetViews:[{schema:asset.schema,label:'报价单',reader:'missing',sections:[]}]};
    expect(assetReading(asset,{presentation:dedicated}).body).toContain('字段阅读');
    expect(assetReading(asset,{readers:{'sales/quote@1':()=>{throw new Error('Reader failed');}}}).body).toContain('字段阅读');
    expect(assetReading(asset,{readers}).title).toBe('UNSAFE WRONG HASH');
  });
  it('keeps final candidate, internal assessments and creator acceptance separate across three process versions',async()=>{
    const versions=[1,2,3].map(number=>({...asset,id:`quote-v${number}`,payload:{...asset.payload as object,title:`报价 ${number}`},state:'candidate'}));
    const input={...data,assets:versions};
    const resolved=resolveWorkbenchRun(input,run,1,{state:'not-converged',progress:'自动修订次数用尽，尚未收敛',primaryAssetVersionId:'quote-v3',process:versions.map((value,index)=>({label:`第 ${index+1} 次报价`,assetVersionId:value.id,assessmentAssetVersionIds:[]}))});
    const model:SpaceWorkbench={data:input,cases:[{case:data.cases[0]!,runs:[resolved],acceptedAssets:[]}]};
    const overview=overviewBody(model);expect(overview).toContain('尚未接受任何结果');expect(overview).toContain('尚未收敛');expect(overview).toContain('用户评价：尚未填写');
    const body=await caseBody(model,model.cases[0]!,resolved,'result',async()=>({presentation}));expect(body).toContain('报价 3');expect(body).not.toContain('<h2>报价 1</h2>');expect(body).toContain('本次结果');
    const process=await caseBody(model,model.cases[0]!,resolved,'process',async()=>({presentation}));expect(process).toContain('第 1 次报价');expect(process).toContain('第 3 次报价');
  });
  it('places exact resolved evidence beside a reader conclusion and folds long assessment details',()=>{
    const reader=()=>({title:'采购说明',sections:[{title:'结论',text:'适合采购',sourceRefs:['material-1','missing']},{title:'必须修改',text:'数量需确认'},{title:'更多意见',text:'额外信息'}]});
    const html=assetReading(asset,{readers:{'sales/quote@1':reader},sources:[{ref:'material-1',label:'供应商原文',assetVersionId:'material-v1',resolved:true,excerpt:'仅限十台'}],compactSections:2}).body;
    expect(html).toContain('本结论的依据');expect(html).toContain('/spaces/quote-space/assets/material-v1?run=run1');expect(html).toContain('来源未解析');expect(html).toContain('仅限十台');
    expect(html.indexOf('必须修改')).toBeLessThan(html.indexOf('<summary>阅读完整意见</summary>'));
    expect(html.indexOf('更多意见')).toBeGreaterThan(html.indexOf('<summary>阅读完整意见</summary>'));
  });
  it('shows ordered original differences in declared fields without inventing improvement',()=>{
    const revised={...asset,id:'quote-v4',payload:{...asset.payload as object,summary:'新版方案'}};
    const html=comparisonBody(undefined,asset,revised,{presentation},{presentation});
    expect(html).toContain('顺序位置 1');expect(html).toContain('方案一');expect(html).toContain('新版方案');expect(html).toContain('质量改善需要对应判者');expect(html).not.toContain('CONTENT');
  });
  it('links only attachments bound to the asset and leaves arbitrary identifiers unavailable',()=>{
    const withAttachments={...asset,payload:{files:['allowed-blob','javascript:alert(1)']},attachments:[{id:'allowed-blob',spaceId:asset.spaceId,sha256:hash,size:12,mediaType:'application/pdf',key:'private'}]};
    const view={...presentation,assetViews:[{schema:asset.schema,label:'Files',sections:[{component:'attachments' as const,path:'/files',label:'附件'}]}]};
    const html=assetReading(withAttachments,{presentation:view}).body;
    expect(html).toContain('/spaces/quote-space/blobs/allowed-blob');expect(html).toContain('未找到本资产绑定的附件');expect(html).not.toContain('javascript:');expect(html).not.toContain('private');
  });
  it('connects method iterations to their actual feedback, method change and validation run',async()=>{
    const review={id:'feedback',spaceId:'quote-space',runId:'run1',assetVersionIds:[asset.id],standard:{id:'price-check',revision:'1',content:'费用依据'},judge:{kind:'human' as const,id:'buyer'},evidence:[asset.id],answers:{good:'清楚',bad:'费用依据不足',improvement:'暂无基线',unresolved:'税费'},createdAt:'2026-10-05'};
    const input={...data,reviews:[review],iterations:[{id:'iteration',reviewIds:[review.id],hypothesis:'补充税费说明',workflowVersionId:'method1',caseIds:['case1'],runIds:['run1']}],workflows:[{id:'method1',spaceId:'quote-space',revision:'2',hash,createdAt:'2026-10-05',changeReason:'加入税费核对',entrypoints:{},config:{}}]};
    const resolved=resolveWorkbenchRun(input,run,1,{state:'needs_review',primaryAssetVersionId:asset.id});
    const html=await iterationsBody({data:input,cases:[{case:input.cases[0]!,runs:[resolved],acceptedAssets:[]}]},async()=>({presentation}));
    expect(html).toContain('费用依据不足');expect(html).toContain('加入税费核对');expect(html).toContain('/spaces/quote-space/cases/case1?run=run1');expect(html).toContain('尚未记录采用决定');expect(html).toContain('尚无对应基线比较');
  });

});

describe('bounded comparison layouts and fragment evidence',()=>{
  it('renders exact identities first and separates continuous text from labelled ordered items',()=>{
    const layout:WorkflowPresentation={...presentation,assetViews:[{schema:asset.schema,label:'报价',titlePath:'/title',sections:[],reader:'fixture',compare:{fields:['/summary','/lines'],labels:{'/summary':'方案说明','/lines':'报价项目'},sections:[{path:'/lines',label:'连续产品说明',kind:'paragraphs',fields:['/product']},{path:'/lines',label:'逐项金额',kind:'items',fields:['/amount'],labels:{'/amount':'金额'}}]}}]};
    const revised={...asset,id:'quote-v4',assetId:'another-logical-quote',payload:{...asset.payload as object,lines:[{product:'新版产品',amount:110}]}};
    const options={presentation:layout,readers:{fixture:()=>({title:'报价',sections:[]})},identity:{runLabel:'第 1 次运行',roundLabel:'第 2 轮'}};
    const html=comparisonBody(undefined,asset,revised,options,{...options,identity:{runLabel:'第 1 次运行',roundLabel:'第 3 轮'}});
    expect(html.indexOf('准确资产版本：quote-v3')).toBeLessThan(html.indexOf('保存顺序与原文变化'));
    expect(html).toContain('第 2 轮');expect(html).toContain('第 3 轮');expect(html).toContain('another-logical-quote');expect(html).toContain('run1');
    expect(html).toContain('连续产品说明');expect(html).toContain('基线连续原文');expect(html).toContain('逐项金额');expect(html).toContain('<dt>金额</dt>');
    expect(html).not.toContain('"product"');expect(html).not.toContain('<h3>/lines</h3>');expect(html).toContain('作者声明');expect(html).toContain('无法据此判断段落移动');
    expect(html).toContain('&lt;img src=x&gt;');expect(html).not.toContain('<img');
  });
  it('links the exact pointer and selected run/case to the matching deterministic fragment',()=>{
    const html=assetReading(asset,{readers:{'sales/quote@1':()=>({title:'结论',sections:[{title:'依据',text:'证据结论',sourceRefs:['material-1']} ]})},runContext:{runId:'run<&',caseId:'case&'},sources:[{ref:'material-1',label:'材料<&',assetVersionId:'material-v1',pointer:'/notes/0',resolved:true,excerpt:'原文 <script>bad</script>'}]}).body;
    expect(html).toContain('pointer=%2Fnotes%2F0#fragment-notes-0');expect(html).toContain('run=run%3C%26&amp;case=case%26');
    const returned=assetReading(asset,{presentation,runContext:{runId:'run1',caseId:'case1',backAssetVersionId:'quote-v3',backRound:2},sources:[{ref:'material-1',label:'材料',assetVersionId:'material-v1',pointer:'/0',resolved:true}]}).body;
    expect(returned).toContain('backAsset=quote-v3&amp;backRound=2#fragment-0');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');expect(html).not.toContain('<script>');
    const parent=assetReading(asset,{readers:{'sales/quote@1':()=>({title:'材料包',sections:[{title:'来源',text:'原文',pointer:'/notes/0'}]})}}).body;
    expect(parent).toContain('id="fragment-notes-0"');
  });
});

describe('actionable overview',()=>{
  it('does not treat every unaccepted result as a pending task',()=>{
    const resolved=resolveWorkbenchRun(data,run,1,{state:'completed',primaryAssetVersionId:asset.id,requiresAttention:false});
    const model:SpaceWorkbench={data,cases:[{case:data.cases[0]!,runs:[resolved],acceptedAssets:[]}]};
    expect(overviewBody(model)).toContain('暂无待处理案例');
    const blocked={...resolved,state:'blocked',requiresAttention:true};
    expect(overviewBody({...model,cases:[{...model.cases[0]!,runs:[blocked]}]})).toContain('1 个案例需要处理');
    expect(overviewBody({...model,cases:[{...model.cases[0]!,runs:[blocked],acceptedAssets:[asset]}]})).toContain('暂无待处理案例');
  });
});
