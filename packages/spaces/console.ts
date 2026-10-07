import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { assetReading, assetCard, caseCard, overviewBody, caseBody, iterationsBody, comparisonBody, comparisonForm, stateLabel, fragmentAnchor, type ReadingOptions } from './workbench-render.js';
import type { PostgresWorkflowRunStore } from '@signal-room/workflow-postgres';
import type { WorkflowPresentation, ResolvedPresentation } from './presentation.js';
import type { AssetVersion, NodeContext, SessionEvent, SpaceOverview, WorkflowSpace } from './types.js';
import { resolveWorkbenchRun, compareWorkbenchAssets, getAssetSources, getSpaceWorkbench, type BusinessPresentationAdapter, type WorkbenchRun } from './workbench-model.js';
import { processReadingBody, type ProcessSelection } from './process-render.js';
import type { ProcessView } from './process-projection.js';
import { methodListBody, methodVersionBody, methodPath } from './method-render.js';
import { renderWorkflowDiagram } from './archify-render.js';
import { workflowDiagramCss, workflowDiagramScript, sendWorkflowDiagram } from './diagram-host.js';
import type { WorkflowMethodHost } from './method-workbench.js';

/** A host must pass a service already bound to an authenticated principal. */
export interface SpaceConsoleService {
  listSpaces(): Promise<WorkflowSpace[]>;
  runtimeEvidence?(spaceId:string):Promise<Pick<PostgresWorkflowRunStore,'getRun'|'getArtifact'|'listArtifacts'|'listSteps'|'listEvents'|'listAttempts'>>;
  runtimeContexts?(spaceId:string,runId:string):Promise<NodeContext[]>;
  process?(spaceId:string,runId:string):Promise<ProcessView>;
  getPresentation?(spaceId:string,id:string,revision:string):Promise<WorkflowPresentation>;
  resolvePresentation?(spaceId: string, workflowVersionId: string, entrypoint: string): Promise<ResolvedPresentation | null>;
  overview(spaceId: string): Promise<SpaceOverview>;
  readAsset(spaceId: string, versionId: string): Promise<AssetVersion & {state: string}>;
  readContext(spaceId: string, contextId: string): Promise<NodeContext>;
  sessionEvents(spaceId: string, sessionId: string, after?: number, limit?: number):
    Promise<{items: SessionEvent[]; nextCursor: number; hasMore: boolean}>;
  readBlob(spaceId: string, blobId: string): Promise<Uint8Array>;
}

export interface AssetReading { title: string; sections: Array<{title:string;text:string;sourceRefs?:string[];pointer?:string;view?:'body'|'visual'|'evidence'}> }
export type AssetReader = (asset: AssetVersion) => AssetReading;
export interface SpaceConsoleOptions {
  title?: string;
  readers?: Record<string,AssetReader>;
  /** Optional host route, evaluated before the read-only console routes. */
  extension?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
  workbenchHref?: string;
  executionHref?: string;
  validationHref?: string;
  businessAdapter?: BusinessPresentationAdapter;
  methods?: WorkflowMethodHost;
  /** Trusted HTML supplied by the authenticated interactive host. */
  renderActions?: (input: {data: SpaceOverview; caseId: string; run?: WorkbenchRun}) => string | Promise<string>;
  renderCreateCase?: (input:{data:SpaceOverview}) => string;
}

