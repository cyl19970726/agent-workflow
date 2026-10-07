import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {isDeepStrictEqual} from 'node:util';
import {buildWorkflowGraphState, getAssetSources, renderWorkflowDiagram, type AssetReader, type AssetVersion, type BusinessPresentationAdapter, type BusinessRunResolution, type SpaceCase, type SpaceOverview, type SpaceRun, type WorkflowSpaceService, type WorkflowVersion} from '@signal-room/workflow-spaces';
import {AssetReadingSchema, AssetRelationsSchema, AssetSummarySchema, BusinessCommandReceiptSchema, BusinessDispatchRequestSchema, BusinessFormSchema, BusinessPreparationSchema, BusinessPrepareRequestSchema, BusinessStartRequestSchema, CaseSummarySchema, ComparisonReadingSchema, HandlingNoteListSchema, HandlingNoteRequestSchema, HandlingNoteSchema, IterationSchema, NodeDetailSchema, OccurrenceDetailSchema, PlanAttemptSchema, PlanCommandReceiptSchema, PlanComparisonSchema, PlanDetailSchema, PlanDispatchRequestSchema, PlanEntrySchema, PlanIssueSchema, PlanStartRequestSchema, PlanSummarySchema, ProcessSchema, ReviewReadingSchema, RunDetailSchema, RunSummarySchema, SummarySchema, VersionDetailSchema, VersionSummarySchema, listSchema, type AssetSummaryDto, type AvailabilityDto, type BusinessCommandReceiptDto, type BusinessFormDto, type BusinessPreparationDto, type ComparisonSubjectDto, type CursorList, type EntryActionsDto, type HandlingNoteDto, type HandlingNoteRequestDto, type PlanCommandReceiptDto, type ReviewDto} from './contracts.js';
import {assetDto, caseDto, cleanConfig, nodeDto, occurrenceDto, runDto, versionDto} from './read-model.js';
import {ScopedReadCache} from './read-cache.js';

type NarrowService=Pick<WorkflowSpaceService,'spaceSummary'|'readRun'|'readWorkflowVersion'|'readCase'|'readReview'|'caseRunsPage'|'versionRunStats'|'versionIterationsPage'|'readAssetsByIds'|'runAssets'|'assetConsumerRuns'|'reviewsForAsset'|'getExecutionTask'>;
type Service=Pick<WorkflowSpaceService,'listSpaces'|'overview'|'readAsset'|'readContext'|'process'|'validationPlans'|'validationPlan'|'validationSummary'|'executionTasks'|'readManifest'|'resolvePresentation'> & Partial<NarrowService>;
export interface SpaceApiHost {
  principal?:{id:string;kind:'human'|'service'};
  /** Changes on login, logout, or authorization change. Bound into every cursor. */
  cacheScope?:string;
  /** Time zone used only for human-facing saved timestamps; defaults explicitly to UTC. */
  displayTimeZone?:string;
  service:Service;
  readers?:Record<string,AssetReader>;
  /** Optional display order for frozen manifest slots; unknown slots retain saved order. */
  inputSlotOrder?:string[];
  /** Trusted host projection of the exact frozen inputs; never sourced from browser fields. */
  inputSummary?:(input:{assets:Array<{slot:string;asset:AssetVersion}>})=>string[];
  adapter?:BusinessPresentationAdapter;
  /** Optional bounded status projection for a single exact run; no all-history parsing. */
  runSummary?:(input:{spaceId:string;run:SpaceRun;version:WorkflowVersion;case:SpaceCase})=>Promise<BusinessRunResolution>;
  /** Trusted domain association for imported records; validated against saved Space objects before display. */
  importedAssetScope?:(input:{spaceId:string;asset:AssetVersion})=>Promise<{caseId:string;runId:string|null;versionId:string|null}|null>;
  scope:{workflowId:string;entrypoint:string;adoptionSlot?:string};
  availability?:(versionId:string)=>AvailabilityDto;
  /** Same-origin, session-bound command security supplied by the authenticated host. */
  commandSecurity?:{origin:string;csrfToken:string;verifyCsrf:(request:IncomingMessage,principal:NonNullable<SpaceApiHost['principal']>)=>boolean|Promise<boolean>};
  /** Narrow commands own fresh preflight, idempotency, and target-only queue dispatch. */
  commands?:{
    entryActions:(input:{spaceId:string;planId:string;entryId:string;attempt:number})=>Promise<EntryActionsDto>;
    startPlanEntry:(input:{spaceId:string;planId:string;entryId:string;attempt:number;inputManifestId:string})=>Promise<PlanCommandReceiptDto>;
    dispatchRun:(input:{spaceId:string;planId:string;entryId:string;attempt:number;runId:string})=>Promise<PlanCommandReceiptDto>;
  };
  /** Ordinary business operations supplied by the authenticated domain host. */
  business?:{
    form:(input:{spaceId:string})=>Promise<BusinessFormDto>;
    prepare:(input:{spaceId:string;key:string;versionId:string;values:Record<string,unknown>})=>Promise<BusinessPreparationDto>;
    preparation:(input:{spaceId:string;caseId:string})=>Promise<BusinessPreparationDto|null>;
    start:(input:{spaceId:string;caseId:string;versionId:string;inputManifestId:string;key:string})=>Promise<BusinessCommandReceiptDto>;
    dispatch:(input:{spaceId:string;caseId:string;runId:string;versionId:string;inputManifestId:string})=>Promise<BusinessCommandReceiptDto>;
    handlingNotes:(input:{spaceId:string;caseId:string;runId:string;assetId:string;limit:101})=>Promise<HandlingNoteDto[]>;
    readHandlingNote:(input:{spaceId:string;caseId:string;runId:string;assetId:string;noteId:string})=>Promise<HandlingNoteDto|null>;
    addHandlingNote:(input:{spaceId:string;caseId:string;runId:string;assetId:string;input:HandlingNoteRequestDto;importedBy:string})=>Promise<HandlingNoteDto>;
  };
}
export interface SpaceApiOptions {
  resolveHost:(input:{request:IncomingMessage;spaceId:string})=>SpaceApiHost|null|Promise<SpaceApiHost|null>;
  cursorSecret:string|Uint8Array;
  now?:()=>Date;
}
type Code='UNAUTHENTICATED'|'FORBIDDEN'|'NOT_FOUND'|'RELATION_MISMATCH'|'INVALID_REQUEST'|'INVALID_CURSOR'|'METHOD_NOT_ALLOWED'|'SERVICE_FAILURE'|'HISTORY_UNAVAILABLE'|'EXECUTION_DISABLED'|'CONFLICT'|'UNAVAILABLE'|'BASELINE_REQUIRED';
class ApiFailure extends Error {constructor(readonly status:number,readonly code:Code,message:string){super(message);}}
function reject(status:number,code:Code,message:string):never {throw new ApiFailure(status,code,message);}
function required(value:string|undefined,label:string):string {if(!value||value.length>240||/[\u0000-\u001f]/u.test(value))reject(400,'INVALID_REQUEST',`Invalid ${label}`);return value;}
function decode(value:string,label:string):string {try{return required(decodeURIComponent(value),label);}catch(error){if(error instanceof ApiFailure)throw error;return reject(400,'INVALID_REQUEST',`Invalid ${label}`);}}
function exact(value:boolean):void {if(!value)reject(409,'RELATION_MISMATCH','The selected objects do not have the required exact relationship');}
const base=(spaceId:string)=>`/api/workflow-spaces/v1/spaces/${encodeURIComponent(spaceId)}`;
const safeId=(value:string)=>encodeURIComponent(value);
class RequestTiming {
  private readonly started=process.hrtime.bigint();
  private readonly stages=new Map<string,number>();
  private hits=0;private misses=0;
  async measure<T>(name:'host'|'membership'|'overview'|'subject'|'process'|'projection'|'preflight'|'command'|'receipt',work:()=>Promise<T>):Promise<T>{
    const start=process.hrtime.bigint();
    try{return await work();}finally{this.stages.set(name,(this.stages.get(name)??0)+Number(process.hrtime.bigint()-start)/1e6);}
  }
  cache(hit:boolean):void{if(hit)this.hits++;else this.misses++;}
  header():string{return [...this.stages].map(([name,duration])=>`${name};dur=${duration.toFixed(1)}`).concat(`cache;desc="hit=${this.hits} miss=${this.misses}"`,`total;dur=${(Number(process.hrtime.bigint()-this.started)/1e6).toFixed(1)}`).join(', ');}
}
const responseTimings=new WeakMap<ServerResponse,RequestTiming>();

