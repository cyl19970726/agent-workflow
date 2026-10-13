import {createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {artifactPayloadSha256} from '@signal-room/workflow';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {isDeepStrictEqual} from 'node:util';
import {ZodError} from 'zod';
import {buildWorkflowGraphState, getAssetSources, isRunAssetSource, projectExpectedAssets, projectRunGraphAssets, renderWorkflowDiagram, type AssetReader, type AssetVersion, type BusinessPresentationAdapter, type BusinessRunResolution, type BusinessUnderstandingRevision, type BusinessUnderstandingSave, type DesignSpaceState, type MethodCapabilityRevision, type MethodCapabilitySave, type MethodDesignBasis, type MethodDesignRevision, type MethodDesignSave, type ProcessView, type RunGraphAssets, type ReviewDraft, type RunDispositionRevision, type RunDispositionSave, type RunDiagnosisRevision, type RunDiagnosisSave, type SpaceCase, type SpaceOverview, type SpaceRun, type WorkflowSpaceService, type WorkflowVersion} from '@signal-room/workflow-spaces';
import {AssetReadingSchema, AssetRelationsSchema, AssetSummarySchema, BusinessCommandReceiptSchema, BusinessDispatchRequestSchema, BusinessFormSchema, BusinessPreparationSchema, BusinessPrepareRequestSchema, BusinessStartRequestSchema, CaseFrozenInputsSchema, CaseSummarySchema, ComparisonReadingSchema, HandlingNoteListSchema, HandlingNoteRequestSchema, HandlingNoteSchema, IterationSchema, NodeDetailSchema, OccurrenceDetailSchema, PlanAttemptSchema, PlanCommandReceiptSchema, PlanComparisonSchema, PlanDetailSchema, PlanDispatchRequestSchema, PlanEntrySchema, PlanIssueSchema, PlanStartRequestSchema, PlanSummarySchema, ProcessSchema, ReviewReadingSchema, RunDetailSchema, RunSummarySchema, SummarySchema, UnderstandingRevisionListSchema, UnderstandingRevisionRequestSchema, UnderstandingRevisionSchema, VersionDetailSchema, VersionSummarySchema, listSchema, type AssetSummaryDto, type AvailabilityDto, type BusinessCommandReceiptDto, type BusinessFormDto, type BusinessPreparationDto, type ComparisonSubjectDto, type CursorList, type EntryActionsDto, type HandlingNoteDto, type HandlingNoteRequestDto, type PlanCommandReceiptDto, type ReviewDto} from './contracts.js';
import {MethodDesignBasisSchema, MethodDesignPreviewSchema, MethodDesignPublicationReceiptSchema, MethodDesignPublicationRequestSchema, MethodDesignRevisionListSchema, MethodDesignRevisionRequestSchema, MethodDesignRevisionSchema, type MethodDesignPreviewDto, type MethodDesignPublicationReceiptDto} from './contracts.js';
import {MethodCapabilityRevisionListSchema,MethodCapabilityRevisionRequestSchema,MethodCapabilityRevisionSchema,MethodDesignDefinitionSchema,type MethodDesignDefinitionDto} from './contracts.js';
import {MethodExecutionCommandSchema,MethodExecutionStateSchema,type MethodExecutionCommandDto} from './contracts.js';
import {ReadingSectionSchema, RunInputManifestSchema, RunSessionEventsSchema, OccurrenceRuntimeSchema, UnpublishedResponsesSchema, type ReadingSectionDto} from './contracts.js';
import {ExternalAgentObservationRequestSchema, ExternalAgentObservationReceiptUnionSchema, ExternalAgentObservationSchema, ExternalAgentAssetObservationRequestSchema, ExternalAgentAssetObservationSchema, ReviewSubjectsSchema, RunReviewRequestSchema, RunReviewSchema, RunDispositionRequestSchema, RunDispositionRevisionSchema, RunDiagnosisRequestSchema, RunDiagnosisRevisionSchema, RunDiagnosisRevisionListSchema, type SavedResponseTargetDto, type PublishedAssetTargetDto} from './contracts.js';
import {agentDeclarationDto,assetDto, caseDto, cleanConfig, nodeDto, occurrenceDto, runDto, versionDto} from './read-model.js';
import {ScopedReadCache} from './read-cache.js';
import {canReadWorkflow, readableWorkflowIds, readWorkflowScopeKey} from './read-workflow-scope.js';
import {runtimeEventReadings} from './runtime-read.js';
import {AssetAttachmentsSchema, AttachmentSchema, AttachmentImportRequestSchema, AttachmentImportReceiptSchema} from './contracts.js';

type NarrowService=Pick<WorkflowSpaceService,'spaceSummary'|'readRun'|'readWorkflowVersion'|'readCase'|'readReview'|'caseRunsPage'|'versionRunStats'|'versionIterationsPage'|'readAssetsByIds'|'inputManifests'|'runAssets'|'assetConsumerRuns'|'reviewsForAsset'|'reviewsForRun'|'recordReview'|'readSavedResponseTarget'|'observeSavedResponseTarget'|'readPublishedAssetTarget'|'observePublishedAsset'|'readExternalAgentObservation'|'getExecutionTask'|'adoptionHeads'|'sessionEvents'|'runtimeEvents'|'uploadBlob'|'readBlob'|'importAsset'>;
type Service=Pick<WorkflowSpaceService,'listSpaces'|'overview'|'readAsset'|'readContext'|'process'|'validationPlans'|'validationPlan'|'validationSummary'|'executionTasks'|'readManifest'|'resolvePresentation'> & Partial<NarrowService>;
async function loadRunGraphAssets(service:Service,spaceId:string,view:ProcessView):Promise<RunGraphAssets>{
  const manifest=await service.readManifest(spaceId,view.run.inputManifestId);
  const saved=service.runAssets?await service.runAssets(spaceId,view.run.runId):[];
  const ids=[...new Set([...Object.values(manifest.assets),...saved.map(asset=>asset.id),...view.occurrences.flatMap(occurrence=>
    [...occurrence.inputBindings,...occurrence.outputBindings].map(binding=>binding.assetVersionId))])];
  const assets=service.readAssetsByIds?await service.readAssetsByIds(spaceId,ids):
    (await service.overview(spaceId)).assets.filter(asset=>ids.includes(asset.id));
  return projectRunGraphAssets(view,manifest,assets);
}
export interface SpaceApiHost {
  principal?:{id:string;kind:'human'|'service';externalAgent?:{id:string;sessionId:string;role?:'design'|'observer'}};
  /** Changes on login, logout, or authorization change. Bound into every cursor. */
  cacheScope?:string;
  /** Time zone used only for human-facing saved timestamps; defaults explicitly to UTC. */
  displayTimeZone?:string;
  service:Service;
  /** Explicit host opt-in for attachment mutations; read-only hosts keep this false. */
  attachmentWrites?:boolean;
  readers?:Record<string,AssetReader>;
  /** Optional display order for frozen manifest slots; unknown slots retain saved order. */
  inputSlotOrder?:string[];
  /** Trusted host projection of the exact frozen inputs; never sourced from browser fields. */
  inputSummary?:(input:{assets:Array<{slot:string;asset:AssetVersion}>})=>string[];
  adapter?:BusinessPresentationAdapter;
  /** Trusted domain rendering of a complete, sanitized saved Agent output. */
  unpublishedResponseReader?:(input:{nodeId:string;output:unknown})=>Promise<{title:string;sections:ReadingSectionDto[];reason?:string}|null>|{title:string;sections:ReadingSectionDto[];reason?:string}|null;
  reviewStandard?:(input:{spaceId:string;runId:string;target?:{kind:'asset';assetVersionId:string}|{kind:'response';target:SavedResponseTargetDto}})=>Promise<{id:string;revision:string;content:string}|null>;
  runDisposition?:{
    current:(spaceId:string,runId:string)=>Promise<RunDispositionRevision|null>;
    read:(spaceId:string,revisionId:string)=>Promise<RunDispositionRevision>;
    list:(spaceId:string,runId:string)=>Promise<RunDispositionRevision[]>;
    save?:(spaceId:string,input:RunDispositionSave)=>Promise<RunDispositionRevision>;
  };
  runDiagnosis?:{
    current:(spaceId:string,runId:string)=>Promise<RunDiagnosisRevision|null>;
    read:(spaceId:string,revisionId:string)=>Promise<RunDiagnosisRevision>;
    list:(spaceId:string,runId:string)=>Promise<RunDiagnosisRevision[]>;
    save?:(spaceId:string,input:RunDiagnosisSave)=>Promise<RunDiagnosisRevision>;
  };
  /** Optional bounded status projection for a single exact run; no all-history parsing. */
  runSummary?:(input:{spaceId:string;run:SpaceRun;version:WorkflowVersion;case:SpaceCase})=>Promise<BusinessRunResolution>;
  /** Trusted host read of the exact saved native run metadata; absent for historical integrations. */
  runExecutionMode?:(input:{spaceId:string;runId:string})=>Promise<string|null>;
  /** Trusted domain association for imported records; validated against saved Space objects before display. */
  importedAssetScope?:(input:{spaceId:string;asset:AssetVersion})=>Promise<{caseId:string;runId:string|null;versionId:string|null}|null>;
  scope:{workflowId:string;entrypoint:string;adoptionSlot?:string;auxiliaryWorkflowIds?:readonly string[]};
  /** Exact, permission-checked design Space totals; absent for legacy business hosts. */
  businessState?:(spaceId:string)=>Promise<DesignSpaceState>;
  availability?:(versionId:string)=>AvailabilityDto|Promise<AvailabilityDto>;
  /** Same-origin, session-bound command security supplied by the authenticated host. */
  commandSecurity?:{origin:string;csrfToken:string;verifyCsrf:(request:IncomingMessage,principal:NonNullable<SpaceApiHost['principal']>)=>boolean|Promise<boolean>};
  understanding?:{
    current:(spaceId:string)=>Promise<BusinessUnderstandingRevision|null>;
    read:(spaceId:string,revisionId:string)=>Promise<BusinessUnderstandingRevision>;
    history:(spaceId:string)=>Promise<BusinessUnderstandingRevision[]>;
    save?:(spaceId:string,input:BusinessUnderstandingSave)=>Promise<BusinessUnderstandingRevision>;
  };
  methodCapability?:{
    current:(spaceId:string)=>Promise<MethodCapabilityRevision|null>;
    read:(spaceId:string,revisionId:string)=>Promise<MethodCapabilityRevision>;
    history:(spaceId:string)=>Promise<MethodCapabilityRevision[]>;
    save?:(spaceId:string,input:MethodCapabilitySave)=>Promise<MethodCapabilityRevision>;
  };
  methodExecution?:{
    status:(spaceId:string)=>Promise<Record<string,unknown>>;
    command?:(spaceId:string,input:MethodExecutionCommandDto)=>Promise<Record<string,unknown>>;
  };
  methodDesign?:{
    current:(spaceId:string)=>Promise<MethodDesignRevision|null>;
    read:(spaceId:string,revisionId:string)=>Promise<MethodDesignRevision>;
    history:(spaceId:string)=>Promise<MethodDesignRevision[]>;
    basis:(spaceId:string,versionId:string)=>Promise<MethodDesignBasis|null>;
    save?:(spaceId:string,input:MethodDesignSave)=>Promise<MethodDesignRevision>;
    preview?:(spaceId:string,designRevisionId:string)=>Promise<MethodDesignPreviewDto>;
    definition?:(spaceId:string,designRevisionId:string)=>Promise<Omit<MethodDesignDefinitionDto,'expectedAssets'|'diagramUrl'>>;
    publish?:(spaceId:string,input:{designRevisionId:string;expectedCandidateId:string})=>Promise<MethodDesignPublicationReceiptDto>;
  };
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
function safeZodIssues(error:ZodError):Array<{path:string;code:string;expected?:string}>{
  const safeSegment=(segment:PropertyKey):string=>typeof segment==='number'&&Number.isSafeInteger(segment)&&segment>=0?String(segment):
    typeof segment==='string'&&/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(segment)?segment:'*';
  const expectedTypes=new Set(['string','number','boolean','object','array','null','undefined','bigint','date','symbol']);
  return error.issues.slice(0,20).map(issue=>({
    path:issue.path.slice(0,12).map(safeSegment).join('.')||'$',
    code:/^[a-z_]+$/u.test(issue.code)?issue.code:'invalid',
    ...(issue.code==='invalid_type'&&typeof issue.expected==='string'&&expectedTypes.has(issue.expected)?{expected:issue.expected}:{})
  }));
}
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
async function methodEvidence(service:Service,spaceId:string,selected:WorkflowVersion,entrypoint:string,presentation?:Parameters<typeof projectExpectedAssets>[1]){
  const heads=service.adoptionHeads?await service.adoptionHeads(spaceId):null;
  return {expectedAssets:projectExpectedAssets(entry(selected,entrypoint),presentation),
    adoptionSlots:heads?.filter(value=>value.target.kind==='workflow'&&value.target.id===selected.id).map(value=>value.slot)??[],
    adoptionStatus:heads?'recorded' as const:'unknown' as const};
}
function methodGraphIds(selectedEntry:WorkflowVersion['entrypoints'][string],presentation?:Parameters<typeof projectExpectedAssets>[1]):string[]{
  return [...(selectedEntry.process?.nodes.map(node=>node.id)??[]),...projectExpectedAssets(selectedEntry,presentation).assets.map(asset=>asset.id)];
}
function reviewDto(value:SpaceOverview['reviews'][number]):ReviewDto{return {id:value.id,runId:value.runId,assetIds:value.assetVersionIds,createdAt:value.createdAt,judge:{kind:value.judge.kind,id:value.judge.id},standard:{id:value.standard.id,revision:value.standard.revision},answers:value.answers,baselineReviewId:value.baselineReviewId??null};}
async function jsonBody(request:IncomingMessage,maxBytes=4096):Promise<unknown>{
  if(request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()!=='application/json')reject(400,'INVALID_REQUEST','JSON body required');
  let size=0;const parts:Buffer[]=[];
  for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)reject(413,'INVALID_REQUEST','Request body too large');parts.push(bytes);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return reject(400,'INVALID_REQUEST','Invalid JSON body');}
}
async function binaryBody(request:IncomingMessage,maxBytes=16*1024*1024):Promise<Uint8Array>{
  const length=request.headers['content-length'];
  if(length!==undefined&&(!/^\d+$/u.test(length)||Number(length)>maxBytes))reject(413,'INVALID_REQUEST','Attachment exceeds 16 MiB');
  let size=0;const parts:Buffer[]=[];
  for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)reject(413,'INVALID_REQUEST','Attachment exceeds 16 MiB');parts.push(bytes);}
  if(!size)reject(400,'INVALID_REQUEST','Empty attachment');
  return Buffer.concat(parts,size);
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
const sensitiveTraceKey=/authorization|cookie|password|secret|credential|private.?key|api.?key|access.?token|refresh.?token|headers|^env$/iu;
function redactSavedText(value:string):string{return value
  .replace(/Bearer\s+[^\s"'<>]+/giu,'Bearer [REDACTED]')
  .replace(/\b(?:sk|gh[pousr]|glpat)-[A-Za-z0-9_-]{10,}\b/gu,'[REDACTED]')
  .replace(/\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{10,}\b/gu,'[REDACTED]')
  .replace(/([?&](?:X-Amz-Signature|X-Goog-Signature|sig|signature|token|api[_-]?key|key)=)[^&#\s]+/giu,'$1[REDACTED]')
  .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/giu,'$1[REDACTED]');}
function safeTraceBody(value:unknown,depth=0,coverage?:{truncated:boolean}):unknown{
  if(depth>8){if(coverage)coverage.truncated=true;return '[truncated depth]';}
  if(typeof value==='string'){if(value.length>16_384&&coverage)coverage.truncated=true;return redactSavedText(value.slice(0,16_384));}
  if(value===null||typeof value==='number'||typeof value==='boolean')return value;
  if(Array.isArray(value)){if(value.length>100&&coverage)coverage.truncated=true;return value.slice(0,100).map(item=>safeTraceBody(item,depth+1,coverage));}
  if(value&&typeof value==='object'){
    const entries=Object.entries(value);if(entries.length>100&&coverage)coverage.truncated=true;
    return Object.fromEntries(entries.slice(0,100).map(([key,item])=>[key,sensitiveTraceKey.test(key)?'[REDACTED]':safeTraceBody(item,depth+1,coverage)]));
  }
  return null;
}
function safeAgentDeclaration(...args:Parameters<typeof agentDeclarationDto>){
  const declaration=agentDeclarationDto(...args);
  if(declaration===null)return {agentDeclaration:null,agentDeclarationCoverage:null};
  const coverage={truncated:false};
  return {agentDeclaration:safeTraceBody(declaration,0,coverage),agentDeclarationCoverage:coverage.truncated?'truncated':'full'};
}
function savedResponseText(value:unknown,maxBytes=1_000_000):{output:string;coverage:'full'|'truncated';safeValue:unknown}{
  let truncated=false;
  const clean=(item:unknown,depth:number):unknown=>{
    if(depth>24){truncated=true;return '[truncated depth]';}
    if(typeof item==='string')return redactSavedText(item);
    if(item===null||typeof item==='number'||typeof item==='boolean')return item;
    if(Array.isArray(item))return item.map(value=>clean(value,depth+1));
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,value])=>[key,sensitiveTraceKey.test(key)?'[REDACTED]':clean(value,depth+1)]));
    return null;
  };
  const safeValue=clean(value,0),output=JSON.stringify(safeValue,null,2);
  if(Buffer.byteLength(output,'utf8')<=maxBytes)return {output,coverage:truncated?'truncated':'full',safeValue};
  truncated=true;
  let bytes=0,text='';for(const char of output){const size=Buffer.byteLength(char,'utf8');if(bytes+size>maxBytes)break;text+=char;bytes+=size;}
  return {output:text,coverage:'truncated',safeValue:null};
}
function safeDifferences(value:Record<string,{baseline?:unknown;candidate?:unknown;expected?:unknown;observed?:unknown}>):Record<string,Record<string,unknown>>{
  return Object.fromEntries(Object.entries(value).filter(([key])=>safeDifferenceKeys.has(key)).map(([key,pair])=>[key,Object.fromEntries(Object.entries(pair).map(([side,item])=>[side,item&&typeof item==='object'?cleanConfig(item):typeof item==='string'?item.slice(0,240):item]))]));
}
function reuseService(base:Service,cache:ScopedReadCache,scope:string,timing?:RequestTiming):Service{
  const read=<T>(key:string,ttl:number|((value:T)=>number),load:()=>Promise<T>)=>cache.get(scope,key,ttl,load,hit=>timing?.cache(hit));
  return {
    listSpaces:()=>base.listSpaces(),
    ...(base.adoptionHeads?{adoptionHeads:(spaceId)=>read(`adoptionHeads:${spaceId}`,3_000,()=>base.adoptionHeads!(spaceId))}:{}),
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
    ...(base.inputManifests?{inputManifests:spaceId=>read(`manifests:${spaceId}`,3_000,()=>base.inputManifests!(spaceId))}:{}),
    resolvePresentation:(spaceId,versionId,entrypoint)=>read(`presentation:${spaceId}:${versionId}:${entrypoint}`,5_000,()=>base.resolvePresentation(spaceId,versionId,entrypoint)),
    ...(base.readRun?{readRun:(spaceId,runId)=>read(`run:${spaceId}:${runId}`,3_000,()=>base.readRun!(spaceId,runId))}:{}),
    ...(base.readWorkflowVersion?{readWorkflowVersion:(spaceId,id)=>read(`workflow:${spaceId}:${id}`,5_000,()=>base.readWorkflowVersion!(spaceId,id))}:{}),
    ...(base.readCase?{readCase:(spaceId,id)=>read(`case:${spaceId}:${id}`,5_000,()=>base.readCase!(spaceId,id))}:{}),
    ...(base.readReview?{readReview:(spaceId,id)=>read(`review:${spaceId}:${id}`,5_000,()=>base.readReview!(spaceId,id))}:{}),
    ...(base.reviewsForRun?{reviewsForRun:(spaceId,runId)=>read(`runReviews:${spaceId}:${runId}`,2_000,()=>base.reviewsForRun!(spaceId,runId))}:{}),
    ...(base.recordReview?{recordReview:(spaceId,input)=>base.recordReview!(spaceId,input)}:{}),
    ...(base.readSavedResponseTarget?{readSavedResponseTarget:(spaceId,target)=>read(`savedResponse:${spaceId}:${JSON.stringify(target)}`,5_000,()=>base.readSavedResponseTarget!(spaceId,target))}:{}),
    ...(base.observeSavedResponseTarget?{observeSavedResponseTarget:(spaceId,target)=>base.observeSavedResponseTarget!(spaceId,target)}:{}),
    ...(base.readPublishedAssetTarget?{readPublishedAssetTarget:(spaceId,target)=>read(`publishedAsset:${spaceId}:${JSON.stringify(target)}`,5_000,()=>base.readPublishedAssetTarget!(spaceId,target))}:{}),
    ...(base.observePublishedAsset?{observePublishedAsset:(spaceId,target)=>base.observePublishedAsset!(spaceId,target)}:{}),
    ...(base.readExternalAgentObservation?{readExternalAgentObservation:(spaceId,id)=>read(`agentObservation:${spaceId}:${id}`,5_000,()=>base.readExternalAgentObservation!(spaceId,id))}:{}),
    ...(base.sessionEvents?{sessionEvents:(spaceId,sessionId,after,limit)=>read(`sessionEvents:${spaceId}:${sessionId}:${after}:${limit}`,2_000,()=>base.sessionEvents!(spaceId,sessionId,after,limit))}:{}),
    ...(base.runtimeEvents?{runtimeEvents:(spaceId,sessionId,after,limit)=>read(`runtimeEvents:${spaceId}:${sessionId}:${after}:${limit}`,2_000,()=>base.runtimeEvents!(spaceId,sessionId,after,limit))}:{}),
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
  const script=`<script>(function(){var ids=new Set(${list});function revealFocus(id){
    if(!window.Archify||!Archify.view||typeof Archify.view.reveal!=='function')return;
    var svg=document.querySelector('.diagram-container > svg');if(!svg||!svg.querySelector('.workflow-data-edges'))return;
    var target=svg.querySelector('[data-node-id="'+CSS.escape(id)+'"]');if(!target)return;
    var related=[id];if(!target.hasAttribute('data-expected-asset')&&!target.hasAttribute('data-actual-asset'))svg.querySelectorAll('.workflow-data-edge[data-edge-kind="produces"]').forEach(function(edge){
      var assetId=edge.getAttribute('data-graph-asset-id');if(edge.getAttribute('data-handoff-node-id')===id&&assetId&&ids.has(assetId)&&related.indexOf(assetId)===-1)related.push(assetId);
    });
    Archify.view.reveal(related,{includeNeighbors:related.length===1,reason:'space-parent-focus'});
  }window.addEventListener('message',function(event){if(event.source!==window.parent||!event.data||event.data.type!=='space-node-focus')return;var id=event.data.nodeId;if(id===null){window.__spaceFocusNode=null;if(window.Archify&&Archify.focus&&typeof Archify.focus.clear==='function')Archify.focus.clear({updateUrl:false,restoreFocus:false});return}if(typeof id!=='string'||!ids.has(id))return;window.__spaceFocusNode=id;if(window.Archify&&Archify.focus&&typeof Archify.focus.set==='function')Archify.focus.set(id,{toggle:false});revealFocus(id);setTimeout(function(){window.__spaceFocusNode=null},0);});})();</script>`;
  // The pinned renderer emits this message both for a click and a focus mutation.
  // Suppress only the immediate programmatic focus echo; later human selections still emit.
  const bridged=html.replaceAll("window.parent.postMessage({type:'workflow-node-select',nodeId:id}, '*')", "if(window.__spaceFocusNode!==id)window.parent.postMessage({type:'workflow-node-select',nodeId:id}, '*')");
  const css=`<style id="space-viewer-adapter">.focus-chip,.node-outline,.semantic-lens,.diagram-guide{display:none!important}html[data-present="true"] body{padding:8px!important;overflow:hidden}html[data-present="true"] .container{height:calc(100dvh - 16px)!important;max-width:none!important;gap:8px!important}html[data-present="true"] .header{display:none!important}html[data-present="true"] .workflow-legend{flex:none;margin:0;font-size:11px;padding:8px}html[data-present="true"] .diagram-container{flex:1!important;min-height:0!important;margin:0!important;padding:12px 12px 52px!important}html[data-present="true"] .diagram-container>svg{transition:transform 0s!important;height:100%!important;min-height:0!important;min-width:0!important;width:100%!important}.toolbar{display:none!important}@media(max-width:600px){.workflow-legend{font-size:10px!important;padding:5px!important;gap:4px!important}}</style>`;
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
      const understandingWrite=request.method==='POST'&&segment.length===2&&segment[0]==='understanding'&&segment[1]==='revisions';
      const designWrite=request.method==='POST'&&segment.length===2&&segment[0]==='method-design'&&segment[1]==='revisions';
      const capabilityWrite=request.method==='POST'&&segment.length===2&&segment[0]==='method-capability'&&segment[1]==='revisions';
      const executionWrite=request.method==='POST'&&segment.length===2&&segment[0]==='method-execution'&&segment[1]==='commands';
      const designPublish=request.method==='POST'&&segment.length===2&&segment[0]==='method-design'&&segment[1]==='publications';
      const reviewWrite=request.method==='POST'&&segment.length===3&&segment[0]==='runs'&&!!segment[1]&&segment[2]==='reviews';
      const observationWrite=request.method==='POST'&&segment.length===3&&segment[0]==='runs'&&!!segment[1]&&['review-observations','asset-observations'].includes(segment[2]!);
      const dispositionWrite=request.method==='POST'&&segment.length===3&&segment[0]==='runs'&&!!segment[1]&&segment[2]==='dispositions';
      const diagnosisWrite=request.method==='POST'&&segment.length===3&&segment[0]==='runs'&&!!segment[1]&&segment[2]==='diagnoses';
      const attachmentUpload=request.method==='POST'&&segment.length===2&&segment[0]==='attachments'&&segment[1]==='blobs';
      const attachmentImport=request.method==='POST'&&segment.length===2&&segment[0]==='attachments'&&segment[1]==='imports';
      if(request.method!=='GET'&&!head&&!command&&!businessWrite&&!understandingWrite&&!designWrite&&!capabilityWrite&&!executionWrite&&!designPublish&&!reviewWrite&&!observationWrite&&!dispositionWrite&&!diagnosisWrite&&!attachmentUpload&&!attachmentImport){response.setHeader('allow','GET, HEAD');reject(405,'METHOD_NOT_ALLOWED','Read-only endpoint');}
      const spaceId=decode(path[4],'space ID');
      const host=await timing.measure('host',()=>Promise.resolve(options.resolveHost({request,spaceId})));
      if(!host?.principal?.id||!host.cacheScope)reject(401,'UNAUTHENTICATED','Authentication required');
      const readableKey=readWorkflowScopeKey(host.scope);
      const scopeKey=ScopedReadCache.scopeKey({principal:host.principal,cacheScope:`${host.cacheScope}:${readableKey}`,spaceId,workflowId:host.scope.workflowId,entrypoint:host.scope.entrypoint,adoptionSlot:host.scope.adoptionSlot});
      let memberships:Awaited<ReturnType<Service['listSpaces']>>;
      try{memberships=await timing.measure('membership',()=>host.service.listSpaces());}catch(error){cache.clearScope(scopeKey);throw error;}
      if(!memberships.some(space=>space.id===spaceId)){cache.clearScope(scopeKey);reject(403,'FORBIDDEN','Space access denied');}
      const secureWrite=async()=>{
        if(!host.commandSecurity)reject(405,'METHOD_NOT_ALLOWED','Read-only endpoint');
        const security=host.commandSecurity;
        if(request.headers.origin!==security.origin||!security.origin||request.headers['x-space-csrf']!==security.csrfToken||!security.csrfToken||!await security.verifyCsrf(request,host.principal!))reject(403,'FORBIDDEN','Same-origin session verification failed');
      };
      const attachmentWriter=()=>host.principal?.kind==='human'||host.principal?.externalAgent?.role==='design';
      const attachmentDto=(blob:{id:string;sha256:string;size:number;mediaType:string})=>AttachmentSchema.parse({id:blob.id,sha256:blob.sha256,size:blob.size,mediaType:blob.mediaType});
      if(attachmentUpload){
        if(!host.attachmentWrites||!host.service.uploadBlob)reject(405,'METHOD_NOT_ALLOWED','Attachment storage unavailable');
        await secureWrite();if(!attachmentWriter())reject(403,'FORBIDDEN','Attachment writes require a human or design Agent');
        const mediaType=request.headers['content-type']?.trim();
        if(!mediaType||mediaType.length>240||/[\u0000-\u001f]/u.test(mediaType))reject(400,'INVALID_REQUEST','Attachment media type required');
        const bytes=await binaryBody(request);
        const blob=await host.service.uploadBlob(spaceId,bytes,mediaType);
        exact(blob.spaceId===spaceId&&blob.size===bytes.byteLength);
        respond(response,200,attachmentDto(blob),false);return true;
      }
      if(attachmentImport){
        if(!host.attachmentWrites||!host.service.importAsset)reject(405,'METHOD_NOT_ALLOWED','Asset import unavailable');
        await secureWrite();if(!attachmentWriter())reject(403,'FORBIDDEN','Attachment writes require a human or design Agent');
        const parsed=AttachmentImportRequestSchema.safeParse(await jsonBody(request,256*1024));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid attachment import request');
        const body=parsed.data;
        if(!Object.hasOwn(body,'payload'))reject(400,'INVALID_REQUEST','Asset payload required');
        if(new Set(body.blobIds).size!==body.blobIds.length)reject(400,'INVALID_REQUEST','Duplicate attachment IDs');
        const saved=await host.service.importAsset(spaceId,{assetId:body.assetId,expectedHead:body.expectedHead??undefined,schema:body.schema,payload:body.payload,description:body.description,blobIds:body.blobIds,dependencies:body.dependencies,idempotencyKey:body.idempotencyKey});
        exact(saved.spaceId===spaceId&&saved.assetId===body.assetId&&saved.source.kind==='import'&&saved.source.actorId===host.principal.id&&saved.attachments.length===body.blobIds.length&&saved.attachments.every(blob=>body.blobIds.includes(blob.id)));
        respond(response,200,AttachmentImportReceiptSchema.parse({assetVersionId:saved.id,assetId:saved.assetId,version:saved.version,payloadHash:saved.payloadHash,attachments:saved.attachments.map(attachmentDto)}),false);return true;
      }
      if(segment[0]==='assets'&&segment[1]&&segment[2]==='attachments'&&(segment.length===3||(segment.length===5&&segment[4]==='content'))){
        const selected=await host.service.readAsset(spaceId,segment[1]);exact(selected.spaceId===spaceId&&selected.id===segment[1]);
        if(segment.length===3){respond(response,200,AssetAttachmentsSchema.parse({assetVersionId:selected.id,assetId:selected.assetId,version:selected.version,items:selected.attachments.map(attachmentDto)}),head);return true;}
        const blob=selected.attachments.find(item=>item.id===segment[3]);
        if(!blob)reject(404,'NOT_FOUND','Attachment not bound to this asset version');
        if(!host.service.readBlob)reject(405,'METHOD_NOT_ALLOWED','Attachment storage unavailable');
        const bytes=await host.service.readBlob(spaceId,blob.id);
        exact(bytes.byteLength===blob.size);
        response.setHeader('server-timing',timing.header());
        response.writeHead(200,{'content-type':blob.mediaType,'content-length':bytes.byteLength,'cache-control':'private, no-store','content-disposition':`attachment; filename="${blob.sha256}"`,'x-content-type-options':'nosniff','x-content-sha256':blob.sha256});
        response.end(head?undefined:Buffer.from(bytes));return true;
      }
      const exactScopedRun=async(runId:string)=>{
        const selected=host.service.readRun?await host.service.readRun(spaceId,runId):find((await host.service.overview(spaceId)).runs,value=>value.runId===runId);
        exact(selected.runId===runId&&selected.spaceId===spaceId&&selected.entrypoint===host.scope.entrypoint);
        const method=host.service.readWorkflowVersion?await host.service.readWorkflowVersion(spaceId,selected.workflowVersionId):find((await host.service.overview(spaceId)).workflows,value=>value.id===selected.workflowVersionId);
        exact(method.id===selected.workflowVersionId&&method.spaceId===spaceId&&method.entrypoints[selected.entrypoint]?.workflowId===host.scope.workflowId);
        return selected;
      };
      if(observationWrite){
        if(segment[2]==='asset-observations'){
          if(!host.service.observePublishedAsset||!host.service.readPublishedAssetTarget)reject(405,'METHOD_NOT_ALLOWED','Published asset observation unavailable');
          await secureWrite();
          if(host.principal.kind!=='service'||!host.principal.externalAgent)reject(403,'FORBIDDEN','External Agent credential required');
          const runId=required(segment[1],'run ID');await exactScopedRun(runId);
          const parsed=ExternalAgentAssetObservationRequestSchema.safeParse(await jsonBody(request,4096));
          if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid published asset target');
          exact(parsed.data.target.runId===runId);
          const exactAsset=await host.service.readPublishedAssetTarget(spaceId,parsed.data.target);
          exact(exactAsset.asset.id===parsed.data.target.assetVersionId&&exactAsset.asset.payloadHash===parsed.data.target.payloadHash&&
            isRunAssetSource(exactAsset.source)&&exactAsset.source.runId===runId&&isDeepStrictEqual(exactAsset.asset.source,exactAsset.source));
          const saved=savedResponseText(exactAsset.asset.payload);
          if(saved.coverage!=='full')reject(413,'HISTORY_UNAVAILABLE','Published asset exceeds complete Agent reading limit');
          let reading:{title:string;sections:ReadingSectionDto[];readerStatus:'registered'|'fallback';reason:string|null}=
            {title:'已发布资产',sections:[],readerStatus:'fallback',reason:'此资产尚未提供专用阅读器；请阅读完整保存数据'};
          const reader=host.readers?.[`${exactAsset.asset.schema.namespace}@${exactAsset.asset.schema.revision}`];
          if(reader){try{
            const rendered=reader({...exactAsset.asset,payload:saved.safeValue});
            if(rendered&&rendered.sections.length&&rendered.sections.length<=64){
              const sections=ReadingSectionSchema.array().parse(rendered.sections).map(section=>({...section,title:redactSavedText(section.title),text:redactSavedText(section.text),...(section.sourceRefs?{sourceRefs:section.sourceRefs.map(redactSavedText)}:{})}));
              if(Buffer.byteLength(JSON.stringify(sections),'utf8')<=1_000_000)reading={title:redactSavedText(rendered.title),sections,readerStatus:'registered',reason:null};
            }
          }catch{reading.reason='阅读器无法解释这份资产；请阅读完整保存数据';}}
          let observed:Awaited<ReturnType<NonNullable<Service['observePublishedAsset']>>>;
          try{observed=await timing.measure('command',()=>host.service.observePublishedAsset!(spaceId,parsed.data.target));}finally{cache.clearScope(scopeKey);}
          exact(isDeepStrictEqual(observed.receipt.target,parsed.data.target)&&observed.receipt.observer.id===host.principal.externalAgent.id&&
            observed.receipt.observer.sessionId===host.principal.externalAgent.sessionId&&observed.receipt.observer.servicePrincipalId===host.principal.id&&
            observed.asset.id===exactAsset.asset.id&&observed.asset.payloadHash===exactAsset.asset.payloadHash);
          respond(response,200,ExternalAgentAssetObservationSchema.parse({receipt:observed.receipt,asset:{target:parsed.data.target,publication:'published',payload:saved.output,coverage:'full',reading}}),false);return true;
        }
        if(!host.service.observeSavedResponseTarget||!host.service.readSavedResponseTarget)reject(405,'METHOD_NOT_ALLOWED','External Agent observation unavailable');
        await secureWrite();
        if(host.principal.kind!=='service'||!host.principal.externalAgent)reject(403,'FORBIDDEN','External Agent credential required');
        const runId=required(segment[1],'run ID');await exactScopedRun(runId);
        const parsed=ExternalAgentObservationRequestSchema.safeParse(await jsonBody(request,4096));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid observation target');
        exact(parsed.data.target.runId===runId);
        const exactResponse=await host.service.readSavedResponseTarget(spaceId,parsed.data.target);
        exact(isDeepStrictEqual(exactResponse.target,parsed.data.target));
        const saved=savedResponseText(exactResponse.output);
        if(saved.coverage!=='full')reject(413,'HISTORY_UNAVAILABLE','Saved response exceeds complete Agent reading limit');
        let reading:{title:string;sections:ReadingSectionDto[];readerStatus:'registered'|'fallback';reason:string|null}={title:'未发布响应',sections:[],readerStatus:'fallback',reason:'此方法尚未提供响应阅读器'};
        if(host.unpublishedResponseReader){
          const view=await host.service.process(spaceId,runId);
          const occurrence=find(view.occurrences,value=>value.id===parsed.data.target.occurrenceId);
          if(occurrence.nodeId){
            try{const rendered=await host.unpublishedResponseReader({nodeId:occurrence.nodeId,output:saved.safeValue});
              if(rendered&&rendered.sections.length&&rendered.sections.length<=64){
                const sections=ReadingSectionSchema.array().parse(rendered.sections).map(section=>({...section,title:redactSavedText(section.title),text:redactSavedText(section.text),...(section.sourceRefs?{sourceRefs:section.sourceRefs.map(redactSavedText)}:{})}));
                if(Buffer.byteLength(JSON.stringify(sections),'utf8')<=1_000_000)reading={title:redactSavedText(rendered.title),sections,readerStatus:'registered',reason:rendered.reason?redactSavedText(rendered.reason):null};
              }
            }catch{reading.reason='阅读器无法解释这份响应';}
          }
        }
        let observed:Awaited<ReturnType<NonNullable<Service['observeSavedResponseTarget']>>>;
        try{observed=await timing.measure('command',()=>host.service.observeSavedResponseTarget!(spaceId,parsed.data.target));}finally{cache.clearScope(scopeKey);}
        exact(isDeepStrictEqual(observed.receipt.target,parsed.data.target)&&observed.receipt.observer.id===host.principal.externalAgent.id&&observed.receipt.observer.sessionId===host.principal.externalAgent.sessionId&&observed.receipt.observer.servicePrincipalId===host.principal.id);
        respond(response,200,ExternalAgentObservationSchema.parse({receipt:observed.receipt,response:{publication:'unpublished',output:saved.output,coverage:'full',reading}}),false);return true;
      }
      if(reviewWrite){
        if(!host.service.recordReview||!host.reviewStandard)reject(405,'METHOD_NOT_ALLOWED','Review recording unavailable');
        await secureWrite();
        const runId=required(segment[1],'run ID');await exactScopedRun(runId);
        const parsed=RunReviewRequestSchema.safeParse(await jsonBody(request,262144));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid review request');
        exact(parsed.data.runId===runId&&(!parsed.data.responseTarget||parsed.data.responseTarget.runId===runId));
        if(parsed.data.judge.kind==='human'&& (host.principal.kind!=='human'||parsed.data.judge.id!==host.principal.id))reject(403,'FORBIDDEN','Human judge identity mismatch');
        if(parsed.data.judge.kind==='agent'&&host.principal.kind!=='service')reject(403,'FORBIDDEN','Agent judge credential required');
        if(host.principal.externalAgent){if(parsed.data.judge.kind!=='agent'||parsed.data.judge.id!==host.principal.externalAgent.id||parsed.data.judge.sessionId!==host.principal.externalAgent.sessionId||!parsed.data.observationReceiptId)reject(403,'FORBIDDEN','External Agent review identity mismatch');}
        const standardTarget=parsed.data.responseTarget?{kind:'response' as const,target:parsed.data.responseTarget}:
          parsed.data.assetVersionIds.length===1?{kind:'asset' as const,assetVersionId:parsed.data.assetVersionIds[0]!}:undefined;
        const standard=await host.reviewStandard({spaceId,runId,...(standardTarget?{target:standardTarget}:{})});
        if(!standard||!isDeepStrictEqual(standard,parsed.data.standard))reject(409,'CONFLICT','Review standard differs from frozen input');
        let saved:Awaited<ReturnType<NonNullable<Service['recordReview']>>>;
        try{saved=await timing.measure('command',()=>host.service.recordReview!(spaceId,parsed.data as ReviewDraft));}finally{cache.clearScope(scopeKey);}
        exact(saved.runId===runId&&saved.id===parsed.data.id);
        respond(response,200,RunReviewSchema.parse(saved),false);return true;
      }
      if(dispositionWrite){
        if(!host.runDisposition?.save)reject(405,'METHOD_NOT_ALLOWED','Disposition recording unavailable');
        await secureWrite();
        if(host.principal.kind!=='human'&&!host.principal.externalAgent)reject(403,'FORBIDDEN','Authenticated disposition author required');
        const runId=required(segment[1],'run ID');await exactScopedRun(runId);
        const parsed=RunDispositionRequestSchema.safeParse(await jsonBody(request,262144));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid disposition request');
        if(host.principal.externalAgent&&!parsed.data.observationReceiptId)reject(403,'FORBIDDEN','External Agent observation required');
        exact(parsed.data.runId===runId&&parsed.data.evidenceRefs.every(ref=>ref.kind==='asset'||(ref.kind==='run'?ref.runId===runId:ref.target.runId===runId)));
        let saved:RunDispositionRevision;
        try{saved=await timing.measure('command',()=>host.runDisposition!.save!(spaceId,parsed.data));}finally{cache.clearScope(scopeKey);}
        exact(saved.runId===runId&&(host.principal.externalAgent?saved.author.kind==='agent'&&saved.author.id===host.principal.externalAgent.id&&saved.author.sessionId===host.principal.externalAgent.sessionId:saved.author.kind==='human'&&saved.author.id===host.principal.id));
        respond(response,200,RunDispositionRevisionSchema.parse(saved),false);return true;
      }
      if(diagnosisWrite){
        if(!host.runDiagnosis?.save)reject(405,'METHOD_NOT_ALLOWED','Run diagnosis revisions unavailable');
        await secureWrite();
        if(host.principal.kind!=='human'&&!host.principal.externalAgent)reject(403,'FORBIDDEN','Authenticated diagnosis author required');
        const runId=required(segment[1],'run ID');await exactScopedRun(runId);
        const parsed=RunDiagnosisRequestSchema.safeParse(await jsonBody(request,262144));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid run diagnosis request');
        exact(parsed.data.runId===runId);
        if(host.principal.externalAgent&&!parsed.data.observationReceiptId)reject(403,'FORBIDDEN','External Agent observation required');
        let saved:RunDiagnosisRevision;
        try{saved=await timing.measure('command',()=>host.runDiagnosis!.save!(spaceId,parsed.data));}finally{cache.clearScope(scopeKey);}
        exact(saved.runId===runId&&(host.principal.externalAgent?saved.author.kind==='agent'&&saved.author.id===host.principal.externalAgent.id&&saved.author.sessionId===host.principal.externalAgent.sessionId:saved.author.kind==='human'&&saved.author.id===host.principal.id));
        respond(response,200,RunDiagnosisRevisionSchema.parse(saved),false);return true;
      }
      if(executionWrite){
        if(!host.methodExecution?.command)reject(405,'METHOD_NOT_ALLOWED','Method execution commands unavailable');
        await secureWrite();
        if(host.principal?.kind!=='service'||host.principal.externalAgent?.role!=='design')
          reject(403,'FORBIDDEN','Design Agent credential required');
        const parsed=MethodExecutionCommandSchema.safeParse(await jsonBody(request,262144));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid method execution command');
        let result:Record<string,unknown>;
        try{result=await timing.measure('command',()=>host.methodExecution!.command!(spaceId,parsed.data));}finally{cache.clearScope(scopeKey);}
        respond(response,200,MethodExecutionStateSchema.parse(result),false);return true;
      }
      if(understandingWrite){
        if(!host.understanding?.save)reject(405,'METHOD_NOT_ALLOWED','Understanding revisions unavailable');
        await secureWrite();
        const parsed=UnderstandingRevisionRequestSchema.safeParse(await jsonBody(request,262144));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid understanding revision request');
        const agent=host.principal?.externalAgent;
        if(host.principal?.kind==='service'&&(!agent||agent.role!=='design'))reject(403,'FORBIDDEN','Design Agent credential required');
        if(agent&&(parsed.data.authorship.kind!=='agent'||parsed.data.authorship.name!==agent.id||parsed.data.authorship.sessionId!==agent.sessionId))
          reject(403,'FORBIDDEN','Understanding authorship must match the authenticated Agent');
        let saved:BusinessUnderstandingRevision;
        try{saved=await timing.measure('command',()=>host.understanding!.save!(spaceId,parsed.data));}finally{cache.clearScope(scopeKey);}
        if(agent&&saved.recordedBy!==host.principal!.id)reject(409,'RELATION_MISMATCH','Saved understanding author differs from the authenticated Agent');
        respond(response,200,UnderstandingRevisionSchema.parse(saved),false);return true;
      }
      if(capabilityWrite){
        if(!host.methodCapability?.save)reject(405,'METHOD_NOT_ALLOWED','Method capability revisions unavailable');
        await secureWrite();
        const parsed=MethodCapabilityRevisionRequestSchema.safeParse(await jsonBody(request,4*1024*1024));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid method capability revision request');
        exact(parsed.data.workflowId===host.scope.workflowId&&parsed.data.entrypoint===host.scope.entrypoint);
        const agent=host.principal?.externalAgent;
        if(host.principal?.kind==='service'&&(!agent||agent.role!=='design'))reject(403,'FORBIDDEN','Design Agent credential required');
        if(agent&&(parsed.data.authorship.kind!=='agent'||parsed.data.authorship.name!==agent.id||parsed.data.authorship.sessionId!==agent.sessionId))
          reject(403,'FORBIDDEN','Method capability authorship must match the authenticated Agent');
        let saved:MethodCapabilityRevision;
        try{saved=await timing.measure('command',()=>host.methodCapability!.save!(spaceId,parsed.data));}finally{cache.clearScope(scopeKey);}
        exact(saved.workflowId===host.scope.workflowId&&saved.entrypoint===host.scope.entrypoint&&saved.previousRevisionId===parsed.data.expectedRevisionId&&
          saved.understanding.revisionId===parsed.data.understanding.revisionId&&saved.understanding.payloadHash===parsed.data.understanding.payloadHash&&
          saved.provider.id===parsed.data.provider.id&&saved.provider.contractRevision===parsed.data.provider.contractRevision);
        if(agent&&(saved.recordedBy!==host.principal!.id||saved.authorship.kind!=='agent'||saved.authorship.name!==agent.id||saved.authorship.sessionId!==agent.sessionId))
          reject(409,'RELATION_MISMATCH','Saved method capability author differs from the authenticated Agent');
        respond(response,200,MethodCapabilityRevisionSchema.parse(saved),false);return true;
      }
      if(designWrite){
        if(!host.methodDesign?.save)reject(405,'METHOD_NOT_ALLOWED','Method design revisions unavailable');
        await secureWrite();
        const parsed=MethodDesignRevisionRequestSchema.safeParse(await jsonBody(request,262144));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid method design revision request');
        exact(parsed.data.workflowId===host.scope.workflowId&&parsed.data.entrypoint===host.scope.entrypoint);
        const agent=host.principal?.externalAgent;
        if(host.principal?.kind==='service'&&(!agent||agent.role!=='design'))reject(403,'FORBIDDEN','Design Agent credential required');
        if(agent&&(parsed.data.authorship.kind!=='agent'||parsed.data.authorship.name!==agent.id||
          parsed.data.authorship.sessionId!==agent.sessionId))
          reject(403,'FORBIDDEN','Method design authorship must match the authenticated design Agent');
        let saved:MethodDesignRevision;
        try{saved=await timing.measure('command',()=>host.methodDesign!.save!(spaceId,parsed.data));}finally{cache.clearScope(scopeKey);}
        exact(saved.workflowId===host.scope.workflowId&&saved.entrypoint===host.scope.entrypoint&&saved.understanding.revisionId===parsed.data.understanding.revisionId&&saved.understanding.payloadHash===parsed.data.understanding.payloadHash&&
          (!parsed.data.capability||saved.capability?.revisionId===parsed.data.capability.revisionId&&saved.capability.payloadHash===parsed.data.capability.payloadHash));
        if(agent&&(saved.recordedBy!==host.principal!.id||saved.authorship.kind!=='agent'||
          saved.authorship.name!==agent.id||saved.authorship.sessionId!==agent.sessionId))
          reject(409,'RELATION_MISMATCH','Saved method design author differs from the authenticated Agent');
        respond(response,200,MethodDesignRevisionSchema.parse(saved),false);return true;
      }
      if(designPublish){
        if(!host.methodDesign?.publish)reject(405,'METHOD_NOT_ALLOWED','Method publication unavailable');
        await secureWrite();
        const parsed=MethodDesignPublicationRequestSchema.safeParse(await jsonBody(request));
        if(!parsed.success)reject(400,'INVALID_REQUEST','Invalid method publication request');
        const agent=host.principal?.externalAgent;
        if(host.principal?.kind==='service'&&(!agent||agent.role!=='design'))reject(403,'FORBIDDEN','Design Agent credential required');
        const draft=await host.methodDesign.read(spaceId,parsed.data.designRevisionId);
        exact(draft.id===parsed.data.designRevisionId&&draft.workflowId===host.scope.workflowId&&draft.entrypoint===host.scope.entrypoint);
        if(agent&&(draft.recordedBy!==host.principal!.id||draft.authorship.kind!=='agent'||
          draft.authorship.name!==agent.id||draft.authorship.sessionId!==agent.sessionId))
          reject(403,'FORBIDDEN','Method design revision does not belong to the authenticated design Agent');
        let published:MethodDesignPublicationReceiptDto;
        try{published=await timing.measure('command',()=>host.methodDesign!.publish!(spaceId,parsed.data));}finally{cache.clearScope(scopeKey);}
        exact(published.versionId===parsed.data.expectedCandidateId&&published.designRevisionId===draft.id&&published.understandingRevisionId===draft.understanding.revisionId);
        respond(response,200,MethodDesignPublicationReceiptSchema.parse(published),false);return true;
      }
      if(segment[0]==='understanding'&&host.understanding){
        if(segment.length===1){
          if([...url.searchParams.keys()].some(key=>key!=='revision')||url.searchParams.getAll('revision').length>1)reject(400,'INVALID_REQUEST','Invalid understanding query');
          const revisionId=url.searchParams.get('revision');
          let result:BusinessUnderstandingRevision|null;
          try{result=revisionId===null?await host.understanding.current(spaceId):await host.understanding.read(spaceId,required(revisionId,'revision ID'));}
          catch(error){if(error instanceof Error&&error.message==='Asset is not a business understanding revision')reject(404,'NOT_FOUND','Understanding revision not found');throw error;}
          if(!result)reject(404,'NOT_FOUND','Understanding revision not found');
          if(revisionId!==null)exact(result.id===revisionId);
          respond(response,200,UnderstandingRevisionSchema.parse(result),head);return true;
        }
        if(segment.length===2&&segment[1]==='revisions'){
          const values=await host.understanding.history(spaceId);
          const page=paged(values,url,value=>`${String(value.revision).padStart(12,'0')}\u0000${value.id}`,{spaceId,cacheScope:host.cacheScope,route:'understanding/revisions',filter:''},signer,now);
          respond(response,200,UnderstandingRevisionListSchema.parse(page),head);return true;
        }
      }
      const exactVersion=async(versionId:string)=>{
        const version=host.service.readWorkflowVersion?await host.service.readWorkflowVersion(spaceId,versionId):find((await host.service.overview(spaceId)).workflows,value=>value.id===versionId);
        exact(version.id===versionId&&version.spaceId===spaceId&&version.entrypoints[host.scope.entrypoint]?.workflowId===host.scope.workflowId);
        return version;
      };
      if(segment[0]==='method-execution'&&segment.length===1&&host.methodExecution){
        if(url.search)reject(400,'INVALID_REQUEST','Invalid method execution query');
        respond(response,200,MethodExecutionStateSchema.parse(await host.methodExecution.status(spaceId)),head);return true;
      }
      if(segment[0]==='method-capability'&&host.methodCapability){
        if(segment.length===1){
          if([...url.searchParams.keys()].some(key=>key!=='revision')||url.searchParams.getAll('revision').length>1)reject(400,'INVALID_REQUEST','Invalid method capability query');
          const revisionId=url.searchParams.get('revision');
          let capability:MethodCapabilityRevision|null;
          try{capability=revisionId===null?await host.methodCapability.current(spaceId):await host.methodCapability.read(spaceId,required(revisionId,'revision ID'));}
          catch(error){if(error instanceof Error&&/Asset is not a method capability revision|Method capability logical asset does not match workflow/u.test(error.message))reject(404,'NOT_FOUND','Method capability revision not found');throw error;}
          if(!capability)reject(404,'NOT_FOUND','Method capability revision not found');
          exact(capability.workflowId===host.scope.workflowId&&capability.entrypoint===host.scope.entrypoint&&(!revisionId||capability.id===revisionId));
          respond(response,200,MethodCapabilityRevisionSchema.parse(capability),head);return true;
        }
        if(segment.length===2&&segment[1]==='revisions'){
          const values=await host.methodCapability.history(spaceId);
          exact(values.every(value=>value.workflowId===host.scope.workflowId&&value.entrypoint===host.scope.entrypoint));
          const page=paged(values,url,value=>`${String(value.revision).padStart(12,'0')}\u0000${value.id}`,{spaceId,cacheScope:host.cacheScope,route:'method-capability/revisions',filter:''},signer,now);
          respond(response,200,MethodCapabilityRevisionListSchema.parse(page),head);return true;
        }
      }
      if(segment[0]==='method-design'&&host.methodDesign){
        if(segment.length===1){
          if([...url.searchParams.keys()].some(key=>key!=='revision')||url.searchParams.getAll('revision').length>1)reject(400,'INVALID_REQUEST','Invalid method design query');
          const revisionId=url.searchParams.get('revision');
          let draft:MethodDesignRevision|null;
          try{draft=revisionId===null?await host.methodDesign.current(spaceId):await host.methodDesign.read(spaceId,required(revisionId,'revision ID'));}
          catch(error){if(error instanceof Error&&/Asset is not a method design revision|Method design logical asset does not match workflow/u.test(error.message))reject(404,'NOT_FOUND','Method design revision not found');throw error;}
          if(!draft)reject(404,'NOT_FOUND','Method design revision not found');
          exact(draft.workflowId===host.scope.workflowId&&draft.entrypoint===host.scope.entrypoint&&(!revisionId||draft.id===revisionId));
          respond(response,200,MethodDesignRevisionSchema.parse(draft),head);return true;
        }
        if(segment.length===2&&segment[1]==='revisions'){
          const values=await host.methodDesign.history(spaceId);
          exact(values.every(value=>value.workflowId===host.scope.workflowId&&value.entrypoint===host.scope.entrypoint));
          const page=paged(values,url,value=>`${String(value.revision).padStart(12,'0')}\u0000${value.id}`,{spaceId,cacheScope:host.cacheScope,route:'method-design/revisions',filter:''},signer,now);
          respond(response,200,MethodDesignRevisionListSchema.parse(page),head);return true;
        }
        if(segment.length===2&&segment[1]==='preview'){
          if(!host.methodDesign.preview)reject(404,'NOT_FOUND','Method design preview unavailable');
          if([...url.searchParams.keys()].some(key=>key!=='revision')||url.searchParams.getAll('revision').length!==1)reject(400,'INVALID_REQUEST','Invalid preview query');
          const revisionId=required(url.searchParams.get('revision')??undefined,'revision ID');
          const draft=await host.methodDesign.read(spaceId,revisionId);
          exact(draft.id===revisionId&&draft.workflowId===host.scope.workflowId&&draft.entrypoint===host.scope.entrypoint);
          const preview=await host.methodDesign.preview(spaceId,revisionId);
          exact(preview.designRevisionId===revisionId&&preview.designHash===draft.payloadHash&&preview.understandingRevisionId===draft.understanding.revisionId&&preview.understandingHash===draft.understanding.payloadHash&&preview.workflowId===draft.workflowId&&preview.entrypoint===draft.entrypoint);
          respond(response,200,MethodDesignPreviewSchema.parse(preview),head);return true;
        }
        if(segment.length===2&&(segment[1]==='definition'||segment[1]==='diagram')){
          if(!host.methodDesign.definition)reject(404,'NOT_FOUND','Method design definition unavailable');
          const diagram=segment[1]==='diagram';
          if(diagram){
            if([...url.searchParams.keys()].some(key=>!['revision','expectedCandidateId','embed'].includes(key))||
              url.searchParams.getAll('revision').length!==1||url.searchParams.getAll('expectedCandidateId').length!==1||
              url.searchParams.getAll('embed').length>1||url.searchParams.has('embed')&&url.searchParams.get('embed')!=='1')
              reject(400,'INVALID_REQUEST','Invalid diagram query');
          }else if([...url.searchParams.keys()].some(key=>key!=='revision')||url.searchParams.getAll('revision').length!==1)
            reject(400,'INVALID_REQUEST','Invalid definition query');
          const revisionId=required(url.searchParams.get('revision')??undefined,'revision ID');
          const expectedCandidateId=diagram?required(url.searchParams.get('expectedCandidateId')??undefined,'expected candidate ID'):null;
          const draft=await host.methodDesign.read(spaceId,revisionId);
          exact(draft.id===revisionId&&draft.workflowId===host.scope.workflowId&&draft.entrypoint===host.scope.entrypoint&&!!draft.capability);
          const supplied=await host.methodDesign.definition(spaceId,revisionId);
          exact(supplied.designRevisionId===draft.id&&supplied.designPayloadHash===draft.payloadHash&&
            supplied.understandingRevisionId===draft.understanding.revisionId&&supplied.understandingPayloadHash===draft.understanding.payloadHash&&
            supplied.capabilityRevisionId===draft.capability!.revisionId&&supplied.capabilityPayloadHash===draft.capability!.payloadHash&&
            supplied.workflowId===host.scope.workflowId&&supplied.entrypoint===host.scope.entrypoint);
          const candidate=supplied.version as unknown as WorkflowVersion;
          exact(candidate.id===supplied.candidateId&&candidate.entrypoints?.[supplied.entrypoint]?.workflowId===supplied.workflowId);
          if(expectedCandidateId!==null)exact(supplied.candidateId===expectedCandidateId);
          const presentation=supplied.presentation as unknown as Parameters<typeof projectExpectedAssets>[1];
          const expectedAssets=projectExpectedAssets(candidate.entrypoints[supplied.entrypoint]!,presentation);
          const diagramUrl=`${base(spaceId)}/method-design/diagram?revision=${safeId(revisionId)}&expectedCandidateId=${safeId(supplied.candidateId)}&embed=1`;
          const definition=MethodDesignDefinitionSchema.parse({...supplied,expectedAssets,diagramUrl});
          if(segment[1]==='definition'){respond(response,200,definition,head);return true;}
          const html=await renderWorkflowDiagram({entry:candidate.entrypoints[definition.entrypoint]!,presentation:definition.presentation as unknown as Parameters<typeof renderWorkflowDiagram>[0]['presentation'],detailBase:base(spaceId)});
          response.setHeader('x-method-candidate-id',definition.candidateId);
          respond(response,200,html,head,'text/html; charset=utf-8');return true;
        }
      }
      if(segment[0]==='versions'&&segment[1]&&segment[2]==='design'&&segment.length===3&&host.methodDesign){
        const versionId=required(segment[1],'version ID');await exactVersion(versionId);
        const basis=await host.methodDesign.basis(spaceId,versionId);
        if(!basis)reject(404,'NOT_FOUND','Method design basis was not recorded for this version');
        exact(basis.design.workflowId===host.scope.workflowId&&basis.design.entrypoint===host.scope.entrypoint&&basis.design.understanding.revisionId===basis.understanding.id&&basis.design.understanding.payloadHash===basis.understanding.payloadHash);
        respond(response,200,MethodDesignBasisSchema.parse(basis),head);return true;
      }
      const exactCase=async(caseId:string)=>{
        const value=host.service.readCase?await host.service.readCase(spaceId,caseId):find((await host.service.overview(spaceId)).cases,item=>item.id===caseId);
        exact(value.id===caseId&&value.spaceId===spaceId);return value;
      };
      const businessRun=async(runId:string)=>{
        const run=host.service.readRun?await host.service.readRun(spaceId,runId):find((await host.service.overview(spaceId)).runs,item=>item.runId===runId);
        exact(run.runId===runId&&run.spaceId===spaceId&&run.entrypoint===host.scope.entrypoint);
        await exactVersion(run.workflowVersionId);return run;
      };
      const readableRun=async(runId:string)=>{
        const run=host.service.readRun?await host.service.readRun(spaceId,runId):find((await host.service.overview(spaceId)).runs,item=>item.runId===runId);
        exact(run.runId===runId&&run.spaceId===spaceId&&run.entrypoint===host.scope.entrypoint);
        const version=host.service.readWorkflowVersion?await host.service.readWorkflowVersion(spaceId,run.workflowVersionId):find((await host.service.overview(spaceId)).workflows,item=>item.id===run.workflowVersionId);
        exact(version.id===run.workflowVersionId&&version.spaceId===spaceId&&canReadWorkflow(host.scope,version.entrypoints[run.entrypoint]?.workflowId));
        return {run,version};
      };
      if(segment[0]==='runs'&&segment[1]&&segment[2]==='occurrences'&&segment[3]&&segment[4]==='runtime'&&segment.length===5){
        if(!host.service.runtimeEvents)reject(404,'HISTORY_UNAVAILABLE','Saved runner events unavailable');
        if([...url.searchParams.keys()].some(key=>!['attemptId','after','limit'].includes(key))||url.searchParams.getAll('attemptId').length!==1||url.searchParams.getAll('after').length>1||url.searchParams.getAll('limit').length>1)reject(400,'INVALID_REQUEST','Invalid runtime event query');
        const runId=required(segment[1],'run ID'),occurrenceId=required(segment[3],'occurrence ID');
        const attemptId=required(url.searchParams.get('attemptId')??undefined,'attempt ID');
        const after=Number(url.searchParams.get('after')??'0'),limit=Number(url.searchParams.get('limit')??'100');
        if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)reject(400,'INVALID_REQUEST','Invalid runtime event cursor or limit');
        const {run,version}=await readableRun(runId);
        const view=await host.service.process(spaceId,runId);
        exact(view.run.spaceId===spaceId&&view.run.runId===runId&&view.run.workflowVersionId===run.workflowVersionId);
        const occurrence=find(view.occurrences,value=>value.id===occurrenceId);
        if(!occurrence.attemptIds.includes(attemptId))reject(404,'NOT_FOUND','Attempt not found in authorized occurrence');
        const contexts=await Promise.all(occurrence.contextIds.map(id=>host.service.readContext(spaceId,id)));
        const matching=contexts.filter(context=>context.runId===runId&&context.spaceId===spaceId&&context.attemptId===attemptId&&occurrence.stepRunIds.includes(context.stepRunId));
        if(matching.length!==1)reject(404,'HISTORY_UNAVAILABLE','Exact runner context unavailable');
        const context=matching[0]!;
        if(context.producer!=='agent')reject(409,'RELATION_MISMATCH','Selected attempt is a program step with no Agent runner evidence');
        const page=await host.service.runtimeEvents(spaceId,context.sessionId,after,limit);
        exact(page.items.length<=limit&&page.nextCursor>=after&&page.items.every(event=>event.sessionId===context.sessionId&&event.seq>after&&event.seq<=page.nextCursor));
        const relevant=page.items.filter(event=>event.attemptId===attemptId);
        const projected=runtimeEventReadings(relevant,safeTraceBody);
        const frozenPrompt=version.entrypoints[run.entrypoint]?.nodeDefinitions?.[occurrence.nodeId??'']?.instructions??null;
        respond(response,200,OccurrenceRuntimeSchema.parse({runId,occurrenceId,versionId:version.id,stepRunId:context.stepRunId,attemptId,contextId:context.id,sessionId:context.sessionId,
          frozenPrompt:frozenPrompt===null?null:redactSavedText(frozenPrompt.slice(0,16_384)),frozenPromptCoverage:frozenPrompt===null?'unrecorded':frozenPrompt.length>16_384?'truncated':'full',
          contextInstructions:redactSavedText(context.instructions.slice(0,16_384)),contextInstructionsCoverage:context.instructions.length>16_384?'truncated':'full',effectiveConfig:cleanConfig(context.effectiveConfig),
          ...projected,nextCursor:page.nextCursor,hasMore:page.hasMore,scanComplete:!page.hasMore,
          observedCallCount:after===0&&!page.hasMore?projected.events.filter(event=>event.type==='siwc.tool_call').length:null,
          bodyCoverage:projected.events.some(event=>event.bodyCoverage==='truncated')?'truncated':'full',evidenceScope:'saved-runner-events-only',
          snapshotAt:now().toISOString(),sanitized:true}),head);return true;
      }
      if(segment[0]==='runs'&&segment[1]&&segment[2]==='sessions'&&segment[3]&&segment[4]==='events'&&segment.length===5){
        if(!host.service.sessionEvents)reject(404,'HISTORY_UNAVAILABLE','Saved session events unavailable');
        if([...url.searchParams.keys()].some(key=>key!=='after'&&key!=='limit')||url.searchParams.getAll('after').length>1||url.searchParams.getAll('limit').length>1)reject(400,'INVALID_REQUEST','Invalid event query');
        const runId=required(segment[1],'run ID'),sessionId=required(segment[3],'session ID');
        const afterText=url.searchParams.get('after'),limitText=url.searchParams.get('limit');
        const after=afterText===null?0:Number(afterText),limit=limitText===null?50:Number(limitText);
        if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)reject(400,'INVALID_REQUEST','Invalid event cursor or limit');
        const {run}=await readableRun(runId);
        const view=await host.service.process(spaceId,runId);
        exact(view.run.spaceId===spaceId&&view.run.runId===runId&&view.run.workflowVersionId===run.workflowVersionId&&view.run.caseId===run.caseId);
        const matching=view.occurrences.filter(value=>value.sessionIds.includes(sessionId));
        if(!matching.length)reject(404,'NOT_FOUND','Session not found in authorized run');
        const contextIds=[...new Set(matching.flatMap(value=>value.contextIds))];
        const contexts=await Promise.all(contextIds.map(id=>host.service.readContext(spaceId,id)));
        const allowedAttempts=new Set(contexts.filter(value=>value.runId===runId&&value.sessionId===sessionId&&matching.some(occurrence=>occurrence.contextIds.includes(value.id)&&occurrence.stepRunIds.includes(value.stepRunId))).map(value=>value.attemptId));
        if(!allowedAttempts.size)reject(404,'NOT_FOUND','Session not found in authorized run');
        const page=await host.service.sessionEvents(spaceId,sessionId,after,limit);
        exact(page.items.length<=limit&&page.nextCursor>=after&&page.items.every(value=>value.sessionId===sessionId&&value.seq>after&&value.seq<=page.nextCursor));
        respond(response,200,RunSessionEventsSchema.parse({runId,sessionId,items:page.items.filter(value=>allowedAttempts.has(value.attemptId)).map(value=>({id:value.id,seq:value.seq,attemptId:value.attemptId,kind:value.kind,body:safeTraceBody(value.body),createdAt:value.createdAt})),nextCursor:page.nextCursor,hasMore:page.hasMore,snapshotAt:now().toISOString()}),head);return true;
      }
      if(segment[0]==='runs'&&segment[1]&&segment[2]==='occurrences'&&segment[3]&&segment[4]==='responses'&&segment.length===5){
        if(!host.service.sessionEvents)reject(404,'HISTORY_UNAVAILABLE','Saved session responses unavailable');
        if([...url.searchParams.keys()].length)reject(400,'INVALID_REQUEST','Invalid response query');
        const runId=required(segment[1],'run ID'),occurrenceId=required(segment[3],'occurrence ID');
        const {run}=await readableRun(runId),view=await host.service.process(spaceId,runId);
        exact(view.run.spaceId===spaceId&&view.run.runId===runId&&view.run.workflowVersionId===run.workflowVersionId&&view.run.caseId===run.caseId);
        const occurrence=find(view.occurrences,value=>value.id===occurrenceId);
        const responses=[] as Array<{stepRunId:string;attemptId:string;sessionId:string;eventId:string;eventSeq:number;publication:'unpublished';output:string;coverage:'full'|'truncated';reading:{title:string;sections:ReadingSectionDto[];readerStatus:'registered'|'fallback';reason:string|null}}>;
        if(occurrence.state==='failed'&&!occurrence.outputBindings.length){
          const agentSteps=new Set(occurrence.technicalSteps.filter(value=>value.kind==='agent').map(value=>value.id));
          const contexts=await Promise.all(occurrence.contextIds.map(id=>host.service.readContext(spaceId,id)));
          for(const context of contexts){
            exact(context.runId===runId&&occurrence.stepRunIds.includes(context.stepRunId));
            if(!agentSteps.has(context.stepRunId)||!occurrence.attemptIds.includes(context.attemptId))continue;
            let after=0,hasMore=true,last:Awaited<ReturnType<NonNullable<Service['sessionEvents']>>>['items'][number]|undefined;
            for(let pageNumber=0;hasMore&&pageNumber<100;pageNumber++){
              const page=await host.service.sessionEvents(spaceId,context.sessionId,after,1000);
              exact(page.items.length<=1000&&page.nextCursor>=after&&page.items.every(value=>value.sessionId===context.sessionId&&value.seq>after&&value.seq<=page.nextCursor));
              for(const event of page.items){
                const body=event.body as {role?:unknown;output?:unknown}|null;
                if(event.attemptId===context.attemptId&&event.kind==='message'&&body?.role==='assistant'&&body.output!==undefined)last=event;
              }
              if(page.hasMore&&page.nextCursor===after)reject(502,'HISTORY_UNAVAILABLE','Saved response pagination did not advance');
              after=page.nextCursor;hasMore=page.hasMore;
            }
            if(hasMore)reject(413,'HISTORY_UNAVAILABLE','Saved response history exceeds bounded read');
            if(last){
              if(responses.length>=16)reject(413,'HISTORY_UNAVAILABLE','Too many saved responses for bounded read');
              const body=last.body as {output:unknown};
              const used=responses.reduce((sum,item)=>sum+Buffer.byteLength(item.output,'utf8'),0);
              const saved=savedResponseText(body.output,Math.max(0,1_000_000-used));
              let reason=saved.coverage==='truncated'?'保存的响应超过阅读上限，无法完整解析':!occurrence.nodeId?'此执行记录没有业务节点':!host.unpublishedResponseReader?'此方法尚未提供响应阅读器':'阅读器无法解释这份响应';
              let reading:{title:string;sections:ReadingSectionDto[];readerStatus:'registered'|'fallback';reason:string|null}={title:'未发布响应',sections:[],readerStatus:'fallback',reason};
              if(saved.coverage==='full'&&occurrence.nodeId&&host.unpublishedResponseReader){
                try{
                  const rendered=await host.unpublishedResponseReader({nodeId:occurrence.nodeId,output:saved.safeValue});
                  if(rendered&&rendered.sections.length&&rendered.sections.length<=64){
                    const sections=ReadingSectionSchema.array().parse(rendered.sections).map(section=>({...section,title:redactSavedText(section.title),text:redactSavedText(section.text),...(section.sourceRefs?{sourceRefs:section.sourceRefs.map(redactSavedText)}:{})}));
                    if(Buffer.byteLength(JSON.stringify(sections),'utf8')<=1_000_000){
                      reading={title:redactSavedText(rendered.title),sections,readerStatus:'registered',reason:rendered.reason?redactSavedText(rendered.reason):null};
                    }else reason='阅读器生成的内容超过阅读上限';
                  }
                }catch{reason='阅读器无法解释这份响应';}
                if(reading.readerStatus==='fallback')reading.reason=reason;
              }
              responses.push({stepRunId:context.stepRunId,attemptId:context.attemptId,sessionId:context.sessionId,eventId:last.id,eventSeq:last.seq,publication:'unpublished',output:saved.output,coverage:saved.coverage,reading});
            }
          }
        }
        respond(response,200,UnpublishedResponsesSchema.parse({runId,occurrenceId,responses}),head);return true;
      }
      if(segment[0]==='runs'&&segment[1]&&segment[2]==='review-observations'&&segment.length===4&&host.service.readExternalAgentObservation){
        const runId=required(segment[1],'run ID'),receiptId=required(segment[3],'observation ID');await readableRun(runId);
        const receipt=await host.service.readExternalAgentObservation(spaceId,receiptId);
        exact(receipt.id===receiptId&&receipt.target.runId===runId);
        respond(response,200,ExternalAgentObservationReceiptUnionSchema.parse(receipt),head);return true;
      }
      if(segment[0]==='runs'&&segment[1]&&['review-subjects','reviews','dispositions'].includes(segment[2]??'')){
        const runId=required(segment[1],'run ID'),{run:selected}=await readableRun(runId);
        if(segment[2]==='review-subjects'&&segment.length===3){
          const view=await host.service.process(spaceId,runId);
          exact(view.run.runId===runId&&view.run.spaceId===spaceId&&view.run.caseId===selected.caseId&&view.run.workflowVersionId===selected.workflowVersionId);
          const assets=host.service.runAssets?await host.service.runAssets(spaceId,runId):(await host.service.overview(spaceId)).assets.filter(value=>isRunAssetSource(value.source)&&value.source.runId===runId);
          const subjects:Array<({kind:'asset';asset:AssetSummaryDto;target:PublishedAssetTargetDto}|{kind:'response';target:SavedResponseTargetDto;occurrenceLabel:string})&{standard?:{id:string;revision:string;content:string}|null}>=assets.filter(value=>isRunAssetSource(value.source)&&value.source.runId===runId).map(value=>({kind:'asset' as const,asset:assetDto({runs:[selected]},value),target:{runId,assetVersionId:value.id,payloadHash:value.payloadHash}}));
          if(host.service.sessionEvents&&host.service.readSavedResponseTarget){
            for(const occurrence of view.occurrences.filter(value=>value.state==='failed'&&!value.outputBindings.length)){
              const agentSteps=new Set(occurrence.technicalSteps.filter(step=>step.kind==='agent').map(step=>step.id));
              const contexts=await Promise.all(occurrence.contextIds.map(id=>host.service.readContext(spaceId,id)));
              for(const context of contexts){
                exact(context.runId===runId&&occurrence.stepRunIds.includes(context.stepRunId));
                if(!agentSteps.has(context.stepRunId)||!occurrence.attemptIds.includes(context.attemptId))continue;
                let after=0,hasMore=true,last:Awaited<ReturnType<NonNullable<Service['sessionEvents']>>>['items'][number]|undefined;
                for(let pageNumber=0;hasMore&&pageNumber<100;pageNumber++){
                  const page=await host.service.sessionEvents(spaceId,context.sessionId,after,1000);
                  exact(page.items.length<=1000&&page.nextCursor>=after&&page.items.every(value=>value.sessionId===context.sessionId&&value.seq>after&&value.seq<=page.nextCursor));
                  for(const event of page.items){const body=event.body as {role?:unknown;output?:unknown}|null;
                    if(event.attemptId===context.attemptId&&event.kind==='message'&&body?.role==='assistant'&&body.output!==undefined)last=event;}
                  if(page.hasMore&&page.nextCursor===after)reject(502,'HISTORY_UNAVAILABLE','Saved response pagination did not advance');
                  after=page.nextCursor;hasMore=page.hasMore;
                }
                if(hasMore)reject(413,'HISTORY_UNAVAILABLE','Saved response history exceeds bounded read');
                if(!last)continue;
                const target:SavedResponseTargetDto={runId,occurrenceId:occurrence.id,stepRunId:context.stepRunId,attemptId:context.attemptId,sessionId:context.sessionId,eventId:last.id,eventSeq:last.seq,outputHash:await artifactPayloadSha256((last.body as {output:unknown}).output)};
                const verified=await host.service.readSavedResponseTarget(spaceId,target);
                exact(isDeepStrictEqual(verified.target,target));
                subjects.push({kind:'response',target,occurrenceLabel:occurrence.nodeId??occurrence.id});
              }
            }
          }
          const failures=[...new Map(view.occurrences.flatMap(value=>value.technicalSteps.filter(step=>step.state==='failed'&&step.error).map(step=>[step.id,{stepRunId:step.id,key:step.key,error:step.error!}] as const))).values()];
          const standard=host.reviewStandard?await host.reviewStandard({spaceId,runId}):null;
          if(host.reviewStandard){for(const subject of subjects){
            subject.standard=await host.reviewStandard({spaceId,runId,target:subject.kind==='asset'?{kind:'asset',assetVersionId:subject.asset.id}:{kind:'response',target:subject.target}});
          }}
          respond(response,200,ReviewSubjectsSchema.parse({runId,caseId:selected.caseId,versionId:selected.workflowVersionId,standard,subjects,failures}),head);return true;
        }
        if(segment[2]==='reviews'){
          if(segment.length===3){
            const values=host.service.reviewsForRun?await host.service.reviewsForRun(spaceId,runId):(await host.service.overview(spaceId)).reviews.filter(value=>value.runId===runId);
            exact(values.every(value=>value.runId===runId&&value.spaceId===spaceId));
            respond(response,200,listSchema(RunReviewSchema).parse(paged(values,url,value=>`${value.createdAt}\u0000${value.id}`,{spaceId,cacheScope:`${host.cacheScope}:${readableKey}`,route:`runs/${runId}/reviews`,filter:''},signer,now)),head);return true;
          }
          if(segment.length===4){const review=host.service.readReview?await host.service.readReview(spaceId,segment[3]!):find((await host.service.overview(spaceId)).reviews,value=>value.id===segment[3]);exact(review.id===segment[3]&&review.spaceId===spaceId&&review.runId===runId);respond(response,200,RunReviewSchema.parse(review),head);return true;}
        }
        if(segment[2]==='dispositions'&&host.runDisposition){
          if(segment.length===3){const values=await host.runDisposition.list(spaceId,runId);exact(values.every(value=>value.runId===runId));respond(response,200,listSchema(RunDispositionRevisionSchema).parse(paged(values,url,value=>`${String(value.revision).padStart(12,'0')}\u0000${value.id}`,{spaceId,cacheScope:`${host.cacheScope}:${readableKey}`,route:`runs/${runId}/dispositions`,filter:''},signer,now)),head);return true;}
          if(segment.length===4){const value=await host.runDisposition.read(spaceId,segment[3]!);exact(value.id===segment[3]&&value.runId===runId);respond(response,200,RunDispositionRevisionSchema.parse(value),head);return true;}
        }
      }
      if(segment[0]==='runs'&&segment[1]&&host.runDiagnosis&&['diagnosis','diagnoses'].includes(segment[2]??'')){
        const runId=required(segment[1],'run ID'),{run:selected}=await readableRun(runId);
        if(segment[2]==='diagnosis'&&segment.length===3){
          const current=await host.runDiagnosis.current(spaceId,runId);
          if(current)exact(current.runId===runId&&current.workflowVersionId===selected.workflowVersionId);
          respond(response,200,current?RunDiagnosisRevisionSchema.parse(current):null,head);return true;
        }
        if(segment[2]==='diagnoses'&&segment.length===3){
          const values=await host.runDiagnosis.list(spaceId,runId);
          exact(values.every(value=>value.runId===runId&&value.workflowVersionId===selected.workflowVersionId));
          const page=paged(values,url,value=>`${String(value.revision).padStart(12,'0')}\u0000${value.id}`,{spaceId,cacheScope:`${host.cacheScope}:${readableKey}`,route:`runs/${runId}/diagnoses`,filter:''},signer,now);
          respond(response,200,RunDiagnosisRevisionListSchema.parse(page),head);return true;
        }
        if(segment[2]==='diagnoses'&&segment.length===4){
          const revisionId=required(segment[3],'diagnosis revision ID'),value=await host.runDiagnosis.read(spaceId,revisionId);
          exact(value.id===revisionId&&value.runId===runId&&value.workflowVersionId===selected.workflowVersionId);
          respond(response,200,RunDiagnosisRevisionSchema.parse(value),head);return true;
        }
      }
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
          exact(asset.spaceId===spaceId&&isRunAssetSource(asset.source)&&asset.source.runId===runId);
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
        if(businessWrite==='start'&&(await host.availability?.(versionId))?.state!=='available')reject(409,'UNAVAILABLE','Exact method executor is unavailable');
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
          if(command==='start'&&(await host.availability?.(selected.workflowVersionId))?.state!=='available')reject(409,'UNAVAILABLE','Exact method executor is unavailable');
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
        exact(asset.spaceId===spaceId&&isRunAssetSource(asset.source)&&asset.source.runId===runId);
        const notes=await host.business.handlingNotes({spaceId,caseId:run.caseId,runId,assetId,limit:101});
        exact(notes.length<=101&&notes.every(note=>note.caseId===run.caseId&&note.runId===runId&&note.subjectAssetId===assetId&&note.verification==='declared-external'));
        respond(response,200,HandlingNoteListSchema.parse({items:notes.slice(0,100),truncated:notes.length>100,nextCursor:null,snapshotAt:now().toISOString()}),head);return true;
      }
      if(segment[0]==='summary'&&segment.length===1&&authenticated.service.spaceSummary){
        const snapshot=await timing.measure('subject',()=>authenticated.service.spaceSummary!(spaceId,host.scope));
        exact(snapshot.space.id===spaceId);
        const designState=host.businessState?await host.businessState(spaceId):null;
        if(designState)exact(designState.space.id===spaceId&&designState.scope.workflowId===host.scope.workflowId&&designState.scope.entrypoint===host.scope.entrypoint);
        respond(response,200,SummarySchema.parse({id:spaceId,title:snapshot.space.purpose,purpose:snapshot.space.purpose,
          subject:{id:authenticated.principal!.id,cacheScope:authenticated.cacheScope,kind:authenticated.principal!.kind,...(authenticated.principal!.externalAgent?{externalAgent:authenticated.principal!.externalAgent}:{})},
          methodScope:{workflowId:host.scope.workflowId,entrypoint:host.scope.entrypoint,adoptionSlot:host.scope.adoptionSlot??null},
          adoptedVersionId:snapshot.adoptedVersionId,latestVersionId:snapshot.latestVersionId,
          counts:{versions:snapshot.versionCount,cases:snapshot.caseCount,runs:snapshot.runCount,assets:snapshot.assetCount},
          ...(designState?{businessState:{...designState.counts,understandingRevisionId:designState.understandingRevisionId}}:{}),
          capabilities:{read:true,attachmentWrite:!!(authenticated.attachmentWrites&&host.service.uploadBlob&&host.service.importAsset&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),write:!!((authenticated.commands||authenticated.business||(authenticated.attachmentWrites&&(host.service.uploadBlob||host.service.importAsset))||authenticated.understanding?.save||authenticated.methodCapability?.save||authenticated.methodDesign?.save||authenticated.methodDesign?.publish||authenticated.methodExecution?.command||authenticated.service.recordReview||authenticated.service.observeSavedResponseTarget||authenticated.service.observePublishedAsset||authenticated.runDisposition?.save||authenticated.runDiagnosis?.save)&&authenticated.commandSecurity),understandingWrite:!!(authenticated.understanding?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),methodCapabilityRead:!!authenticated.methodCapability,methodCapabilityWrite:!!(authenticated.methodCapability?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),methodDesignRead:!!authenticated.methodDesign,methodDesignWrite:!!(authenticated.methodDesign?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),methodPublish:!!(authenticated.methodDesign?.publish&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),methodExecutionRead:!!authenticated.methodExecution,methodExecutionWrite:!!(authenticated.methodExecution?.command&&authenticated.commandSecurity&&authenticated.principal?.kind==='service'&&authenticated.principal?.externalAgent?.role==='design'),reviewRead:true,reviewWrite:!!(authenticated.service.recordReview&&authenticated.reviewStandard&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent)),observationRead:!!authenticated.service.readExternalAgentObservation,observationWrite:!!((authenticated.service.observeSavedResponseTarget||authenticated.service.observePublishedAsset)&&authenticated.commandSecurity&&authenticated.principal?.externalAgent),dispositionRead:!!authenticated.runDisposition,dispositionWrite:!!(authenticated.runDisposition?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent)),diagnosisRead:!!authenticated.runDiagnosis,diagnosisWrite:!!(authenticated.runDiagnosis?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent))},
          csrfToken:(authenticated.commands||authenticated.business||(authenticated.attachmentWrites&&(host.service.uploadBlob||host.service.importAsset))||authenticated.understanding?.save||authenticated.methodCapability?.save||authenticated.methodDesign?.save||authenticated.methodDesign?.publish||authenticated.methodExecution?.command||authenticated.service.recordReview||authenticated.service.observeSavedResponseTarget||authenticated.service.observePublishedAsset||authenticated.runDisposition?.save||authenticated.runDiagnosis?.save)&&authenticated.commandSecurity?authenticated.commandSecurity.csrfToken:null,
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
        const method=await getVersion(run.workflowVersionId);exact(run.entrypoint===host.scope.entrypoint&&method.spaceId===spaceId&&canReadWorkflow(host.scope,method.entrypoints[run.entrypoint]?.workflowId));
        const assets=await Promise.all(review.assetVersionIds.map(id=>authenticated.service.readAsset(spaceId,id)));
        for(const asset of assets)exact(asset.spaceId===spaceId&&isRunAssetSource(asset.source)&&asset.source.runId===run.runId);
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
            version.spaceId!==spaceId||!version.entrypoints[entry.entrypoint]||!canReadWorkflow(host.scope,version.entrypoints[entry.entrypoint]?.workflowId)||caseValue.spaceId!==spaceId||
            manifest.spaceId!==spaceId||manifest.id!==entry.inputManifestId||manifest.caseId!==entry.caseId||
            asset.spaceId!==spaceId||asset.id!==review.assetVersionIds[0]||!isRunAssetSource(asset.source)||asset.source.runId!==run.runId)return null;
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
      const listScope=(route:string,filter='')=>({spaceId,cacheScope:`${authenticated.cacheScope!}:${readableKey}`,route,filter});
      const available=async(id:string):Promise<AvailabilityDto>=>await authenticated.availability?.(id)??{state:'unknown',reason:null};
      const methodVersion=async(id:string)=>{
        const method=await getVersion(id);
        exact(method.spaceId===spaceId&&canReadWorkflow(host.scope,method.entrypoints[host.scope.entrypoint]?.workflowId));
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
      const executionMode=async(runId:string)=>authenticated.runExecutionMode?authenticated.runExecutionMode({spaceId,runId}):null;
      if(segment[0]==='cases'&&segment[1]&&segment[2]==='inputs'&&segment.length===3){
        if([...url.searchParams.keys()].some(key=>!['manifestId','after','limit'].includes(key))||
          url.searchParams.getAll('manifestId').length>1||url.searchParams.getAll('after').length>1||url.searchParams.getAll('limit').length>1||
          (url.searchParams.has('manifestId')&&(url.searchParams.has('after')||url.searchParams.has('limit'))))
          reject(400,'INVALID_REQUEST','Invalid Case frozen input query');
        const caseId=required(segment[1],'case ID');await exactCase(caseId);
        const requestedId=url.searchParams.has('manifestId')?required(url.searchParams.get('manifestId')??undefined,'manifest ID'):null;
        const after=url.searchParams.has('after')?required(url.searchParams.get('after')??undefined,'manifest cursor'):undefined;
        const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100;
        if(!Number.isSafeInteger(limit)||limit<1||limit>100)reject(400,'INVALID_REQUEST','Invalid Case frozen input page size');
        if(!requestedId&&!authenticated.service.inputManifests)reject(404,'HISTORY_UNAVAILABLE','Case frozen input history unavailable');
        const records=requestedId?[await authenticated.service.readManifest(spaceId,requestedId)]:
          (await authenticated.service.inputManifests!(spaceId)).filter(record=>record.spaceId===spaceId&&record.caseId===caseId&&(!after||record.id>after))
            .sort((a,b)=>a.id.localeCompare(b.id)).slice(0,limit+1);
        for(const record of records)if(record.spaceId!==spaceId||record.caseId!==caseId)
          reject(404,'NOT_FOUND','Frozen input manifest not found in this Case');
        const hasMore=!requestedId&&records.length>limit,selected=records.slice(0,limit);
        const ids=[...new Set(selected.flatMap(record=>Object.values(record.assets)))];
        const assets=ids.length?(authenticated.service.readAssetsByIds?await authenticated.service.readAssetsByIds(spaceId,ids):await Promise.all(ids.map(id=>authenticated.service.readAsset(spaceId,id)))):[];
        const byId=new Map(assets.map(value=>[value.id,value]));
        const manifests=await Promise.all(selected.map(async record=>({id:record.id,hash:record.hash,
          slots:await Promise.all(Object.entries(record.assets).map(async([slot,id])=>{
            const value=byId.get(id);
            if(!value||value.spaceId!==spaceId||value.id!==id)reject(404,'NOT_FOUND','Frozen input asset unavailable');
            return {slot,asset:await scopedAsset({runs:[]},value),payloadHash:value.payloadHash,readingUrl:`${base(spaceId)}/assets/${safeId(id)}/reading`};
          }))})));
        respond(response,200,CaseFrozenInputsSchema.parse({caseId,manifests,hasMore,nextCursor:hasMore?selected.at(-1)!.id:null,snapshotAt:now().toISOString()}),head);return true;
      }
      const exactRunSummary=async(selected:SpaceRun,method:WorkflowVersion,caseValue:SpaceCase,assets:SpaceOverview['assets'])=>{
        const [task,resolved]=await Promise.all([
          authenticated.service.getExecutionTask?authenticated.service.getExecutionTask(spaceId,selected.runId):authenticated.service.executionTasks(spaceId).then(rows=>rows.find(row=>row.runId===selected.runId)),
          authenticated.runSummary?.({spaceId,run:selected,version:method,case:caseValue})
        ]);
        return runDto({assets},selected,task?{status:task.status,error:task.error,createdAt:task.createdAt}:undefined,resolved,await executionMode(selected.runId));
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
            const [stats,plans]=await Promise.all([authenticated.service.versionRunStats(spaceId,selected.id,host.scope.entrypoint,selectedEntry.workflowId),authenticated.service.validationPlans(spaceId)]);
            const value=versionDto({runs:[]},selected,host.scope.entrypoint,await available(selected.id),planIds(plans,selected.id),stats,presentation?.presentation.label,host.displayTimeZone);
            respond(response,200,VersionDetailSchema.parse({...value,...await methodEvidence(authenticated.service,spaceId,selected,host.scope.entrypoint,presentation?.presentation),hash:selected.hash,purpose:presentation?.presentation.purpose??null,designBasis:selected.designBasis??null,nodes:selectedEntry.process?.nodes.map(node=>nodeDto(selectedEntry,node,labels.get(node.id)))??[],graphUrl:selectedEntry.process?`${base(spaceId)}/versions/${safeId(selected.id)}/graph`:null}),head);return true;
          }
          if(segment[2]==='nodes'){
            const node=find(selectedEntry.process?.nodes??[],value=>value.id===segment[3]);const definition=selectedEntry.nodeDefinitions?.[node.id];
            respond(response,200,NodeDetailSchema.parse({...nodeDto(selectedEntry,node,labels.get(node.id)),versionId:selected.id,instructions:definition?.instructions??null,configuration:definition?.configuration?cleanConfig(definition.configuration):null,...safeAgentDeclaration(selectedEntry,node)}),head);return true;
          }
          if(!selectedEntry.process)reject(404,'HISTORY_UNAVAILABLE','Historical graph was not recorded');
          const html=await renderWorkflowDiagram({entry:selectedEntry,presentation:presentation?.presentation,detailBase:base(spaceId)});
          respond(response,200,bridgeWorkflowDiagram(html,methodGraphIds(selectedEntry,presentation?.presentation)),head,'text/html; charset=utf-8');return true;
        }
      }
      if(segment[0]==='cases'&&segment[1]&&segment[2]==='runs'&&segment.length===3&&authenticated.service.caseRunsPage&&authenticated.service.runAssets){
        const selectedCase=await timing.measure('subject',()=>getCase(segment[1]!));exact(selectedCase.spaceId===spaceId);
        const scope=listScope(`cases/${selectedCase.id}/runs`),page=pageRequest(url,scope,signer);
        const rows=await authenticated.service.caseRunsPage(spaceId,selectedCase.id,readableWorkflowIds(host.scope),host.scope.entrypoint,page.after,page.limit+1);
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
        if(segment[2]==='inputs'&&segment.length===3){
          const manifest=await authenticated.service.readManifest(spaceId,selected.inputManifestId);
          exact(manifest.spaceId===spaceId&&manifest.id===selected.inputManifestId&&manifest.caseId===selected.caseId);
          const entries=Object.entries(manifest.assets);
          const assets=await authenticated.service.readAssetsByIds(spaceId,entries.map(([,id])=>id));
          const byId=new Map(assets.map(value=>[value.id,value]));
          const slots=await Promise.all(entries.map(async([slot,id])=>{const value=byId.get(id);if(!value)reject(404,'NOT_FOUND','Frozen input asset unavailable');return {slot,asset:await scopedAsset({runs:[selected]},value),payloadHash:value.payloadHash};}));
          respond(response,200,RunInputManifestSchema.parse({runId:selected.runId,caseId:selected.caseId,versionId:method.id,inputManifestId:manifest.id,inputManifestHash:manifest.hash,slots}),head);return true;
        }
        if((segment[2]==='process'&&segment.length===3)||(segment[2]==='graph'&&segment.length===3)||(segment[2]==='occurrences'&&segment.length===4)){
          const view=await timing.measure('process',()=>authenticated.service.process(spaceId,selected.runId));
          exact(view.run.spaceId===spaceId&&view.run.runId===selected.runId&&view.run.workflowVersionId===method.id&&view.run.caseId===caseValue.id&&view.run.entrypoint===selected.entrypoint&&view.run.inputManifestId===selected.inputManifestId);
          const selectedEntry=entry(method,selected.entrypoint);
          const presentation=await authenticated.service.resolvePresentation(spaceId,method.id,selected.entrypoint);
          const labels=new Map(presentation?.presentation.stages?.map(stage=>[stage.id,stage.label])??[]);
          if(segment[2]==='graph'){
            if(!view.contract)reject(404,'HISTORY_UNAVAILABLE','Run process graph unavailable');
            const actualAssets=await loadRunGraphAssets(authenticated.service,spaceId,view);
            const html=await renderWorkflowDiagram({entry:{...selectedEntry,process:view.contract},presentation:presentation?.presentation,view,actualAssets,detailBase:base(spaceId)});
            respond(response,200,bridgeWorkflowDiagram(html,[...view.contract.nodes.map(node=>node.id),...actualAssets.assets.map(asset=>asset.id)]),head,'text/html; charset=utf-8');return true;
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
            const actualAssets=view.contract?await loadRunGraphAssets(authenticated.service,spaceId,view):null;
            respond(response,200,ProcessSchema.parse({runId:selected.runId,versionId:method.id,caseId:selected.caseId,contractSource:view.contractSource,coverage:view.coverage,unmappedStepIds:view.unmappedStepIds,nodes:(view.contract?.nodes??selectedEntry.process?.nodes??[]).map(node=>nodeDto(selectedEntry,node,labels.get(node.id))),occurrences:view.occurrences.map(occurrenceValue),graphAssetIds:actualAssets?.assets.map(asset=>asset.id)??[],graphUrl:view.contract?`${base(spaceId)}/runs/${safeId(selected.runId)}/graph`:null,graphState}),head);return true;
          }
          const occurrence=occurrences[0]!;const contexts=await Promise.all(occurrence.contextIds.map(id=>authenticated.service.readContext(spaceId,id)));
          for(const context of contexts)exact(context.runId===selected.runId&&occurrence.stepRunIds.includes(context.stepRunId));
          respond(response,200,OccurrenceDetailSchema.parse({...occurrenceValue(occurrence),runId:selected.runId,versionId:method.id,contexts:contexts.map(value=>({id:value.id,nodeId:value.nodeId,stepRunId:value.stepRunId,attemptId:value.attemptId,producer:value.producer,instructions:value.instructions,model:value.producer==='agent'&&typeof value.effectiveConfig.model==='string'?value.effectiveConfig.model:null,reasoningEffort:value.producer==='agent'&&typeof value.effectiveConfig.reasoningEffort==='string'?value.effectiveConfig.reasoningEffort:null,effectiveConfig:cleanConfig(value.effectiveConfig),sessionId:value.sessionId}))}),head);return true;
        }
      }
      if(segment[0]==='assets'&&segment[1]&&segment.length===3&&['reading','relations'].includes(segment[2]!)&&authenticated.service.readRun&&authenticated.service.readAssetsByIds&&authenticated.service.runAssets&&authenticated.service.assetConsumerRuns&&authenticated.service.reviewsForAsset){
        const selected=await timing.measure('subject',()=>authenticated.service.readAsset(spaceId,segment[1]!));exact(selected.spaceId===spaceId);
        const source=isRunAssetSource(selected.source)?await exactRun(selected.source.runId):null;
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
          const sameRun=source&&isRunAssetSource(value.source)&&value.source.runId===source.selected.runId;
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
        const consumers=(await Promise.all(scopedCandidates.filter(({run,method})=>run.entrypoint===host.scope.entrypoint&&canReadWorkflow(host.scope,method.entrypoints[host.scope.entrypoint]?.workflowId)).map(async({run})=>{
          const view=await authenticated.service.process(spaceId,run.runId);exact(view.run.runId===run.runId);
          return view.occurrences.filter(occurrence=>occurrence.inputBindings.some(binding=>binding.assetVersionId===selected.id)).map(occurrence=>({runId:run.runId,versionId:run.workflowVersionId,caseId:run.caseId,nodeId:occurrence.nodeId??null,nodeLabel:occurrence.nodeId??'Unknown node',occurrenceId:occurrence.id,round:occurrence.round??null,state:occurrence.state}));
        }))).flat();
        const page=paged(consumers,url,value=>`${value.runId}\u0000${value.occurrenceId}`,listScope(`assets/${selected.id}/relations`),signer,now);
        const dependencyDtos=await Promise.all(selected.dependencies.map(id=>present(find([...byId.values()],value=>value.id===id))));
        const earlier=selected.dependencies.map(id=>find([...byId.values()],value=>value.id===id)).filter(value=>value.schema.namespace===selected.schema.namespace&&value.schema.revision===selected.schema.revision&&value.schema.hash===selected.schema.hash&&value.createdAt<=selected.createdAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
        const resolution=source&&authenticated.adapter?await authenticated.adapter.resolveRun({data:minimal([...byId.values()]),run:source.selected}):null;
        const declared=resolution?.process?.find(item=>item.assetVersionId===selected.id)?.assessmentAssetVersionIds??(resolution?.primaryAssetVersionId===selected.id?resolution.assessmentAssetVersionIds??[]:[]);
        const assessmentAssets=declared.length?await authenticated.service.readAssetsByIds(spaceId,declared):[];
        const assessments=await Promise.all(assessmentAssets.filter(value=>value.dependencies.includes(selected.id)&&isRunAssetSource(value.source)&&value.source.runId===source?.selected.runId).map(value=>present(value)));
        const reviews=await authenticated.service.reviewsForAsset(spaceId,selected.id);
        exact(reviews.every(review=>review.spaceId===spaceId&&review.assetVersionIds.includes(selected.id)));
        respond(response,200,AssetRelationsSchema.parse({assetId:selected.id,producer:source?{runId:source.selected.runId,versionId:source.selected.workflowVersionId,caseId:source.selected.caseId,nodeId:producing?.nodeId??(selected.source.kind==='node'?selected.source.nodeId:null),nodeLabel:producing?.nodeId??(selected.source.kind==='node'?selected.source.nodeId:'Unknown node'),occurrenceId:producing?.id??null,round:producing?.round??null}:null,dependencies:dependencyDtos,previousDraft:earlier[0]?await present(earlier[0]):null,assessments,consumers:page.items,reviews:reviews.map(reviewDto),nextCursor:page.nextCursor,snapshotAt:page.snapshotAt}),head);return true;
      }
      const data=await timing.measure('overview',()=>authenticated.service.overview(spaceId));
      exact(data.space.id===spaceId);
      const scope=authenticated.scope;
      const allVersions=data.workflows.filter(item=>!!item.entrypoints[scope.entrypoint]&&canReadWorkflow(scope,item.entrypoints[scope.entrypoint]?.workflowId));
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
        const sourceRunId=isRunAssetSource(value.source)?value.source.runId:undefined;
        const sourceRun=sourceRunId?data.runs.find(item=>item.runId===sourceRunId):undefined;
        const presentations=sourceRun?[await presentationFor(sourceRun.workflowVersionId,sourceRun.entrypoint)]:await Promise.all(allVersions.map(method=>presentationFor(method.id,scope.entrypoint)));
        const labels=new Set(presentations.flatMap(resolved=>resolved?.presentation.assetViews.filter(view=>view.schema.namespace===value.schema.namespace&&view.schema.revision===value.schema.revision&&view.schema.hash===value.schema.hash).map(view=>view.label)??[]));
        return scopedAsset(data,value,labels.size===1?[...labels][0]:undefined);
      };
      const selectedVersion=(id:string)=>{const selected=version(data,id);entry(selected,scope.entrypoint);exact(canReadWorkflow(scope,selected.entrypoints[scope.entrypoint]?.workflowId));return selected;};
      const selectedRun=(id:string)=>{const selected=run(data,id);exact(selected.entrypoint===scope.entrypoint&&allVersions.some(item=>item.id===selected.workflowVersionId));return selected;};
      const tasks=async()=>authenticated.service.executionTasks(spaceId);
      const resolveRun=async(item:SpaceOverview['runs'][number])=>{const task=(await tasks()).find(value=>value.runId===item.runId);const resolved=authenticated.adapter?await authenticated.adapter.resolveRun({data,run:item}):undefined;return runDto(data,item,task?{status:task.status,error:task.error,createdAt:task.createdAt}:undefined,resolved,await executionMode(item.runId));};
      const graphUrl=(kind:'versions'|'runs',id:string)=>`${base(spaceId)}/${kind}/${safeId(id)}/graph`;
      if(segment[0]==='summary'&&segment.length===1){
        const primaryVersions=allVersions.filter(value=>value.entrypoints[scope.entrypoint]?.workflowId===scope.workflowId);
        const adopted=scope.adoptionSlot?[...data.adoptions].reverse().find(item=>item.slot===scope.adoptionSlot&&item.target.kind==='workflow'&&primaryVersions.some(version=>version.id===item.target.id)):undefined;
        const latest=[...primaryVersions].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
        const designState=host.businessState?await host.businessState(spaceId):null;
        if(designState)exact(designState.space.id===spaceId&&designState.scope.workflowId===scope.workflowId&&designState.scope.entrypoint===scope.entrypoint);
        send(SummarySchema,{id:spaceId,title:data.space.purpose,purpose:data.space.purpose,subject:{id:authenticated.principal!.id,cacheScope:authenticated.cacheScope,kind:authenticated.principal!.kind,...(authenticated.principal!.externalAgent?{externalAgent:authenticated.principal!.externalAgent}:{})},methodScope:{workflowId:scope.workflowId,entrypoint:scope.entrypoint,adoptionSlot:scope.adoptionSlot??null},adoptedVersionId:adopted?.target.id??null,latestVersionId:latest?.id??null,counts:{versions:allVersions.length,cases:data.cases.length,runs:data.runs.filter(item=>allVersions.some(value=>value.id===item.workflowVersionId)).length,assets:data.assets.length},...(designState?{businessState:{...designState.counts,understandingRevisionId:designState.understandingRevisionId}}:{}),capabilities:{read:true,attachmentWrite:!!(authenticated.attachmentWrites&&host.service.uploadBlob&&host.service.importAsset&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),write:!!((authenticated.commands||authenticated.business||(authenticated.attachmentWrites&&(host.service.uploadBlob||host.service.importAsset))||authenticated.understanding?.save||authenticated.methodCapability?.save||authenticated.methodDesign?.save||authenticated.methodDesign?.publish||authenticated.methodExecution?.command||authenticated.service.recordReview||authenticated.service.observeSavedResponseTarget||authenticated.service.observePublishedAsset||authenticated.runDisposition?.save||authenticated.runDiagnosis?.save)&&authenticated.commandSecurity),understandingWrite:!!(authenticated.understanding?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),methodCapabilityRead:!!authenticated.methodCapability,methodCapabilityWrite:!!(authenticated.methodCapability?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),methodDesignRead:!!authenticated.methodDesign,methodDesignWrite:!!(authenticated.methodDesign?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),methodPublish:!!(authenticated.methodDesign?.publish&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent?.role==='design')),methodExecutionRead:!!authenticated.methodExecution,methodExecutionWrite:!!(authenticated.methodExecution?.command&&authenticated.commandSecurity&&authenticated.principal?.kind==='service'&&authenticated.principal?.externalAgent?.role==='design'),reviewRead:true,reviewWrite:!!(authenticated.service.recordReview&&authenticated.reviewStandard&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent)),observationRead:!!authenticated.service.readExternalAgentObservation,observationWrite:!!((authenticated.service.observeSavedResponseTarget||authenticated.service.observePublishedAsset)&&authenticated.commandSecurity&&authenticated.principal?.externalAgent),dispositionRead:!!authenticated.runDisposition,dispositionWrite:!!(authenticated.runDisposition?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent)),diagnosisRead:!!authenticated.runDiagnosis,diagnosisWrite:!!(authenticated.runDiagnosis?.save&&authenticated.commandSecurity&&(authenticated.principal?.kind==='human'||authenticated.principal?.externalAgent))},csrfToken:(authenticated.commands||authenticated.business||(authenticated.attachmentWrites&&(host.service.uploadBlob||host.service.importAsset))||authenticated.understanding?.save||authenticated.methodCapability?.save||authenticated.methodDesign?.save||authenticated.methodDesign?.publish||authenticated.methodExecution?.command||authenticated.service.recordReview||authenticated.service.observeSavedResponseTarget||authenticated.service.observePublishedAsset||authenticated.runDisposition?.save||authenticated.runDiagnosis?.save)&&authenticated.commandSecurity?authenticated.commandSecurity.csrfToken:null,snapshotAt:now().toISOString()});return true;
      }
      if(segment[0]==='versions'){
        if(segment.length===1){const knownPlans=await plans();const versions=await Promise.all(allVersions.map(async value=>versionDto(data,value,scope.entrypoint,await available(value.id),planIds(knownPlans,value.id),undefined,(await presentationFor(value.id,scope.entrypoint))?.presentation.label,host.displayTimeZone)));send(listSchema(VersionSummarySchema),paged(versions,url,value=>`${value.createdAt}\u0000${value.id}`,listScope('versions'),signer,now));return true;}
        const selected=selectedVersion(required(segment[1],'version ID')),selectedEntry=entry(selected,scope.entrypoint);
        const presentation=await authenticated.service.resolvePresentation(spaceId,selected.id,scope.entrypoint);
        const labels=new Map(presentation?.presentation.stages?.map(stage=>[stage.id,stage.label])??[]);
        const nodes=selectedEntry.process?.nodes.map(node=>nodeDto(selectedEntry,node,labels.get(node.id)))??[];
        if(segment.length===2){const value=versionDto(data,selected,scope.entrypoint,await available(selected.id),planIds(await plans(),selected.id),undefined,presentation?.presentation.label,host.displayTimeZone);send(VersionDetailSchema,{...value,...await methodEvidence(authenticated.service,spaceId,selected,scope.entrypoint,presentation?.presentation),hash:selected.hash,purpose:presentation?.presentation.purpose??null,designBasis:selected.designBasis??null,nodes,graphUrl:selectedEntry.process?graphUrl('versions',selected.id):null});return true;}
        if(segment[2]==='nodes'&&segment.length===4){const node=find(selectedEntry.process?.nodes??[],value=>value.id===segment[3]);const definition=selectedEntry.nodeDefinitions?.[node.id];send(NodeDetailSchema,{...nodeDto(selectedEntry,node,labels.get(node.id)),versionId:selected.id,instructions:definition?.instructions??null,configuration:definition?.configuration?cleanConfig(definition.configuration):null,...safeAgentDeclaration(selectedEntry,node)});return true;}
        if(segment[2]==='graph'&&segment.length===3){if(!selectedEntry.process)reject(404,'HISTORY_UNAVAILABLE','Historical graph was not recorded');const html=await renderWorkflowDiagram({entry:selectedEntry,presentation:presentation?.presentation,detailBase:base(spaceId)});respond(response,200,bridgeWorkflowDiagram(html,methodGraphIds(selectedEntry,presentation?.presentation)),head,'text/html; charset=utf-8');return true;}
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
        if(segment[2]==='inputs'&&segment.length===3){const manifest=await authenticated.service.readManifest(spaceId,selected.inputManifestId);exact(manifest.spaceId===spaceId&&manifest.caseId===selected.caseId&&manifest.id===selected.inputManifestId);send(RunInputManifestSchema,{runId:selected.runId,caseId:selected.caseId,versionId:selected.workflowVersionId,inputManifestId:manifest.id,inputManifestHash:manifest.hash,slots:await Promise.all(Object.entries(manifest.assets).map(async([slot,id])=>{const value=asset(data,id);return {slot,asset:await scopedAsset(data,value),payloadHash:value.payloadHash};}))});return true;}
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
        if(segment[2]==='process'&&segment.length===3){const graphState=view.contract?buildWorkflowGraphState(view):null;if(graphState)exact(graphState.spaceId===spaceId&&graphState.runId===selected.runId&&graphState.versionId===method.id);const actualAssets=view.contract?await loadRunGraphAssets(authenticated.service,spaceId,view):null;send(ProcessSchema,{runId:selected.runId,versionId:method.id,caseId:selected.caseId,contractSource:view.contractSource,coverage:view.coverage,unmappedStepIds:view.unmappedStepIds,nodes:nodeDtos,occurrences:view.occurrences.map(value=>occurrenceDto(data,value,labels.get(value.nodeId??'')??value.nodeId??value.id,titleForAsset)),graphAssetIds:actualAssets?.assets.map(asset=>asset.id)??[],graphUrl:view.contract?graphUrl('runs',selected.runId):null,graphState});return true;}
        if(segment[2]==='graph'&&segment.length===3){if(!view.contract)reject(404,'HISTORY_UNAVAILABLE','Run process graph unavailable');const actualAssets=await loadRunGraphAssets(authenticated.service,spaceId,view);const renderEntry={...methodEntry,process:view.contract};const html=await renderWorkflowDiagram({entry:renderEntry,presentation:presentation?.presentation,view,actualAssets,detailBase:base(spaceId)});respond(response,200,bridgeWorkflowDiagram(html,[...view.contract.nodes.map(node=>node.id),...actualAssets.assets.map(asset=>asset.id)]),head,'text/html; charset=utf-8');return true;}
        if(segment[2]==='occurrences'&&segment.length===4){const occurrence=find(view.occurrences,value=>value.id===segment[3]);const contexts=await Promise.all(occurrence.contextIds.map(value=>authenticated.service.readContext(spaceId,value)));for(const context of contexts)exact(context.runId===selected.runId&&occurrence.stepRunIds.includes(context.stepRunId));send(OccurrenceDetailSchema,{...occurrenceDto(data,occurrence,labels.get(occurrence.nodeId??'')??occurrence.nodeId??occurrence.id,titleForAsset),runId:selected.runId,versionId:method.id,contexts:contexts.map(value=>({id:value.id,nodeId:value.nodeId,stepRunId:value.stepRunId,attemptId:value.attemptId,producer:value.producer,instructions:value.instructions,model:value.producer==='agent'&&typeof value.effectiveConfig.model==='string'?value.effectiveConfig.model:null,reasoningEffort:value.producer==='agent'&&typeof value.effectiveConfig.reasoningEffort==='string'?value.effectiveConfig.reasoningEffort:null,effectiveConfig:cleanConfig(value.effectiveConfig),sessionId:value.sessionId}))});return true;}
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
            for(const value of data.assets)if(isRunAssetSource(value.source)&&runIds.has(value.source.runId))included.add(value.id);
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
        const selected=asset(data,required(segment[1],'asset ID'));if(isRunAssetSource(selected.source))selectedRun(selected.source.runId);
        if(segment[2]==='reading'&&segment.length===3){
          const read=await authenticated.service.readAsset(spaceId,selected.id);exact(read.id===selected.id);
          let title=(await assetDisplay(selected)).title;
          let sections:Array<{title:string;text:string;pointer?:string;sourceRefs?:string[];view?:'body'|'visual'|'evidence'}>;
          let readerStatus:'registered'|'presentation'|'fallback'='fallback';
          const sourceRun=isRunAssetSource(read.source)?selectedRun(read.source.runId):undefined;
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
          const source=isRunAssetSource(selected.source)?selectedRun(selected.source.runId):null;
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
          const assessments=await Promise.all(declaredAssessmentIds.map(id=>asset(data,id)).filter(value=>value.dependencies.includes(selected.id)&&isRunAssetSource(value.source)&&value.source.runId===source?.runId).map(assetDisplay));
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
            send(PlanEntrySchema,{planId:selected.id,entryId:selectedEntry.id,side:selectedEntry.side,repeat:selectedEntry.repeat,caseId:selectedEntry.caseId,caseTitle:caseValue.title,versionId:selectedEntry.workflowVersionId,entrypoint:selectedEntry.entrypoint,planStatus:selected.status,status:row.status,availability:await available(selectedEntry.workflowVersionId),manifest:{id:manifest.id,hash:manifest.hash,caseId:manifest.caseId,slots:frozenAssets.map(({slot,asset,payloadHash})=>({slot,asset,payloadHash}))},inputSections,inputSummary:authenticated.inputSummary?.({assets:frozenAssets.map(({slot,read})=>({slot,asset:read}))})??[],standard:selected.standard,requiredJudgeCoverage:row.requiredJudgeCoverage,attempts:row.attempts.slice(-30).map(attemptDto),attemptsTruncated:row.attempts.length>30,nextAttempt:(latest?.attempt??0)+1,queue,queueTruncated:active.length>100,actions:offered,snapshotAt:now().toISOString()});return true;
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
      const known=error instanceof ApiFailure?error:error instanceof ZodError?new ApiFailure(400,'INVALID_REQUEST','Invalid request data'):commandFailure??(/Asset version conflict|Idempotency conflict|Review ID conflicts with a different request|Expected diagnosis revision ID is required/u.test(text)||structured?.code==='23505'?new ApiFailure(409,'CONFLICT','Operation conflicts with the current saved state'):
        /^(?:Saved response (?:occurrence, step or attempt mismatch|target must be failed and unpublished|Agent context mismatch|event mismatch|assistant output missing|output hash mismatch|review run mismatch)|Published asset (?:payload hash mismatch|must be a node output of the exact run|producer context mismatch|has no exact node output binding|origin run mismatch|observation producer or target mismatch)|Review target must be produced by reviewed run|Run disposition review must belong to the same run|Run diagnosis (?:disposition run or hash mismatch|selected reviews must occur in the exact disposition revision|review is outside the run)|Diagnosis (?:asset evidence hash mismatch|asset evidence is outside the run|response evidence is outside the run|review evidence is not a selected review|disposition evidence run or hash mismatch|input manifest run or hash mismatch|run evidence is outside the run|run step evidence does not exist|candidate predecessor must be the exact run workflow version|candidate must cite a change-method issue|candidate must cite hypotheses from its change-method issues|candidate hypothesis needs at least one supporting evidence reference)|Agent diagnosis review observation target mismatch|Trace (?:session is outside the run|event is outside the exact run or session)|Disposition (?:asset|response|run) evidence is outside the run|Disposition run step evidence does not exist|Disposition review observation target mismatch|Agent observer must be independent from producer|Agent disposition requires its own observed review|External Agent review requires the exact observed response target)$/u.test(text)?new ApiFailure(409,'RELATION_MISMATCH','The selected evidence does not match the exact saved run'):
        /^(?:Response evidence pointer does not exist|Disposition (?:asset|response) evidence pointer does not exist|Diagnosis (?:evidence pointer does not exist|trace pointer requires an exact event|issue IDs must be distinct|issue unknowns must contain nonblank text|hypothesis IDs must be distinct|hypothesis unknowns must contain nonblank text|hypothesis evidence must be arrays|issue needs evidence and at least one competing explanation|candidate needs changes, benefits, risks and falsification conditions|candidate change before and after must differ|candidate .* must contain nonblank text)|Trace (?:event ID and sequence must be supplied together|event sequence is invalid)|Run diagnosis (?:requires distinct selected reviews|requires at least one issue|exceeds the size limit)|Review needs exactly one target form: asset versions or saved response|Response evidence pointers require a saved response target|External Agent asset review requires one exact asset version)$/u.test(text)?new ApiFailure(400,'INVALID_REQUEST','Invalid review or diagnosis evidence'):
        /^(?:Human judge identity mismatch|Saved response review requires authenticated human judgment|Human author required|Human review cannot claim an Agent observation receipt|External Agent observer credential required|External Agent observation credential or run mismatch|External Agent review identity or observed target mismatch|External Agent asset review identity or observed target mismatch|External Agent review requires an observation receipt|Agent disposition cannot claim another Agent review|Agent diagnosis (?:requires every selected review to be its own observed review|primary observation receipt must belong to a selected review))$/u.test(text)?new ApiFailure(403,'FORBIDDEN','Authenticated author or observation credential required'):
        /Space access denied|access denied|capability denied/u.test(text)?new ApiFailure(403,'FORBIDDEN','Space access denied'):/not found in authorized space|outside authorized Space|Record not found in authorized space|Asset is not a method design revision|Asset is not a run diagnosis revision|Asset is not an external Agent observation receipt|Asset is not a published asset observation receipt|Method design logical asset does not match workflow|Run diagnosis logical asset mismatch/u.test(text)?new ApiFailure(404,'NOT_FOUND','Object not found in authorized Space'):null);
      respond(response,known?.status??500,{error:{code:known?.code??'SERVICE_FAILURE',message:known?.message??'Space API request failed',requestId,
        ...(error instanceof ZodError?{details:{issues:safeZodIssues(error)}}:{})}},head);return true;
    }
  };
}