const css = `
  ${workflowDiagramCss}
  :root{font:15px/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#24303b;background:#f8f9f7}
  *{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{margin:0}a{color:#17685c;text-decoration:none}a:hover{text-decoration:underline}
  .shell{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;background:#f0f3ef;border-right:1px solid #dce3dc;padding:24px 16px}.brand{font-weight:750;color:#233a35;display:block;margin:0 8px 22px}
  .switcher{display:block;width:100%;padding:9px;border:1px solid #cbd6ce;border-radius:8px;background:#fff;color:#24303b;min-width:0}.sidebar nav{display:grid;gap:3px;margin:20px 0}.sidebar nav a{display:block;padding:9px 10px;border-radius:7px;color:#42534e}.sidebar nav a:hover,.sidebar nav a[aria-current=page]{background:#dce9e1;color:#174f43;text-decoration:none}.sidebar .secondary{border-top:1px solid #d6ded8;padding-top:15px}
  main{width:min(100%,1500px);margin:0 auto;padding:36px clamp(18px,4vw,62px) 90px;min-width:0}.eyebrow{color:#577066;font-size:.78rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase}.lead{font-size:1.08rem;color:#52645d;max-width:70ch}
  h1{font-size:clamp(1.8rem,3vw,2.5rem);line-height:1.2;margin:.25rem 0 1rem;letter-spacing:-.025em}h2{font-size:1.28rem;line-height:1.3;margin:2rem 0 .7rem}h3{font-size:1.04rem;margin:1rem 0 .35rem}p{margin:.45rem 0 1rem;overflow-wrap:anywhere}.muted{color:#6a7771}.badge{display:inline-block;border:1px solid #cad7ce;border-radius:999px;background:#f4f8f4;padding:2px 9px;font-size:.8rem;white-space:normal}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:14px}.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.reading{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,.85fr);gap:22px;align-items:start}
  .card{border:1px solid #dce3dc;border-radius:12px;background:#fff;padding:18px;margin:9px 0;min-width:0;overflow-wrap:anywhere;box-shadow:0 2px 12px #16332708}.card p:last-child{margin-bottom:0}.prose{max-width:74ch}.prose p{white-space:pre-wrap;margin:.75rem 0 1.1rem;line-height:1.75}.prose ul{padding-left:1.4rem}
  .process-status{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:.9rem;color:#52645d}.process-layout{display:grid;grid-template-columns:minmax(150px,.65fr) minmax(0,1.65fr) minmax(190px,.8fr);gap:18px;align-items:start}.process-layout h2{font-size:1.08rem;margin:12px 0}.process-layout .card{padding:13px}.process-layout small{color:#6a7771;font-size:.8rem}.process-document{min-width:0}.process-document .prose{max-width:none}.parallel-summary{border-left:2px solid #17685c;padding-left:8px;font-size:.85rem}.method-list>li{margin:15px 0}.method-list ul{padding-left:18px}.process-document h2{font-size:1.2rem}.process-nodes a[aria-current=page]{font-weight:700}
  .method-graph{overflow:auto;border:1px solid #dce3dc;border-radius:12px;background:#fff;max-width:100%;margin:12px 0}.method-graph svg{display:block;min-width:780px;width:100%;height:auto}.method-status{padding:10px 14px;background:#eaf2eb;border-radius:8px}.method-graph a:hover rect{fill:#dfeee3}#node-detail{scroll-margin-top:20px}
  section[id^=fragment-]:target{border-left:3px solid #17685c;background:#edf4ee;padding:12px;scroll-margin-top:20px}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5f2;border:1px solid #dce3dc;border-radius:8px;padding:12px;max-height:560px;overflow:auto}table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e1e7e1;padding:9px}
  dt{font-weight:650;margin-top:12px}dd{margin:4px 0 16px 16px;min-width:0}.reading-item{padding:14px 0;border-bottom:1px solid #e1e7e1}li{overflow-wrap:anywhere} code{font-size:.87em;color:#586e62}form{display:flex;flex-wrap:wrap;gap:10px;align-items:end}form[method=post]{display:block}form[method=post]>label{width:100%;margin:14px 0}form[method=post] input:not([type=hidden]),form[method=post] textarea,form[method=post] select{width:100%}form[method=post] textarea{min-height:110px;resize:vertical}form[method=post] button{margin:8px 6px 0 0}form[method=post] small{display:block;font-size:.85rem;color:#6a7771;margin-top:10px}label{display:grid;gap:4px;min-width:0}select,input,textarea,button{font:inherit;max-width:100%}select,input,textarea{background:#fff;color:#24303b;border:1px solid #bfcfc3;border-radius:7px;padding:8px}button{background:#17685c;color:#fff;border:0;border-radius:7px;padding:9px 13px;cursor:pointer}details{margin-top:12px}summary{cursor:pointer;color:#17685c}.tabs{display:flex;flex-wrap:wrap;gap:5px;border-bottom:1px solid #dce3dc;margin:25px 0}.tabs a{padding:9px 12px;color:#52645d}.tabs a[aria-current=page]{border-bottom:2px solid #17685c;color:#17685c;font-weight:700}.empty{padding:18px;border:1px dashed #cbd7cd;border-radius:10px;color:#6a7771}.notice{border-left:3px solid #a87536;padding:8px 14px;background:#faf5e9}.crumbs{font-size:.85rem;color:#6a7771;margin-bottom:20px}
  @media(max-width:1050px){.process-layout{grid-template-columns:minmax(0,1fr)}.process-nodes{display:block}.process-nodes>.card{display:inline-block;width:calc(50% - 8px);vertical-align:top;margin:4px;min-width:0}.process-relations{border-top:1px solid #dce3dc}}@media(max-width:800px){.process-nodes>.card{display:block;width:auto;margin:8px 0}.long-goal{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.shell{display:block}.sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid #dce3dc;padding:10px 16px}.brand{display:inline-block;margin:0 12px 0 0}.switcher{display:inline-block;width:auto;max-width:55vw}.sidebar nav{display:flex;overflow-x:auto;margin:8px 0 0;white-space:nowrap}.sidebar .secondary{border:0;padding:0;margin:0}.reading,.two{grid-template-columns:1fr}main{padding:24px 18px 70px}}
`;

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function pretty(value: unknown): string {
  return escape(JSON.stringify(value, null, 2) ?? 'null');
}

function block(value: unknown): string { return `<pre>${pretty(value)}</pre>`; }
function id(value: string): string { return encodeURIComponent(value); }
function spacePath(spaceId: string): string { return `/spaces/${id(spaceId)}`; }
function assetPath(spaceId: string, versionId: string): string { return `${spacePath(spaceId)}/assets/${id(versionId)}`; }
function sessionPath(spaceId: string, sessionId: string): string { return `${spacePath(spaceId)}/sessions/${id(sessionId)}`; }
function contextPath(spaceId: string, contextId: string): string { return `${spacePath(spaceId)}/contexts/${id(contextId)}`; }
function blobPath(spaceId: string, blobId: string): string { return `${spacePath(spaceId)}/blobs/${id(blobId)}`; }