function codec(secret:string|Uint8Array){
  const mac=(raw:string)=>createHmac('sha256',secret).update(raw).digest('base64url');
  return {
    encode:(value:unknown)=>{const raw=Buffer.from(JSON.stringify(value)).toString('base64url');return `${raw}.${mac(raw)}`;},
    decode:(cursor:string):Record<string,unknown>=>{
      const [raw,signature,...extra]=cursor.split('.');
      if(!raw||!signature||extra.length||cursor.length>4096)reject(400,'INVALID_CURSOR','Invalid cursor');
      const left=Buffer.from(mac(raw)),right=Buffer.from(signature);
      if(left.length!==right.length||!timingSafeEqual(left,right))reject(400,'INVALID_CURSOR','Invalid cursor');
      try {const value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value as Record<string,unknown>;}catch{return reject(400,'INVALID_CURSOR','Invalid cursor');}
    }
  };
}
function pageRequest(url:URL,scope:{spaceId:string;cacheScope:string;route:string;filter:string},signer:ReturnType<typeof codec>):{limit:number;after?:string}{
  const limitText=url.searchParams.get('limit');const limit=limitText===null?30:Number(limitText);
  if(!Number.isInteger(limit)||limit<1||limit>100)reject(400,'INVALID_REQUEST','Limit must be between 1 and 100');
  let after:string|undefined;
  const cursor=url.searchParams.get('cursor');
  if(cursor){const value=signer.decode(cursor);if(value.v!==1||value.spaceId!==scope.spaceId||value.cacheScope!==scope.cacheScope||value.route!==scope.route||value.filter!==scope.filter||typeof value.after!=='string')reject(400,'INVALID_CURSOR','Cursor scope or filter changed');after=value.after;}
  return {limit,...(after===undefined?{}:{after})};
}
function paged<T>(values:T[],url:URL,key:(value:T)=>string,scope:{spaceId:string;cacheScope:string;route:string;filter:string},signer:ReturnType<typeof codec>,now:()=>Date):CursorList<T>{
  const {limit,after}=pageRequest(url,scope,signer);
  const ordered=[...values].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
  const remaining=after===undefined?ordered:ordered.filter(value=>key(value)>after);
  const items=remaining.slice(0,limit);
  return {items,nextCursor:remaining.length>limit?signer.encode({v:1,...scope,after:key(items[items.length-1]!)}):null,snapshotAt:now().toISOString()};
}
function respond(response:ServerResponse,status:number,body:unknown,head:boolean,type='application/json; charset=utf-8'){
  const text=type.startsWith('application/json')?JSON.stringify(body):String(body);
  const timing=responseTimings.get(response);if(timing)response.setHeader('server-timing',timing.header());
  if(type.startsWith('text/html'))response.setHeader('content-security-policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts allow-downloads");
  response.writeHead(status,{'content-type':type,'cache-control':'private, no-store','content-length':Buffer.byteLength(text),'x-content-type-options':'nosniff'});
  response.end(head?undefined:text);
}
function find<T>(values:T[],predicate:(value:T)=>boolean):T {return values.find(predicate)??reject(404,'NOT_FOUND','Object not found in authorized Space');}
function version(data:SpaceOverview,id:string){return find(data.workflows,item=>item.id===id);}
function run(data:SpaceOverview,id:string){return find(data.runs,item=>item.runId===id);}
function asset(data:SpaceOverview,id:string){return find(data.assets,item=>item.id===id);}
function entry(version:SpaceOverview['workflows'][number],name:string){return version.entrypoints[name]??reject(404,'NOT_FOUND','Entrypoint absent from exact method version');}
function planIds(plans:Awaited<ReturnType<Service['validationPlans']>>,versionId:string){return plans.filter(value=>value.baseline.workflowVersionId===versionId||value.candidate.workflowVersionId===versionId).map(value=>value.id);}
function reviewDto(value:SpaceOverview['reviews'][number]):ReviewDto{return {id:value.id,runId:value.runId,assetIds:value.assetVersionIds,createdAt:value.createdAt,judge:{kind:value.judge.kind,id:value.judge.id},standard:{id:value.standard.id,revision:value.standard.revision},answers:value.answers,baselineReviewId:value.baselineReviewId??null};}
async function jsonBody(request:IncomingMessage,maxBytes=4096):Promise<unknown>{
  if(request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')reject(400,'INVALID_REQUEST','JSON body required');
  let size=0;const parts:Buffer[]=[];
  for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)reject(413,'INVALID_REQUEST','Request body too large');parts.push(bytes);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return reject(400,'INVALID_REQUEST','Invalid JSON body');}
}
function commandRoute(segment:string[]):'start'|'dispatch'|null{
  if(segment[0]!=='validation-plans'||!segment[1]||segment[2]!=='entries'||!segment[3]||segment[4]!=='attempts'||!segment[5])return null;
  if(segment.length===7&&segment[6]==='start')return 'start';
  if(segment.length===9&&segment[6]==='runs'&&segment[7]&&segment[8]==='dispatch')return 'dispatch';
  return null;
}
function businessWriteRoute(segment:string[]):'prepare'|'start'|'dispatch'|'note'|null{
  if(segment.length===2&&segment[0]==='business'&&segment[1]==='preparations')return 'prepare';
  if(segment.length===3&&segment[0]==='cases'&&segment[1]&&segment[2]==='runs')return 'start';
  if(segment.length===5&&segment[0]==='cases'&&segment[1]&&segment[2]==='runs'&&segment[3]&&segment[4]==='dispatch')return 'dispatch';
  if(segment.length===5&&segment[0]==='runs'&&segment[1]&&segment[2]==='assets'&&segment[3]&&segment[4]==='handling-notes')return 'note';
  return null;
}
const safeDifferenceKeys=new Set(['workflowVersion','model','reasoningEffort','temperature','maxOutputTokens','webResearch','maxRevisions','executionMode','profileHash']);
function safeDifferences(value:Record<string,{baseline?:unknown;candidate?:unknown;expected?:unknown;observed?:unknown}>):Record<string,Record<string,unknown>>{
  return Object.fromEntries(Object.entries(value).filter(([key])=>safeDifferenceKeys.has(key)).map(([key,pair])=>[key,Object.fromEntries(Object.entries(pair).map(([side,item])=>[side,item&&typeof item==='object'?cleanConfig(item):typeof item==='string'?item.slice(0,240):item]))]));
}
function reuseService(base:Service,cache:ScopedReadCache,scope:string,timing?:RequestTiming):Service{
  const read=<T>(key:string,ttl:number|((value:T)=>number),load:()=>Promise<T>)=>cache.get(scope,key,ttl,load,hit=>timing?.cache(hit));
  return {
    listSpaces:()=>base.listSpaces(),
    overview:spaceId=>read(`overview:${spaceId}`,4_000,()=>base.overview(spaceId)),
    ...(base.spaceSummary?{spaceSummary:(spaceId,methodScope)=>read(`spaceSummary:${spaceId}:${JSON.stringify(methodScope)}`,3_000,()=>base.spaceSummary!(spaceId,methodScope))}:{}),
    readAsset:(spaceId,id)=>read(`asset:${spaceId}:${id}`,5_000,()=>base.readAsset(spaceId,id)),
    readContext:(spaceId,id)=>read(`context:${spaceId}:${id}`,5_000,()=>base.readContext(spaceId,id)),
    process:(spaceId,runId)=>read(`process:${spaceId}:${runId}`,value=>value.terminal?30_000:3_000,async()=>{
      const [view,task]=await Promise.all([base.process(spaceId,runId),base.getExecutionTask?base.getExecutionTask(spaceId,runId):base.executionTasks(spaceId).then(tasks=>tasks.find(item=>item.runId===runId))]);
      return {view,terminal:!!task&&['completed','failed','canceled'].includes(task.status)};
    }).then(value=>value.view),
    validationPlans:spaceId=>read(`validationPlans:${spaceId}`,4_000,()=>base.validationPlans(spaceId)),
    validationPlan:(spaceId,id)=>read(`validationPlan:${spaceId}:${id}`,5_000,()=>base.validationPlan(spaceId,id)),
    validationSummary:(spaceId,id)=>read(`validationSummary:${spaceId}:${id}`,3_000,()=>base.validationSummary(spaceId,id)),
    executionTasks:spaceId=>read(`executionTasks:${spaceId}`,2_000,()=>base.executionTasks(spaceId)),
    readManifest:(spaceId,id)=>read(`manifest:${spaceId}:${id}`,5_000,()=>base.readManifest(spaceId,id)),
    resolvePresentation:(spaceId,versionId,entrypoint)=>read(`presentation:${spaceId}:${versionId}:${entrypoint}`,5_000,()=>base.resolvePresentation(spaceId,versionId,entrypoint)),
    ...(base.readRun?{readRun:(spaceId,runId)=>read(`run:${spaceId}:${runId}`,3_000,()=>base.readRun!(spaceId,runId))}:{}),
    ...(base.readWorkflowVersion?{readWorkflowVersion:(spaceId,id)=>read(`workflow:${spaceId}:${id}`,5_000,()=>base.readWorkflowVersion!(spaceId,id))}:{}),
    ...(base.readCase?{readCase:(spaceId,id)=>read(`case:${spaceId}:${id}`,5_000,()=>base.readCase!(spaceId,id))}:{}),
    ...(base.readReview?{readReview:(spaceId,id)=>read(`review:${spaceId}:${id}`,5_000,()=>base.readReview!(spaceId,id))}:{}),
    ...(base.caseRunsPage?{caseRunsPage:(spaceId,caseId,workflowId,entrypoint,after,limit)=>read(`caseRuns:${spaceId}:${caseId}:${workflowId}:${entrypoint}:${after??''}:${limit}`,2_000,()=>base.caseRunsPage!(spaceId,caseId,workflowId,entrypoint,after,limit))}:{}),
    ...(base.versionRunStats?{versionRunStats:(spaceId,versionId,entrypoint,workflowId)=>read(`versionStats:${spaceId}:${versionId}:${entrypoint}:${workflowId}`,3_000,()=>base.versionRunStats!(spaceId,versionId,entrypoint,workflowId))}:{}),
    ...(base.versionIterationsPage?{versionIterationsPage:(spaceId,versionId,after,limit)=>read(`iterations:${spaceId}:${versionId}:${after??''}:${limit}`,5_000,()=>base.versionIterationsPage!(spaceId,versionId,after,limit))}:{}),
    ...(base.readAssetsByIds?{readAssetsByIds:(spaceId,ids)=>read(`assetSet:${spaceId}:${JSON.stringify(ids)}`,3_000,()=>base.readAssetsByIds!(spaceId,ids))}:{}),
    ...(base.runAssets?{runAssets:(spaceId,runId)=>read(`runAssets:${spaceId}:${runId}`,3_000,()=>base.runAssets!(spaceId,runId))}:{}),
    ...(base.assetConsumerRuns?{assetConsumerRuns:(spaceId,id)=>read(`consumerRuns:${spaceId}:${id}`,3_000,()=>base.assetConsumerRuns!(spaceId,id))}:{}),
    ...(base.reviewsForAsset?{reviewsForAsset:(spaceId,id)=>read(`assetReviews:${spaceId}:${id}`,3_000,()=>base.reviewsForAsset!(spaceId,id))}:{}),
    ...(base.getExecutionTask?{getExecutionTask:(spaceId,runId)=>read(`task:${spaceId}:${runId}`,2_000,()=>base.getExecutionTask!(spaceId,runId))}:{})
  };
}
function reuseAdapter(base:BusinessPresentationAdapter|undefined,cache:ScopedReadCache,scope:string):BusinessPresentationAdapter|undefined{
  if(!base)return undefined;
  return {
    resolveRun:input=>cache.get(scope,`adapterRun:${input.run.runId}`,3_000,()=>base.resolveRun(input)),
    ...(base.resolveSources?{resolveSources:input=>cache.get(scope,`adapterSources:${input.asset.id}`,5_000,()=>base.resolveSources!(input))}:{})
  };
}
export function bridgeWorkflowDiagram(html:string,nodeIds:string[]):string{
  const list=JSON.stringify(nodeIds).replace(/</g,'\\u003c');
  const script=`<script>(function(){var ids=new Set(${list});window.addEventListener('message',function(event){if(event.source!==window.parent||!event.data||event.data.type!=='space-node-focus'||typeof event.data.nodeId!=='string'||!ids.has(event.data.nodeId))return;window.__spaceFocusNode=event.data.nodeId;if(window.Archify&&Archify.focus&&typeof Archify.focus.set==='function')Archify.focus.set(event.data.nodeId,{toggle:false});setTimeout(function(){window.__spaceFocusNode=null},0);});})();</script>`;
  // The pinned renderer emits this message both for a click and a focus mutation.
  // Suppress only the immediate programmatic focus echo; later human selections still emit.
  const bridged=html.replaceAll("window.parent.postMessage({type:'workflow-node-select',nodeId:id}, '*')", "if(window.__spaceFocusNode!==id)window.parent.postMessage({type:'workflow-node-select',nodeId:id}, '*')");
  const css=`<style id="space-viewer-adapter">.focus-chip,.node-outline,.semantic-lens,.diagram-guide{display:none!important}html[data-present="true"] body{padding:8px!important;overflow:hidden}html[data-present="true"] .container{height:calc(100dvh - 16px)!important;max-width:none!important;gap:8px!important}html[data-present="true"] .header{display:none!important}html[data-present="true"] .workflow-legend{flex:none;margin:0;font-size:11px;padding:8px}html[data-present="true"] .diagram-container{flex:1!important;min-height:0!important;margin:0!important;padding:12px 12px 52px!important}html[data-present="true"] .diagram-container>svg{height:100%!important;min-height:0!important;min-width:0!important;width:100%!important}.toolbar{display:none!important}@media(max-width:600px){.workflow-legend{font-size:10px!important;padding:5px!important;gap:4px!important}}</style>`;
  return bridged.replace('<html ','<html data-present="true" ').replace('</head>',`${css}</head>`).replace('</body>',`${script}</body>`);
}

