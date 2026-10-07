import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createSpaceConsole, type AssetReader, type SpaceConsoleService } from './console.js';
import type { AssetVersion, Review, SpaceOverview, SpaceRun } from './types.js';
import type { BusinessPresentationAdapter, WorkbenchRun } from './workbench-model.js';
import type { WorkflowMethodHost } from './method-workbench.js';
import { methodPath, methodPreviewBody } from './method-render.js';
import { renderWorkflowDiagram } from './archify-render.js';
import { workflowDiagramCss, sendWorkflowDiagram } from './diagram-host.js';
import type { ExecutionTask } from './execution-tasks.js';
import type { ValidationWorkbench } from './validation-workbench.js';
import type { ValidationPlanDraft } from './types.js';
import { validationListBody, validationDetailBody } from './validation-render.js';

export interface InteractiveFormField {
  name: string;
  label: string;
  kind: 'text' | 'textarea' | 'number';
  required?: boolean;
  hint?: string;
  defaultValue?: string;
}

export interface InteractiveWorkflowHost {
  spaceId: string;
  label: string;
  caseFields: InteractiveFormField[];
  runFields: InteractiveFormField[];
  createCase(input: Record<string, string>, commandId: string): Promise<{ id: string }>;
  startRun(caseId: string, input: Record<string, string>, options: {
    baselineRunId?: string;
    baselineAssetVersionId?: string;
    baselineReviewId?: string;
    feedback?: string;
    hypothesis: string;
    commandId: string;
    workflowVersionId?: string;
    entrypoint?: string;
  }): Promise<{ runId: string }>;
  saveReview(caseId: string, input: {
    runId: string;
    assetVersionId: string;
    baselineAssetVersionId?: string;
    baselineReviewId?: string;
    answers: { good: string; bad: string; improvement: string; unresolved: string };
    accept: boolean;
    commandId: string;
  }): Promise<{ id: string }>;
  runStatus(runId: string): Promise<{ state: string; progress?: string; error?: string;
    /** null means no reviewable result; omitted preserves legacy hosts showing all deliverables. */
    reviewableAssetVersionId?: string | null;
    sessions?: Array<{ sessionId: string; label: string }> }>; 
  isDeliverable(asset: AssetVersion): boolean;
  methods?: WorkflowMethodHost;
  execution?: {
    list(): Promise<ExecutionTask[]>;
    cancel(runId:string): Promise<unknown>;
    dispatch(): Promise<unknown>;
  };
  validation?: ValidationWorkbench;
  freezeInput?(caseId:string,fields:Record<string,string>,commandId:string):Promise<{id:string}>;
}

export interface InteractiveSpaceConsoleOptions {
  title?: string;
  readers?: Record<string, AssetReader>;
  workflow: InteractiveWorkflowHost;
  businessAdapter?: BusinessPresentationAdapter;
}

const MAX_BODY_BYTES = 65_536;
const MAX_FIELD_CHARS = 40_000;

function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function pathId(value: string): string { return encodeURIComponent(value); }
function casePath(caseId: string): string { return `/workbench/cases/${pathId(caseId)}`; }
function newCommandId(): string { return randomBytes(16).toString('hex'); }