function page(title: string, body: string, siteTitle: string, workbenchHref?: string, spaceId?: string, active?: string, executionHref?:string): string {
  const nav = spaceId ? [
    ['概览', spacePath(spaceId), 'overview'], ['工作流', `${spacePath(spaceId)}/workflows`, 'workflows'], ['案例', `${spacePath(spaceId)}/cases`, 'cases'],
    ['资产', `${spacePath(spaceId)}/assets`, 'assets'], ['方法迭代', `${spacePath(spaceId)}/iterations`, 'iterations'],
    ['执行记录', `${spacePath(spaceId)}/sessions`, 'sessions'], ['配置', `${spacePath(spaceId)}/config`, 'config'],
  ] : [];
  const links = (items: typeof nav) => items.map(([label,href,key]) => `<a href="${href}"${active===key ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(siteTitle)}</title><style>${css}</style></head><body><div class="shell"><aside class="sidebar"><a class="brand" href="/">${escape(siteTitle)}</a><a class="switcher" href="/" aria-label="切换 Space">切换 Space</a><nav aria-label="主导航">${links(nav.slice(0,4))}</nav><nav class="secondary" aria-label="其他页面">${links(nav.slice(4))}${workbenchHref ? `<a href="${escape(workbenchHref)}">操作工作台</a>` : ''}${executionHref?`<a href="${escape(executionHref)}">运行任务</a>`:''}</nav></aside><main>${body}</main></div></body></html>`;
}

function section(title: string, items: string[], empty = '暂无记录'): string {
  return `<section><h2>${escape(title)}</h2>${items.length ? items.join('') : `<p class="muted">${escape(empty)}</p>`}</section>`;
}

function renderSpaces(spaces: WorkflowSpace[]): string {
  return `<h1>业务 Space</h1><p class="muted">选择业务目的，阅读案例与成果。</p>${spaces.length
    ? `<div class="grid">${spaces.map((space) => `<article class="card"><h2><a href="${spacePath(space.id)}">${escape(space.purpose)}</a></h2><p><span class="badge">${escape(stateLabel(space.status))}</span></p><p class="muted">${escape(space.id)}</p></article>`).join('')}</div>`
    : '<p>此账号暂无可访问的 Space。</p>'}`;
}

async function readingOptions(service:SpaceConsoleService,data:SpaceOverview,asset:AssetVersion,options:SpaceConsoleOptions,viewBindingId?:string|null):Promise<ReadingOptions> {
  const source=asset.source;
  const run=source.kind==='node'?data.runs.find(run=>run.runId===source.runId):undefined;
  const resolved=run&&service.resolvePresentation?await service.resolvePresentation(data.space.id,run.workflowVersionId,run.entrypoint):null;
  let presentation=resolved?.presentation;
  if(viewBindingId) {
    const selected=resolved?.history.find(binding=>binding.id===viewBindingId);
    if(!selected||!service.getPresentation)throw new Error('Invalid query: view binding does not belong to this workflow');
    presentation=await service.getPresentation(data.space.id,selected.presentationId,selected.presentationRevision);
    if(presentation.hash!==selected.presentationHash)throw new Error('Presentation binding hash mismatch');
  }
  const sources=options.businessAdapter?.resolveSources?await getAssetSources(service,data,asset,options.businessAdapter):[];
  return {readers:options.readers,presentation,presentationHistory:resolved?.history,sources,runContext:run?{runId:run.runId,caseId:run.caseId}:undefined};
}
function renderAsset(spaceId:string,asset:AssetVersion&{state:string},reading:ReadingOptions,data:SpaceOverview,selectedRun?:SpaceOverview["runs"][number],final=false,returnHref?:string,process?:ProcessView):string {
  const view=assetReading(asset,reading),source=asset.source;
  const run=selectedRun??(source.kind==='node'?data.runs.find(run=>run.runId===source.runId):undefined);
  const item=run?data.cases.find(item=>item.id===run.caseId):undefined;
  const dependencies=asset.dependencies.filter(versionId=>data.assets.some(value=>value.id===versionId));
  const sourceHref=(value:NonNullable<ReadingOptions['sources']>[number])=>`${assetPath(spaceId,value.assetVersionId!)}?${run?`run=${id(run.runId)}&amp;`:''}${value.pointer?`pointer=${id(value.pointer)}&amp;`:''}backAsset=${id(asset.id)}${process?.occurrences.find(item=>Object.values(item.outputs).flat().includes(asset.id))?.round?`&amp;backRound=${process.occurrences.find(item=>Object.values(item.outputs).flat().includes(asset.id))!.round}`:''}${value.pointer?`#${fragmentAnchor(value.pointer)}`:''}`;
  const relatedCard=(value:AssetVersion&{state:string})=>{
    const occurrence=process?.occurrences.find(item=>Object.values(item.outputs).flat().includes(value.id));
    if(!occurrence)return assetCard(value,{readers:reading.readers,presentation:reading.presentation});
    const label=reading.presentation?.stages?.find(stage=>stage.id===occurrence.nodeId)?.label??occurrence.nodeId;
    return `<article class="card"><h3><a href="${spacePath(spaceId)}/cases/${id(run!.caseId)}?run=${id(run!.runId)}&amp;tab=process&amp;asset=${id(value.id)}${occurrence.round?`&amp;round=${occurrence.round}`:''}">${occurrence.round?`第 ${occurrence.round} 轮 · `:''}${escape(label)} · 使用此版本</a></h3><p>${escape(assetReading(value,{readers:reading.readers,presentation:reading.presentation}).title)}</p></article>`;
  };
  return `<p class="crumbs"><a href="${spacePath(spaceId)}">${escape(data.space.purpose)}</a>${item?` / <a href="${returnHref??`${spacePath(spaceId)}/cases/${id(item.id)}?run=${id(run!.runId)}`}">${escape(item.title)}</a>`:''} / 资产</p><h1>${escape(view.title)}</h1><p><span class="badge">${escape(stateLabel(asset.state))}</span>${run?` · ${final?'本次最终候选':'过程或支持产物'} · <a href="${returnHref??`${spacePath(spaceId)}/cases/${id(run.caseId)}?run=${id(run.runId)}`}">${returnHref?'返回选中轮次与资产':'返回对应案例与运行'}</a>`:''}</p>${view.body}
  ${section('依据什么生成',[...dependencies.filter(versionId=>!(reading.sources??[]).some(source=>source.assetVersionId===versionId)).map(versionId=>assetCard(data.assets.find(value=>value.id===versionId)!,{readers:reading.readers,presentation:reading.presentation})),...(reading.sources??[]).map(value=>`<article class="card">${value.resolved&&value.assetVersionId?`<a href="${sourceHref(value)}">${escape(value.label)}</a>`:`${escape(value.label)} · 来源未解析`}${value.excerpt?`<details><summary>原始片段</summary><p>${escape(value.excerpt)}</p></details>`:''}</article>`)])}
  ${section('谁使用了它',data.assets.filter(value=>value.dependencies.includes(asset.id)).map(relatedCard))}
  ${section('附件',asset.attachments.map(blob=>`<p><a href="${blobPath(spaceId,blob.id)}">${escape(blob.mediaType)} · ${escape(blob.id)}</a></p>`))}
  <details><summary>版本与来源</summary><p>不可变资产版本 ${escape(asset.version)} · ${escape(asset.createdAt)}</p><p>Schema ${escape(asset.schema.namespace)}@${escape(asset.schema.revision)} · version ID ${escape(asset.id)} · Logical asset ${escape(asset.assetId)}</p>
  ${source.kind==='node'?`<p><a href="${contextPath(spaceId,source.contextId)}">生产上下文</a> · <a href="${sessionPath(spaceId,source.sessionId)}">执行记录</a>${source.generatedByContextId?` · <a href="${contextPath(spaceId,source.generatedByContextId)}">原始 Agent 上下文</a>`:''}</p>`:''}
  ${dependencies.length?`<h3>准确依赖版本</h3><ul>${dependencies.map(versionId=>`<li><a href="${assetPath(spaceId,versionId)}">${escape(versionId)}</a></li>`).join('')}</ul>`:''}${block({source:asset.source,schema:asset.schema,payloadHash:asset.payloadHash,runId:run?.runId})}<details><summary>原始结构数据</summary>${block(asset.payload)}</details>${reading.presentation?`<p>兼容展示视图 ${escape(reading.presentation.id)}@${escape(reading.presentation.revision)}；运行未记录当时视图，当前使用独立兼容绑定。</p>${reading.presentationHistory?.length?`<h3>展示绑定历史</h3><ul>${reading.presentationHistory.map(binding=>`<li><a href="${assetPath(spaceId,asset.id)}?${run?`run=${id(run.runId)}&amp;`:''}viewBinding=${id(binding.id)}">视图 ${escape(binding.presentationRevision)}</a> · ${escape(binding.createdAt)} · ${escape(binding.actorId)}</li>`).join('')}</ul>`:''}`:''}</details>`;
}

function renderContext(spaceId: string, context: NodeContext): string {
  const inputs = Object.entries(context.inputs).map(([slot, input]) => `<article class="card"><h3>${escape(slot)}</h3><p>准确输入版本 <a href="${assetPath(spaceId, input.assetVersionId)}">${escape(input.assetVersionId)}</a> · view ${escape(input.viewVersion)}</p>${block(input.payload)}</article>`);
  return `<p><a href="${spacePath(spaceId)}">Space 概览</a> · <a href="${sessionPath(spaceId,context.sessionId)}">会话记录</a></p><h1>实际交付上下文</h1><p>${escape(context.nodeId)} · run ${escape(context.runId)} · attempt ${escape(context.attemptId)}</p>
    ${section('冻结输入', inputs)}${section('实际指令与配置', [block({instructions: context.instructions, effectiveConfig: context.effectiveConfig, hash: context.hash})])}
    ${section('选用知识', context.knowledge.map((item) => `<article class="card"><h3>${escape(item.entryId)} · ${escape(item.classification)}</h3><p>${escape(item.content)}</p>${block({id: item.id, sourceAssetIds: item.sourceAssetIds, sourceMessageIds: item.sourceMessageIds})}</article>`))}`;
}

function renderSession(spaceId: string, sessionId: string, result: {items: SessionEvent[]; nextCursor: number; hasMore: boolean}): string {
  const entries = result.items.map((event) => `<article class="card"><h3>#${escape(event.seq)} · ${escape(event.kind)}</h3><p class="muted">Attempt ${escape(event.attemptId)} · ${escape(event.createdAt)}</p>${block(event.body)}</article>`);
  const next = result.hasMore ? `<p><a href="${sessionPath(spaceId, sessionId)}?cursor=${result.nextCursor}">下一页事件 →</a></p>` : '';
  return `<p><a href="${spacePath(spaceId)}">Space 概览</a></p><h1>会话记录</h1><p>${escape(sessionId)}</p>${entries.join('') || '<p class="muted">本页暂无事件。</p>'}${next}`;
}

function sendHtml(response: ServerResponse, status: number, title: string, body: string, siteTitle: string, workbenchHref?: string, spaceId?: string, active?: string, executionHref?:string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(page(title, body, siteTitle, workbenchHref, spaceId, active, executionHref));
}

function pathParts(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

function queryId(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value || value.length > 256) throw new Error('Invalid query');
  return value;
}

function cursorValue(url: URL): number {
  const raw = url.searchParams.get('cursor');
  if (!raw) return 0;
  if (!/^\d{1,12}$/.test(raw)) throw new Error('Invalid cursor');
  return Number(raw);
}

async function handle(request: IncomingMessage, response: ServerResponse,
  service: SpaceConsoleService, siteTitle: string, options?:SpaceConsoleOptions): Promise<void> {
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  if (options?.extension && await options.extension(request, response)) return;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendHtml(response, 405, 'Method not allowed', '<h1>Method not allowed</h1>', siteTitle);
    return;
  }
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if(url.pathname==='/workflow-diagram.js'){response.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8'});response.end(workflowDiagramScript);return;}
    const parts = pathParts(url.pathname);
    if (!parts.length) {
      sendHtml(response, 200, 'Spaces', renderSpaces(await service.listSpaces()), siteTitle);
      return;
    }
    if (parts[0] !== 'spaces' || !parts[1] || parts[1].length > 256) {
      sendHtml(response, 404, 'Not found', '<h1>Page not found</h1>', siteTitle);
      return;
    }
    const spaceId = parts[1];
    const settings=options??{};
    if(parts[2]==='workflows'&&(parts.length===3||parts.length===5||(parts.length===6&&parts[5]==='diagram'))) {
      const data=await service.overview(spaceId);
      if(parts.length===3){sendHtml(response,200,'工作流',methodListBody(data,settings.methods),siteTitle,settings.workbenchHref,spaceId,'workflows',settings.executionHref);return;}
      const version=data.workflows.find(value=>value.id===parts[3]),entrypoint=parts[4]!;
      if(!version?.entrypoints[entrypoint])throw new Error('Record not found in authorized space');
      const availability=settings.methods&&version.entrypoints[entrypoint]?.workflowId===settings.methods.workflowId?await settings.methods.availability(version.id,entrypoint):undefined;
      const resolved=service.resolvePresentation?await service.resolvePresentation(spaceId,version.id,entrypoint):null;
      const selection=url.searchParams.get('node')??undefined;
      const runId=url.searchParams.get('run')||undefined;
      const selectedRun=runId?data.runs.find(run=>run.runId===runId&&run.workflowVersionId===version.id&&run.entrypoint===entrypoint):undefined;
      if(runId&&!selectedRun)throw new Error('Invalid query: run outside exact method');
      const view=selectedRun&&service.process?await service.process(spaceId,selectedRun.runId):undefined;
      if(view&&(view.run.spaceId!==spaceId||view.run.workflowVersionId!==version.id||view.run.entrypoint!==entrypoint||view.run.runId!==runId))throw new Error('Invalid query: mismatched process projection');
      const savedEntry=version.entrypoints[entrypoint]!;
      const diagramEntry=savedEntry.process?savedEntry:view?.contract?{...savedEntry,process:view.contract}:savedEntry;
      if(selection&&!diagramEntry.process?.nodes.some(node=>node.id===selection))throw new Error('Invalid query: method node');
      if(parts.length===6){
        if(!diagramEntry.process?.nodes.length)throw new Error('Record not found in authorized space');
        sendWorkflowDiagram(response,await renderWorkflowDiagram({entry:diagramEntry,presentation:resolved?.presentation,selectedNodeId:selection,detailBase:methodPath(spaceId,version.id,entrypoint),view}));return;
      }
      const contexts=view?await service.runtimeContexts?.(spaceId,view.run.runId)??[]:[];
      sendHtml(response,200,version.revision,methodVersionBody(data,version,entrypoint,selection,availability,resolved?.presentation,{view,contexts}),siteTitle,settings.workbenchHref,spaceId,'workflows',settings.executionHref);return;
    }
    if(parts.length===2 || (parts.length===3&&['cases','assets','iterations','sessions','config'].includes(parts[2]!)) || (parts.length===4&&parts[2]==='cases')) {
      const model=await getSpaceWorkbench(service,spaceId,settings.businessAdapter),data=model.data;
      const active=parts[2]??'overview';
      let body:string,title=data.space.purpose;
      if(parts.length===4) {
        const item=model.cases.find(item=>item.case.id===parts[3]);
        if(!item) throw new Error('Record not found in authorized space');
        const runId=url.searchParams.get('run');
        const run=runId?item.runs.find(run=>run.binding.runId===runId):item.runs.at(-1);
        if(runId&&!run) throw new Error('Record not found in authorized space');
        const tab=url.searchParams.get('tab')??'result';
        if(!['result','process','compare','evidence'].includes(tab)) throw new Error('Invalid query');
        title=item.case.title;
        let extraEvidence='';
        if(tab==='evidence'&&run) {
          const contexts=await service.runtimeContexts?.(spaceId,run.binding.runId)??[];
          const knownSessionIds=new Set([...run.sessions.map(value=>value.sessionId),...data.assets.flatMap(asset=>asset.source.kind==='node'&&asset.source.runId===run.binding.runId?[asset.source.sessionId]:[])]);
          const sessionIds=[...new Set(contexts.map(value=>value.sessionId))].filter(value=>!knownSessionIds.has(value));
          extraEvidence=sessionIds.map(sessionId=>`<p><a href="${sessionPath(spaceId,sessionId)}">准确运行会话 ${escape(sessionId)}</a></p>`).join('');
          if(service.runtimeEvidence) {
            const evidence=await service.runtimeEvidence(spaceId);
            const [record,steps,events]=await Promise.all([evidence.getRun(run.binding.runId),evidence.listSteps(run.binding.runId),evidence.listEvents(run.binding.runId)]);
            const counts=new Map<string,number>();
            for(const event of events) counts.set(event.type,(counts.get(event.type)??0)+1);
            const milestones=events.filter(event=>/^(workflow|phase|step|harness)\./.test(event.type)||/fail|recover|retry|resum/i.test(event.type));
            extraEvidence+=`<h2>运行与故障恢复记录</h2><p class="muted">共 ${events.length} 条事件。故障记录保留在执行历史中；事件数量不等于未解决业务问题。</p><details><summary>事件类型汇总</summary><ul>${[...counts].map(([type,count])=>`<li>${escape(type)}：${count}</li>`).join('')}</ul></details>${milestones.map(event=>`<details><summary>${escape(event.type)}</summary>${block(event)}</details>`).join('')}<details><summary>全部事件原始证据</summary>${block(events)}</details><details><summary>运行与步骤原始证据</summary>${block({record,steps})}</details>`;
          }
        }
        if(tab==='process'&&run&&service.process) {
          const view=await service.process(spaceId,run.binding.runId);
          const mode=url.searchParams.get('mode')??'execution',round=url.searchParams.get('round');
          if(!['execution','method'].includes(mode)||round&&(!/^[1-9]\d*$/.test(round)||!view.occurrences.some(value=>value.round===Number(round))))throw new Error('Invalid query: process mode or round');
          const selection:ProcessSelection={mode:mode as ProcessSelection['mode'],...(round?{round:Number(round)}:{}),...(url.searchParams.has('node')?{occurrenceId:url.searchParams.get('node')!}:{}),...(url.searchParams.has('asset')?{assetVersionId:url.searchParams.get('asset')!}:{})};
          if(selection.occurrenceId&&!view.occurrences.some(value=>value.id===selection.occurrenceId))throw new Error('Invalid query: process node');
          const relatedIds=new Set(view.occurrences.flatMap(value=>[...Object.values(value.inputs),...Object.values(value.outputs).flat()]));
          if(selection.assetVersionId&&!relatedIds.has(selection.assetVersionId))throw new Error('Invalid query: process asset outside run');
          const readings=Object.fromEntries(await Promise.all(data.assets.filter(asset=>relatedIds.has(asset.id)).map(async asset=>[asset.id,await readingOptions(service,data,asset,settings)])));
          const resolved=service.resolvePresentation?await service.resolvePresentation(spaceId,run.binding.workflowVersionId,run.binding.entrypoint):null;
          const evidence=service.runtimeEvidence?await service.runtimeEvidence(spaceId):undefined;
          const steps=evidence?await evidence.listSteps(run.binding.runId):[];
          const attempts=evidence?(await Promise.all(steps.filter(step=>view.occurrences.some(occurrence=>occurrence.stepRunIds.includes(step.id))).map(step=>evidence.listAttempts(step.id)))).flat():[];
          const contexts=await service.runtimeContexts?.(spaceId,run.binding.runId)??[];
          const events=evidence?(await evidence.listEvents(run.binding.runId)).filter(event=>/fail|recover|retry|resum/i.test(event.type)):[];
          body=processReadingBody({model,item,run,view,selection,presentation:resolved?.presentation,readings,steps,attempts,contexts,events});
        } else body=await caseBody(model,item,run,tab,asset=>readingOptions(service,data,asset,settings),await settings.renderActions?.({data,caseId:item.case.id,run})??'',extraEvidence);
      } else if(active==='overview') {
        const primary=model.cases.flatMap(item=>item.runs.at(-1)?.primary?[item.runs.at(-1)!.primary!]:[]);
        const readings=Object.fromEntries(await Promise.all(primary.map(async asset=>[asset.id,await readingOptions(service,data,asset,settings)])));
        body=overviewBody(model,settings.renderCreateCase?.({data}),readings);
        body=`<section class="card"><h2>查看完整流程</h2><p>从工作流版本阅读方法图、节点输入输出与已有运行。</p><a href="${spacePath(spaceId)}/workflows">查看完整流程</a>${settings.methods?' · <a href="/workbench/workflows/preview">查看待发布草稿</a>':''}${settings.executionHref?` · <a href="${escape(settings.executionHref)}">查看运行任务</a>`:''}${settings.validationHref?` · <a href="${escape(settings.validationHref)}">验证计划</a>`:''}</section>`+body;
      }
      else if(active==='cases') body=`<h1>案例</h1>${settings.renderCreateCase?.({data})??''}<div class="grid">${model.cases.map(item=>caseCard(item,spaceId)).join('')||'<p class="empty">尚未创建案例</p>'}</div>`;
      else if(active==='assets') body=`<h1>资产</h1>${comparisonForm(spaceId,data.assets)}<div class="grid">${(await Promise.all(data.assets.map(async asset=>assetCard(asset,await readingOptions(service,data,asset,settings))))).join('')||'<p class="empty">暂无资产</p>'}</div>`;
      else if(active==='iterations') body=await iterationsBody(model,asset=>readingOptions(service,data,asset,settings));
      else if(active==='sessions') body=`<h1>执行记录</h1>${data.sessions.map(session=>`<article class="card"><h2><a href="${sessionPath(spaceId,session.id)}">${escape(session.role)}</a></h2><p>${escape(session.completeness)} · ${escape(Math.max(0,session.nextSeq-1))} 条事件</p></article>`).join('')||'<p class="empty">暂无执行记录</p>'}`;
      else body=`<h1>配置</h1>${data.workflows.map(workflow=>`<article class="card"><h2>${escape(workflow.id)} · ${escape(workflow.revision)}</h2><p>${escape(workflow.changeReason)}</p><details><summary>入口与配置</summary>${block(workflow)}</details></article>`).join('')||'<p class="empty">尚未发布方法版本</p>'}`;
      sendHtml(response,200,title,body,siteTitle,settings.workbenchHref,spaceId,active,settings.executionHref);return;
    }
    if (parts.length === 4 && parts[2] === 'assets') {
      const asset=await service.readAsset(spaceId,parts[3]!);const data=await service.overview(spaceId);
      const reading=await readingOptions(service,data,asset,settings,url.searchParams.get('viewBinding'));
      const requestedRun=url.searchParams.get('run');
      const source=asset.source;
      const runId=requestedRun??(source.kind==='node'?source.runId:undefined);
      const contextRun=runId?data.runs.find(value=>value.runId===runId):undefined;
      if(runId&&!contextRun)throw new Error('Invalid query: asset context run');
      if(contextRun&&!(source.kind==='node'&&source.runId===contextRun.runId)) {
        const dependencies=new Set(data.assets.filter(value=>value.source.kind==='node'&&value.source.runId===contextRun.runId).flatMap(value=>value.dependencies));
        const contexts=await service.runtimeContexts?.(spaceId,contextRun.runId)??[];
        for(const context of contexts)for(const input of Object.values(context.inputs))dependencies.add(input.assetVersionId);
        if(!dependencies.has(asset.id))throw new Error('Invalid query: asset is outside requested run dependencies');
      }
      let final=false;
      if(contextRun) {
        reading.runContext={runId:contextRun.runId,caseId:contextRun.caseId};
        if(!reading.presentation&&service.resolvePresentation){const resolved=await service.resolvePresentation(spaceId,contextRun.workflowVersionId,contextRun.entrypoint);reading.presentation=resolved?.presentation;reading.presentationHistory=resolved?.history;}
        if(settings.businessAdapter)final=resolveWorkbenchRun(data,contextRun,1,await settings.businessAdapter.resolveRun({data,run:contextRun})).primary?.id===asset.id;
      }
      const fragment=url.searchParams.get('pointer');
      if(fragment!==null) {
        if(!fragment.startsWith('/')||/~(?![01])/u.test(fragment))throw new Error('Invalid query: fragment pointer');
        let current:unknown=asset.payload;
        for(const part of fragment.slice(1).split('/').map(value=>value.replace(/~1/g,'/').replace(/~0/g,'~'))) {
          if(!current||typeof current!=='object'||!Object.hasOwn(current,part))throw new Error('Invalid query: fragment missing in immutable parent');
          current=(current as Record<string,unknown>)[part];
        }
      }
      let returnHref:string|undefined;
      const process=contextRun&&service.process?await service.process(spaceId,contextRun.runId):undefined;
      if(reading.runContext)reading.runContext={...reading.runContext,backAssetVersionId:asset.id,backRound:process?.occurrences.find(value=>Object.values(value.outputs).flat().includes(asset.id))?.round};
      const backAsset=url.searchParams.get('backAsset'),backRound=url.searchParams.get('backRound');
      if(backAsset&&contextRun&&service.process) {
        if(!process!.occurrences.some(value=>Object.values(value.outputs).flat().includes(backAsset)||Object.values(value.inputs).includes(backAsset))||backRound&&(!/^[1-9]\d*$/.test(backRound)||!process!.occurrences.some(value=>value.round===Number(backRound))))throw new Error('Invalid query: return process selection');
        returnHref=`${spacePath(spaceId)}/cases/${id(contextRun.caseId)}?run=${id(contextRun.runId)}&amp;tab=process&amp;asset=${id(backAsset)}${backRound?`&amp;round=${backRound}`:''}`;
      }
      sendHtml(response,200,assetReading(asset,reading).title,renderAsset(spaceId,asset,reading,data,contextRun,final,returnHref,process),siteTitle,settings.workbenchHref,spaceId,'assets',settings.executionHref);return;
    }
    if (parts.length === 3 && parts[2] === 'compare') {
      const [left,right]=await Promise.all([service.readAsset(spaceId,queryId(url,'left')),service.readAsset(spaceId,queryId(url,'right'))]);
      const data=await service.overview(spaceId),mode=url.searchParams.get('mode');
      if(mode&&!['auto','within-run','between-runs'].includes(mode)) throw new Error('Invalid query');
      const comparison=left.source.kind==='node'&&right.source.kind==='node'?compareWorkbenchAssets(data,left.id,right.id,mode==='within-run'||mode==='between-runs'?mode:undefined):undefined;
      if(!comparison&&mode&&mode!=='auto') throw new Error('Invalid query: comparison requires runs');
      const [leftOptions,rightOptions]=await Promise.all([readingOptions(service,data,left,settings),readingOptions(service,data,right,settings)]);
      if(comparison&&service.process) {
        const views=await Promise.all([service.process(spaceId,comparison.leftRun.runId),service.process(spaceId,comparison.rightRun.runId)]);
        [leftOptions,rightOptions].forEach((reading,index)=>{const version=index===0?left:right;const occurrence=views[index]!.occurrences.find(value=>Object.values(value.outputs).flat().includes(version.id));reading.identity={runLabel:comparison.mode==='within-run'?'同一次运行':index===0?'基线运行':'候选运行',...(occurrence?.round?{roundLabel:`第 ${occurrence.round} 轮`}:{})};});
      }
      sendHtml(response,200,'比较',comparisonBody(comparison,left,right,leftOptions,rightOptions),siteTitle,settings.workbenchHref,spaceId,'assets',settings.executionHref);return;
    }
    if (parts.length === 4 && parts[2] === 'contexts') {
      const context = await service.readContext(spaceId, parts[3]!);
      sendHtml(response, 200, 'Node context', renderContext(spaceId, context), siteTitle,settings.workbenchHref,spaceId,'sessions',settings.executionHref);
      return;
    }
    if (parts.length === 4 && parts[2] === 'sessions') {
      const result = await service.sessionEvents(spaceId, parts[3]!, cursorValue(url), 100);
      sendHtml(response, 200, '会话记录', renderSession(spaceId, parts[3]!, result), siteTitle,settings.workbenchHref,spaceId,'sessions',settings.executionHref);
      return;
    }
    if (parts.length === 4 && parts[2] === 'blobs') {
      const bytes = await service.readBlob(spaceId, parts[3]!);
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' });
      response.end(bytes);
      return;
    }
    sendHtml(response, 404, 'Not found', '<h1>Page not found</h1>', siteTitle);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = /access denied|requires a human|Permission denied/i.test(message) ? 403
      : /not found in authorized space|Unknown space/i.test(message) ? 404
        : /Invalid query|Invalid cursor|URI malformed|Comparison requires|Comparison mode/i.test(message) ? 400 : 500;
    sendHtml(response, status, status === 403 ? 'Access denied' : 'Request failed',
      `<h1>${status === 403 ? 'Access denied' : status === 404 ? 'Record not found' : status === 400 ? 'Invalid request' : 'Request failed'}</h1>`, siteTitle);
  }
}

/** Read-only HTTP UI. The caller decides the listening address and authenticated service lifetime. */
export function createSpaceConsole(service: SpaceConsoleService, options: SpaceConsoleOptions = {}): Server {
  const title = options.title ?? 'Workflow Spaces';
  return createServer((request, response) => { void handle(request, response, service, title,options); });
}
