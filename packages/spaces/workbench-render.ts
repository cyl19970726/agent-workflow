import type { AssetVersion, BlobManifest, SpaceOverview, Review } from './types.js';
import type { AssetReader } from './console.js';
import type { PresentationBinding, WorkflowPresentation, PresentationField, PresentationSection, PresentationComparisonSection } from './presentation.js';
import type { SpaceWorkbench, WorkbenchCase, WorkbenchRun, ResolvedAssetSource, AssetComparison } from './workbench-model.js';

export const escapeHtml=(value:unknown):string=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const e=escapeHtml;
export function stateLabel(value:string):string {return ({candidate:'候选',imported:'已导入',archived:'已归档',cancelled:'已取消',invalid:'校验未通过',accepted:'已接受',rejected:'已拒绝',active:'进行中',recorded:'已记录',running:'执行中',completed:'执行完成',succeeded:'执行完成',failed:'执行失败',pending:'等待执行',queued:'已排队',needs_review:'待评价',awaiting_review:'待评价',stopped:'已停止',incomplete:'记录不完整',open:'记录中',complete:'记录完整','not-converged':'尚未收敛','not_converged':'尚未收敛'})[value]??value;}
function contextualHref(asset:AssetVersion):string {return assetHref(asset.spaceId,asset.id)+(asset.source.kind==='node'?`?run=${encodeURIComponent(asset.source.runId)}`:'');}
/** Exact-parent fragment locator, never a cross-version item identity. */
export function fragmentAnchor(pointer:string):string {
  // Encode every non-alphanumeric character to avoid collisions with separators.
  return 'fragment'+pointer.split('/').slice(1).map(part=>'-'+Array.from(part).map(char=>/[A-Za-z0-9]/.test(char)?char:'_'+char.codePointAt(0)!.toString(16)+'_').join('')).join('');
}
interface ReadingContext {runId:string;caseId:string;backAssetVersionId?:string;backRound?:number}
function sourceHref(spaceId:string,source:ResolvedAssetSource,context?:ReadingContext):string {
  const query=new URLSearchParams();
  if(context?.runId) query.set('run',context.runId);
  if(context?.caseId) query.set('case',context.caseId);
  if(source.pointer) query.set('pointer',source.pointer);
  if(context?.backAssetVersionId)query.set('backAsset',context.backAssetVersionId);
  if(context?.backRound)query.set('backRound',String(context.backRound));
  return assetHref(spaceId,source.assetVersionId!)+(query.size?'?'+query.toString():'')+(source.pointer?'#'+fragmentAnchor(source.pointer):'');
}
const root=(spaceId:string)=>`/spaces/${encodeURIComponent(spaceId)}`;
export const assetHref=(spaceId:string,assetId:string)=>`${root(spaceId)}/assets/${encodeURIComponent(assetId)}`;
export const caseHref=(spaceId:string,caseId:string)=>`${root(spaceId)}/cases/${encodeURIComponent(caseId)}`;
const json=(value:unknown)=>`<pre>${e(JSON.stringify(value,null,2))}</pre>`;
const paragraphs=(value:unknown)=> (Array.isArray(value)?value:[value]).flatMap(item=>String(item??'').split(/\n\s*\n/)).filter(Boolean).map(item=>`<p>${e(item)}</p>`).join('');
export function structured(value:unknown):string {
  if(value===null||value===undefined) return '<span class="muted">未记录</span>';
  if(Array.isArray(value)) return value.length?`<ol>${value.map(item=>`<li>${structured(item)}</li>`).join('')}</ol>`:'<p class="muted">暂无条目</p>';
  if(typeof value==='object') return `<dl>${Object.entries(value).map(([key,item])=>`<dt>${e(key)}</dt><dd>${structured(item)}</dd>`).join('')}</dl>`;
  return paragraphs(value);
}
function pointer(value:unknown,path:string):unknown {
  for(const part of path.slice(1).split('/').map(part=>part.replace(/~1/g,'/').replace(/~0/g,'~'))) {
    if(!value||typeof value!=='object'||!Object.hasOwn(value,part)) return undefined;
    value=(value as Record<string,unknown>)[part];
  }
  return value;
}
export interface ReadingOptions {readers?:Record<string,AssetReader>;presentation?:WorkflowPresentation;presentationHistory?:PresentationBinding[];sources?:ResolvedAssetSource[];compactSections?:number;runContext?:ReadingContext;identity?:{runLabel?:string;roundLabel?:string}}
function field(field:PresentationField,payload:unknown,sources:ResolvedAssetSource[],spaceId:string,attachments:BlobManifest[]=[],context?:ReadingContext):string {
  const value=pointer(payload,field.path);
  let body:string;
  if(value===undefined||value===null||(Array.isArray(value)&&!value.length)) body=`<p class="muted">${e(field.emptyText??'暂无记录')}</p>`;
  else if(field.component==='paragraphs') body=paragraphs(value);
  else if(field.component==='status') body=`<span class="badge">${e(typeof value==='string'?stateLabel(value):value)}</span>`;
  else if(field.component==='source-links') body=`<ul>${(Array.isArray(value)?value:[]).map(ref=>{
    const source=sources.find(item=>item.ref===String(ref));
    return `<li>${source?.resolved&&source.assetVersionId?`<a href="${e(sourceHref(spaceId,source,context))}">${e(source.label)}</a>`:`${e(source?.label??ref)} <span class="muted">来源未解析</span>`}${source?.excerpt?paragraphs(source.excerpt):''}</li>`;
  }).join('')}</ul>`;
  else if(field.component==='attachments')body=`<ul>${(Array.isArray(value)?value:[]).map((ref,index)=>{const id=typeof ref==='string'?ref:ref?.id;const blob=attachments.find(blob=>blob.id===id);return `<li>${blob?`<a href="${root(spaceId)}/blobs/${encodeURIComponent(blob.id)}">附件 ${index+1} · ${e(blob.mediaType)}</a> (${e(blob.size)} 字节)`:'未找到本资产绑定的附件'}</li>`;}).join('')}</ul>`;
  else if(field.component==='table'&&Array.isArray(value)) {
    const keys=[...new Set(value.flatMap(item=>item&&typeof item==='object'?Object.keys(item):[]))];
    body=keys.length?`<table><thead><tr>${keys.map(key=>`<th>${e(key)}</th>`).join('')}</tr></thead><tbody>${value.map(item=>`<tr>${keys.map(key=>`<td>${structured(item?.[key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`:structured(value);
  } else body=structured(value);
  return `<section><h3>${e(field.label)}</h3>${body}</section>`;
}
function section(section:PresentationSection,payload:unknown,sources:ResolvedAssetSource[],spaceId:string,attachments:BlobManifest[]=[],context?:ReadingContext):string {
  if(section.component==='fields') return `<section><h2>${e(section.label)}</h2>${section.fields.map(item=>field(item,payload,sources,spaceId,attachments,context)).join('')}</section>`;
  if(section.component==='items') {
    const values=pointer(payload,section.path);
    return `<section><h2>${e(section.label)}</h2>${Array.isArray(values)&&values.length?values.map((item,index)=>`<article class="reading-item">${section.headingPath?`<h3>${e(pointer(item,section.headingPath)??`条目 ${index+1}`)}</h3>`:''}${section.fields.map(value=>field(value,item,sources,spaceId,attachments,context)).join('')}</article>`).join(''):`<p class="muted">${e(section.emptyText??'暂无记录')}</p>`}</section>`;
  }
  return field(section,payload,sources,spaceId,attachments,context);
}
export function assetReading(asset:AssetVersion,options:ReadingOptions={}):{title:string;body:string;label:string} {
  const presentation=options.presentation;
  const view=presentation?.assetViews.find(view=>view.schema.namespace===asset.schema.namespace&&view.schema.revision===asset.schema.revision&&view.schema.hash===asset.schema.hash);
  // An installed contract never falls back to a reader keyed by only namespace and revision.
  const reader=view?.reader?options.readers?.[view.reader]:!presentation?options.readers?.[`${asset.schema.namespace}@${asset.schema.revision}#${asset.schema.hash}`]??options.readers?.[`${asset.schema.namespace}@${asset.schema.revision}`]:undefined;
  let fallbackReason='此类型尚未配置专用视图，以下按字段阅读。';
  try {
    if(view?.reader&&!reader) throw new Error('Reader unavailable');
    if(reader) {
      const reading=reader(asset);
      const markup=reading.sections.map(item=>`<section${item.pointer?` id="${e(fragmentAnchor(item.pointer))}"`:""}><h2>${e(item.title)}</h2>${paragraphs(item.text)}${item.sourceRefs?.length?`<aside class="source-evidence"><h3>本结论的依据</h3>${item.sourceRefs.map(ref=>{const source=options.sources?.find(value=>value.ref===ref);return `<p>${source?.resolved&&source.assetVersionId?`<a href="${e(sourceHref(asset.spaceId,source,options.runContext??(asset.source.kind==='node'?{runId:asset.source.runId,caseId:''}:undefined)))}">${e(source.label)}</a>`:`${e(source?.label??ref)} · 来源未解析`}</p>${source?.excerpt?`<details><summary>查看原始片段</summary>${paragraphs(source.excerpt)}</details>`:''}`;}).join('')}</aside>`:''}</section>`);
      return {title:reading.title,label:view?.label??reading.title,body:`<div class="prose">${options.compactSections&&markup.length>options.compactSections?markup.slice(0,options.compactSections).join('')+`<details><summary>阅读完整意见</summary>${markup.slice(options.compactSections).join('')}</details>`:markup.join('')}</div>`};
    }
    if(view) {
      return {title:String(view.titlePath?pointer(asset.payload,view.titlePath)??view.label:view.label),label:view.label,body:`<div class="prose">${view.sections.map(item=>section(item,asset.payload,options.sources??[],asset.spaceId,asset.attachments,options.runContext)).join('')}</div>`};
    }
  } catch { fallbackReason='专用阅读器暂不可用，以下按保存的字段阅读。'; }
  return {title:'资产内容',label:'结构化资产',body:`<p class="notice">${fallbackReason}</p><div class="prose">${structured(asset.payload)}</div>`};
}
export function assetCard(asset:AssetVersion&{state?:string},options:ReadingOptions={}):string {
  const view=assetReading(asset,options);
  return `<article class="card"><h3><a href="${contextualHref(asset)}">${e(view.title)}</a></h3>${asset.state&&asset.state!=='candidate'?`<span class="badge">${e(stateLabel(asset.state))}</span>`:''}<p class="muted">${e(view.label)} · 准确保存的版本</p></article>`;
}
export function reviewCard(review:Review):string {
  return `<article class="card"><h3>${review.judge.kind==='human'?'用户评价':'流程评价'} · ${e(review.judge.id)}</h3><p class="muted">标准 ${e(review.standard.id)}@${e(review.standard.revision)}</p>${Object.entries({好:review.answers.good,不好:review.answers.bad,相比基线的改善:review.answers.improvement,仍不满意:review.answers.unresolved}).map(([label,text])=>`<h3>${label}</h3>${paragraphs(text)}`).join('')}<p class="muted">${review.baselineReviewId?`基线评价：${e(review.baselineReviewId)}`:'未记录基线评价'}</p><details><summary>判者、对象与证据</summary>${json(review)}</details></article>`;
}
function accepted(item:WorkbenchCase):string {
  return item.acceptedAssets.length?`<p>当前已接受结果：${item.acceptedAssets.map((asset,index)=>`<a href="${contextualHref(asset)}">阅读已接受结果${item.acceptedAssets.length>1?` ${index+1}`:''}</a>`).join('、')}</p>`:'<p class="muted">尚未接受任何结果</p>';
}
export function caseCard(item:WorkbenchCase,spaceId:string):string {
  const run=item.runs.at(-1);
  return `<article class="card"><h3><a href="${caseHref(spaceId,item.case.id)}">${e(item.case.title)}</a></h3><p>${e(item.case.objective)}</p><p><span class="badge">${e(run?.progress??(run?stateLabel(run.state):'尚未运行'))}</span></p>${accepted(item)}${run?.primary?`<p>最新候选结果：<a href="${assetHref(spaceId,run.primary.id)}">阅读本次结果</a></p>`:'<p class="muted">尚无最终候选结果</p>'}<p class="muted">${run?.reviews.some(review=>review.judge.kind==='human')?'已有用户评价':'用户评价：尚未填写'}</p></article>`;
}
export function overviewBody(model:SpaceWorkbench,create='',readings:Record<string,ReadingOptions>={}):string {
  const pending=model.cases.filter(item=>item.runs.at(-1)?.requiresAttention&&!item.acceptedAssets.some(asset=>asset.id===item.runs.at(-1)?.primary?.id));
  return `<p class="eyebrow">业务工作台</p><h1>${e(model.data.space.purpose)}</h1><p class="lead">围绕案例阅读结果、判断质量，并追溯每次执行。</p><h2>需要处理的事项</h2>${pending.length?`<p>${pending.length} 个案例需要处理；请阅读当前阻碍与对应评价。</p>`:'<p class="muted">暂无待处理案例</p>'}<h2>正在进行的案例</h2>${create}<div class="grid">${model.cases.map(item=>caseCard(item,model.data.space.id)).join('')||'<p class="empty">尚未创建案例</p>'}</div><h2>最近结果</h2><div class="grid">${model.cases.flatMap(item=>item.runs.slice(-1).flatMap(run=>run.primary?[assetCard(run.primary,readings[run.primary.id])]:[])).join('')||'<p class="empty">尚无最终候选结果</p>'}</div>`;
}
export async function caseBody(model:SpaceWorkbench,item:WorkbenchCase,run:WorkbenchRun|undefined,tab:string,reading:(asset:AssetVersion)=>Promise<ReadingOptions>,actions='',extraEvidence=''):Promise<string> {
  const base=caseHref(model.data.space.id,item.case.id);
  const href=(value:WorkbenchRun,key=tab)=>`${base}?run=${encodeURIComponent(value.binding.runId)}&tab=${key}`;
  const header=`<p class="crumbs"><a href="${root(model.data.space.id)}">${e(model.data.space.purpose)}</a> / 案例</p><h1>${e(item.case.title)}</h1><p class="lead${item.case.objective.length>160?' long-goal':''}">${e(item.case.objective.length>160?item.case.objective.slice(0,160)+'…':item.case.objective)}</p>${item.case.objective.length>160?`<details><summary>完整业务目标</summary>${paragraphs(item.case.objective)}</details>`:''}${accepted(item)}<div class="tabs" aria-label="运行切换">${item.runs.map(value=>`<a href="${href(value)}"${value===run?' aria-current="page"':''}>第 ${value.number} 次运行</a>`).join('')}</div>`;
  if(!run) return header+'<p class="empty">此案例尚未运行</p>'+actions;
  const primaryReading=run.primary?assetReading(run.primary,await reading(run.primary)):undefined;
  const sessions=[...new Map([...run.sessions,...model.data.sessions.filter(session=>model.data.assets.some(asset=>asset.source.kind==='node'&&asset.source.runId===run.binding.runId&&asset.source.sessionId===session.id)).map(session=>({sessionId:session.id,label:session.role}))].map(session=>[session.sessionId,session])).values()];
  const outputs=run.primary?new Set(run.process.filter(stage=>stage.asset.schema.namespace===run.primary!.schema.namespace&&stage.asset.schema.revision===run.primary!.schema.revision&&stage.asset.schema.hash===run.primary!.schema.hash).map(stage=>stage.asset.id)).size:0;
  const intro=`<p><span class="badge">${e(run.progress??stateLabel(run.state))}</span> · 方法：${e(run.methodLabel)}</p>${run.reason?`<p class="notice">${e(stateLabel(run.reason))}</p>`:''}${outputs?`<p>本次产生 ${outputs} 份${e(primaryReading?.label??'主产物')}；这是第 ${run.number} 次运行。</p>`:''}${run.inputSummary.length?`<details><summary>本次输入条件</summary>${run.inputSummary.map(value=>paragraphs(value)).join('')}</details>`:''}${['running','queued','pending'].includes(run.state)?`<p><a href="${href(run)}">刷新本次进展</a> · <a href="${href(run,'evidence')}">查看执行记录</a></p>`:''}<div class="tabs">${[['result','本次结果'],['process','过程与修订'],['compare','与基线比较'],['evidence','执行证据']].map(([key,label])=>`<a href="${href(run,key)}"${key===tab?' aria-current="page"':''}>${label}</a>`).join('')}</div>`;
  let body='';
  if(tab==='result') {
    const primary=primaryReading;
    const assessments=await Promise.all(run.assessments.map(async asset=>{const view=assetReading(asset,{...await reading(asset),compactSections:2});return `<article class="card"><h3><a href="${contextualHref(asset)}">${e(view.title)}</a></h3>${view.body}</article>`;}));
    const supporting=(await Promise.all(run.supporting.map(async asset=>assetCard(asset,await reading(asset))))).join('');
    body=`${supporting?`<details><summary>依据的支持材料</summary>${supporting}</details>`:''}<div class="reading"><article>${primary?`<h2>${e(primary.title)}</h2>${primary.body}<p><a href="${assetHref(model.data.space.id,run.primary!.id)}">查看结果来源与用途</a></p>`:'<p class="empty">本次尚无最终候选结果；过程产物仍可阅读。</p>'}</article><aside><h2>对这份结果的判断</h2>${assessments.join('')||'<p class="muted">未记录对应流程评价</p>'}${run.reviews.map(reviewCard).join('')}${!run.reviews.some(review=>review.judge.kind==='human')?'<p class="muted">用户评价：尚未填写</p>':''}${actions}</aside></div>`;
  } else if(tab==='process') body=(await Promise.all(run.process.map(async stage=>`<section><h2>${e(stage.label)}</h2>${assetCard(stage.asset,await reading(stage.asset))}${(await Promise.all(stage.assessments.map(async asset=>assetCard(asset,await reading(asset))))).join('')}</section>`))).join('')||'<p class="empty">暂无过程记录</p>';
  else if(tab==='compare') {
    const assets=[...run.process.map(stage=>stage.asset),...item.runs.flatMap(value=>value.primary?[value.primary]:[])].filter(asset=>!run.primary||asset.schema.namespace===run.primary.schema.namespace&&asset.schema.revision===run.primary.schema.revision&&asset.schema.hash===run.primary.schema.hash);
    const names=Object.fromEntries(await Promise.all(assets.map(async asset=>{const owner=item.runs.find(value=>value.binding.runId===(asset.source.kind==='node'?asset.source.runId:''));const stage=owner?.process.find(stage=>stage.asset.id===asset.id);const view=assetReading(asset,await reading(asset));return [asset.id,`第 ${owner?.number??'?'} 次运行 · ${stage?.label??'候选结果'} · ${view.title}`];})));
    body=`<p>同一运行内比较产物：观察修改是否落实。两次运行比较结果：同时检查输入、方法和配置条件。</p>${comparisonForm(model.data.space.id,assets,names)}<p class="muted">没有基线或评价时，不推断质量改善。</p>`;
  } else body=`<h2>本次输入与实际配置</h2><details><summary>冻结输入与配置证据</summary>${json(run.binding)}</details><h2>生产记录</h2>${sessions.map(session=>`<p><a href="${root(model.data.space.id)}/sessions/${encodeURIComponent(session.sessionId)}">${e(session.label)}</a></p>`).join('')||'<p class="muted">暂无会话记录</p>'}${extraEvidence}`;
  return header+intro+body;
}
export function comparisonForm(spaceId:string,assets:SpaceOverview['assets'],names:Record<string,string>={}):string {
  const unique=[...new Map(assets.map(asset=>[asset.id,asset])).values()];
  if(unique.length<2) return '<p class="muted">尚无两份可比较的结果</p>';
  const choices=(selected:number)=>unique.map((asset,index)=>`<option value="${e(asset.id)}"${index===selected?' selected':''}>${e(names[asset.id]??`资产 ${index+1}`)}</option>`).join('');
  return `<form method="get" action="${root(spaceId)}/compare"><label>比较模式<select name="mode"><option value="auto">按所选运行识别</option><option value="within-run">同一运行内比较产物</option><option value="between-runs">两次运行比较结果</option></select></label><label>基线<select name="left">${choices(0)}</select></label><label>候选<select name="right">${choices(1)}</select></label><button>比较准确版本</button></form>`;
}
function lines(value:unknown):unknown[] {
  if(typeof value==='string') return value.split(/\n\s*\n/);
  if(Array.isArray(value)) return value;
  return [value];
}
function differences(left:unknown,right:unknown,render:(value:unknown)=>string=structured):string {
  const before=lines(left),after=lines(right);
  if(JSON.stringify(before)===JSON.stringify(after)) return '<p class="muted">此字段没有变化</p>';
  // Saved indices are alignment only. No move/identity claim without stable IDs.
  return Array.from({length:Math.max(before.length,after.length)},(_,index)=>JSON.stringify(before[index])===JSON.stringify(after[index])?'':`<article class="card"><h3>顺序位置 ${index+1}</h3><div class="two"><section><h3>基线原文</h3>${index<before.length?render(before[index]):'<p class="muted">此位置无条目</p>'}</section><section><h3>候选原文</h3>${index<after.length?render(after[index]):'<p class="muted">此位置无条目</p>'}</section></div></article>`).join('');
}
function compareSection(section:PresentationComparisonSection,left:unknown,right:unknown):string {
  const before=pointer(left,section.path),after=pointer(right,section.path);
  const item=(value:unknown)=>`<dl>${(section.fields??[]).map(path=>`<dt>${e(section.labels?.[path]??path)}</dt><dd>${structured(pointer(value,path))}</dd>`).join('')}</dl>`;
  if(section.kind==='items') return `<section><h3>${e(section.label)}</h3>${differences(before,after,item)}</section>`;
  const text=(value:unknown)=>section.fields?.length?(Array.isArray(value)?value:[]).map(item=>section.fields!.map(path=>pointer(item,path)).filter(value=>value!==undefined&&value!==null).map(String).join('\n')).join('\n\n'):value;
  const baseline=text(before),candidate=text(after);
  return `<section><h3>${e(section.label)}</h3>${JSON.stringify(baseline)===JSON.stringify(candidate)?'<p class="muted">此字段没有变化</p>':''}<div class="two"><section><h4>基线连续原文</h4>${paragraphs(baseline)}</section><section><h4>候选连续原文</h4>${paragraphs(candidate)}</section></div></section>`;
}
export function comparisonBody(comparison:AssetComparison|undefined,left:AssetVersion,right:AssetVersion,leftOptions:ReadingOptions,rightOptions:ReadingOptions):string {
  const identity=(asset:AssetVersion,options:ReadingOptions,label:string)=>{
    const view=assetReading(asset,options),runId=asset.source.kind==='node'?asset.source.runId:'未绑定运行';
    return `<article class="card comparison-identity"><h2>${e(label)} · <a href="${e(contextualHref(asset))}">${e(view.title)}</a></h2><p>${e(options.identity?.runLabel??'运行')}：${e(runId)}${options.identity?.roundLabel?' · '+e(options.identity.roundLabel):' · 业务轮次未提供'}</p><p>准确资产版本：${e(asset.id)}</p><p>逻辑资产：${e(asset.assetId)} · 保存版本 ${e(asset.version)}</p></article>`;
  };
  const one=(asset:AssetVersion,options:ReadingOptions)=>{const view=assetReading(asset,options);return `<article class="card"><h2><a href="${e(contextualHref(asset))}">${e(view.title)}</a></h2>${view.body}</article>`;};
  const matching=(asset:AssetVersion,options:ReadingOptions)=>options.presentation?.assetViews.find(view=>view.schema.namespace===asset.schema.namespace&&view.schema.revision===asset.schema.revision&&view.schema.hash===asset.schema.hash);
  const leftView=matching(left,leftOptions),rightView=matching(right,rightOptions);
  const layout=leftView?.compare&&rightView?.compare?leftView.compare:undefined;
  const paths=layout?.fields.filter(path=>rightView!.compare!.fields.includes(path))??[];
  const sections=layout?.sections?.filter(section=>rightView!.compare!.sections?.some(other=>other.path===section.path&&other.kind===section.kind&&JSON.stringify(other.fields)===JSON.stringify(section.fields)))??[];
  const covered=new Set(sections.map(section=>section.path));
  const diff=sections.map(section=>compareSection(section,left.payload,right.payload)).join('')+paths.filter(path=>!covered.has(path)).map(path=>`<section><h3>${e(layout?.labels?.[path]??path)}</h3>${differences(pointer(left.payload,path),pointer(right.payload,path))}</section>`).join('');
  return `<h1>${comparison?.mode==='within-run'?'同一运行内比较产物':comparison?'两次运行比较结果':'比较准确资产版本'}</h1><div class="two">${identity(left,leftOptions,'基线')}${identity(right,rightOptions,'候选')}</div><p class="notice">正文差异是事实；质量改善需要对应判者与标准的评价。作者自述仅是作者声明，不代表独立复核已解决。</p>${comparison?`<details><summary>输入、方法与配置条件差异</summary>${structured(comparison.changedConditions)}</details>`:''}<h2>保存顺序与原文变化</h2><p class="muted">按保存顺序列出变化；顺序位置不代表稳定段落身份，无法据此判断段落移动。</p>${diff||differences(left.payload,right.payload)}<details><summary>阅读两份完整原文</summary><div class="two">${one(left,leftOptions)}${one(right,rightOptions)}</div></details>${comparison?`<h2>独立记录的基线与候选评价</h2><div class="two"><section>${comparison.reviews.baseline.map(reviewCard).join('')||'<p>未记录基线评价</p>'}</section><section>${comparison.reviews.candidate.map(reviewCard).join('')||'<p>未记录候选评价</p>'}</section></div>`:''}`;
}

export async function iterationsBody(model:SpaceWorkbench,reading:(asset:AssetVersion)=>Promise<ReadingOptions>):Promise<string> {
  const {data}=model;
  const cards=await Promise.all(data.iterations.map(async iteration=>{
    const feedback=data.reviews.filter(review=>iteration.reviewIds.includes(review.id));
    const workflow=data.workflows.find(value=>value.id===iteration.workflowVersionId);
    const predecessor=workflow?.predecessorId?data.workflows.find(value=>value.id===workflow.predecessorId):undefined;
    const runs=model.cases.flatMap(item=>item.runs.filter(run=>iteration.runIds.includes(run.binding.runId)).map(run=>({item,run})));
    const comparisons=data.comparisons.filter(comparison=>{
      const candidate=data.reviews.find(review=>review.id===comparison.candidateReviewId);
      return Boolean(candidate&&iteration.runIds.includes(candidate.runId)&&iteration.reviewIds.includes(comparison.baselineReviewId));
    });
    const adoptions=data.adoptions.filter(value=>value.target.kind==='workflow'&&value.target.id===iteration.workflowVersionId||comparisons.some(comparison=>comparison.id===value.comparisonId));
    const evidenceAssets=[...new Set(feedback.flatMap(review=>review.assetVersionIds))].flatMap(id=>data.assets.find(asset=>asset.id===id)??[]);
    const evidenceCards=await Promise.all(evidenceAssets.map(async asset=>assetCard(asset,await reading(asset))));
    return `<article class="card"><h2>${e(iteration.hypothesis)}</h2><h3>发现的问题与依据</h3>${feedback.length?feedback.map(review=>`<p>${e(review.judge.kind==='human'?'用户':'Agent')} ${e(review.judge.id)} · 标准 ${e(review.standard.id)}@${e(review.standard.revision)}</p>${paragraphs(review.answers.bad)}${paragraphs(review.answers.unresolved)}`).join(''):'<p class="muted">相关评价未在当前授权记录中找到</p>'}${evidenceCards.join('')}<h3>方法变化</h3>${workflow?`<p>${e(predecessor?.revision??'未记录前一方法')} → ${e(workflow.revision)}</p>${paragraphs(workflow.changeReason)}`:'<p class="muted">未找到对应方法版本</p>'}<h3>验证运行</h3>${runs.map(({item,run})=>`<p><a href="${caseHref(data.space.id,item.case.id)}?run=${encodeURIComponent(run.binding.runId)}">${e(item.case.title)} · 第 ${run.number} 次运行</a> · ${e(run.progress??stateLabel(run.state))}</p>`).join('')||'<p class="muted">未找到当前可读验证运行</p>'}<h3>比较结果</h3>${comparisons.map(comparison=>paragraphs(comparison.conclusion)).join('')||'<p class="muted">尚无对应基线比较；不推断改善</p>'}<h3>采用决定</h3>${adoptions.map(adoption=>`<p>${e(adoption.actorId)} · ${e(adoption.createdAt)}</p>${paragraphs(adoption.reason)}`).join('')||'<p class="muted">尚未记录采用决定</p>'}<details><summary>迭代与比较证据</summary>${json({iteration,comparisons,adoptions})}</details></article>`;
  }));
  return `<h1>方法迭代</h1><p class="lead">从评价发现问题，形成假设，以验证运行和采用决定检查变化。</p>${cards.join('')||'<p class="empty">暂无方法迭代记录。同一次运行内的多份产物不等于方法实验。</p>'}${data.comparisons.length?`<h2>独立比较记录</h2>${data.comparisons.map(comparison=>`<article class="card">${paragraphs(comparison.conclusion)}<details><summary>准确评价与条件差异</summary>${json(comparison)}</details></article>`).join('')}`:''}`;
}