function send(response: ServerResponse, status: number, title: string, body: string, siteTitle: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(siteTitle)}</title><style>
    :root{font:16px/1.55 system-ui,sans-serif;color:#24323b;background:#f5f6f4}*{box-sizing:border-box}body{margin:0}main{max-width:1480px;margin:auto;padding:24px 18px 60px;overflow-wrap:anywhere}nav{border-bottom:1px solid #d9dfdf;padding:12px 18px}nav div{max-width:1480px;margin:auto;overflow-wrap:anywhere}a{color:#245c58;text-decoration:none}a:hover{text-decoration:underline}h1{font-size:1.7rem}h2{font-size:1.25rem;margin-top:2rem}.card{border:1px solid #d9dfdf;border-radius:10px;background:#fff;padding:14px;margin:12px 0;min-width:0}.muted{color:#64716f}.badge{display:inline-block;border:1px solid #c1cbc8;border-radius:99px;padding:1px 8px;font-size:.82rem}label{display:grid;gap:4px;margin:12px 0}input,textarea,select,button{font:inherit;color:#24323b;background:#f5f6f4;border:1px solid #c1cbc8;border-radius:6px;padding:8px;max-width:100%}input,textarea,select{width:100%}button{cursor:pointer;margin:8px 8px 0 0;background:#245c58;border-color:#245c58;color:#fff}button.secondary{background:#fff;border-color:#c1cbc8}small{display:block;color:#64716f}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}details{margin-top:12px}summary{cursor:pointer;color:#245c58}.error{border-color:#f87171}
    .method-graph{overflow:auto;max-width:100%;border:1px solid #d9dfdf;border-radius:10px;background:white}.method-graph svg{display:block;min-width:780px;width:100%;height:auto}.method-graph a:hover rect{fill:#dfeee3}#node-detail{scroll-margin-top:20px}.inline{display:flex;align-items:center;gap:8px}.inline input[type=checkbox]{width:auto}.grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))}fieldset{min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}.validation-group{margin:24px 0}.validation-group>h3{margin:0 0 8px}.validation-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.validation-pair>.card{margin:0}@media(max-width:650px){.validation-pair{grid-template-columns:minmax(0,1fr)}}
    ${workflowDiagramCss}
  </style></head><body><nav><div><a href="/workbench">${escape(siteTitle)}</a> · <a href="/">Space 记录</a></div></nav><main>${body}</main></body></html>`);
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { Location: location });
  response.end();
}

function csrfFields(token: string): string {
  return `<input type="hidden" name="csrf" value="${escape(token)}"><input type="hidden" name="commandId" value="${newCommandId()}">`;
}

function fieldsHtml(fields: InteractiveFormField[]): string {
  return fields.map(field => {
    const name = escape(field.name), label = escape(field.label), defaultValue = escape(field.defaultValue ?? '');
    const required = field.required ? ' required' : '';
    const control = field.kind === 'textarea'
      ? `<textarea name="${name}" rows="4" maxlength="${MAX_FIELD_CHARS}"${required}>${defaultValue}</textarea>`
      : `<input name="${name}" type="${field.kind}" value="${defaultValue}" maxlength="${MAX_FIELD_CHARS}"${required}>`;
    return `<label>${label}${control}${field.hint ? `<small>${escape(field.hint)}</small>` : ''}</label>`;
  }).join('');
}

function deliverables(data: SpaceOverview, host: InteractiveWorkflowHost, run?: SpaceRun): SpaceOverview['assets'] {
  return data.assets.filter(asset => asset.source.kind === 'node' && (!run || asset.source.runId === run.runId) && host.isDeliverable(asset))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function reviewsFor(data: SpaceOverview, assetId: string): Review[] {
  return data.reviews.filter(review => review.assetVersionIds.includes(assetId));
}
function nodeRunId(asset: AssetVersion): string | undefined {
  return asset.source.kind === 'node' ? asset.source.runId : undefined;
}

function reviewForm(caseId: string, data: SpaceOverview, host: InteractiveWorkflowHost, asset: SpaceOverview['assets'][number], token: string): string {
  if (asset.source.kind !== 'node') return '';
  const run = data.runs.find(item => item.runId === nodeRunId(asset));
  if (!run || run.caseId !== caseId) return '';
  const baselines = deliverables(data, host).filter(item => item.id !== asset.id && nodeRunId(item) !== run.runId && data.runs.some(value => value.runId === nodeRunId(item) && value.caseId === caseId));
  const options = baselines.flatMap(item => reviewsFor(data, item.id).map(review => `<option value="${escape(review.id)}">第 ${data.runs.findIndex(value => value.runId === nodeRunId(item)) + 1} 轮 · ${review.judge.kind === 'human' ? '人工' : 'Agent'}评价 ${escape(review.id)}</option>`)).join('');
  return `<details class="card"><summary>给这份结果写四问反馈</summary><form method="post" action="${casePath(caseId)}/reviews">${csrfFields(token)}<input type="hidden" name="runId" value="${escape(run.runId)}"><input type="hidden" name="assetVersionId" value="${escape(asset.id)}"><p>反馈绑定上方确切结果版本。保存评价不会自动启动下一轮。</p><label>上一版四问评价<select name="baselineReviewId"><option value="">首轮：建立基线，无上一版</option>${options}</select></label><label>好在哪里<textarea name="good" required maxlength="${MAX_FIELD_CHARS}"></textarea></label><label>不好在哪里<textarea name="bad" required maxlength="${MAX_FIELD_CHARS}"></textarea></label><label>比上一版提升了什么<textarea name="improvement" required maxlength="${MAX_FIELD_CHARS}" placeholder="首轮可写：建立基线，无上一版可比。"></textarea></label><label>仍有什么不满意<textarea name="unresolved" required maxlength="${MAX_FIELD_CHARS}"></textarea></label><button type="submit" name="decision" value="review">保存评价</button><button class="secondary" type="submit" name="decision" value="accept">保存评价并接受结果</button><small>接受是明确决定，宿主还会核验内容关口；评价本身不等于接受。</small></form></details>`;
}

type MethodChoice={versionId:string;revision:string;entrypoint:string};
async function methodChoices(data:SpaceOverview,host:InteractiveWorkflowHost):Promise<MethodChoice[]> {
  if(!host.methods)return[];
  const choices=data.workflows.flatMap(version=>Object.entries(version.entrypoints).filter(([entrypoint,entry])=>entrypoint===host.methods!.entrypoint&&entry.workflowId===host.methods!.workflowId).map(([entrypoint])=>({versionId:version.id,revision:version.revision,entrypoint})));
  const available=await Promise.all(choices.map(async choice=>{try{return(await host.methods!.availability(choice.versionId,choice.entrypoint)).available;}catch{return false;}}));
  return choices.filter((_,index)=>available[index]);
}
function methodSelect(choices:MethodChoice[]):string {
  if(!choices.length)return'<p class="muted">暂无可执行的已发布方法版本。</p>';
  return `<label>方法版本<select name="workflowVersionId" required><option value="">请选择准确版本</option>${choices.map(choice=>`<option value="${escape(choice.versionId)}">${escape(choice.revision)} · ${escape(choice.versionId)}</option>`).join('')}</select></label><input type="hidden" name="entrypoint" value="${escape(choices[0]!.entrypoint)}">`;
}
async function selectedMethod(form:URLSearchParams,data:SpaceOverview,host:InteractiveWorkflowHost,exact?:{workflowVersionId:string;entrypoint:string}):Promise<{workflowVersionId:string;entrypoint:string}|undefined> {
  if(!host.methods)return undefined;
  const workflowVersionId=exact?.workflowVersionId??required(form,'workflowVersionId'),entrypoint=exact?.entrypoint??required(form,'entrypoint');
  if(exact&&(optional(form,'workflowVersionId')!==undefined||optional(form,'entrypoint')!==undefined))throw new FormError(400,'版本入口由页面路径固定');
  const version=data.workflows.find(item=>item.id===workflowVersionId),entry=version?.entrypoints[entrypoint];
  if(!entry||entry.workflowId!==host.methods.workflowId||entrypoint!==host.methods.entrypoint)throw new FormError(400,'方法版本与入口不属于此工作台');
  const availability=await host.methods.availability(workflowVersionId,entrypoint);
  if(!availability.available)throw new InteractiveConsoleError(409,availability.reason??'此方法版本目前不可执行');
  return{workflowVersionId,entrypoint};
}

async function actionPanel(caseId: string, data: SpaceOverview, host: InteractiveWorkflowHost, token: string, run?: WorkbenchRun): Promise<string> {
  const selectedCase=data.cases.find(item=>item.id===caseId);
  if(!selectedCase) return '';
  const runs=data.runs.filter(value=>value.caseId===caseId);
  const result=run?.primary;
  const review=result?reviewForm(caseId,data,host,result,token):'<p class="muted">本次尚无可评价的终态结果。</p>';
  const reviewed=deliverables(data,host).filter(asset=>runs.some(value=>value.runId===nodeRunId(asset)))
    .flatMap(asset=>reviewsFor(data,asset.id).map(value=>({asset,review:value}))).filter(item=>item.review.runId===nodeRunId(item.asset));
  const baselineOptions=runs.filter(value=>reviewed.some(item=>nodeRunId(item.asset)===value.runId)).map(value=>`<option value="${escape(value.runId)}">第 ${runs.indexOf(value)+1} 次运行</option>`).join('');
  const baselineReviews=reviewed.map(item=>`<option value="${escape(item.review.id)}">第 ${runs.findIndex(value=>value.runId===nodeRunId(item.asset))+1} 次运行 · ${item.review.judge.kind==='human'?'人工':'Agent'}评价 ${escape(item.review.id)}</option>`).join('');
  const choices=host.methods?await methodChoices(data,host):[];
  const selection=host.methods?methodSelect(choices):'';
  const disabled=host.methods&&!choices.length?' disabled':'';
  const first=`<form method="post" action="${casePath(caseId)}/runs">${csrfFields(token)}<h3>建立首次结果基线</h3>${selection}<label>这次希望验证什么<textarea name="hypothesis" required maxlength="${MAX_FIELD_CHARS}"></textarea></label>${fieldsHtml(host.runFields)}<button type="submit"${disabled}>明确启动新运行</button></form>`;
  const rerun=reviewed.length?`<form method="post" action="${casePath(caseId)}/runs">${csrfFields(token)}<h3>根据已评价结果继续修订</h3>${selection}<label>基线运行<select name="baselineRunId" required><option value="">请选择</option>${baselineOptions}</select></label><label>准确基线评价<select name="baselineReviewId" required><option value="">请选择</option>${baselineReviews}</select></label><label>这次希望改善什么<textarea name="hypothesis" required maxlength="${MAX_FIELD_CHARS}"></textarea></label><label>评价或修订依据<textarea name="feedback" required maxlength="${MAX_FIELD_CHARS}"></textarea></label><button type="submit"${disabled}>明确启动反馈修订</button><small>沿用基线运行的冻结输入。反馈修订与方法实验分别记录；本入口不修改方法。</small></form>`:'<p class="muted">先保存准确结果的四问评价，再继续反馈修订。</p>';
  return `${review}<details class="card"><summary>发起 ${escape(host.label)} 新运行</summary>${first}${rerun}</details><script src="/workbench/form-drafts.js" defer></script>`;
}

function exactRunForm(data:SpaceOverview,host:InteractiveWorkflowHost,versionId:string,entrypoint:string,token:string):string {
  const version=data.workflows.find(value=>value.id===versionId)!;
  return `<p><a href="${methodPath(host.spaceId,versionId,entrypoint)}">返回方法版本</a></p><h1>用此版本运行</h1><p class="card">准确版本：${escape(version.revision)} · <code>${escape(versionId)}</code><br>入口：<code>${escape(entrypoint)}</code></p><p>启动将为所选案例创建独立运行任务；方法版本由此页面固定。</p><form method="post" action="/workbench/workflows/${pathId(versionId)}/${pathId(entrypoint)}/run">${csrfFields(token)}<label>选择案例<select name="caseId" required><option value="">请选择案例</option>${data.cases.map(item=>`<option value="${escape(item.id)}">${escape(item.title)} · ${escape(item.id)}</option>`).join('')}</select></label><label>这次希望验证什么<textarea name="hypothesis" required maxlength="${MAX_FIELD_CHARS}"></textarea></label>${fieldsHtml(host.runFields)}<button type="submit"${data.cases.length?'':' disabled'}>明确启动此版本</button></form>${data.cases.length?'':'<p>请先创建案例。</p>'}`;
}
const taskStatus:Record<string,string>={queued:'排队中',running:'执行中',cancel_requested:'取消已请求，等待停止',interrupted:'中断，需核对与协调恢复',completed:'执行已结束',failed:'执行失败',canceled:'已取消'};
async function tasksBody(data:SpaceOverview,host:InteractiveWorkflowHost,token:string):Promise<string> {
  const tasks=(await host.execution!.list()).filter(task=>task.spaceId===host.spaceId).sort((a,b)=>(b.createdAt??'').localeCompare(a.createdAt??''));
  const statuses=await Promise.all(tasks.map(async task=>{try{return await host.runStatus(task.runId);}catch{return undefined;}}));
  const executors=await Promise.all(tasks.map(async task=>{
    if(task.status!=='queued'||!host.methods)return undefined;
    try{return await host.methods.availability(task.workflowVersionId,task.entrypoint);}catch{return{available:false,reason:'执行器可用性核验失败'};}
  }));
  const count=(status:ExecutionTask['status'])=>tasks.filter(task=>task.status===status).length;
  return `<p><a href="/spaces/${pathId(host.spaceId)}">Space 概览</a></p><h1>运行任务</h1><p>执行中 ${count('running')} · 排队 ${count('queued')} · 中断 ${count('interrupted')} · 等待取消 ${count('cancel_requested')}</p><p>任务状态说明执行是否结束；业务质量和人工接受仍在案例与评价中判断。页面仅查看状态，不会自动派发任务。<a href="/workbench/runs">刷新状态</a></p><form method="post" action="/workbench/runs/dispatch">${csrfFields(token)}<button type="submit">派发排队任务</button></form>${tasks.map((task,index)=>{const run=data.runs.find(item=>item.runId===task.runId),status=statuses[index],executor=executors[index];const cancellable=task.status==='queued'||task.status==='running';return `<article class="card"><h2>${escape(data.cases.find(item=>item.id===task.caseId)?.title??task.caseId)}</h2><p><span class="badge">${escape(taskStatus[task.status]??task.status)}</span>${executor&&!executor.available?` · 等待对应版本执行器${executor.reason?`：${escape(executor.reason)}`:''}`:status?` · 业务状态：${escape(status.progress??status.state)}`:''}</p><p>版本：<a href="${methodPath(host.spaceId,task.workflowVersionId,task.entrypoint)}">${escape(task.workflowVersionId)} · ${escape(task.entrypoint)}</a></p><p><a href="${casePath(task.caseId)}?run=${pathId(task.runId)}">查看案例运行 ${escape(task.runId)}</a>${run?` · <a href="/spaces/${pathId(host.spaceId)}/cases/${pathId(task.caseId)}?run=${pathId(task.runId)}&amp;tab=process">过程</a> · <a href="/spaces/${pathId(host.spaceId)}/cases/${pathId(task.caseId)}?run=${pathId(task.runId)}&amp;tab=evidence">执行证据</a>`:''}</p>${status?.sessions?.length?`<p>会话：${status.sessions.map(session=>`<a href="/spaces/${pathId(host.spaceId)}/sessions/${pathId(session.sessionId)}">${escape(session.label)}</a>`).join(' · ')}</p>`:''}${task.error?`<p class="error">${escape(task.error)}</p>`:''}${task.status==='interrupted'?'<p>执行中断，需要核对持久状态后再协调恢复；此页面不会自动重试。</p>':''}${cancellable?`<form method="post" action="/workbench/runs/${pathId(task.runId)}/cancel">${csrfFields(token)}<button type="submit">请求取消此任务</button></form>`:''}</article>`;}).join('')||'<p class="card">暂无执行任务。</p>'}`;
}

const formDraftScript = `(() => {
  const prefix='workflow-space-form:';
  const saved=new URLSearchParams(location.search).get('savedReview');
  document.querySelectorAll('form[method="post"]').forEach(form=>{
    const target=form.querySelector('[name="assetVersionId"]')?.value||form.querySelector('[name="baselineRunId"]')?.name||'initial';
    const key=prefix+form.getAttribute('action')+':'+target;
    if(saved&&saved===target)sessionStorage.removeItem(key);
    let draft;try{draft=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
    const controls=[...form.querySelectorAll('textarea,select,input:not([type="hidden"])')];
    if(draft)controls.forEach(control=>{if(Object.hasOwn(draft,control.name))control.value=draft[control.name];});
    const save=()=>{const values={};controls.forEach(control=>{values[control.name]=control.value;});try{sessionStorage.setItem(key,JSON.stringify(values));}catch{}};
    form.addEventListener('input',save);form.addEventListener('change',save);
  });
  if(saved){const url=new URL(location.href);url.searchParams.delete('savedReview');history.replaceState(null,'',url);}
})();`;

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/x-www-form-urlencoded') throw new FormError(415, '请使用页面表单提交');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > MAX_BODY_BYTES) throw new FormError(413, '提交内容过大');
    chunks.push(part);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function required(form: URLSearchParams, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1 || !values[0]?.trim() || values[0].length > MAX_FIELD_CHARS) throw new FormError(400, `${name} 无效`);
  return values[0].trim();
}

function optional(form: URLSearchParams, name: string): string | undefined {
  const values = form.getAll(name);
  if (values.length > 1 || (values[0]?.length ?? 0) > MAX_FIELD_CHARS) throw new FormError(400, `${name} 无效`);
  return values[0]?.trim() || undefined;
}

function lines(value:string|undefined):string[]{return(value??'').split(/\r?\n/u).map(item=>item.trim()).filter(Boolean);}
function selectedValidationMethod(value:string,data:SpaceOverview):ValidationPlanDraft['baseline'] {
  const divider=value.lastIndexOf('|');
  if(divider<1)throw new FormError(400,'请选择已发布方法和入口');
  const workflowVersionId=value.slice(0,divider),entrypoint=value.slice(divider+1);
  if(!data.workflows.some(v=>v.id===workflowVersionId&&v.entrypoints[entrypoint]))throw new FormError(400,'方法版本与入口不属于此 Space');
  return{workflowVersionId,entrypoint};
}
function forbidValidationIdentity(form:URLSearchParams):void {
  for(const key of form.keys())if(/^(?:judge|judgeId|judgeKind|standard|humanJudgeId)(?:\.|\[|$)/u.test(key)&&!['standardId','standardRevision','standardContent'].includes(key))throw new FormError(400,'评价者与标准不能由网页更改');
}

function formFields(form: URLSearchParams, fields: InteractiveFormField[]): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const field of fields) result[field.name] = field.required ? required(form, field.name) : optional(form, field.name) ?? '';
  return result;
}

/** A safe, user-facing error that host callbacks may throw for validation or workflow gates. */
export class InteractiveConsoleError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
class FormError extends Error { constructor(readonly status: number, message: string) { super(message); } }

function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function expectedOrigin(request: IncomingMessage): string | null {
  const host = request.headers.host;
  if (!host || !/^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/.test(host)) return null;
  return `http://${host}`;
}

/** A loopback, single-user HTML action host. Authentication and command idempotency belong to the caller. */
export function createInteractiveSpaceConsole(service: SpaceConsoleService, options: InteractiveSpaceConsoleOptions): Server {
  const host = options.workflow;
  const token = randomBytes(32).toString('hex');
  const siteTitle = options.title ?? `${host.label} 工作台`;
  const extension = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    let pathname: string;
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname; }
    catch { return false; }
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    // Chromium can send Origin: null for same-origin forms under no-referrer.
    response.setHeader('Referrer-Policy', 'same-origin');
    if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/workbench/form-drafts.js') {
      response.writeHead(200, {'Content-Type':'application/javascript; charset=utf-8'});response.end(formDraftScript);return true;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/workbench') {
      request.url=`/spaces/${pathId(host.spaceId)}`;return false;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && /^\/workbench\/cases\/[^/]+$/.test(pathname)) {
      const url=new URL(request.url??'/', 'http://localhost');
      request.url=`/spaces/${pathId(host.spaceId)}/cases/${pathname.split('/')[3]}${url.search}`;return false;
    }
    if (pathname !== '/workbench' && !pathname.startsWith('/workbench/')) return false;
    try {
      const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if ((request.method==='GET'||request.method==='HEAD')&&pathname==='/workbench/validation'&&host.validation) {
        const listed=await host.validation.list();
        const inputForm=host.freezeInput?`<details class="card"><summary>冻结案例输入</summary><p>使用已有案例建立准确输入清单。完成后刷新本页，在计划中选择它。</p><form method="post" action="/workbench/validation/inputs">${csrfFields(token)}<label>案例<select name="caseId" required><option value="">请选择</option>${listed.data.cases.map(item=>`<option value="${escape(item.id)}">${escape(item.title)}</option>`).join('')}</select></label>${fieldsHtml(host.runFields)}<button type="submit">冻结输入</button></form></details>`:'';
        send(response,200,'验证计划',inputForm+validationListBody(listed,csrfFields(token)),siteTitle);return true;
      }
      if ((request.method==='GET'||request.method==='HEAD')&&parts.length===3&&parts[1]==='validation'&&parts[2]!=='inputs'&&host.validation) {
        send(response,200,'验证计划详情',validationDetailBody(await host.validation.detail(parts[2]!),csrfFields(token)),siteTitle);return true;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && (pathname === '/workbench/workflows/preview'||pathname === '/workbench/workflows/preview/diagram') && host.methods) {
        const [data,candidate]=await Promise.all([service.overview(host.spaceId),host.methods.preview()]);
        if(candidate.entrypoint!==host.methods.entrypoint||candidate.version.entrypoints[candidate.entrypoint]?.workflowId!==host.methods.workflowId) throw new InteractiveConsoleError(409,'候选方法入口与工作台不一致');
        const query=new URL(request.url??'/', 'http://localhost').searchParams;
        const expectedVersion=query.get('version');
        if(expectedVersion&&expectedVersion!==candidate.version.id)throw new InteractiveConsoleError(409,'候选已改变，请刷新方法预览');
        const selection=query.get('node');
        if(selection&&!candidate.version.entrypoints[candidate.entrypoint]?.process?.nodes.some(node=>node.id===selection))throw new FormError(400,'节点不存在');
        if(pathname.endsWith('/diagram')){
          const entry=candidate.version.entrypoints[candidate.entrypoint]!;
          if(!entry.process?.nodes.length)throw new FormError(404,'候选没有流程声明');
          sendWorkflowDiagram(response,await renderWorkflowDiagram({entry,presentation:candidate.presentation,selectedNodeId:selection??undefined,detailBase:'/workbench/workflows/preview'}));return true;
        }
        send(response,200,'待发布方法预览',methodPreviewBody(data,candidate,csrfFields(token),selection),siteTitle);return true;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/workbench/runs' && host.execution) {
        const data=await service.overview(host.spaceId);
        send(response,200,'运行任务',await tasksBody(data,host,token),siteTitle);return true;
      }
      if ((request.method === 'GET' || request.method === 'HEAD') && parts.length===5&&parts[1]==='workflows'&&parts[4]==='run'&&host.methods) {
        const data=await service.overview(host.spaceId),workflowVersionId=parts[2]!,entrypoint=parts[3]!;
        const version=data.workflows.find(value=>value.id===workflowVersionId);
        if(!version)throw new FormError(404,'方法版本不存在');
        await selectedMethod(new URLSearchParams(),data,host,{workflowVersionId,entrypoint});
        send(response,200,'用此版本运行',exactRunForm(data,host,workflowVersionId,entrypoint,token),siteTitle);return true;
      }
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (!expectedOrigin(request) || origin !== expectedOrigin(request)) throw new FormError(403, '提交来源无效');
        const form = await readForm(request);
        if (!sameToken(optional(form, 'csrf'), token)) throw new FormError(403, '表单已失效，请刷新页面');
        const commandId = required(form, 'commandId');
        if (!/^[a-f0-9]{32}$/.test(commandId)) throw new FormError(400, '请求编号无效');
        if(parts[1]==='validation'&&host.validation){
          const validation=host.validation,planId=parts[2];
          forbidValidationIdentity(form);
          if(parts.length===3&&planId==='inputs'&&host.freezeInput){
            const listed=await validation.list(),caseId=required(form,'caseId');
            if(!listed.data.cases.some(item=>item.id===caseId))throw new FormError(400,'案例不属于此 Space');
            await host.freezeInput(caseId,formFields(form,host.runFields),commandId);redirect(response,'/workbench/validation');return true;
          }
          if(parts.length===2){
            const {data,manifests,humanJudgeId}=await validation.list();
            const selected=form.getAll('caseId');
            if(!selected.length||new Set(selected).size!==selected.length)throw new FormError(400,'请选择至少一个不同案例');
            const cases=selected.map(caseId=>{
              if(!data.cases.some(item=>item.id===caseId))throw new FormError(400,'案例不属于此 Space');
              const inputManifestId=required(form,`manifest:${caseId}`);
              if(!manifests.some(item=>item.id===inputManifestId&&item.caseId===caseId))throw new FormError(400,'输入清单不属于选中案例');
              const repeats=Number(required(form,`repeats:${caseId}`));
              if(!Number.isSafeInteger(repeats)||repeats<1||repeats>20)throw new FormError(400,'重复次数应为 1 至 20');
              return{caseId,inputManifestId,repeats};
            });
            const baseline=selectedValidationMethod(required(form,'baseline'),data),candidate=selectedValidationMethod(required(form,'candidate'),data);
            if(baseline.workflowVersionId===candidate.workflowVersionId&&baseline.entrypoint===candidate.entrypoint)throw new FormError(400,'请选择两个不同的已发布方法');
            const draft:ValidationPlanDraft={id:commandId,kind:'prospective',question:required(form,'question'),hypothesis:required(form,'hypothesis'),baseline,candidate,cases,
              standard:{id:required(form,'standardId'),revision:required(form,'standardRevision'),content:required(form,'standardContent')},judges:[{kind:'human',id:humanJudgeId}],expectedVariables:lines(optional(form,'expectedVariables')),exclusionRules:lines(optional(form,'exclusionRules'))};
            const created=await validation.create(draft);redirect(response,`/workbench/validation/${pathId(created.id)}`);return true;
          }
          if(!planId)throw new FormError(404,'验证计划不存在');
          const base=`/workbench/validation/${pathId(planId)}`;
          if(parts.length===4&&parts[3]==='freeze'){await validation.freeze(planId);redirect(response,base);return true;}
          if(parts.length===4&&parts[3]==='start'){const attempt=Number(required(form,'attempt'));if(!Number.isSafeInteger(attempt)||attempt<1)throw new FormError(400,'尝试编号无效');await validation.start(planId,required(form,'entryId'),attempt);redirect(response,base);return true;}
          if(parts.length===4&&parts[3]==='dispatch'){await validation.dispatch();redirect(response,base);return true;}
          if(parts.length===4&&parts[3]==='exclude'){
            const detail=await validation.detail(planId),entryId=required(form,'entryId'),rule=required(form,'rule');
            if(!detail.entries.some(item=>item.entry.id===entryId)||!detail.plan.exclusionRules.includes(rule))throw new FormError(400,'排除项或冻结规则无效');
            await validation.exclude(planId,{entryId,rule,reason:required(form,'reason')});redirect(response,base);return true;
          }
          if(parts.length===4&&parts[3]==='review'){
            const input={id:commandId,entryId:required(form,'entryId'),runId:required(form,'runId'),assetVersionIds:[required(form,'assetVersionId')],baselineReviewId:optional(form,'baselineReviewId'),
              answers:{good:required(form,'good'),bad:required(form,'bad'),improvement:required(form,'improvement'),unresolved:required(form,'unresolved')}};
            await validation.review(planId,input);redirect(response,base);return true;
          }
          if(parts.length===4&&parts[3]==='link-run'){
            const [entryId,runId]=required(form,'link').split('|');
            if(!entryId||!runId)throw new FormError(400,'旧运行选择无效');
            const detail=await validation.detail(planId),entry=detail.entries.find(item=>item.entry.id===entryId);
            if(!entry||!detail.data.runs.some(run=>run.runId===runId&&run.caseId===entry.entry.caseId&&run.workflowVersionId===entry.entry.workflowVersionId&&run.entrypoint===entry.entry.entrypoint&&run.inputManifestId===entry.entry.inputManifestId))throw new FormError(400,'旧运行与冻结条件不符');
            await validation.linkRun(planId,{entryId,runId,attempt:entry.attempts.length+1});redirect(response,base);return true;
          }
          if(parts.length===4&&parts[3]==='link-review'){
            const [entryId,runId,reviewId]=required(form,'link').split('|');
            if(!entryId||!runId||!reviewId)throw new FormError(400,'旧评价选择无效');
            const detail=await validation.detail(planId),entry=detail.entries.find(item=>item.entry.id===entryId);
            if(!entry?.attempts.some(attempt=>attempt.runId===runId)||!detail.data.reviews.some(review=>review.id===reviewId&&review.runId===runId))throw new FormError(400,'旧评价不属于准确计划运行');
            await validation.linkReview(planId,{entryId,runId,reviewId});redirect(response,base);return true;
          }
          if(parts.length===4&&parts[3]==='compare'){
            await validation.compare(planId,{id:commandId,baselineEntryId:required(form,'baselineEntryId'),candidateEntryId:required(form,'candidateEntryId'),baselineReviewId:required(form,'baselineReviewId'),candidateReviewId:required(form,'candidateReviewId'),conclusion:required(form,'conclusion')});redirect(response,base);return true;
          }
          if(parts.length===4&&parts[3]==='issues'){
            const detail=await validation.detail(planId),entryIds=form.getAll('entryId');
            if(!entryIds.length||new Set(entryIds).size!==entryIds.length)throw new FormError(400,'请选择不同的证据计划项');
            const entries=entryIds.map(entryId=>detail.entries.find(item=>item.entry.id===entryId)?.entry);
            if(entries.some(entry=>!entry))throw new FormError(400,'证据计划项不存在');
            const runId=optional(form,'runId'),nodeId=optional(form,'nodeId');
            if((runId||nodeId)&&entries.length!==1)throw new FormError(400,'准确运行或节点只能关联单个计划项');
            const kind=required(form,'kind');if(kind!=='observation'&&kind!=='cause-hypothesis')throw new FormError(400,'问题类型无效');
            await validation.issue(planId,{id:commandId,kind,category:required(form,'category'),text:required(form,'text'),nextHypothesis:optional(form,'nextHypothesis'),evidence:entries.map(entry=>({entryId:entry!.id,caseId:entry!.caseId,runId,nodeId}))});redirect(response,base);return true;
          }
          if(parts.length===4&&parts[3]==='adopt'){
            const detail=await validation.detail(planId),targetVersionId=required(form,'targetVersionId');
            if(targetVersionId!==detail.plan.candidate.workflowVersionId)throw new FormError(400,'采用目标必须是此计划候选版本');
            await validation.adopt(planId,{idempotencyKey:commandId,slot:required(form,'slot'),target:{kind:'workflow',id:targetVersionId},expectedPrevious:optional(form,'expectedPrevious'),comparisonId:required(form,'comparisonId'),reason:required(form,'reason')});redirect(response,base);return true;
          }
        }
        if (pathname === '/workbench/workflows/publish' && host.methods) {
          const expectedVersionId=required(form,'expectedVersionId');
          const preview=await host.methods.preview();
          if(preview.version.id!==expectedVersionId||preview.entrypoint!==host.methods.entrypoint)throw new InteractiveConsoleError(409,'候选方法已经变化，请刷新预览');
          const predecessorId=optional(form,'predecessorId');
          const prior=(await service.overview(host.spaceId)).workflows.filter(version=>version.id!==expectedVersionId&&version.entrypoints[host.methods!.entrypoint]?.workflowId===host.methods!.workflowId);
          if(prior.length&&!predecessorId)throw new FormError(400,'请选择此工作流的前驱版本');
          if(predecessorId&&(!prior.some(version=>version.id===predecessorId)||predecessorId===expectedVersionId))throw new FormError(400,'前驱版本不属于此工作流入口');
          const published=await host.methods.publish({expectedVersionId,predecessorId,changeReason:required(form,'changeReason')});
          if(published.workflowVersionId!==expectedVersionId||published.entrypoint!==host.methods.entrypoint)throw new InteractiveConsoleError(409,'发布返回的版本身份不一致');
          redirect(response,methodPath(host.spaceId,published.workflowVersionId,published.entrypoint));return true;
        }
        if (parts.length===5&&parts[1]==='workflows'&&parts[4]==='run'&&host.methods) {
          const data=await service.overview(host.spaceId),workflowVersionId=parts[2]!,entrypoint=parts[3]!,caseId=required(form,'caseId');
          if(!data.cases.some(item=>item.id===caseId))throw new FormError(404,'案例不存在');
          const exact=await selectedMethod(form,data,host,{workflowVersionId,entrypoint});
          const result=await host.startRun(caseId,formFields(form,host.runFields),{...exact,hypothesis:required(form,'hypothesis'),commandId});
          redirect(response,host.execution?'/workbench/runs':`${casePath(caseId)}?run=${pathId(result.runId)}`);return true;
        }
        if(pathname==='/workbench/runs/dispatch'&&host.execution){await host.execution.dispatch();redirect(response,'/workbench/runs');return true;}
        if(parts.length===4&&parts[1]==='runs'&&parts[3]==='cancel'&&host.execution){
          const task=(await host.execution.list()).find(item=>item.runId===parts[2]&&item.spaceId===host.spaceId);
          if(!task)throw new FormError(404,'任务不存在');
          if(task.status!=='queued'&&task.status!=='running')throw new InteractiveConsoleError(409,'此任务当前不能取消');
          await host.execution.cancel(task.runId);redirect(response,'/workbench/runs');return true;
        }
        if (parts.length === 2 && parts[1] === 'cases') {
          const created = await host.createCase(formFields(form, host.caseFields), commandId);
          redirect(response, casePath(created.id));
          return true;
        }
        if (parts.length === 4 && parts[1] === 'cases' && parts[3] === 'runs') {
          const caseId = parts[2]!;
          const data = await service.overview(host.spaceId);
          if (!data.cases.some(item => item.id === caseId)) throw new FormError(404, '案例不存在');
          const baselineRunId = optional(form, 'baselineRunId');
          const baselineReviewId = optional(form, 'baselineReviewId');
          if (Boolean(baselineRunId) !== Boolean(baselineReviewId)) throw new FormError(400, '请选择同一旧运行及其四问评价');
          let baselineAssetVersionId: string | undefined;
          if (baselineRunId) {
            const baselineRun = data.runs.find(run => run.runId === baselineRunId && run.caseId === caseId);
            const baselineReview = data.reviews.find(review => review.id === baselineReviewId && review.runId === baselineRunId);
            const baselineAsset = data.assets.find(asset => baselineReview?.assetVersionIds.includes(asset.id) && host.isDeliverable(asset) && asset.source.kind === 'node' && asset.source.runId === baselineRunId);
            if (!baselineRun || !baselineReview || !baselineAsset) throw new FormError(400, '比较基线不属于本案例旧运行');
            baselineAssetVersionId = baselineAsset.id;
          }
          const feedback = baselineRunId ? required(form, 'feedback') : undefined;
          const runFields = baselineRunId ? Object.create(null) as Record<string, string> : formFields(form, host.runFields);
          const method=await selectedMethod(form,data,host);
          await host.startRun(caseId, runFields, { ...method,baselineRunId, baselineAssetVersionId, baselineReviewId, feedback, hypothesis: required(form, 'hypothesis'), commandId });
          redirect(response, host.execution?'/workbench/runs':casePath(caseId));
          return true;
        }
        if (parts.length === 4 && parts[1] === 'cases' && parts[3] === 'reviews') {
          const caseId = parts[2]!;
          const data = await service.overview(host.spaceId);
          if (!data.cases.some(item => item.id === caseId)) throw new FormError(404, '案例不存在');
          const runId = required(form, 'runId'), assetVersionId = required(form, 'assetVersionId');
          const run = data.runs.find(item => item.runId === runId && item.caseId === caseId);
          const asset = data.assets.find(item => item.id === assetVersionId && host.isDeliverable(item));
          if (!run || asset?.source.kind !== 'node' || asset.source.runId !== runId) throw new FormError(400, '评价对象不属于本案例运行');
          const state = await host.runStatus(runId);
          if (state.reviewableAssetVersionId !== undefined && state.reviewableAssetVersionId !== assetVersionId) throw new FormError(409, '这份结果尚不是可评价的本次最终结果');
          const baselineReviewId = optional(form, 'baselineReviewId');
          let baselineAssetVersionId: string | undefined;
          if (baselineReviewId) {
            const baselineReview = data.reviews.find(item => item.id === baselineReviewId);
            const baseline = data.assets.find(item => baselineReview?.assetVersionIds.includes(item.id) && host.isDeliverable(item));
            if (!baselineReview || !baseline || baseline.id === asset.id || nodeRunId(baseline) === runId || nodeRunId(baseline) !== baselineReview.runId || !data.runs.some(item => item.runId === nodeRunId(baseline) && item.caseId === caseId)) throw new FormError(400, '评价基线不属于本案例的另一轮');
            baselineAssetVersionId = baseline.id;
          }
          const decision = required(form, 'decision');
          if (decision !== 'review' && decision !== 'accept') throw new FormError(400, '评价动作无效');
          await host.saveReview(caseId, { runId, assetVersionId, baselineAssetVersionId, baselineReviewId,
            answers: { good: required(form, 'good'), bad: required(form, 'bad'), improvement: required(form, 'improvement'), unresolved: required(form, 'unresolved') }, accept: decision === 'accept', commandId });
          redirect(response, `${casePath(caseId)}?savedReview=${pathId(assetVersionId)}`);
          return true;
        }
      }
      send(response, request.method === 'GET' || request.method === 'HEAD' ? 404 : 405, '页面不存在', '<h1>页面不存在</h1>', siteTitle);
      return true;
    } catch (error) {
      const status = error instanceof FormError || error instanceof InteractiveConsoleError ? error.status : /access denied|permission denied/i.test(String(error)) ? 403 : 500;
      const message = error instanceof FormError || error instanceof InteractiveConsoleError ? error.message : status === 403 ? '没有访问权限' : '操作未完成，请返回检查输入或稍后重试';
      send(response, status, '操作未完成', `<section class="card error"><h1>${escape(message)}</h1><p><a href="/workbench">返回工作台</a></p></section>`, siteTitle);
      return true;
    }
  };
  const businessAdapter:BusinessPresentationAdapter=options.businessAdapter??{
    async resolveRun({data,run}) {
      const status=await host.runStatus(run.runId);
      return {state:status.state,progress:status.progress,primaryAssetVersionId:status.reviewableAssetVersionId??null,sessions:status.sessions,
        process:deliverables(data,host,run).map((asset,index)=>({label:`第 ${index+1} 次产出`,assetVersionId:asset.id,assessmentAssetVersionIds:[]}))};
    },
  };
  return createSpaceConsole(service, { title: siteTitle, readers: options.readers, extension, businessAdapter, methods:host.methods,executionHref:host.execution?'/workbench/runs':undefined,validationHref:host.validation?'/workbench/validation':undefined,
    renderActions:({data,caseId,run})=>data.space.id===host.spaceId?actionPanel(caseId,data,host,token,run):'',
    renderCreateCase:({data})=>data.space.id===host.spaceId?`<details class="card"><summary>创建案例</summary><form method="post" action="/workbench/cases">${csrfFields(token)}${fieldsHtml(host.caseFields)}<button type="submit">创建案例</button></form><script src="/workbench/form-drafts.js" defer></script></details>`:'',
  });
}