/** Authenticated reads and explicitly scoped plan commands. Returns false outside the shared Space API. */
export function createWorkflowSpaceApiHandler(options:SpaceApiOptions){
  if(Buffer.byteLength(options.cursorSecret)<32)throw new Error('cursorSecret requires at least 32 bytes');
  const signer=codec(options.cursorSecret),now=options.now??(()=>new Date());
  const cache=new ScopedReadCache(()=>now().getTime());
  return async(request:IncomingMessage,response:ServerResponse):Promise<boolean>=>{
    const url=new URL(request.url??'/',`http://${request.headers.host??'localhost'}`);
    const path=url.pathname.split('/').filter(Boolean);
    if(path[0]!=='api'||path[1]!=='workflow-spaces'||path[2]!=='v1'||path[3]!=='spaces'||!path[4])return false;
    const head=request.method==='HEAD',requestId=randomUUID(),timing=new RequestTiming();
    response.setHeader('x-request-id',requestId);responseTimings.set(response,timing);
    try{
      const segment=path.slice(5).map(value=>decode(value,'path segment'));
      const command=request.method==='POST'?commandRoute(segment):null;
      const businessWrite=request.method==='POST'?businessWriteRoute(segment):null;
      if(request.method!=='GET'&&!head&&!command&&!businessWrite){response.setHeader('allow','GET, HEAD');reject(405,'METHOD_NOT_ALLOWED','Read-only endpoint');}
      const spaceId=decode(path[4],'space ID');
      const host=await timing.measure('host',()=>Promise.resolve(options.resolveHost({request,spaceId})));
      if(!host?.principal?.id||!host.cacheScope)reject(401,'UNAUTHENTICATED','Authentication required');
      const scopeKey=ScopedReadCache.scopeKey({principal:host.principal,cacheScope:host.cacheScope,spaceId,workflowId:host.scope.workflowId,entrypoint:host.scope.entrypoint,adoptionSlot:host.scope.adoptionSlot});
      let memberships:Awaited<ReturnType<Service['listSpaces']>>;
      try{memberships=await timing.measure('membership',()=>host.service.listSpaces());}catch(error){cache.clearScope(scopeKey);throw error;}
      if(!memberships.some(space=>space.id===spaceId)){cache.clearScope(scopeKey);reject(403,'FORBIDDEN','Space access denied');}
      const secureWrite=async()=>{
        if(!host.commandSecurity)reject(405,'METHOD_NOT_ALLOWED','Read-only endpoint');
        const security=host.commandSecurity;
        if(request.headers.origin!==security.origin||!security.origin||request.headers['x-space-csrf']!==security.csrfToken||!security.csrfToken||!await security.verifyCsrf(request,host.principal!))reject(403,'FORBIDDEN','Same-origin session verification failed');
      };
      const exactVersion=async(versionId:string)=>{
        const version=host.service.readWorkflowVersion?await host.service.readWorkflowVersion(spaceId,versionId):find((await host.service.overview(spaceId)).workflows,value=>value.id===versionId);
        exact(version.id===versionId&&version.spaceId===spaceId&&version.entrypoints[host.scope.entrypoint]?.workflowId===host.scope.workflowId);
        return version;
      };
      const exactCase=async(caseId:string)=>{
        const value=host.service.readCase?await host.service.readCase(spaceId,caseId):find((await host.service.overview(spaceId)).cases,item=>item.id===caseId);
        exact(value.id===caseId&&value.spaceId===spaceId);return value;
      };
      const businessRun=async(runId:string)=>{
        const run=host.service.readRun?await host.service.readRun(spaceId,runId):find((await host.service.overview(spaceId)).runs,item=>item.runId===runId);
        exact(run.runId===runId&&run.spaceId===spaceId&&run.entrypoint===host.scope.entrypoint);
        await exactVersion(run.workflowVersionId);return run;
      };
      const checkPreparation=async(value:BusinessPreparationDto,caseId?:string,versionId?:string)=>{
        exact(!caseId||value.caseId===caseId);exact(!versionId||value.versionId===versionId);
        const [selected,manifest]=await Promise.all([exactCase(value.caseId),host.service.readManifest(spaceId,value.inputManifestId),exactVersion(value.versionId)]);
        exact(selected.id===value.caseId&&selected.title===value.caseTitle&&selected.objective===value.objective);
        exact(manifest.spaceId===spaceId&&manifest.caseId===value.caseId&&manifest.hash===value.inputManifestHash);
        const expectedIds=new Set(Object.values(manifest.assets));
        const actualIds=new Set(value.inputs.map(input=>input.id));
        exact(actualIds.size===value.inputs.length&&actualIds.size===expectedIds.size&&[...actualIds].every(id=>expectedIds.has(id)));
        const actualAssets=await Promise.all([...actualIds].map(id=>host.service.readAsset(spaceId,id)));
        const byId=new Map(actualAssets.map(asset=>[asset.id,asset]));
        for(const item of value.inputs){
          const actual=byId.get(item.id);
          exact(!!actual&&actual.spaceId===spaceId&&item.schema.namespace===actual.schema.namespace&&item.schema.revision===actual.schema.revision&&item.schema.hash===actual.schema.hash&&item.payloadHash===actual.payloadHash&&item.sourceKind===actual.source.kind);
        }
        exact(value.runs.length<=100&&value.runs.every(run=>run.caseId===value.caseId&&run.versionId===value.versionId));
        return value;
      };
      if(businessWrite){
        if(!host.business)reject(405,'METHOD_NOT_ALLOWED','Business commands unavailable');
        await secureWrite();
        if(businessWrite==='prepare'){
          const parsed=BusinessPrepareRequestSchema.safeParse(await jsonBody(request,131072));
          if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid business preparation request');
          await exactVersion(parsed.data.versionId);
          let prepared:BusinessPreparationDto;
          try{prepared=await timing.measure('command',()=>host.business!.prepare({spaceId,...parsed.data}));}finally{cache.clearScope(scopeKey);}
          respond(response,200,BusinessPreparationSchema.parse(await checkPreparation(prepared,undefined,parsed.data.versionId)),false);return true;
        }
        if(businessWrite==='note'){
          const runId=required(segment[1],'run ID'),assetId=required(segment[3],'asset ID');
          const run=await businessRun(runId);
          const asset=await host.service.readAsset(spaceId,assetId);
          exact(asset.spaceId===spaceId&&asset.source.kind==='node'&&asset.source.runId===runId);
          const parsed=HandlingNoteRequestSchema.safeParse(await jsonBody(request,32768));
          if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid handling note request');
          let note:HandlingNoteDto;
          try{note=await timing.measure('command',()=>host.business!.addHandlingNote({spaceId,caseId:run.caseId,runId,assetId,input:parsed.data,importedBy:host.principal!.id}));}finally{cache.clearScope(scopeKey);}
          exact(note.caseId===run.caseId&&note.runId===runId&&note.subjectAssetId===assetId&&note.importedBy===host.principal.id&&note.verification==='declared-external');
          const saved=await timing.measure('receipt',()=>host.business!.readHandlingNote({spaceId,caseId:run.caseId,runId,assetId,noteId:note.id}));
          exact(!!saved&&saved.id===note.id&&saved.caseId===run.caseId&&saved.runId===runId&&saved.subjectAssetId===assetId&&saved.importedBy===host.principal.id&&saved.verification==='declared-external');
          exact(isDeepStrictEqual(HandlingNoteSchema.parse(saved),HandlingNoteSchema.parse(note)));
          respond(response,200,HandlingNoteSchema.parse(saved),false);return true;
        }
        const caseId=required(segment[1],'case ID');
        await exactCase(caseId);
        const parsed=businessWrite==='start'?BusinessStartRequestSchema.safeParse(await jsonBody(request)):BusinessDispatchRequestSchema.safeParse(await jsonBody(request));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid business run request');
        const {versionId,inputManifestId}=parsed.data;
        const manifest=await host.service.readManifest(spaceId,inputManifestId);
        exact(manifest.id===inputManifestId&&manifest.spaceId===spaceId&&manifest.caseId===caseId);
        await exactVersion(versionId);
        const runId=businessWrite==='dispatch'?required(segment[3],'run ID'):undefined;
        if(runId){const run=await businessRun(runId);exact(run.caseId===caseId&&run.workflowVersionId===versionId&&run.inputManifestId===inputManifestId);}
        if(businessWrite==='start'&&host.availability?.(versionId).state!=='available')reject(409,'UNAVAILABLE','Exact method executor is unavailable');
        let receipt:BusinessCommandReceiptDto;
        try{receipt=await timing.measure('command',()=>businessWrite==='start'?host.business!.start({spaceId,caseId,versionId,inputManifestId,key:'key' in parsed.data?parsed.data.key as string:''}):host.business!.dispatch({spaceId,caseId,runId:runId!,versionId,inputManifestId}));}finally{cache.clearScope(scopeKey);}
        exact(receipt.caseId===caseId&&receipt.versionId===versionId&&receipt.inputManifestId===inputManifestId&&receipt.inputManifestHash===manifest.hash&&(!runId||receipt.runId===runId));
        const linked=await timing.measure('receipt',()=>businessRun(receipt.runId));
        exact(linked.caseId===caseId&&linked.workflowVersionId===versionId&&linked.inputManifestId===inputManifestId);
        respond(response,200,BusinessCommandReceiptSchema.parse(receipt),false);return true;
      }
      if(command){
        if(!host.commands||!host.commandSecurity){response.setHeader('allow','GET, HEAD');reject(405,'METHOD_NOT_ALLOWED','Read-only endpoint');}
        const security=host.commandSecurity;
        if(request.headers.origin!==security.origin||!security.origin||request.headers['x-space-csrf']!==security.csrfToken||!security.csrfToken||!await security.verifyCsrf(request,host.principal!))reject(403,'FORBIDDEN','Same-origin session verification failed');
        const planId=required(segment[1],'plan ID'),entryId=required(segment[3],'entry ID'),attempt=Number(segment[5]);
        if(!Number.isSafeInteger(attempt)||attempt<1)reject(400,'INVALID_REQUEST','Invalid attempt');
        const {selected,manifest}=await timing.measure('preflight',async()=>{
          const plan=await host.service.validationPlan(spaceId,planId);
          if(plan.status!=='frozen')reject(409,'CONFLICT','Validation plan is not frozen');
          const selected=find(plan.entries,value=>value.id===entryId);
          if(selected.excludedReason)reject(409,'CONFLICT','Validation entry is excluded');
          const manifest=await host.service.readManifest(spaceId,selected.inputManifestId);
          exact(manifest.id===selected.inputManifestId&&manifest.caseId===selected.caseId&&manifest.spaceId===spaceId);
          const method=host.service.readWorkflowVersion?await host.service.readWorkflowVersion(spaceId,selected.workflowVersionId):find((await host.service.overview(spaceId)).workflows,value=>value.id===selected.workflowVersionId);
          exact(method.spaceId===spaceId&&!!method.entrypoints[selected.entrypoint]&&method.entrypoints[selected.entrypoint]?.workflowId===host.scope.workflowId&&selected.entrypoint===host.scope.entrypoint);
          if(command==='start'&&host.availability?.(selected.workflowVersionId).state!=='available')reject(409,'UNAVAILABLE','Exact method executor is unavailable');
          return {selected,manifest};
        });
        let receipt:PlanCommandReceiptDto;
        if(command==='start'){
          const parsed=PlanStartRequestSchema.safeParse(await jsonBody(request));
          if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid start request');
          exact(parsed.data.inputManifestId===selected.inputManifestId);
          try{receipt=await timing.measure('command',()=>host.commands!.startPlanEntry({spaceId,planId,entryId,attempt,inputManifestId:parsed.data.inputManifestId}));}finally{cache.clearScope(scopeKey);}
        }else{
          const parsed=PlanDispatchRequestSchema.safeParse(await jsonBody(request));
          if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid dispatch request');
          const runId=required(segment[7],'run ID');
          const summary=await timing.measure('preflight',()=>host.service.validationSummary(spaceId,planId));
          exact(summary.entries.some(value=>value.entry.id===entryId&&value.attempts.some(value=>value.attempt===attempt&&value.runId===runId)));
          try{receipt=await timing.measure('command',()=>host.commands!.dispatchRun({spaceId,planId,entryId,attempt,runId}));}finally{cache.clearScope(scopeKey);}
        }
        exact(receipt.planId===planId&&receipt.entryId===entryId&&receipt.attempt===attempt&&receipt.caseId===selected.caseId&&receipt.versionId===selected.workflowVersionId&&receipt.inputManifestId===selected.inputManifestId&&receipt.inputManifestHash===manifest.hash&&(command!=='dispatch'||receipt.runId===segment[7]));
        const linked=await timing.measure('receipt',()=>host.service.validationSummary(spaceId,planId));
        exact(linked.entries.some(value=>value.entry.id===entryId&&value.attempts.some(value=>value.attempt===attempt&&value.runId===receipt.runId)));
        respond(response,200,PlanCommandReceiptSchema.parse(receipt),false);
        return true;
      }
      const authenticated={...host,service:reuseService(host.service,cache,scopeKey,timing),adapter:reuseAdapter(host.adapter,cache,scopeKey)};
      if(segment[0]==='business'&&segment[1]==='form'&&segment.length===2){
        if(!host.business)reject(404,'NOT_FOUND','Business form unavailable');
        respond(response,200,BusinessFormSchema.parse(await host.business.form({spaceId})),head);return true;
      }
      if(segment[0]==='cases'&&segment[1]&&segment[2]==='preparation'&&segment.length===3){
        if(!host.business)reject(404,'NOT_FOUND','Business preparation unavailable');
        const caseId=required(segment[1],'case ID');await exactCase(caseId);
        const prepared=await host.business.preparation({spaceId,caseId});
        if(!prepared)reject(404,'NOT_FOUND','Business preparation unavailable');
        respond(response,200,BusinessPreparationSchema.parse(await checkPreparation(prepared,caseId)),head);return true;
      }
      if(segment[0]==='runs'&&segment[1]&&segment[2]==='assets'&&segment[3]&&segment[4]==='handling-notes'&&segment.length===5){
        if(!host.business)reject(404,'NOT_FOUND','Handling notes unavailable');
        const runId=required(segment[1],'run ID'),assetId=required(segment[3],'asset ID');
        const run=await businessRun(runId);
        const asset=await authenticated.service.readAsset(spaceId,assetId);
        exact(asset.spaceId===spaceId&&asset.source.kind==='node'&&asset.source.runId===runId);
        const notes=await host.business.handlingNotes({spaceId,caseId:run.caseId,runId,assetId,limit:101});
        exact(notes.length<=101&&notes.every(note=>note.caseId===run.caseId&&note.runId===runId&&note.subjectAssetId===assetId&&note.verification==='declared-external'));
        respond(response,200,HandlingNoteListSchema.parse({items:notes.slice(0,100),truncated:notes.length>100,nextCursor:null,snapshotAt:now().toISOString()}),head);return true;
      }
      if(segment[0]==='summary'&&segment.length===1&&authenticated.service.spaceSummary){
        const snapshot=await timing.measure('subject',()=>authenticated.service.spaceSummary!(spaceId,host.scope));
        exact(snapshot.space.id===spaceId);
        respond(response,200,SummarySchema.parse({id:spaceId,title:snapshot.space.purpose,purpose:snapshot.space.purpose,
          subject:{id:authenticated.principal!.id,cacheScope:authenticated.cacheScope},
          methodScope:{workflowId:host.scope.workflowId,entrypoint:host.scope.entrypoint,adoptionSlot:host.scope.adoptionSlot??null},
          adoptedVersionId:snapshot.adoptedVersionId,latestVersionId:snapshot.latestVersionId,
          counts:{versions:snapshot.versionCount,cases:snapshot.caseCount,runs:snapshot.runCount,assets:snapshot.assetCount},
          capabilities:{read:true,write:!!((authenticated.commands||authenticated.business)&&authenticated.commandSecurity)},
          csrfToken:(authenticated.commands||authenticated.business)&&authenticated.commandSecurity?authenticated.commandSecurity.csrfToken:null,
          snapshotAt:now().toISOString()}),head);return true;
      }
      const getRun=async(id:string)=>authenticated.service.readRun?authenticated.service.readRun(spaceId,id):find((await authenticated.service.overview(spaceId)).runs,value=>value.runId===id);
      const getVersion=async(id:string)=>authenticated.service.readWorkflowVersion?authenticated.service.readWorkflowVersion(spaceId,id):find((await authenticated.service.overview(spaceId)).workflows,value=>value.id===id);
      const getCase=async(id:string)=>authenticated.service.readCase?authenticated.service.readCase(spaceId,id):find((await authenticated.service.overview(spaceId)).cases,value=>value.id===id);
      const reviewedAsset=async(run:SpaceRun,value:AssetVersion)=>{
        const [view,presentation]=await Promise.all([authenticated.service.process(spaceId,run.runId),authenticated.service.resolvePresentation(spaceId,run.workflowVersionId,run.entrypoint)]);
        exact(view.run.runId===run.runId);
        const matches=view.occurrences.filter(occurrence=>occurrence.outputBindings.some(binding=>binding.assetVersionId===value.id));
        if(matches.length>1)exact(false);
        const payload=value.payload as {title?:unknown}|null;
        const title=typeof payload?.title==='string'&&payload.title.trim()?undefined:presentation?.presentation.assetViews.find(item=>item.schema.namespace===value.schema.namespace&&item.schema.revision===value.schema.revision&&item.schema.hash===value.schema.hash)?.label;
        return assetDto({runs:[run]},value,title,matches[0]);
      };
      if(segment[0]==='reviews'&&segment.length===2){
        const review=authenticated.service.readReview?await authenticated.service.readReview(spaceId,segment[1]!):find((await authenticated.service.overview(spaceId)).reviews,value=>value.id===segment[1]);
        exact(review.spaceId===spaceId);
        const run=await getRun(review.runId);exact(run.spaceId===spaceId);
        const method=await getVersion(run.workflowVersionId);exact(run.entrypoint===host.scope.entrypoint&&method.spaceId===spaceId&&method.entrypoints[run.entrypoint]?.workflowId===host.scope.workflowId);
        const assets=await Promise.all(review.assetVersionIds.map(id=>authenticated.service.readAsset(spaceId,id)));
        for(const asset of assets)exact(asset.spaceId===spaceId&&asset.source.kind==='node'&&asset.source.runId===run.runId);
        respond(response,200,ReviewReadingSchema.parse({review:reviewDto(review),assets:await Promise.all(assets.map(asset=>reviewedAsset(run,asset)))}),head);return true;
      }
      if(segment[0]==='validation-plans'&&segment[1]&&segment[2]==='comparisons'&&segment[3]&&segment[4]==='reading'&&segment.length===5){
        const planId=segment[1],comparisonId=segment[3],summary=await authenticated.service.validationSummary(spaceId,planId);
        exact(summary.plan.id===planId&&summary.plan.spaceId===spaceId);
        const comparisons=summary.comparisons.filter(value=>value.id===comparisonId);
        if(!comparisons.length)reject(404,'NOT_FOUND','Comparison not found in authorized plan');
        const comparison=comparisons[0]!;
        const unavailable=(reason:string)=>respond(response,200,ComparisonReadingSchema.parse({id:comparisonId,planId,status:'unavailable',reason,conclusion:comparison.conclusion,baseline:null,candidate:null}),head);
        if(comparisons.length!==1||comparison.comparison.baselineReviewId!==comparison.baselineReviewId||comparison.comparison.candidateReviewId!==comparison.candidateReviewId){unavailable('保存的比较身份不唯一或不完整');return true;}
        const pairs=summary.pairs.filter(value=>value.baselineEntryId===comparison.baselineEntryId&&value.candidateEntryId===comparison.candidateEntryId);
        if(pairs.length!==1){unavailable('保存的计划配对关系不唯一');return true;}
        const subject=async(side:'baseline'|'candidate',entryId:string,reviewId:string):Promise<ComparisonSubjectDto|null>=>{
          const rows=summary.entries.filter(value=>value.entry.id===entryId&&value.entry.side===side);
          if(rows.length!==1)return null;
          const row=rows[0]!,entry=row.entry;
          if(entry.caseId!==pairs[0]!.caseId||entry.repeat!==pairs[0]!.repeat||entry.entrypoint!==host.scope.entrypoint)return null;
          const matches=row.attempts.flatMap(attempt=>attempt.reviews.filter(review=>review.id===reviewId).map(review=>({attempt,review})));
          if(matches.length!==1)return null;
          const {attempt,review}=matches[0]!;
          if(review.spaceId!==spaceId||review.runId!==attempt.runId||review.assetVersionIds.length!==1||
            review.standard.id!==summary.plan.standard.id||review.standard.revision!==summary.plan.standard.revision||review.standard.content!==summary.plan.standard.content||
            !attempt.judgeEvidence.some(evidence=>evidence.reviewId===reviewId&&evidence.verified)||
            !['succeeded','needs_review'].includes(attempt.run?.state??'')||attempt.task&&attempt.task.status!=='completed')return null;
          const [run,version,caseValue,manifest,asset]=await Promise.all([getRun(attempt.runId),getVersion(entry.workflowVersionId),getCase(entry.caseId),authenticated.service.readManifest(spaceId,entry.inputManifestId),authenticated.service.readAsset(spaceId,review.assetVersionIds[0]!)]);
          if(run.spaceId!==spaceId||run.runId!==attempt.runId||run.workflowVersionId!==entry.workflowVersionId||run.entrypoint!==entry.entrypoint||run.caseId!==entry.caseId||run.inputManifestId!==entry.inputManifestId||
            version.spaceId!==spaceId||!version.entrypoints[entry.entrypoint]||version.entrypoints[entry.entrypoint]?.workflowId!==host.scope.workflowId||caseValue.spaceId!==spaceId||
            manifest.spaceId!==spaceId||manifest.id!==entry.inputManifestId||manifest.caseId!==entry.caseId||
            asset.spaceId!==spaceId||asset.id!==review.assetVersionIds[0]||asset.source.kind!=='node'||asset.source.runId!==run.runId)return null;
          return {side,entryId,attempt:attempt.attempt,runId:run.runId,versionId:version.id,versionLabel:`${version.revision} · ${version.createdAt.slice(0,10)} · ${version.id.slice(-8)}`,caseId:caseValue.id,caseTitle:caseValue.title,inputManifestId:manifest.id,inputManifestHash:manifest.hash,review:reviewDto(review),asset:await reviewedAsset(run,asset)};
        };
        let baseline:ComparisonSubjectDto|null,candidate:ComparisonSubjectDto|null;
        try{[baseline,candidate]=await Promise.all([subject('baseline',comparison.baselineEntryId,comparison.baselineReviewId),subject('candidate',comparison.candidateEntryId,comparison.candidateReviewId)]);}catch(error){
          if(error instanceof Error&&/Record not found in authorized space/u.test(error.message)){unavailable('保存的比较证据不完整');return true;}
          throw error;
        }
        if(!baseline||!candidate||baseline.caseId!==candidate.caseId||baseline.inputManifestId!==candidate.inputManifestId||baseline.inputManifestHash!==candidate.inputManifestHash){unavailable('两侧评价对象无法唯一核对');return true;}
        respond(response,200,ComparisonReadingSchema.parse({id:comparisonId,planId,status:'ready',reason:null,conclusion:comparison.conclusion,baseline,candidate}),head);return true;
      }
      const listScope=(route:string,filter='')=>({spaceId,cacheScope:authenticated.cacheScope!,route,filter});
      const available=(id:string)=>authenticated.availability?.(id)??{state:'unknown' as const,reason:null};
      const methodVersion=async(id:string)=>{
        const method=await getVersion(id);
        exact(method.spaceId===spaceId&&method.entrypoints[host.scope.entrypoint]?.workflowId===host.scope.workflowId);
        return method;
      };
      const exactRun=async(id:string)=>{
        const selected=await getRun(id);
        exact(selected.spaceId===spaceId&&selected.entrypoint===host.scope.entrypoint);
        const method=await methodVersion(selected.workflowVersionId);
        return {selected,method};
      };
      const importedScopes=new Map<string,Promise<{caseId:string;runId:string|null;versionId:string|null}|null>>();
      const importedScope=(asset:AssetVersion)=>{
        if(asset.source.kind!=='import'||!authenticated.importedAssetScope)return Promise.resolve(null);
        let pending=importedScopes.get(asset.id);
        if(!pending){pending=(async()=>{
          const declared=await authenticated.importedAssetScope!({spaceId,asset});
          if(!declared)return null;
          const caseValue=await getCase(declared.caseId);
          exact(caseValue.id===declared.caseId&&caseValue.spaceId===spaceId);
          if(declared.versionId){const method=await methodVersion(declared.versionId);exact(method.id===declared.versionId);}
          if(declared.runId){
            exact(!!declared.versionId);
            const {selected}=await exactRun(declared.runId);
            exact(selected.runId===declared.runId&&selected.caseId===declared.caseId&&selected.workflowVersionId===declared.versionId);
          }
          return declared;
        })();importedScopes.set(asset.id,pending);}
        return pending;
      };
      const scopedAsset=async(data:Pick<SpaceOverview,'runs'>,asset:AssetVersion&{state?:string},title?:string,occurrence?:Parameters<typeof assetDto>[3]):Promise<AssetSummaryDto>=>{
        const dto=assetDto(data,asset,title,occurrence);
        const association=await importedScope(asset);
        return association?{...dto,caseId:association.caseId,runId:association.runId,versionId:association.versionId,nodeId:null,occurrenceId:null,round:null}:dto;
      };
      const exactRunSummary=async(selected:SpaceRun,method:WorkflowVersion,caseValue:SpaceCase,assets:SpaceOverview['assets'])=>{
        const [task,resolved]=await Promise.all([
          authenticated.service.getExecutionTask?authenticated.service.getExecutionTask(spaceId,selected.runId):authenticated.service.executionTasks(spaceId).then(rows=>rows.find(row=>row.runId===selected.runId)),
          authenticated.runSummary?.({spaceId,run:selected,version:method,case:caseValue})
        ]);
        return runDto({assets},selected,task?{status:task.status,error:task.error,createdAt:task.createdAt}:undefined,resolved);
      };
      if(segment[0]==='versions'&&segment[1]&&authenticated.service.readWorkflowVersion){
        const selected=await timing.measure('subject',()=>methodVersion(segment[1]!));
        const selectedEntry=entry(selected,host.scope.entrypoint);
        if(segment[2]==='iterations'&&segment.length===3&&authenticated.service.versionIterationsPage){
          const page=pageRequest(url,listScope(`versions/${selected.id}/iterations`),signer);
          const rows=await authenticated.service.versionIterationsPage(spaceId,selected.id,page.after,page.limit+1);
          const items=rows.slice(0,page.limit);
          exact(items.every(value=>value.workflowVersionId===selected.id));
          respond(response,200,listSchema(IterationSchema).parse({items,nextCursor:rows.length>page.limit?signer.encode({v:1,...listScope(`versions/${selected.id}/iterations`),after:items.at(-1)!.id}):null,snapshotAt:now().toISOString()}),head);return true;
        }
        if((segment.length===2||segment[2]==='nodes'&&segment.length===4||segment[2]==='graph'&&segment.length===3)&&authenticated.service.versionRunStats){
          const presentation=await authenticated.service.resolvePresentation(spaceId,selected.id,host.scope.entrypoint);
          const labels=new Map(presentation?.presentation.stages?.map(stage=>[stage.id,stage.label])??[]);
          if(segment.length===2){
            const [stats,plans]=await Promise.all([authenticated.service.versionRunStats(spaceId,selected.id,host.scope.entrypoint,host.scope.workflowId),authenticated.service.validationPlans(spaceId)]);
            const value=versionDto({runs:[]},selected,host.scope.entrypoint,available(selected.id),planIds(plans,selected.id),stats,presentation?.presentation.label,host.displayTimeZone);
            respond(response,200,VersionDetailSchema.parse({...value,hash:selected.hash,purpose:presentation?.presentation.purpose??null,nodes:selectedEntry.process?.nodes.map(node=>nodeDto(selectedEntry,node,labels.get(node.id)))??[],graphUrl:selectedEntry.process?`${base(spaceId)}/versions/${safeId(selected.id)}/graph`:null}),head);return true;
          }
          if(segment[2]==='nodes'){
            const node=find(selectedEntry.process?.nodes??[],value=>value.id===segment[3]);const definition=selectedEntry.nodeDefinitions?.[node.id];
            respond(response,200,NodeDetailSchema.parse({...nodeDto(selectedEntry,node,labels.get(node.id)),versionId:selected.id,instructions:definition?.instructions??null,configuration:definition?.configuration?cleanConfig(definition.configuration):null}),head);return true;
          }
          if(!selectedEntry.process)reject(404,'HISTORY_UNAVAILABLE','Historical graph was not recorded');
          const html=await renderWorkflowDiagram({entry:selectedEntry,presentation:presentation?.presentation,detailBase:base(spaceId)});
          respond(response,200,bridgeWorkflowDiagram(html,selectedEntry.process.nodes.map(node=>node.id)),head,'text/html; charset=utf-8');return true;
        }
      }
      if(segment[0]==='cases'&&segment[1]&&segment[2]==='runs'&&segment.length===3&&authenticated.service.caseRunsPage&&authenticated.service.runAssets){
        const selectedCase=await timing.measure('subject',()=>getCase(segment[1]!));exact(selectedCase.spaceId===spaceId);
        const scope=listScope(`cases/${selectedCase.id}/runs`),page=pageRequest(url,scope,signer);
        const rows=await authenticated.service.caseRunsPage(spaceId,selectedCase.id,host.scope.workflowId,host.scope.entrypoint,page.after,page.limit+1);
        const selectedRows=rows.slice(0,page.limit);
        const items=await timing.measure('projection',()=>Promise.all(selectedRows.map(async selected=>{
          exact(selected.caseId===selectedCase.id&&selected.entrypoint===host.scope.entrypoint);
          const method=await methodVersion(selected.workflowVersionId);
          const assets=await authenticated.service.runAssets!(spaceId,selected.runId);
          return exactRunSummary(selected,method,selectedCase,assets);
        })));
        respond(response,200,listSchema(RunSummarySchema).parse({items,nextCursor:rows.length>page.limit?signer.encode({v:1,...scope,after:selectedRows.at(-1)!.runId}):null,snapshotAt:now().toISOString()}),head);return true;
      }
      if(segment[0]==='runs'&&segment[1]&&authenticated.service.readRun&&authenticated.service.readAssetsByIds&&authenticated.service.runAssets){
        const {selected,method}=await timing.measure('subject',()=>exactRun(segment[1]!));
        const caseValue=await getCase(selected.caseId);exact(caseValue.spaceId===spaceId);
        if(segment.length===2){
          const [manifest,assets]=await Promise.all([authenticated.service.readManifest(spaceId,selected.inputManifestId),authenticated.service.runAssets(spaceId,selected.runId)]);
          exact(manifest.spaceId===spaceId&&manifest.caseId===selected.caseId&&manifest.id===selected.inputManifestId);
          const inputAssets=await authenticated.service.readAssetsByIds(spaceId,Object.values(manifest.assets));
          const summary=await timing.measure('projection',()=>exactRunSummary(selected,method,caseValue,assets));
          respond(response,200,RunDetailSchema.parse({...summary,inputManifestId:manifest.id,inputManifestHash:manifest.hash,configHash:selected.configHash,inputAssets:await Promise.all(inputAssets.map(value=>scopedAsset({runs:[selected]},value))),versionLabel:method.revision,caseTitle:caseValue.title}),head);return true;
        }
        if((segment[2]==='process'&&segment.length===3)||(segment[2]==='graph'&&segment.length===3)||(segment[2]==='occurrences'&&segment.length===4)){
          const view=await timing.measure('process',()=>authenticated.service.process(spaceId,selected.runId));
          exact(view.run.spaceId===spaceId&&view.run.runId===selected.runId&&view.run.workflowVersionId===method.id&&view.run.caseId===caseValue.id&&view.run.entrypoint===selected.entrypoint&&view.run.inputManifestId===selected.inputManifestId);
          const selectedEntry=entry(method,selected.entrypoint);
          const presentation=await authenticated.service.resolvePresentation(spaceId,method.id,selected.entrypoint);
          const labels=new Map(presentation?.presentation.stages?.map(stage=>[stage.id,stage.label])??[]);
          if(segment[2]==='graph'){
            if(!view.contract)reject(404,'HISTORY_UNAVAILABLE','Run process graph unavailable');
            const html=await renderWorkflowDiagram({entry:{...selectedEntry,process:view.contract},presentation:presentation?.presentation,view,detailBase:base(spaceId)});
            respond(response,200,bridgeWorkflowDiagram(html,view.contract.nodes.map(node=>node.id)),head,'text/html; charset=utf-8');return true;
          }
          const occurrences=segment[2]==='occurrences'?[find(view.occurrences,value=>value.id===segment[3])]:view.occurrences;
          const ids=[...new Set(occurrences.flatMap(value=>[...value.inputBindings,...value.outputBindings].map(binding=>binding.assetVersionId)))];
          const assets=await authenticated.service.readAssetsByIds(spaceId,ids);
          const data={runs:[selected],assets};
          const titleForAsset=(value:typeof assets[number])=>{
            const saved=value.payload as {title?:unknown}|null;if(typeof saved?.title==='string'&&saved.title.trim())return undefined;
            return presentation?.presentation.assetViews.find(item=>item.schema.namespace===value.schema.namespace&&item.schema.revision===value.schema.revision&&item.schema.hash===value.schema.hash)?.label;
          };
          const occurrenceValue=(value:typeof view.occurrences[number])=>occurrenceDto(data,value,labels.get(value.nodeId??'')??value.nodeId??value.id,titleForAsset);
          if(segment[2]==='process'){
            const graphState=view.contract?buildWorkflowGraphState(view):null;if(graphState)exact(graphState.spaceId===spaceId&&graphState.runId===selected.runId&&graphState.versionId===method.id);
            respond(response,200,ProcessSchema.parse({runId:selected.runId,versionId:method.id,caseId:selected.caseId,contractSource:view.contractSource,coverage:view.coverage,unmappedStepIds:view.unmappedStepIds,nodes:(view.contract?.nodes??selectedEntry.process?.nodes??[]).map(node=>nodeDto(selectedEntry,node,labels.get(node.id))),occurrences:view.occurrences.map(occurrenceValue),graphUrl:view.contract?`${base(spaceId)}/runs/${safeId(selected.runId)}/graph`:null,graphState}),head);return true;
          }
          const occurrence=occurrences[0]!;const contexts=await Promise.all(occurrence.contextIds.map(id=>authenticated.service.readContext(spaceId,id)));
          for(const context of contexts)exact(context.runId===selected.runId&&occurrence.stepRunIds.includes(context.stepRunId));
          respond(response,200,OccurrenceDetailSchema.parse({...occurrenceValue(occurrence),runId:selected.runId,versionId:method.id,contexts:contexts.map(value=>({id:value.id,nodeId:value.nodeId,instructions:value.instructions,model:typeof value.effectiveConfig.model==='string'?value.effectiveConfig.model:null,reasoningEffort:typeof value.effectiveConfig.reasoningEffort==='string'?value.effectiveConfig.reasoningEffort:null,effectiveConfig:cleanConfig(value.effectiveConfig),sessionId:value.sessionId}))}),head);return true;
        }
      }
      if(segment[0]==='assets'&&segment[1]&&segment.length===3&&['reading','relations'].includes(segment[2]!)&&authenticated.service.readRun&&authenticated.service.readAssetsByIds&&authenticated.service.runAssets&&authenticated.service.assetConsumerRuns&&authenticated.service.reviewsForAsset){
        const selected=await timing.measure('subject',()=>authenticated.service.readAsset(spaceId,segment[1]!));exact(selected.spaceId===spaceId);
        const source=selected.source.kind==='node'?await exactRun(selected.source.runId):null;
        const sourceCase=source?await getCase(source.selected.caseId):null;
        const sourceAssets=source?await authenticated.service.runAssets(spaceId,source.selected.runId):[];
        const relatedIds=[...new Set([selected.id,...selected.dependencies])];
        const related=await authenticated.service.readAssetsByIds(spaceId,relatedIds);
        const byId=new Map([...sourceAssets,...related].map(value=>[value.id,value]));
        const presentation=source?await authenticated.service.resolvePresentation(spaceId,source.method.id,source.selected.entrypoint):null;
        const label=(value:AssetVersion)=>{
          const payload=value.payload as {title?:unknown}|null;if(typeof payload?.title==='string'&&payload.title.trim())return undefined;
          return presentation?.presentation.assetViews.find(view=>view.schema.namespace===value.schema.namespace&&view.schema.revision===value.schema.revision&&view.schema.hash===value.schema.hash)?.label;
        };
        const minimal=(assets:SpaceOverview['assets']):SpaceOverview=>({space:find(memberships,value=>value.id===spaceId),workflows:source?[source.method]:[],cases:sourceCase?[sourceCase]:[],runs:source?[source.selected]:[],assets,reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]});
        const sourceView=source?await timing.measure('process',()=>authenticated.service.process(spaceId,source.selected.runId)):null;
        if(sourceView)exact(sourceView.run.runId===source!.selected.runId);
        const matches=sourceView?.occurrences.filter(value=>value.outputBindings.some(binding=>binding.assetVersionId===selected.id))??[];
        if(matches.length>1)exact(false);
        const producing=matches[0];
        const present=async(value:AssetVersion)=>{
          const sameRun=source&&value.source.kind==='node'&&value.source.runId===source.selected.runId;
          const outputMatches=sameRun?sourceView?.occurrences.filter(occurrence=>occurrence.outputBindings.some(binding=>binding.assetVersionId===value.id))??[]:[];
          if(outputMatches.length>1)exact(false);
          return scopedAsset({runs:source?[source.selected]:[]},value,label(value),outputMatches[0]);
        };
        if(segment[2]==='reading'){
          const matching=presentation?.presentation.assetViews.find(value=>value.schema.namespace===selected.schema.namespace&&value.schema.revision===selected.schema.revision&&value.schema.hash===selected.schema.hash);
          const reader=matching?.reader?authenticated.readers?.[matching.reader]:authenticated.readers?.[`${selected.schema.namespace}@${selected.schema.revision}`];
          let rendered:ReturnType<AssetReader>|undefined;try{rendered=reader?.(selected);}catch{rendered=undefined;}
          const title=rendered?.title??label(selected)??(typeof (selected.payload as {title?:unknown}|null)?.title==='string'?(selected.payload as {title:string}).title:selected.schema.namespace);
          const sections=rendered?.sections??[{title:matching?.label??'Saved data',text:JSON.stringify(selected.payload,null,2)}];
          // A source reference may point to a frozen context input that is not a direct dependency.
          const contextIds=selected.source.kind==='node'?[selected.source.contextId,selected.source.generatedByContextId].filter((id):id is string=>!!id):[];
          const contexts=await Promise.all(contextIds.map(id=>authenticated.service.readContext(spaceId,id)));
          for(const context of contexts)exact(context.spaceId===spaceId&&context.runId===source!.selected.runId);
          const contextAssets=await authenticated.service.readAssetsByIds(spaceId,[...new Set(contexts.flatMap(context=>Object.values(context.inputs).map(input=>input.assetVersionId)).filter(id=>!byId.has(id)))]);
          for(const item of contextAssets)byId.set(item.id,item);
          const sources=await getAssetSources(authenticated.service,minimal([...byId.values()]),selected,authenticated.adapter);
          const sourceIds=sources.length?sources.filter(value=>value.resolved&&value.assetVersionId).map(value=>value.assetVersionId!):selected.dependencies;
          const links=await Promise.all((sources.length?sources.filter(value=>value.resolved&&value.assetVersionId).map(value=>({ref:value.ref,id:value.assetVersionId!,pointer:value.pointer??null})):selected.dependencies.map(id=>({ref:id,id,pointer:null}))).map(async value=>({ref:value.ref,asset:await present(find([...byId.values()],asset=>asset.id===value.id)),pointer:value.pointer})));
          exact(sourceIds.every(id=>byId.has(id)));
          respond(response,200,AssetReadingSchema.parse({asset:await present(selected),title,sections,readerStatus:rendered?'registered':'fallback',sourceLinks:links,payloadHash:selected.payloadHash}),head);return true;
        }
        const candidateRuns=await authenticated.service.assetConsumerRuns(spaceId,selected.id);
        const scopedCandidates=await Promise.all(candidateRuns.map(async run=>({run,method:await getVersion(run.workflowVersionId)})));
        const consumers=(await Promise.all(scopedCandidates.filter(({run,method})=>run.entrypoint===host.scope.entrypoint&&method.entrypoints[host.scope.entrypoint]?.workflowId===host.scope.workflowId).map(async({run})=>{
          const view=await authenticated.service.process(spaceId,run.runId);exact(view.run.runId===run.runId);
          return view.occurrences.filter(occurrence=>occurrence.inputBindings.some(binding=>binding.assetVersionId===selected.id)).map(occurrence=>({runId:run.runId,versionId:run.workflowVersionId,caseId:run.caseId,nodeId:occurrence.nodeId??null,nodeLabel:occurrence.nodeId??'Unknown node',occurrenceId:occurrence.id,round:occurrence.round??null,state:occurrence.state}));
        }))).flat();
        const page=paged(consumers,url,value=>`${value.runId}\u0000${value.occurrenceId}`,listScope(`assets/${selected.id}/relations`),signer,now);
        const dependencyDtos=await Promise.all(selected.dependencies.map(id=>present(find([...byId.values()],value=>value.id===id))));
        const earlier=selected.dependencies.map(id=>find([...byId.values()],value=>value.id===id)).filter(value=>value.schema.namespace===selected.schema.namespace&&value.schema.revision===selected.schema.revision&&value.schema.hash===selected.schema.hash&&value.createdAt<=selected.createdAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
        const resolution=source&&authenticated.adapter?await authenticated.adapter.resolveRun({data:minimal([...byId.values()]),run:source.selected}):null;
        const declared=resolution?.process?.find(item=>item.assetVersionId===selected.id)?.assessmentAssetVersionIds??(resolution?.primaryAssetVersionId===selected.id?resolution.assessmentAssetVersionIds??[]:[]);
        const assessmentAssets=declared.length?await authenticated.service.readAssetsByIds(spaceId,declared):[];
        const assessments=await Promise.all(assessmentAssets.filter(value=>value.dependencies.includes(selected.id)&&value.source.kind==='node'&&value.source.runId===source?.selected.runId).map(value=>present(value)));
        const reviews=await authenticated.service.reviewsForAsset(spaceId,selected.id);
        exact(reviews.every(review=>review.spaceId===spaceId&&review.assetVersionIds.includes(selected.id)));
        respond(response,200,AssetRelationsSchema.parse({assetId:selected.id,producer:source?{runId:source.selected.runId,versionId:source.selected.workflowVersionId,caseId:source.selected.caseId,nodeId:producing?.nodeId??(selected.source.kind==='node'?selected.source.nodeId:null),nodeLabel:producing?.nodeId??(selected.source.kind==='node'?selected.source.nodeId:'Unknown node'),occurrenceId:producing?.id??null,round:producing?.round??null}:null,dependencies:dependencyDtos,previousDraft:earlier[0]?await present(earlier[0]):null,assessments,consumers:page.items,reviews:reviews.map(reviewDto),nextCursor:page.nextCursor,snapshotAt:page.snapshotAt}),head);return true;
      }
      const data=await timing.measure('overview',()=>authenticated.service.overview(spaceId));
      exact(data.space.id===spaceId);
      const scope=authenticated.scope;
      const allVersions=data.workflows.filter(item=>!!item.entrypoints[scope.entrypoint]&&item.entrypoints[scope.entrypoint]?.workflowId===scope.workflowId);
      const send=(schema:{parse:(value:unknown)=>unknown},value:unknown)=>respond(response,200,schema.parse(value),head);
      const plans=async()=>authenticated.service.validationPlans(spaceId);
      const presentationCache=new Map<string,ReturnType<Service['resolvePresentation']>>();
      const presentationFor=(methodId:string,entrypoint:string)=>{
        const key=`${methodId}\u0000${entrypoint}`;
        let pending=presentationCache.get(key);
        if(!pending){pending=authenticated.service.resolvePresentation(spaceId,methodId,entrypoint);presentationCache.set(key,pending);}
        return pending;
      };
      const readerFor=(value:{schema:{namespace:string;revision:string}},configured?:string):AssetReader|undefined=>configured?authenticated.readers?.[configured]:authenticated.readers?.[`${value.schema.namespace}@${value.schema.revision}`];
      const assetDisplay=async(value:SpaceOverview['assets'][number])=>{
        const record=value.payload as {title?:unknown}|null;
        if(typeof record?.title==='string'&&record.title.trim())return scopedAsset(data,value);
        const sourceRunId=value.source.kind==='node'?value.source.runId:undefined;
        const sourceRun=sourceRunId?data.runs.find(item=>item.runId===sourceRunId):undefined;
        const presentations=sourceRun?[await presentationFor(sourceRun.workflowVersionId,sourceRun.entrypoint)]:await Promise.all(allVersions.map(method=>presentationFor(method.id,scope.entrypoint)));
        const labels=new Set(presentations.flatMap(resolved=>resolved?.presentation.assetViews.filter(view=>view.schema.namespace===value.schema.namespace&&view.schema.revision===value.schema.revision&&view.schema.hash===value.schema.hash).map(view=>view.label)??[]));
        return scopedAsset(data,value,labels.size===1?[...labels][0]:undefined);
      };
      const selectedVersion=(id:string)=>{const selected=version(data,id);entry(selected,scope.entrypoint);exact(selected.entrypoints[scope.entrypoint]?.workflowId===scope.workflowId);return selected;};
      const selectedRun=(id:string)=>{const selected=run(data,id);exact(selected.entrypoint===scope.entrypoint&&allVersions.some(item=>item.id===selected.workflowVersionId));return selected;};
      const tasks=async()=>authenticated.service.executionTasks(spaceId);
      const resolveRun=async(item:SpaceOverview['runs'][number])=>{const task=(await tasks()).find(value=>value.runId===item.runId);const resolved=authenticated.adapter?await authenticated.adapter.resolveRun({data,run:item}):undefined;return runDto(data,item,task?{status:task.status,error:task.error,createdAt:task.createdAt}:undefined,resolved);};
      const graphUrl=(kind:'versions'|'runs',id:string)=>`${base(spaceId)}/${kind}/${safeId(id)}/graph`;
      if(segment[0]==='summary'&&segment.length===1){
        const adopted=scope.adoptionSlot?[...data.adoptions].reverse().find(item=>item.slot===scope.adoptionSlot&&item.target.kind==='workflow'&&allVersions.some(version=>version.id===item.target.id)):undefined;
        const latest=[...allVersions].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
        send(SummarySchema,{id:spaceId,title:data.space.purpose,purpose:data.space.purpose,subject:{id:authenticated.principal!.id,cacheScope:authenticated.cacheScope},methodScope:{workflowId:scope.workflowId,entrypoint:scope.entrypoint,adoptionSlot:scope.adoptionSlot??null},adoptedVersionId:adopted?.target.id??null,latestVersionId:latest?.id??null,counts:{versions:allVersions.length,cases:data.cases.length,runs:data.runs.filter(item=>allVersions.some(value=>value.id===item.workflowVersionId)).length,assets:data.assets.length},capabilities:{read:true,write:!!((authenticated.commands||authenticated.business)&&authenticated.commandSecurity)},csrfToken:(authenticated.commands||authenticated.business)&&authenticated.commandSecurity?authenticated.commandSecurity.csrfToken:null,snapshotAt:now().toISOString()});return true;
      }
      if(segment[0]==='versions'){
        if(segment.length===1){const knownPlans=await plans();const versions=await Promise.all(allVersions.map(async value=>versionDto(data,value,scope.entrypoint,available(value.id),planIds(knownPlans,value.id),undefined,(await presentationFor(value.id,scope.entrypoint))?.presentation.label,host.displayTimeZone)));send(listSchema(VersionSummarySchema),paged(versions,url,value=>`${value.createdAt}\u0000${value.id}`,listScope('versions'),signer,now));return true;}
        const selected=selectedVersion(required(segment[1],'version ID')),selectedEntry=entry(selected,scope.entrypoint);
        const presentation=await authenticated.service.resolvePresentation(spaceId,selected.id,scope.entrypoint);
        const labels=new Map(presentation?.presentation.stages?.map(stage=>[stage.id,stage.label])??[]);
        const nodes=selectedEntry.process?.nodes.map(node=>nodeDto(selectedEntry,node,labels.get(node.id)))??[];
        if(segment.length===2){const value=versionDto(data,selected,scope.entrypoint,available(selected.id),planIds(await plans(),selected.id),undefined,presentation?.presentation.label,host.displayTimeZone);send(VersionDetailSchema,{...value,hash:selected.hash,purpose:presentation?.presentation.purpose??null,nodes,graphUrl:selectedEntry.process?graphUrl('versions',selected.id):null});return true;}
        if(segment[2]==='nodes'&&segment.length===4){const node=find(selectedEntry.process?.nodes??[],value=>value.id===segment[3]);const definition=selectedEntry.nodeDefinitions?.[node.id];send(NodeDetailSchema,{...nodeDto(selectedEntry,node,labels.get(node.id)),versionId:selected.id,instructions:definition?.instructions??null,configuration:definition?.configuration?cleanConfig(definition.configuration):null});return true;}
        if(segment[2]==='graph'&&segment.length===3){if(!selectedEntry.process)reject(404,'HISTORY_UNAVAILABLE','Historical graph was not recorded');const html=await renderWorkflowDiagram({entry:selectedEntry,presentation:presentation?.presentation,detailBase:base(spaceId)});respond(response,200,bridgeWorkflowDiagram(html,selectedEntry.process.nodes.map(node=>node.id)),head,'text/html; charset=utf-8');return true;}
        if(segment[2]==='cases'&&segment.length===3){const runIds=data.runs.filter(value=>value.workflowVersionId===selected.id).map(value=>value.caseId);send(listSchema(CaseSummarySchema),paged(data.cases.filter(value=>runIds.includes(value.id)).map(value=>caseDto(data,value)),url,value=>value.id,listScope(`versions/${selected.id}/cases`),signer,now));return true;}
      }
      if(segment[0]==='cases'){
        if(segment.length===1){send(listSchema(CaseSummarySchema),paged(data.cases.map(value=>caseDto(data,value)),url,value=>value.id,listScope('cases'),signer,now));return true;}
        const selected=find(data.cases,value=>value.id===segment[1]);
        if(segment.length===2){send(CaseSummarySchema,caseDto(data,selected));return true;}
        if(segment[2]==='runs'&&segment.length===3){const values=data.runs.filter(value=>value.caseId===selected.id&&allVersions.some(method=>method.id===value.workflowVersionId));send(listSchema(RunSummarySchema),paged(await Promise.all(values.map(resolveRun)),url,value=>value.id,listScope(`cases/${selected.id}/runs`),signer,now));return true;}
      }
      if(segment[0]==='runs'&&segment[1]){
        const selected=selectedRun(segment[1]);
        if(segment.length===2){const manifest=await authenticated.service.readManifest(spaceId,selected.inputManifestId);exact(manifest.caseId===selected.caseId);const summary=await resolveRun(selected);send(RunDetailSchema,{...summary,inputManifestId:manifest.id,inputManifestHash:manifest.hash,configHash:selected.configHash,inputAssets:await Promise.all(Object.values(manifest.assets).map(value=>scopedAsset(data,asset(data,value)))),versionLabel:version(data,selected.workflowVersionId).revision,caseTitle:find(data.cases,value=>value.id===selected.caseId).title});return true;}
        const view=await authenticated.service.process(spaceId,selected.runId);exact(view.run.runId===selected.runId);
        const method=selectedVersion(selected.workflowVersionId),methodEntry=entry(method,selected.entrypoint);
        const presentation=await authenticated.service.resolvePresentation(spaceId,method.id,selected.entrypoint);
        const labels=new Map(presentation?.presentation.stages?.map(stage=>[stage.id,stage.label])??[]);
        const titleForAsset=(value:SpaceOverview['assets'][number])=>{
          const saved=value.payload as {title?:unknown}|null;
          if(typeof saved?.title==='string'&&saved.title.trim())return undefined;
          return presentation?.presentation.assetViews.find(view=>view.schema.namespace===value.schema.namespace&&view.schema.revision===value.schema.revision&&view.schema.hash===value.schema.hash)?.label;
        };
        const nodeDtos=(view.contract?.nodes??methodEntry.process?.nodes??[]).map(node=>nodeDto(methodEntry,node,labels.get(node.id)));
        if(segment[2]==='process'&&segment.length===3){const graphState=view.contract?buildWorkflowGraphState(view):null;if(graphState)exact(graphState.spaceId===spaceId&&graphState.runId===selected.runId&&graphState.versionId===method.id);send(ProcessSchema,{runId:selected.runId,versionId:method.id,caseId:selected.caseId,contractSource:view.contractSource,coverage:view.coverage,unmappedStepIds:view.unmappedStepIds,nodes:nodeDtos,occurrences:view.occurrences.map(value=>occurrenceDto(data,value,labels.get(value.nodeId??'')??value.nodeId??value.id,titleForAsset)),graphUrl:view.contract?graphUrl('runs',selected.runId):null,graphState});return true;}
        if(segment[2]==='graph'&&segment.length===3){if(!view.contract)reject(404,'HISTORY_UNAVAILABLE','Run process graph unavailable');const renderEntry={...methodEntry,process:view.contract};const html=await renderWorkflowDiagram({entry:renderEntry,presentation:presentation?.presentation,view,detailBase:base(spaceId)});respond(response,200,bridgeWorkflowDiagram(html,view.contract.nodes.map(node=>node.id)),head,'text/html; charset=utf-8');return true;}
        if(segment[2]==='occurrences'&&segment.length===4){const occurrence=find(view.occurrences,value=>value.id===segment[3]);const contexts=await Promise.all(occurrence.contextIds.map(value=>authenticated.service.readContext(spaceId,value)));for(const context of contexts)exact(context.runId===selected.runId&&occurrence.stepRunIds.includes(context.stepRunId));send(OccurrenceDetailSchema,{...occurrenceDto(data,occurrence,labels.get(occurrence.nodeId??'')??occurrence.nodeId??occurrence.id,titleForAsset),runId:selected.runId,versionId:method.id,contexts:contexts.map(value=>({id:value.id,nodeId:value.nodeId,instructions:value.instructions,model:typeof value.effectiveConfig.model==='string'?value.effectiveConfig.model:null,reasoningEffort:typeof value.effectiveConfig.reasoningEffort==='string'?value.effectiveConfig.reasoningEffort:null,effectiveConfig:cleanConfig(value.effectiveConfig),sessionId:value.sessionId}))});return true;}
      }
      if(segment[0]==='assets'){
        if(segment.length===1){
          const caseId=url.searchParams.get('caseId')??'',runId=url.searchParams.get('runId')??'',schema=url.searchParams.get('schema')??'',search=url.searchParams.get('search')??'';
          if(caseId)find(data.cases,value=>value.id===caseId);
          if(runId){const selected=selectedRun(runId);if(caseId)exact(selected.caseId===caseId);}
          let values=data.assets;
          if(caseId||runId){
            const selectedRuns=data.runs.filter(value=>(!caseId||value.caseId===caseId)&&(!runId||value.runId===runId)&&allVersions.some(method=>method.id===value.workflowVersionId));
            const runIds=new Set(selectedRuns.map(value=>value.runId));
            const manifests=await Promise.all(selectedRuns.map(value=>authenticated.service.readManifest(spaceId,value.inputManifestId)));
            for(let index=0;index<manifests.length;index++)exact(manifests[index]!.caseId===selectedRuns[index]!.caseId);
            const included=new Set<string>(manifests.flatMap(value=>Object.values(value.assets)));
            for(const value of data.assets)if(value.source.kind==='node'&&runIds.has(value.source.runId))included.add(value.id);
            await Promise.all(data.assets.filter(value=>value.source.kind==='import').map(async value=>{
              const association=await importedScope(value);
              if(association&&(!caseId||association.caseId===caseId)&&(!runId||association.runId===runId))included.add(value.id);
            }));
            const byId=new Map(data.assets.map(value=>[value.id,value]));
            const queue=[...included];for(let index=0;index<queue.length;index++)for(const dependency of byId.get(queue[index]!)?.dependencies??[])if(!included.has(dependency)){included.add(dependency);queue.push(dependency);}
            values=values.filter(value=>included.has(value.id));
          }
          if(schema)values=values.filter(value=>value.schema.namespace===schema);
          const summaries=await Promise.all(values.map(assetDisplay));
          const filtered=search?summaries.filter(value=>`${value.title} ${value.id} ${value.schema.namespace}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())):summaries;
          const listing=paged(filtered,url,value=>`${value.createdAt}\u0000${value.id}`,listScope('assets',JSON.stringify({caseId,runId,schema,search})),signer,now);
          const pageIds=new Set(listing.items.map(value=>value.id));
          const pageRunIds=new Set(listing.items.flatMap(value=>value.sourceKind==='node'&&value.runId?[value.runId]:[]));
          const producers=new Map<string,{id:string;nodeId?:string;round?:number}>();
          await Promise.all([...pageRunIds].map(async selectedRunId=>{
            const process=await authenticated.service.process(spaceId,selectedRunId);
            exact(process.run.runId===selectedRunId);
            for(const occurrence of process.occurrences)for(const output of occurrence.outputBindings){
              if(!pageIds.has(output.assetVersionId))continue;
              const item=listing.items.find(value=>value.id===output.assetVersionId);
              if(item?.runId!==selectedRunId)continue;
              const prior=producers.get(output.assetVersionId);
              if(prior&&prior.id!==occurrence.id)exact(false);
              producers.set(output.assetVersionId,{id:occurrence.id,nodeId:occurrence.nodeId,round:occurrence.round});
            }
          }));
          send(listSchema(AssetSummarySchema),{...listing,items:listing.items.map(item=>{
            const occurrence=producers.get(item.id);
            return occurrence?{...item,nodeId:occurrence.nodeId??item.nodeId,occurrenceId:occurrence.id,round:occurrence.round??null}:item;
          })});return true;
        }
        const selected=asset(data,required(segment[1],'asset ID'));if(selected.source.kind==='node')selectedRun(selected.source.runId);
        if(segment[2]==='reading'&&segment.length===3){
          const read=await authenticated.service.readAsset(spaceId,selected.id);exact(read.id===selected.id);
          let title=(await assetDisplay(selected)).title;
          let sections:Array<{title:string;text:string;pointer?:string;sourceRefs?:string[];view?:'body'|'visual'|'evidence'}>;
          let readerStatus:'registered'|'presentation'|'fallback'='fallback';
          const sourceRun=read.source.kind==='node'?selectedRun(read.source.runId):undefined;
          const process=sourceRun?await authenticated.service.process(spaceId,sourceRun.runId):null;
          if(process&&sourceRun)exact(process.run.runId===sourceRun.runId);
          const producing=process?.occurrences.find(value=>value.outputBindings.some(binding=>binding.assetVersionId===read.id));
          const presentations=sourceRun?[await presentationFor(sourceRun.workflowVersionId,sourceRun.entrypoint)]:await Promise.all(allVersions.map(method=>presentationFor(method.id,scope.entrypoint)));
          const matches=presentations.flatMap(presentation=>presentation?.presentation.assetViews.filter(value=>value.schema.namespace===read.schema.namespace&&value.schema.revision===read.schema.revision&&value.schema.hash===read.schema.hash)??[]);
          const configured=new Set(matches.map(value=>value.reader).filter((value):value is string=>!!value));
          const matching=matches[0];
          const reader=readerFor(read,configured.size===1?[...configured][0]:undefined);
          let rendered:ReturnType<AssetReader>|undefined;
          try{rendered=reader?.(read);}catch{rendered=undefined;}
          if(rendered){title=rendered.title;sections=rendered.sections;readerStatus='registered';}
          else sections=[{title:matching?.label??'Saved data',text:JSON.stringify(read.payload,null,2)}];
          const resolvedSources=await getAssetSources(authenticated.service,data,read,authenticated.adapter);
          const sourceLinks=resolvedSources.length?await Promise.all(resolvedSources.filter(value=>value.resolved&&value.assetVersionId).map(async value=>({ref:value.ref,asset:await assetDisplay(asset(data,value.assetVersionId!)),pointer:value.pointer??null}))):await Promise.all(read.dependencies.map(async value=>({ref:value,asset:await assetDisplay(asset(data,value)),pointer:null})));
          // Adapter refs may be intentionally unresolved; never invent a target for them.
          const links=resolvedSources.length?sourceLinks.filter(value=>resolvedSources.some(source=>source.ref===value.ref&&source.resolved)):sourceLinks;
          send(AssetReadingSchema,{asset:await scopedAsset(data,read,title,producing),title,sections,readerStatus,sourceLinks:links,payloadHash:read.payloadHash});return true;
        }
        if(segment[2]==='relations'&&segment.length===3){
          const source=selected.source.kind==='node'?selectedRun(selected.source.runId):null;
          const sourceView=source?await authenticated.service.process(spaceId,source.runId):null;
          const producing=sourceView?.occurrences.find(value=>value.outputBindings.some(binding=>binding.assetVersionId===selected.id));
          const scopedRuns=data.runs.filter(value=>allVersions.some(method=>method.id===value.workflowVersionId));
          // An imported or transformed asset has no producing Case. Its actual consumers
          // are the occurrence input bindings across this host's authorized method scope.
          const caseRuns=source?scopedRuns.filter(value=>value.caseId===source.caseId):scopedRuns;
          const views=await Promise.all(caseRuns.map(async value=>({run:value,view:await authenticated.service.process(spaceId,value.runId)})));
          const allConsumers=views.flatMap(({run:item,view})=>view.occurrences.filter(occurrence=>occurrence.inputBindings.some(binding=>binding.assetVersionId===selected.id)).map(occurrence=>({runId:item.runId,versionId:item.workflowVersionId,caseId:item.caseId,nodeId:occurrence.nodeId??null,nodeLabel:occurrence.nodeId??'Unknown node',occurrenceId:occurrence.id,round:occurrence.round??null,state:occurrence.state})));
          const consumers=paged(allConsumers,url,value=>`${value.runId}\u0000${value.occurrenceId}`,listScope(`assets/${selected.id}/relations`),signer,now);
          const dependencies=await Promise.all(selected.dependencies.map(value=>assetDisplay(asset(data,value))));
          const earlier=selected.dependencies.map(value=>asset(data,value)).filter(value=>value.schema.namespace===selected.schema.namespace&&value.schema.revision===selected.schema.revision&&value.schema.hash===selected.schema.hash&&value.createdAt<=selected.createdAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
          const previous=earlier[0];
          const resolution=source&&authenticated.adapter?await authenticated.adapter.resolveRun({data,run:source}):null;
          const declaredAssessmentIds=resolution?.process?.find(item=>item.assetVersionId===selected.id)?.assessmentAssetVersionIds??(resolution?.primaryAssetVersionId===selected.id?resolution.assessmentAssetVersionIds??[]:[]);
          const assessments=await Promise.all(declaredAssessmentIds.map(id=>asset(data,id)).filter(value=>value.dependencies.includes(selected.id)&&value.source.kind==='node'&&value.source.runId===source?.runId).map(assetDisplay));
          send(AssetRelationsSchema,{assetId:selected.id,producer:source?{runId:source.runId,versionId:source.workflowVersionId,caseId:source.caseId,nodeId:producing?.nodeId??(selected.source.kind==='node'?selected.source.nodeId:null),nodeLabel:producing?.nodeId??(selected.source.kind==='node'?selected.source.nodeId:'Unknown node'),occurrenceId:producing?.id??null,round:producing?.round??null}:null,dependencies,previousDraft:previous?await assetDisplay(previous):null,assessments,consumers:consumers.items,reviews:data.reviews.filter(value=>value.assetVersionIds.includes(selected.id)).map(reviewDto),nextCursor:consumers.nextCursor,snapshotAt:consumers.snapshotAt});return true;
        }
      }
      if(segment[0]==='validation-plans'){
        const values=(await plans()).filter(value=>allVersions.some(version=>version.id===value.baseline.workflowVersionId||version.id===value.candidate.workflowVersionId));
        const summary=async(value:typeof values[number])=>{const result=await authenticated.service.validationSummary(spaceId,value.id);return {id:value.id,question:value.question,hypothesis:value.hypothesis,status:value.status,baselineVersionId:value.baseline.workflowVersionId,candidateVersionId:value.candidate.workflowVersionId,createdAt:value.createdAt,totals:result.totals.byStatus};};
        if(segment.length===1){const page=paged(values,url,value=>`${value.createdAt}\u0000${value.id}`,listScope('validation-plans'),signer,now);send(listSchema(PlanSummarySchema),{...page,items:await Promise.all(page.items.map(summary))});return true;}
        const selected=find(values,value=>value.id===segment[1]);
        const result=await authenticated.service.validationSummary(spaceId,selected.id);
        exact(result.plan.id===selected.id&&result.plan.spaceId===spaceId);
        if(segment.length===2){send(PlanDetailSchema,{...await summary(selected),entries:result.entries.map(value=>({id:value.entry.id,side:value.entry.side,caseId:value.entry.caseId,status:value.status,runIds:value.attempts.map(attempt=>attempt.runId)})),standard:selected.standard,expectedVariables:selected.expectedVariables});return true;}
        if(segment[2]==='comparisons'&&segment.length===3){
          const trustedReview=(entryId:string,reviewId:string)=>result.entries.some(item=>item.entry.id===entryId&&item.attempts.some(attempt=>attempt.reviews.some(review=>review.id===reviewId)&&attempt.judgeEvidence.some(evidence=>evidence.reviewId===reviewId&&evidence.verified)));
          const values=result.comparisons.filter(value=>result.pairs.some(pair=>pair.baselineEntryId===value.baselineEntryId&&pair.candidateEntryId===value.candidateEntryId)&&trustedReview(value.baselineEntryId,value.baselineReviewId)&&trustedReview(value.candidateEntryId,value.candidateReviewId));
          const page=paged(values,url,value=>value.id,listScope(`validation-plans/${selected.id}/comparisons`),signer,now);
          send(listSchema(PlanComparisonSchema),{...page,items:page.items.map(value=>({id:value.id,baselineEntryId:value.baselineEntryId,candidateEntryId:value.candidateEntryId,baselineReviewId:value.baselineReviewId,candidateReviewId:value.candidateReviewId,conclusion:value.conclusion,changedConditions:safeDifferences(value.comparison.changedConditions)}))});return true;
        }
        if(segment[2]==='issues'&&segment.length===3){
          const exactEvidence=(evidence:typeof result.issues[number]['evidence'][number])=>result.entries.some(item=>item.entry.id===evidence.entryId&&item.entry.caseId===evidence.caseId&&(!evidence.runId||item.attempts.some(attempt=>attempt.runId===evidence.runId))&&(!evidence.nodeId||!!evidence.runId));
          const page=paged(result.issues.filter(issue=>issue.evidence.length>0&&issue.evidence.every(exactEvidence)),url,value=>`${value.createdAt}\u0000${value.id}`,listScope(`validation-plans/${selected.id}/issues`),signer,now);
          send(listSchema(PlanIssueSchema),{...page,items:page.items.map(value=>({id:value.id,kind:value.kind,category:value.category,text:value.text,nextHypothesis:value.nextHypothesis??null,evidence:value.evidence.map(item=>({entryId:item.entryId,caseId:item.caseId,runId:item.runId??null,nodeId:item.nodeId??null})),createdAt:value.createdAt}))});return true;
        }
        if(segment[2]==='entries'&&segment[3]){
          const row=find(result.entries,value=>value.entry.id===segment[3]);
          const selectedEntry=row.entry;
          exact(selectedEntry.caseId===find(selected.cases,value=>value.caseId===selectedEntry.caseId).caseId);
          exact(selectedEntry.entrypoint===scope.entrypoint&&allVersions.some(value=>value.id===selectedEntry.workflowVersionId));
          const attemptDto=(value:typeof row.attempts[number])=>({attempt:value.attempt,runId:value.runId,status:value.status,task:value.task?{status:value.task.status,error:value.task.error??null}:null,run:value.run?{state:value.run.state,error:value.run.error??null}:null,reviews:value.reviews.map(review=>({...reviewDto(review),evidence:review.evidence})),judgeEvidence:value.judgeEvidence.map(evidence=>({reviewId:evidence.reviewId,verified:evidence.verified,expectedProfileHash:evidence.expectedProfileHash??null,observedProfileHash:evidence.observedProfileHash??null,differences:safeDifferences(evidence.differences)}))});
          if(segment[4]==='attempts'&&segment.length===6){const number=Number(segment[5]);if(!Number.isSafeInteger(number)||number<1)reject(400,'INVALID_REQUEST','Invalid attempt');const attempt=find(row.attempts,value=>value.attempt===number);send(PlanAttemptSchema,attemptDto(attempt));return true;}
          if(segment.length===4){
            const manifest=await authenticated.service.readManifest(spaceId,selectedEntry.inputManifestId);
            exact(manifest.id===selectedEntry.inputManifestId&&manifest.caseId===selectedEntry.caseId&&manifest.spaceId===spaceId);
            const caseValue=find(data.cases,value=>value.id===selectedEntry.caseId);
            const slotRank=new Map((authenticated.inputSlotOrder??[]).map((slot,index)=>[slot,index]));
            const orderedSlots=Object.entries(manifest.assets).map(([slot,id],index)=>({slot,id,index})).sort((a,b)=>(slotRank.get(a.slot)??Infinity)-(slotRank.get(b.slot)??Infinity)||a.index-b.index);
            const frozenAssets=await Promise.all(orderedSlots.map(async({slot,id})=>{const selectedAsset=asset(data,id),read=await authenticated.service.readAsset(spaceId,id);exact(read.id===id&&read.payloadHash===selectedAsset.payloadHash);return {slot,asset:await assetDisplay(selectedAsset),payloadHash:read.payloadHash,read};}));
            const presentation=await presentationFor(selectedEntry.workflowVersionId,selectedEntry.entrypoint);
            const inputSections=frozenAssets.flatMap(({slot,read})=>{
              const matching=presentation?.presentation.assetViews.find(view=>view.schema.namespace===read.schema.namespace&&view.schema.revision===read.schema.revision&&view.schema.hash===read.schema.hash);
              const reader=readerFor(read,matching?.reader);
              if(!reader)return [];
              try{return reader(read).sections.map(section=>({...section,title:`${slot} · ${section.title}`,text:section.text.slice(0,32_768)}));}catch{return [];}
            }).slice(0,100);
            const latest=row.attempts.at(-1),actionAttempt=latest?.attempt??1;
            const offered=authenticated.commands&&authenticated.commandSecurity?await authenticated.commands.entryActions({spaceId,planId:selected.id,entryId:selectedEntry.id,attempt:actionAttempt}):{start:false,resume:false,reason:'This host is read-only',resumeTarget:null};
            const active=(await tasks()).filter(value=>['queued','running','cancel_requested','interrupted'].includes(value.status)).sort((a,b)=>a.createdAt<b.createdAt?-1:a.createdAt>b.createdAt?1:a.runId<b.runId?-1:a.runId>b.runId?1:0);
            if(offered.resume){const target=offered.resumeTarget;exact(!!target&&row.attempts.some(value=>value.attempt===target.attempt&&value.runId===target.runId)&&active.some(value=>value.runId===target.runId&&value.status==='queued'));}
            const link=new Map(result.entries.flatMap(value=>value.attempts.map(attempt=>[attempt.runId,value.entry.id] as const)));
            const queue=active.slice(0,100).map(value=>({runId:value.runId,versionId:value.workflowVersionId,caseId:value.caseId,inputManifestId:value.inputManifestId,executorKey:value.executorKey,status:value.status,planId:link.has(value.runId)?selected.id:null,entryId:link.get(value.runId)??null}));
            send(PlanEntrySchema,{planId:selected.id,entryId:selectedEntry.id,side:selectedEntry.side,repeat:selectedEntry.repeat,caseId:selectedEntry.caseId,caseTitle:caseValue.title,versionId:selectedEntry.workflowVersionId,entrypoint:selectedEntry.entrypoint,planStatus:selected.status,status:row.status,availability:available(selectedEntry.workflowVersionId),manifest:{id:manifest.id,hash:manifest.hash,caseId:manifest.caseId,slots:frozenAssets.map(({slot,asset,payloadHash})=>({slot,asset,payloadHash}))},inputSections,inputSummary:authenticated.inputSummary?.({assets:frozenAssets.map(({slot,read})=>({slot,asset:read}))})??[],standard:selected.standard,requiredJudgeCoverage:row.requiredJudgeCoverage,attempts:row.attempts.slice(-30).map(attemptDto),attemptsTruncated:row.attempts.length>30,nextAttempt:(latest?.attempt??0)+1,queue,queueTruncated:active.length>100,actions:offered,snapshotAt:now().toISOString()});return true;
          }
        }
      }
      reject(404,'NOT_FOUND','Unknown Space API route');
    }catch(error){
      const text=error instanceof Error?error.message:'';
      const structured=error&&typeof error==='object'?error as {status?:unknown;code?:unknown;message?:unknown}:null;
      const commandCodes=new Set<Code>(['EXECUTION_DISABLED','CONFLICT','UNAVAILABLE','BASELINE_REQUIRED','INVALID_REQUEST','FORBIDDEN','RELATION_MISMATCH']);
      const approvedCommandError=structured&&typeof structured.code==='string'&&typeof structured.status==='number'&&typeof structured.message==='string'&&
        (structured.code==='NOT_FOUND'?structured.status===404:commandCodes.has(structured.code as Code)&&[400,403,409,422,423,429,503].includes(structured.status));
      const commandFailure=approvedCommandError?new ApiFailure(structured.status as number,structured.code as Code,(structured.message as string).slice(0,500)):null;
      const known=error instanceof ApiFailure?error:commandFailure??(/Space access denied|access denied|capability denied/u.test(text)?new ApiFailure(403,'FORBIDDEN','Space access denied'):/not found in authorized space|outside authorized Space/u.test(text)?new ApiFailure(404,'NOT_FOUND','Object not found in authorized Space'):null);
      respond(response,known?.status??500,{error:{code:known?.code??'SERVICE_FAILURE',message:known?.message??'Space API request failed',requestId}},head);return true;
    }
  };
}
