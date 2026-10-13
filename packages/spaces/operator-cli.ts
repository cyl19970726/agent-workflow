#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { open, readFile, stat, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {createHash} from 'node:crypto';
import {prepareRequest, type PrepareKind} from './operator-prepare.js';
import {collectRunEvidence} from './operator-evidence.js';

type RecordValue = Record<string, unknown>;
type Fetcher = typeof globalThis.fetch;

export interface OperatorCliOptions {
  fetch?: Fetcher;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

const usage = 'Usage: workflow-space-operator onboarding | space | space-create --file <absolute-request.json> | versions | version <version-id> | node <version-id> <node-id> | cases | case <case-id> | run <run-id> | run-inputs <run-id> | process <run-id> | run-evidence <run-id> [--occurrence <occurrence-id>] [--max-pages <1..10>] [--max-occurrences <1..50>] | occurrence <run-id> <occurrence-id> | runtime <run-id> <occurrence-id> <attempt-id> | occurrence-responses <run-id> <occurrence-id> | trace <run-id> <occurrence-id> | run-trace <run-id> <session-id> | asset <asset-id> | blob-upload --file <absolute-path> --media-type <type> | asset-import --file <request.json> | attachment-download <asset-version-id> <blob-id> --out <absolute-path> | review-subjects <run-id> | observe-response --file <target.json> | observe-asset --file <target.json> | observation <run-id> <receipt-id> | reviews <run-id> | review <run-id> <review-id> | review-save --file <payload.json> | dispositions <run-id> | disposition <run-id> <revision-id> | disposition-save --file <payload.json> | diagnosis <run-id> [revision-id] | diagnoses <run-id> | diagnosis-save --file <payload.json> | understanding [--revision <revision-id>] | understanding-history | understanding-save --file <payload.json> | capability [--revision <revision-id>] | capability-history | capability-prepare --file <absolute-input.json> [--out <absolute-ready.json>] | capability-save --file <absolute-payload.json> | design [--revision <revision-id>] | design-history | design-prepare --file <absolute-input.json> [--out <absolute-ready.json>] | design-save --file <payload.json> | design-definition --revision <revision-id> | execution-state | method-command --file <absolute-command.json> | method-preview --design <revision-id> | method-publish --design <revision-id> --expected <candidate-id> | method-basis <version-id>\nSet WORKFLOW_OPERATOR_BASE_URL and WORKFLOW_OPERATOR_SPACE_ID; optionally set exactly one of WORKFLOW_OPERATOR_TOKEN_FILE, WORKFLOW_OPERATOR_AUTHORIZATION or WORKFLOW_OPERATOR_COOKIE.';
const safeConfigKeys = ['stageDeclaration', 'reasoningEffort', 'permissionsRevision', 'timeoutMs', 'webSearchMode', 'whenWebResearchTrue', 'maxRevisions', 'model', 'temperature', 'maxOutputTokens', 'webResearch', 'retryCount', 'executionMode'];

function record(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name} response`);
  return value as RecordValue;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${name} response`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return string(value, name);
}

function count(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${name} response`);
  return value as number;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return string(value, name);
}

function id(value: string | undefined, name: string): string {
  if (!value || value.length > 240 || value === '.' || value === '..') throw new Error(`Invalid ${name}`);
  return value;
}

function evidenceArguments(args:readonly string[]):{runId:string;occurrenceId?:string;maxPages?:number;maxOccurrences?:number} {
  const runId=id(args[0],'run ID');
  const result:{runId:string;occurrenceId?:string;maxPages?:number;maxOccurrences?:number}={runId};
  const seen=new Set<string>();
  for(let index=1;index<args.length;index+=2){
    const flag=args[index],value=args[index+1];
    if(!flag||!value||seen.has(flag)||!['--occurrence','--max-pages','--max-occurrences'].includes(flag))throw new Error(usage);
    seen.add(flag);
    if(flag==='--occurrence')result.occurrenceId=id(value,'occurrence ID');
    else{
      const bound=flag==='--max-pages'?10:50;
      if(!/^\d+$/u.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>bound)throw new Error(usage);
      if(flag==='--max-pages')result.maxPages=Number(value);else result.maxOccurrences=Number(value);
    }
  }
  return result;
}

function preparedSummary(kind:PrepareKind,request:RecordValue,file:string,rechecked:boolean):RecordValue {
  const common={kind,operation:rechecked?'rechecked':'prepared',requestFile:file,
    workflowId:request.workflowId,entrypoint:request.entrypoint,understanding:request.understanding,
    authorship:request.authorship,expectedRevisionId:request.expectedRevisionId,idempotencyKey:request.idempotencyKey};
  if(kind==='design')return {...common,title:request.title,capability:request.capability??null,
    sourceCount:(request.sources as unknown[]).length,contentBytes:Buffer.byteLength(request.content as string,'utf8')};
  return {...common,provider:request.provider,predecessorVersionId:request.predecessorVersionId,
    nodes:Object.entries(record(request.nodes,'prepared nodes')).map(([nodeId,value])=>{
      const node=record(value,'prepared node'),instructions=record(node.instructions,'prepared instructions'),schema=record(node.outputSchema,'prepared schema');
      return {id:nodeId,model:node.model,reasoningEffort:node.reasoningEffort,instructionsSha256:instructions.sha256,
        instructionsBytes:Buffer.byteLength(instructions.content as string,'utf8'),outputSchemaSha256:schema.sha256};
    }),validationSha256:record(request.validation,'prepared validation').sha256};
}

function origin(value: string | undefined): string {
  if (!value) throw new Error('WORKFLOW_OPERATOR_BASE_URL is required');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('Invalid WORKFLOW_OPERATOR_BASE_URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid WORKFLOW_OPERATOR_BASE_URL');
  return parsed.href.replace(/\/$/u, '');
}

function list(value: unknown, name: string): RecordValue[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${name} response`);
  return value.map((item, index) => record(item, `${name}[${index}]`));
}
function stringList(value:unknown,name:string):string[]{
  if(!Array.isArray(value))throw new Error(`Invalid ${name} response`);
  return value.map((item,index)=>string(item,`${name}[${index}]`));
}

function availability(value: unknown): RecordValue {
  const data = record(value, 'availability');
  const state = string(data.state, 'availability.state');
  if (!['available', 'unavailable', 'unknown'].includes(state)) throw new Error('Invalid availability response');
  return { state, reason: optionalString(data.reason, 'availability.reason') };
}

function version(value: unknown): RecordValue {
  const data = record(value, 'version');
  return {
    id: string(data.id, 'version.id'),
    label: string(data.label, 'version.label'),
    revision: string(data.revision, 'version.revision'),
    createdAt: string(data.createdAt, 'version.createdAt'),
    changeReason: string(data.changeReason, 'version.changeReason'),
    predecessorId: nullableString(data.predecessorId, 'version.predecessorId'),
    entrypoint: string(data.entrypoint, 'version.entrypoint'),
    definitionAvailability: string(data.definitionAvailability, 'version.definitionAvailability'),
    availability: availability(data.availability),
    runCount: count(data.runCount, 'version.runCount'),
    caseCount: count(data.caseCount, 'version.caseCount'),
  };
}

function slot(value: unknown): RecordValue {
  const data = record(value, 'slot');
  const schema = record(data.schema, 'slot.schema');
  return {
    slot: string(data.slot, 'slot.slot'),
    label: string(data.label, 'slot.label'),
    schema: { namespace: string(schema.namespace, 'slot.schema.namespace'), revision: string(schema.revision, 'slot.schema.revision'), hash: string(schema.hash, 'slot.schema.hash') },
    optional: data.optional === null || typeof data.optional === 'boolean' ? data.optional : null,
    states: Array.isArray(data.states) ? data.states.map(state => string(state, 'slot.state')) : [],
    projection: data.projection === null || data.projection === undefined ? null : (() => {
      const projection = record(data.projection, 'slot.projection');
      return { version: string(projection.version, 'slot.projection.version'), fields: Array.isArray(projection.fields) ? projection.fields.map(field => string(field, 'slot.projection.field')) : [] };
    })(),
    requiredInputs: Array.isArray(data.requiredInputs) ? data.requiredInputs.map(input => string(input, 'slot.requiredInput')) : [],
    sources: Array.isArray(data.sources) ? data.sources.map(source => {
      const item = record(source, 'slot.source');
      return { kind: string(item.kind, 'slot.source.kind'), source: string(item.source, 'slot.source.source'), port: optionalString(item.port, 'slot.source.port'),
        selection: string(item.selection, 'slot.source.selection'), when: optionalString(item.when, 'slot.source.when') };
    }) : [],
  };
}

function node(value: unknown): RecordValue {
  const data = record(value, 'node');
  const executor = data.executor === null || data.executor === undefined ? null : record(data.executor, 'node.executor');
  return {
    id: string(data.id, 'node.id'), label: string(data.label, 'node.label'), kind: string(data.kind, 'node.kind'),
    purpose: optionalString(data.purpose, 'node.purpose'), definitionRecorded: data.definitionRecorded === true,
    executor: executor ? { family: string(executor.family, 'node.executor.family'), adapter: optionalString(executor.adapter, 'node.executor.adapter') } : null,
    model: optionalString(data.model, 'node.model'),
    tools: data.tools === null || data.tools === undefined ? null : Array.isArray(data.tools) ? data.tools.map(tool => string(tool, 'node.tool')) : null,
    inputs: Array.isArray(data.inputs) ? data.inputs.map(slot) : [],
    outputs: Array.isArray(data.outputs) ? data.outputs.map(slot) : [],
  };
}

function safeConfig(value: unknown): RecordValue | null {
  if (value === null || value === undefined) return null;
  const data = record(value, 'node.configuration');
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => safeConfigKeys.includes(key)).map(([key, nested]) => [key, clean(nested)]));
    return item;
  };
  return Object.fromEntries(safeConfigKeys.filter(key => key in data).map(key => [key, clean(data[key])]));
}

function agentDeclaration(value:unknown):RecordValue|null {
  if(value===undefined||value===null)return null;
  const data=record(value,'node.agentDeclaration');
  const nullableCount=(value:unknown,name:string)=>value===null?null:count(value,name);
  const skills=data.skills===null?null:list(data.skills,'agentDeclaration.skills').map(item=>({
    name:string(item.name,'agentDeclaration.skill.name'),sourceRef:string(item.sourceRef,'agentDeclaration.skill.sourceRef'),
    revision:nullableString(item.revision,'agentDeclaration.skill.revision')}));
  const tools=data.tools===null?null:list(data.tools,'agentDeclaration.tools').map(item=>{
    const coverage=string(item.coverage,'agentDeclaration.tool.coverage');
    if(coverage!=='recorded'&&coverage!=='name-only')throw new Error('Invalid Agent tool coverage');
    return {name:string(item.name,'agentDeclaration.tool.name'),description:nullableString(item.description,'agentDeclaration.tool.description'),
      parameters:item.parameters??null,required:item.required===null?null:stringList(item.required,'agentDeclaration.tool.required'),
      outputSchema:item.outputSchema??null,coverage};
  });
  const permissions=data.permissions===null?null:(()=>{const item=record(data.permissions,'agentDeclaration.permissions');return {
    revision:nullableString(item.revision,'agentDeclaration.permissions.revision'),sandboxMode:nullableString(item.sandboxMode,'agentDeclaration.permissions.sandboxMode'),
    approvalPolicy:nullableString(item.approvalPolicy,'agentDeclaration.permissions.approvalPolicy'),webSearchMode:nullableString(item.webSearchMode,'agentDeclaration.permissions.webSearchMode'),
    conditionalWebSearchMode:nullableString(item.conditionalWebSearchMode,'agentDeclaration.permissions.conditionalWebSearchMode'),
    conditionalPermissionsRevision:nullableString(item.conditionalPermissionsRevision,'agentDeclaration.permissions.conditionalPermissionsRevision'),
    additionalDirectoryCount:nullableCount(item.additionalDirectoryCount,'agentDeclaration.permissions.additionalDirectoryCount')};})();
  return {reasoningEffort:nullableString(data.reasoningEffort,'agentDeclaration.reasoningEffort'),
    timeoutMs:nullableCount(data.timeoutMs,'agentDeclaration.timeoutMs'),maxTurns:nullableCount(data.maxTurns,'agentDeclaration.maxTurns'),
    maxToolCalls:nullableCount(data.maxToolCalls,'agentDeclaration.maxToolCalls'),outputFormat:nullableString(data.outputFormat,'agentDeclaration.outputFormat'),
    outputSchema:data.outputSchema??null,skills,tools,permissions};
}

function expectedAssets(value: unknown): RecordValue {
  const data = record(value, 'expectedAssets');
  return {
    assets: list(data.assets, 'expectedAssets.assets').map(asset => {
      const source = record(asset.source, 'expectedAsset.source');
      const purpose = record(asset.purpose, 'expectedAsset.purpose');
      const schema = asset.schema === undefined ? null : record(asset.schema, 'expectedAsset.schema');
      const producer = asset.producer === undefined ? null : record(asset.producer, 'expectedAsset.producer');
      return { id: string(asset.id, 'expectedAsset.id'), label: string(asset.label, 'expectedAsset.label'),
        source: { kind: string(source.kind, 'expectedAsset.source.kind'), name: optionalString(source.name, 'expectedAsset.source.name'), nodeId: optionalString(source.nodeId, 'expectedAsset.source.nodeId'), port: optionalString(source.port, 'expectedAsset.source.port') },
        schema: schema ? { namespace: string(schema.namespace, 'expectedAsset.schema.namespace'), revision: string(schema.revision, 'expectedAsset.schema.revision'), hash: string(schema.hash, 'expectedAsset.schema.hash') } : null,
        producer: producer ? { nodeId: string(producer.nodeId, 'expectedAsset.producer.nodeId'), port: string(producer.port, 'expectedAsset.producer.port') } : null,
        resultRoles: Array.isArray(asset.resultRoles) ? asset.resultRoles.map(role => string(role, 'expectedAsset.resultRole')) : [],
        purpose: { resultRoles: Array.isArray(purpose.resultRoles) ? purpose.resultRoles.map(role => string(role, 'expectedAsset.purpose.resultRole')) : [],
          consumerNodeIds: Array.isArray(purpose.consumerNodeIds) ? purpose.consumerNodeIds.map(nodeId => string(nodeId, 'expectedAsset.purpose.consumerNodeId')) : [] },
        consumers: list(asset.consumers, 'expectedAsset.consumers').map(consumer => ({ nodeId: string(consumer.nodeId, 'expectedAsset.consumer.nodeId'),
          port: string(consumer.port, 'expectedAsset.consumer.port'), bindingId: string(consumer.bindingId, 'expectedAsset.consumer.bindingId'),
          selection: string(consumer.selection, 'expectedAsset.consumer.selection'), when: optionalString(consumer.when, 'expectedAsset.consumer.when') })),
        missing: Array.isArray(asset.missing) ? asset.missing.map(item => string(item, 'expectedAsset.missing')) : [] };
    }),
    dependencies: list(data.dependencies, 'expectedAssets.dependencies').map(dependency => {
      const to = record(dependency.to, 'expectedAsset.dependency.to');
      return { id: string(dependency.id, 'expectedAsset.dependency.id'), assetId: string(dependency.assetId, 'expectedAsset.dependency.assetId'),
        to: { nodeId: string(to.nodeId, 'expectedAsset.dependency.to.nodeId'), port: string(to.port, 'expectedAsset.dependency.to.port') },
        selection: string(dependency.selection, 'expectedAsset.dependency.selection'), when: optionalString(dependency.when, 'expectedAsset.dependency.when') };
    }),
    gaps: list(data.gaps, 'expectedAssets.gaps').map(gap => ({ code: string(gap.code, 'expectedAsset.gap.code'),
      nodeId: optionalString(gap.nodeId, 'expectedAsset.gap.nodeId'), port: optionalString(gap.port, 'expectedAsset.gap.port'),
      bindingId: optionalString(gap.bindingId, 'expectedAsset.gap.bindingId'), message: string(gap.message, 'expectedAsset.gap.message') })),
  };
}

function caseSummary(value:unknown):RecordValue {
  const data=record(value,'case');
  return {id:string(data.id,'case.id'),title:string(data.title,'case.title'),objective:string(data.objective,'case.objective'),
    constraints:Array.isArray(data.constraints)?data.constraints.map(value=>string(value,'case.constraint')):[],
    runCount:count(data.runCount,'case.runCount'),assetCount:count(data.assetCount,'case.assetCount')};
}
function assetSummary(value:unknown):RecordValue {
  const data=record(value,'asset'),schema=record(data.schema,'asset.schema');
  const sourceKind=string(data.sourceKind,'asset.sourceKind');
  if(!['import','node','transform'].includes(sourceKind))throw new Error('Invalid asset sourceKind');
  return {id:string(data.id,'asset.id'),title:string(data.title,'asset.title'),kind:string(data.kind,'asset.kind'),state:string(data.state,'asset.state'),
    createdAt:string(data.createdAt,'asset.createdAt'),schema:{namespace:string(schema.namespace,'asset.schema.namespace'),revision:string(schema.revision,'asset.schema.revision'),hash:string(schema.hash,'asset.schema.hash')},
    sourceKind,runId:nullableString(data.runId,'asset.runId'),caseId:nullableString(data.caseId,'asset.caseId'),versionId:nullableString(data.versionId,'asset.versionId'),
    nodeId:nullableString(data.nodeId,'asset.nodeId'),occurrenceId:nullableString(data.occurrenceId,'asset.occurrenceId'),
    round:data.round===null?null:count(data.round,'asset.round')};
}
function runSummary(value:unknown):RecordValue {
  const data=record(value,'run');
  return {id:string(data.id,'run.id'),label:string(data.label,'run.label'),versionId:string(data.versionId,'run.versionId'),caseId:string(data.caseId,'run.caseId'),entrypoint:string(data.entrypoint,'run.entrypoint'),
    executionMode:optionalString(data.executionMode,'run.executionMode'),state:string(data.state,'run.state'),taskState:nullableString(data.taskState,'run.taskState'),reason:nullableString(data.reason,'run.reason'),
    progress:nullableString(data.progress,'run.progress'),startedAt:nullableString(data.startedAt,'run.startedAt'),
    assetCount:count(data.assetCount,'run.assetCount'),draftCount:count(data.draftCount,'run.draftCount'),primaryAssetId:nullableString(data.primaryAssetId,'run.primaryAssetId')};
}
function runDetail(value:unknown):RecordValue {
  const data=record(value,'run');
  return {...runSummary(data),inputManifestId:string(data.inputManifestId,'run.inputManifestId'),inputManifestHash:string(data.inputManifestHash,'run.inputManifestHash'),
    configHash:string(data.configHash,'run.configHash'),inputAssets:list(data.inputAssets,'run.inputAssets').map(assetSummary),
    versionLabel:string(data.versionLabel,'run.versionLabel'),caseTitle:string(data.caseTitle,'run.caseTitle')};
}
function inputManifest(value:unknown):RecordValue {
  const data=record(value,'input manifest');
  return {runId:string(data.runId,'input.runId'),caseId:string(data.caseId,'input.caseId'),versionId:string(data.versionId,'input.versionId'),
    inputManifestId:string(data.inputManifestId,'input.id'),inputManifestHash:string(data.inputManifestHash,'input.hash'),
    slots:list(data.slots,'input.slots').map(value=>({slot:string(value.slot,'input.slot'),asset:assetSummary(value.asset),payloadHash:string(value.payloadHash,'input.payloadHash')}))};
}
function technicalStep(value:unknown):RecordValue {
  const data=record(value,'technical step');
  return {id:string(data.id,'technical step.id'),key:string(data.key,'technical step.key'),kind:string(data.kind,'technical step.kind'),
    state:string(data.state,'technical step.state'),error:nullableString(data.error,'technical step.error')};
}
function occurrenceSummary(value:unknown):RecordValue {
  const data=record(value,'occurrence'),provenance=string(data.provenance,'occurrence.provenance');
  if(!['observed','derived','unknown'].includes(provenance))throw new Error('Invalid occurrence provenance');
  const terminal=data.terminalFailure===null||data.terminalFailure===undefined?null:record(data.terminalFailure,'terminal failure');
  if(terminal&&(terminal.state!=='failed'||terminal.provenance!=='derived'))throw new Error('Invalid terminal failure');
  return {id:string(data.id,'occurrence.id'),nodeId:nullableString(data.nodeId,'occurrence.nodeId'),label:string(data.label,'occurrence.label'),
    round:data.round===null?null:count(data.round,'occurrence.round'),branch:nullableString(data.branch,'occurrence.branch'),route:nullableString(data.route,'occurrence.route'),
    provenance,state:string(data.state,'occurrence.state'),terminalFailure:terminal?{state:'failed',provenance:'derived',failedAncestorStepId:string(terminal.failedAncestorStepId,'terminal failure.stepId'),failedAncestorStepKey:string(terminal.failedAncestorStepKey,'terminal failure.stepKey'),error:string(terminal.error,'terminal failure.error')}:null,inputs:list(data.inputs,'occurrence.inputs').map(assetSummary),outputs:list(data.outputs,'occurrence.outputs').map(assetSummary),
    contextIds:Array.isArray(data.contextIds)?data.contextIds.map(value=>string(value,'occurrence.contextId')):[],
    sessionIds:Array.isArray(data.sessionIds)?data.sessionIds.map(value=>string(value,'occurrence.sessionId')):[],
    attemptCount:count(data.attemptCount,'occurrence.attemptCount'),agentAttemptCount:data.agentAttemptCount===null?null:count(data.agentAttemptCount,'occurrence.agentAttemptCount'),
    technicalStepCount:count(data.technicalStepCount,'occurrence.technicalStepCount'),technicalSteps:list(data.technicalSteps,'occurrence.technicalSteps').map(technicalStep),
    failureDetails:list(data.failureDetails,'occurrence.failureDetails').map(technicalStep)};
}
function processReading(value:unknown):RecordValue {
  const data=record(value,'process');
  const contractSource=string(data.contractSource,'process.contractSource'),coverage=string(data.coverage,'process.coverage');
  if(!['method','retrospective','unknown'].includes(contractSource)||!['observed','partial','unknown'].includes(coverage))throw new Error('Invalid process coverage');
  return {runId:string(data.runId,'process.runId'),versionId:string(data.versionId,'process.versionId'),caseId:string(data.caseId,'process.caseId'),
    contractSource,coverage,unmappedStepIds:Array.isArray(data.unmappedStepIds)?data.unmappedStepIds.map(value=>string(value,'process.unmappedStepId')):[],
    nodes:list(data.nodes,'process.nodes').map(node),occurrences:list(data.occurrences,'process.occurrences').map(occurrenceSummary),
    graphUrl:nullableString(data.graphUrl,'process.graphUrl')};
}
function occurrenceDetail(value:unknown):RecordValue {
  const data=record(value,'occurrence');
  return {...occurrenceSummary(data),runId:string(data.runId,'occurrence.runId'),versionId:string(data.versionId,'occurrence.versionId'),
    contexts:list(data.contexts,'occurrence.contexts').map(value=>{const producer=string(value.producer,'context.producer');if(producer!=='agent'&&producer!=='program')throw new Error('Invalid context producer');return {id:string(value.id,'context.id'),nodeId:string(value.nodeId,'context.nodeId'),stepRunId:string(value.stepRunId,'context.stepRunId'),attemptId:string(value.attemptId,'context.attemptId'),producer,
      instructions:string(value.instructions,'context.instructions'),model:nullableString(value.model,'context.model'),reasoningEffort:nullableString(value.reasoningEffort,'context.reasoningEffort'),
      effectiveConfig:safeConfig(value.effectiveConfig),sessionId:string(value.sessionId,'context.sessionId')};})};
}
function assetReading(value:unknown):RecordValue {
  const data=record(value,'asset reading'),readerStatus=string(data.readerStatus,'asset.readerStatus');
  if(!['registered','presentation','fallback'].includes(readerStatus))throw new Error('Invalid asset reader status');
  return {asset:assetSummary(data.asset),title:string(data.title,'asset reading.title'),payloadHash:string(data.payloadHash,'asset reading.payloadHash'),readerStatus,
    sections:list(data.sections,'asset reading.sections').map(value=>({title:string(value.title,'section.title'),text:string(value.text,'section.text'),
      ...(value.pointer===undefined?{}:{pointer:string(value.pointer,'section.pointer')}),
      ...(value.sourceRefs===undefined?{}:{sourceRefs:Array.isArray(value.sourceRefs)?value.sourceRefs.map(ref=>string(ref,'section.sourceRef')):[]}),
      ...(value.view===undefined?{}:{view:string(value.view,'section.view')})})),
    sourceLinks:list(data.sourceLinks,'asset reading.sourceLinks').map(value=>({ref:string(value.ref,'sourceLink.ref'),asset:assetSummary(value.asset),pointer:nullableString(value.pointer,'sourceLink.pointer')}))};
}
function assetRelations(value:unknown):RecordValue {
  const data=record(value,'asset relations');
  const producer=data.producer===null?null:record(data.producer,'asset producer');
  return {assetId:string(data.assetId,'relations.assetId'),producer:producer?{runId:string(producer.runId,'producer.runId'),versionId:string(producer.versionId,'producer.versionId'),
    caseId:string(producer.caseId,'producer.caseId'),nodeId:nullableString(producer.nodeId,'producer.nodeId'),nodeLabel:string(producer.nodeLabel,'producer.nodeLabel'),
    occurrenceId:nullableString(producer.occurrenceId,'producer.occurrenceId'),round:producer.round===null?null:count(producer.round,'producer.round')}:null,
    dependencies:list(data.dependencies,'relations.dependencies').map(assetSummary),previousDraft:data.previousDraft===null?null:assetSummary(data.previousDraft),
    assessments:list(data.assessments,'relations.assessments').map(assetSummary),
    consumers:list(data.consumers,'relations.consumers').map(value=>({runId:string(value.runId,'consumer.runId'),versionId:string(value.versionId,'consumer.versionId'),
      caseId:string(value.caseId,'consumer.caseId'),nodeId:nullableString(value.nodeId,'consumer.nodeId'),nodeLabel:string(value.nodeLabel,'consumer.nodeLabel'),
      occurrenceId:string(value.occurrenceId,'consumer.occurrenceId'),round:value.round===null?null:count(value.round,'consumer.round'),state:string(value.state,'consumer.state')})),
    reviews:list(data.reviews,'relations.reviews').map(value=>({id:string(value.id,'review.id'),runId:string(value.runId,'review.runId')})),
    nextCursor:nullableString(data.nextCursor,'relations.nextCursor'),snapshotAt:string(data.snapshotAt,'relations.snapshotAt')};
}

function responseTarget(value:unknown):RecordValue {
  const data=record(value,'saved response target');
  return {runId:string(data.runId,'target.runId'),occurrenceId:string(data.occurrenceId,'target.occurrenceId'),stepRunId:string(data.stepRunId,'target.stepRunId'),attemptId:string(data.attemptId,'target.attemptId'),sessionId:string(data.sessionId,'target.sessionId'),eventId:string(data.eventId,'target.eventId'),eventSeq:count(data.eventSeq,'target.eventSeq'),outputHash:string(data.outputHash,'target.outputHash')};
}
function publishedAssetTarget(value:unknown):RecordValue {
  const data=record(value,'published asset target');
  return {runId:string(data.runId,'target.runId'),assetVersionId:string(data.assetVersionId,'target.assetVersionId'),payloadHash:string(data.payloadHash,'target.payloadHash')};
}
function observationReceipt(value:unknown):RecordValue {
  const data=record(value,'observation receipt'),observer=record(data.observer,'observation observer');
  if(data.delivery==='published-asset-read'){
    const source=record(data.source,'observation.source');
    if(source.kind!=='node'&&source.kind!=='historical-artifact')throw new Error('Invalid published asset source');
    const exactSource=source.kind==='historical-artifact'?{kind:'historical-artifact',runId:string(source.runId,'source.runId'),
      stepRunId:string(source.stepRunId,'source.stepRunId'),attemptId:string(source.attemptId,'source.attemptId'),
      artifactId:string(source.artifactId,'source.artifactId'),sourceWorkspaceId:string(source.sourceWorkspaceId,'source.sourceWorkspaceId'),
      originalSha256:string(source.originalSha256,'source.originalSha256'),originalUri:string(source.originalUri,'source.originalUri')}:
      {kind:'node',runId:string(source.runId,'source.runId'),stepRunId:string(source.stepRunId,'source.stepRunId'),attemptId:string(source.attemptId,'source.attemptId'),nodeId:string(source.nodeId,'source.nodeId'),producer:string(source.producer,'source.producer'),sessionId:string(source.sessionId,'source.sessionId'),contextId:string(source.contextId,'source.contextId'),...(source.generatedByContextId===undefined?{}:{generatedByContextId:string(source.generatedByContextId,'source.generatedByContextId')})};
    return {id:string(data.id,'observation.id'),assetId:string(data.assetId,'observation.assetId'),payloadHash:string(data.payloadHash,'observation.payloadHash'),createdAt:string(data.createdAt,'observation.createdAt'),target:publishedAssetTarget(data.target),source:exactSource,observer:{id:string(observer.id,'observer.id'),sessionId:string(observer.sessionId,'observer.sessionId'),servicePrincipalId:string(observer.servicePrincipalId,'observer.servicePrincipalId')},producerNativeSessionIds:Array.isArray(data.producerNativeSessionIds)?data.producerNativeSessionIds.map(value=>string(value,'observation.producerNativeSessionId')):[],delivery:'published-asset-read'};
  }
  if(data.delivery!=='saved-response-read')throw new Error('Invalid observation delivery');
  return {id:string(data.id,'observation.id'),assetId:string(data.assetId,'observation.assetId'),payloadHash:string(data.payloadHash,'observation.payloadHash'),createdAt:string(data.createdAt,'observation.createdAt'),target:responseTarget(data.target),observer:{id:string(observer.id,'observer.id'),sessionId:string(observer.sessionId,'observer.sessionId'),servicePrincipalId:string(observer.servicePrincipalId,'observer.servicePrincipalId')},...(data.producerNativeSessionId===undefined?{}:{producerNativeSessionId:string(data.producerNativeSessionId,'observation.producerNativeSessionId')}),delivery:'saved-response-read'};
}
function review(value:unknown):RecordValue {
  const data=record(value,'run review'),standard=record(data.standard,'review.standard'),judge=record(data.judge,'review.judge'),answers=record(data.answers,'review.answers');
  return {id:string(data.id,'review.id'),spaceId:string(data.spaceId,'review.spaceId'),runId:string(data.runId,'review.runId'),assetVersionIds:Array.isArray(data.assetVersionIds)?data.assetVersionIds.map(value=>string(value,'review.assetVersionId')):[],
    ...(data.responseTarget===undefined?{}:{responseTarget:responseTarget(data.responseTarget)}),...(data.observationReceiptId===undefined?{}:{observationReceiptId:string(data.observationReceiptId,'review.observationReceiptId')}),baselineReviewId:optionalString(data.baselineReviewId,'review.baselineReviewId'),
    standard:{id:string(standard.id,'review.standard.id'),revision:string(standard.revision,'review.standard.revision'),content:string(standard.content,'review.standard.content')},
    judge:{kind:string(judge.kind,'review.judge.kind'),id:string(judge.id,'review.judge.id'),...(judge.sessionId===undefined?{}:{sessionId:string(judge.sessionId,'review.judge.sessionId')})},
    evidence:Array.isArray(data.evidence)?data.evidence.map(value=>string(value,'review.evidence')):[],
    evidencePointers:Array.isArray(data.evidencePointers)?data.evidencePointers.map(value=>string(value,'review.evidencePointer')):[],
    answers:{good:string(answers.good,'review.answers.good'),bad:string(answers.bad,'review.answers.bad'),improvement:string(answers.improvement,'review.answers.improvement'),unresolved:string(answers.unresolved,'review.answers.unresolved')},
    createdAt:string(data.createdAt,'review.createdAt')};
}
function dispositionEvidence(value:unknown):RecordValue {
  const data=record(value,'disposition evidence'),kind=string(data.kind,'evidence.kind');
  if(kind==='asset')return {kind,assetVersionId:string(data.assetVersionId,'evidence.assetVersionId'),...(data.pointer===undefined?{}:{pointer:string(data.pointer,'evidence.pointer')})};
  if(kind==='response')return {kind,target:responseTarget(data.target),...(data.pointer===undefined?{}:{pointer:string(data.pointer,'evidence.pointer')})};
  if(kind==='run')return {kind,runId:string(data.runId,'evidence.runId'),...(data.stepRunId===undefined?{}:{stepRunId:string(data.stepRunId,'evidence.stepRunId')})};
  throw new Error('Invalid disposition evidence');
}
function disposition(value:unknown):RecordValue {
  const data=record(value,'disposition'),author=record(data.author,'disposition.author');
  if(data.confirmation!=='unconfirmed'||!['human','agent'].includes(String(author.kind)))throw new Error('Invalid disposition authorship');
  return {id:string(data.id,'disposition.id'),assetId:string(data.assetId,'disposition.assetId'),runId:string(data.runId,'disposition.runId'),revision:count(data.revision,'disposition.revision'),payloadHash:string(data.payloadHash,'disposition.payloadHash'),createdAt:string(data.createdAt,'disposition.createdAt'),
    previousRevisionId:nullableString(data.previousRevisionId,'disposition.previousRevisionId'),recordedBy:string(data.recordedBy,'disposition.recordedBy'),author:author.kind==='human'?{kind:'human',id:string(author.id,'disposition.author.id')}:{kind:'agent',id:string(author.id,'disposition.author.id'),sessionId:string(author.sessionId,'disposition.author.sessionId'),servicePrincipalId:string(author.servicePrincipalId,'disposition.author.servicePrincipalId')},confirmation:'unconfirmed',
    reviewIds:Array.isArray(data.reviewIds)?data.reviewIds.map(value=>string(value,'disposition.reviewId')):[],action:string(data.action,'disposition.action'),reason:string(data.reason,'disposition.reason'),
    unknowns:Array.isArray(data.unknowns)?data.unknowns.map(value=>string(value,'disposition.unknown')):[],evidenceRefs:Array.isArray(data.evidenceRefs)?data.evidenceRefs.map(dispositionEvidence):[],...(data.observationReceiptId===undefined?{}:{observationReceiptId:string(data.observationReceiptId,'disposition.observationReceiptId')}),observationReceiptIds:Array.isArray(data.observationReceiptIds)?data.observationReceiptIds.map(value=>string(value,'disposition.observationReceiptId')):[]};
}
function diagnosisEvidence(value:unknown):RecordValue {
  const data=record(value,'diagnosis evidence'),kind=string(data.kind,'diagnosis evidence.kind');
  const pointer=data.pointer===undefined?{}:{pointer:string(data.pointer,'diagnosis evidence.pointer')};
  if(kind==='asset')return {kind,assetVersionId:string(data.assetVersionId,'evidence.assetVersionId'),payloadHash:string(data.payloadHash,'evidence.payloadHash'),...pointer};
  if(kind==='response')return {kind,target:responseTarget(data.target),...pointer};
  if(kind==='review')return {kind,reviewId:string(data.reviewId,'evidence.reviewId'),...pointer};
  if(kind==='disposition')return {kind,revisionId:string(data.revisionId,'evidence.revisionId'),payloadHash:string(data.payloadHash,'evidence.payloadHash'),...pointer};
  if(kind==='inputs')return {kind,manifestId:string(data.manifestId,'evidence.manifestId'),payloadHash:string(data.payloadHash,'evidence.payloadHash'),...pointer};
  if(kind==='trace')return {kind,sessionId:string(data.sessionId,'evidence.sessionId'),...(data.eventId===undefined?{}:{eventId:string(data.eventId,'evidence.eventId')}),...(data.eventSeq===undefined?{}:{eventSeq:count(data.eventSeq,'evidence.eventSeq')}),...pointer};
  if(kind==='run')return {kind,runId:string(data.runId,'evidence.runId'),...(data.stepRunId===undefined?{}:{stepRunId:string(data.stepRunId,'evidence.stepRunId')})};
  throw new Error('Invalid diagnosis evidence kind');
}
function diagnosis(value:unknown):RecordValue {
  const data=record(value,'diagnosis'),author=record(data.author,'diagnosis.author');
  if(data.confirmation!=='unconfirmed'||!['human','agent'].includes(String(author.kind)))throw new Error('Invalid diagnosis authorship');
  const issues=list(data.issues,'diagnosis.issues').map(item=>{
    const decision=record(item.decision,'diagnosis.issue.decision');
    return {id:string(item.id,'issue.id'),title:string(item.title,'issue.title'),expected:string(item.expected,'issue.expected'),observed:string(item.observed,'issue.observed'),
      evidenceRefs:list(item.evidenceRefs,'issue.evidenceRefs').map(diagnosisEvidence),hypotheses:list(item.hypotheses,'issue.hypotheses').map(hypothesis=>({
        id:string(hypothesis.id,'hypothesis.id'),category:string(hypothesis.category,'hypothesis.category'),explanation:string(hypothesis.explanation,'hypothesis.explanation'),
        supportRefs:list(hypothesis.supportRefs,'hypothesis.supportRefs').map(diagnosisEvidence),counterRefs:list(hypothesis.counterRefs,'hypothesis.counterRefs').map(diagnosisEvidence),
        unknowns:Array.isArray(hypothesis.unknowns)?hypothesis.unknowns.map(value=>string(value,'hypothesis.unknown')):[],discriminatingCheck:string(hypothesis.discriminatingCheck,'hypothesis.discriminatingCheck')})),
      unknowns:Array.isArray(item.unknowns)?item.unknowns.map(value=>string(value,'issue.unknown')):[],
      decision:{route:string(decision.route,'decision.route'),reason:string(decision.reason,'decision.reason'),...(decision.nextCheck===undefined?{}:{nextCheck:string(decision.nextCheck,'decision.nextCheck')}),...(decision.externalIssueRef===undefined?{}:{externalIssueRef:string(decision.externalIssueRef,'decision.externalIssueRef')}),...(decision.designSessionRef===undefined?{}:{designSessionRef:string(decision.designSessionRef,'decision.designSessionRef')})}};
  });
  const candidate=data.candidateDraft===undefined?undefined:(()=>{const draft=record(data.candidateDraft,'diagnosis.candidateDraft');return {
    predecessorVersionId:string(draft.predecessorVersionId,'candidate.predecessorVersionId'),issueIds:stringList(draft.issueIds,'candidate.issueIds'),
    hypothesisIds:stringList(draft.hypothesisIds,'candidate.hypothesisIds'),
    changes:list(draft.changes,'candidate.changes').map(value=>({target:string(value.target,'change.target'),before:string(value.before,'change.before'),after:string(value.after,'change.after'),reason:string(value.reason,'change.reason')})),
    expectedBenefits:stringList(draft.expectedBenefits,'candidate.expectedBenefits'),
    risks:stringList(draft.risks,'candidate.risks'),validationPlan:string(draft.validationPlan,'candidate.validationPlan'),
    falsificationConditions:stringList(draft.falsificationConditions,'candidate.falsificationConditions'),
    conditions:stringList(draft.conditions,'candidate.conditions')};})();
  return {id:string(data.id,'diagnosis.id'),assetId:string(data.assetId,'diagnosis.assetId'),runId:string(data.runId,'diagnosis.runId'),workflowVersionId:string(data.workflowVersionId,'diagnosis.workflowVersionId'),
    revision:count(data.revision,'diagnosis.revision'),payloadHash:string(data.payloadHash,'diagnosis.payloadHash'),createdAt:string(data.createdAt,'diagnosis.createdAt'),
    previousRevisionId:nullableString(data.previousRevisionId,'diagnosis.previousRevisionId'),reviewIds:stringList(data.reviewIds,'diagnosis.reviewIds'),
    dispositionRevisionId:string(data.dispositionRevisionId,'diagnosis.dispositionRevisionId'),dispositionPayloadHash:string(data.dispositionPayloadHash,'diagnosis.dispositionPayloadHash'),issues,
    ...(candidate?{candidateDraft:candidate,candidateStatus:string(data.candidateStatus,'diagnosis.candidateStatus')}:{}),
    ...(data.observationReceiptId===undefined?{}:{observationReceiptId:string(data.observationReceiptId,'diagnosis.observationReceiptId')}),
    author:author.kind==='human'?{kind:'human',id:string(author.id,'author.id')}:{kind:'agent',id:string(author.id,'author.id'),sessionId:string(author.sessionId,'author.sessionId'),servicePrincipalId:string(author.servicePrincipalId,'author.servicePrincipalId')},
    recordedBy:string(data.recordedBy,'diagnosis.recordedBy'),confirmation:'unconfirmed'};
}

/** Read-only, allowlisted projections from the host-authenticated Space API. */
export async function runOperatorCli(argv: readonly string[], options: OperatorCliOptions = {}): Promise<number> {
  const write = options.stdout ?? (value => process.stdout.write(`${value}\n`));
  const error = options.stderr ?? (value => process.stderr.write(`${value}\n`));
  const env = options.env ?? process.env;
  try {
    const [command, first, second, third, fourth, ...extra] = argv;
    if (command === '--help' || command === '-h') { write(usage); return 0; }
    const evidenceArgs=command==='run-evidence'?evidenceArguments(argv.slice(1)):null;
    if (!command || (command!=='run-evidence'&&extra.length) || !['onboarding', 'space', 'space-create', 'versions', 'version', 'node', 'cases', 'case', 'run', 'run-inputs', 'process', 'run-evidence', 'occurrence', 'runtime', 'occurrence-responses', 'trace', 'run-trace', 'asset', 'blob-upload', 'asset-import', 'attachment-download', 'review-subjects', 'observe-response', 'observe-asset', 'observation', 'reviews', 'review', 'review-save', 'dispositions', 'disposition', 'disposition-save', 'diagnosis', 'diagnoses', 'diagnosis-save', 'understanding', 'understanding-history', 'understanding-save', 'capability', 'capability-history', 'capability-prepare', 'capability-save', 'design', 'design-history', 'design-prepare', 'design-save', 'design-definition', 'execution-state', 'method-command', 'method-preview', 'method-publish', 'method-basis'].includes(command) ||
      ((command === 'onboarding' || command === 'space' || command === 'versions' || command === 'cases' || command === 'understanding-history' || command === 'capability-history' || command === 'design-history' || command === 'execution-state') && (first || second || third || fourth)) ||
      ((command === 'version' || command === 'method-basis' || command === 'case' || command === 'run' || command === 'run-inputs' || command === 'process' || command === 'asset' || command === 'review-subjects' || command === 'reviews' || command === 'dispositions' || command === 'diagnoses') && (!first || second || third || fourth)) ||
      (command === 'diagnosis' && (!first || third || fourth)) ||
      ((command === 'node' || command === 'occurrence' || command === 'occurrence-responses' || command === 'trace' || command === 'run-trace' || command === 'review' || command === 'disposition' || command === 'observation') && (!first || !second || third || fourth)) ||
      (command === 'runtime' && (!first || !second || !third || fourth)) ||
      ((command === 'understanding' || command === 'capability' || command === 'design') && ((first || second) && !(first === '--revision' && second && !third && !fourth))) ||
      (command === 'design-definition' && (first !== '--revision' || !second || third || fourth)) ||
      ((command === 'understanding-save' || command === 'capability-save' || command === 'method-command' || command === 'design-save' || command === 'review-save' || command === 'disposition-save' || command === 'diagnosis-save' || command === 'observe-response' || command === 'observe-asset' || command === 'asset-import' || command === 'space-create') && (first !== '--file' || !second || third || fourth)) ||
      ((command==='capability-prepare'||command==='design-prepare')&&(first!=='--file'||!second||((third||fourth)&&!(third==='--out'&&fourth)))) ||
      (command==='blob-upload'&&(first!=='--file'||!second||third!=='--media-type'||!fourth)) ||
      (command==='attachment-download'&&(!first||!second||third!=='--out'||!fourth)) ||
      (command === 'method-preview' && (first !== '--design' || !second || third || fourth)) ||
      (command === 'method-publish' && (first !== '--design' || !second || third !== '--expected' || !fourth))) throw new Error(usage);
    const base = origin(env.WORKFLOW_OPERATOR_BASE_URL);
    const spaceId = id(env.WORKFLOW_OPERATOR_SPACE_ID, 'WORKFLOW_OPERATOR_SPACE_ID');
    const scope = `${base}/api/workflow-spaces/v1/spaces/${encodeURIComponent(spaceId)}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if ([env.WORKFLOW_OPERATOR_AUTHORIZATION,env.WORKFLOW_OPERATOR_COOKIE,env.WORKFLOW_OPERATOR_TOKEN_FILE].filter(Boolean).length>1) throw new Error('Choose one operator authentication source');
    const parsedBase = new URL(base);
    if ((env.WORKFLOW_OPERATOR_AUTHORIZATION || env.WORKFLOW_OPERATOR_COOKIE || env.WORKFLOW_OPERATOR_TOKEN_FILE) && parsedBase.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsedBase.hostname)) {
      throw new Error('Operator credentials require HTTPS or a loopback URL');
    }
    if (env.WORKFLOW_OPERATOR_AUTHORIZATION) headers.authorization = env.WORKFLOW_OPERATOR_AUTHORIZATION;
    if (env.WORKFLOW_OPERATOR_COOKIE) headers.cookie = env.WORKFLOW_OPERATOR_COOKIE;
    if (env.WORKFLOW_OPERATOR_TOKEN_FILE) {
      const file=env.WORKFLOW_OPERATOR_TOKEN_FILE;
      if(!isAbsolute(file))throw new Error('WORKFLOW_OPERATOR_TOKEN_FILE must be absolute');
      let token:string;
      try{const info=await lstat(file);if(!info.isFile()||(info.mode&0o077)!==0)throw new Error();const credential=record(JSON.parse(await readFile(file,'utf8')),'credential');
        if(credential.version===1){if(credential.spaceId!==spaceId)throw new Error();}
        else if(credential.version===2){
          const principal=record(credential.principal,'credential.principal'),agent=record(principal.externalAgent,'credential.externalAgent');
          if(!stringList(credential.spaceIds,'credential.spaceIds').includes(spaceId)||principal.kind!=='service'||
            principal.id!==`external-agent:${string(agent.sessionId,'credential.agent.sessionId')}`||
            !string(agent.id,'credential.agent.id')||!['design','observer'].includes(String(agent.role)))throw new Error();
        }
        else throw new Error();
        token=string(credential.token,'credential.token');if(!token||/\s/u.test(token)||(credential.version===2&&token.length<24))throw new Error();}
      catch{throw new Error('Invalid private operator token file');}
      headers.authorization=`Bearer ${token}`;
    }
    const fetcher = options.fetch ?? globalThis.fetch;
    const getRaw = async (path: string): Promise<unknown> => {
      let response: Response;
      try { response = await fetcher(`${scope}${path}`, { method: 'GET', headers, redirect: 'error' }); }
      catch { throw new Error('Operator API request failed'); }
      if (!response.ok) throw Object.assign(new Error(`Operator API returned HTTP ${response.status}`),{status:response.status});
      let body: unknown;
      try { body = await response.json(); } catch { throw new Error('Operator API returned invalid JSON'); }
      return body;
    };
    const get = async(path:string):Promise<RecordValue>=>record(await getRaw(path),'API');
    const understanding = (value: unknown): RecordValue => {
      const data = record(value, 'understanding');
      if (data.confirmation !== 'unconfirmed') throw new Error('Invalid understanding confirmation');
      const revision=count(data.revision,'understanding.revision');
      if(revision<1)throw new Error('Invalid understanding revision');
      const sources=list(data.sources,'understanding.sources').map(source=>({
        kind:string(source.kind,'understanding.source.kind'),ref:string(source.ref,'understanding.source.ref'),
        title:string(source.title,'understanding.source.title'),
        ...(source.excerpt===undefined?{}:{excerpt:string(source.excerpt,'understanding.source.excerpt')}),
      }));
      if(!sources.length||sources.some(source=>!['document','case','asset','user-request'].includes(source.kind)))throw new Error('Invalid understanding sources');
      const authorship=record(data.authorship,'understanding.authorship');
      const kind=string(authorship.kind,'understanding.authorship.kind');
      if(!['agent','human'].includes(kind))throw new Error('Invalid understanding authorship');
      return {id:string(data.id,'understanding.id'),assetId:string(data.assetId,'understanding.assetId'),revision,
        payloadHash:string(data.payloadHash,'understanding.payloadHash'),createdAt:string(data.createdAt,'understanding.createdAt'),
        previousRevisionId:nullableString(data.previousRevisionId,'understanding.previousRevisionId'),
        changeReason:string(data.changeReason,'understanding.changeReason'),title:string(data.title,'understanding.title'),
        content:string(data.content,'understanding.content'),sources,
        authorship:{kind,name:string(authorship.name,'understanding.authorship.name'),
          ...(authorship.sessionId===undefined?{}:{sessionId:string(authorship.sessionId,'understanding.authorship.sessionId')})},
        recordedBy:string(data.recordedBy,'understanding.recordedBy'),confirmation:'unconfirmed'};
    };
    const design = (value:unknown):RecordValue => {
      const data=record(value,'method design');
      const reference=record(data.understanding,'method design understanding');
      return {...understanding(data),workflowId:string(data.workflowId,'method design workflowId'),
        entrypoint:string(data.entrypoint,'method design entrypoint'),
        understanding:{revisionId:string(reference.revisionId,'method design understanding revisionId'),
          payloadHash:string(reference.payloadHash,'method design understanding payloadHash')},
        ...(data.capability===undefined?{}:{capability:{revisionId:string(record(data.capability,'method design capability').revisionId,'method design capability revisionId'),
          payloadHash:string(record(data.capability,'method design capability').payloadHash,'method design capability payloadHash')}})};
    };
    const saveFile=async(file:string):Promise<RecordValue>=>{
      try{return record(JSON.parse(await readFile(file,'utf8')),'save file');}
      catch{throw new Error('Invalid save file');}
    };
    const securedPost=async(path:string,body:RecordValue,capability:'attachmentWrite'|'methodCapabilityWrite'|'methodExecutionWrite'|'methodDesignWrite'|'methodPublish'|'reviewWrite'|'dispositionWrite'|'observationWrite'|'diagnosisWrite',
      check?:(summary:RecordValue)=>Promise<void>|void):Promise<RecordValue>=>{
      const summary=await get('/summary');
      if(record(summary.capabilities,'summary.capabilities')[capability]!==true)throw new Error('Method operation is unavailable');
      await check?.(summary);
      const csrf=string(summary.csrfToken,'summary.csrfToken');
      if(!csrf)throw new Error('Method operation requires a CSRF token');
      let response:Response;
      try{response=await fetcher(`${scope}${path}`,{method:'POST',headers:{...headers,'content-type':'application/json','x-space-csrf':csrf,origin:new URL(base).origin},body:JSON.stringify(body),redirect:'error'});}
      catch{throw new Error('Operator API request failed');}
      if(!response.ok)throw new Error(`Operator API returned HTTP ${response.status}`);
      let result:unknown;
      try{result=await response.json();}catch{throw new Error('Operator API returned invalid JSON');}
      return record(result,'API');
    };
    const pages=async(path:string,name:string,project:(value:unknown)=>RecordValue):Promise<RecordValue[]>=>{
      const items:RecordValue[]=[];let cursor:string|null=null;const seen=new Set<string>();
      for(let page=0;page<100;page++){
        const join=path.includes('?')?'&':'?';
        const data=await get(`${path}${join}limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
        items.push(...list(data.items,`${name}.items`).map(project));
        cursor=nullableString(data.nextCursor,`${name}.nextCursor`);
        if(!cursor) return items;
        if(seen.has(cursor)||page===99)throw new Error(`Operator API ${name} pagination did not finish`);
        seen.add(cursor);
      }
      return items;
    };
    let output: RecordValue;
    if (command === 'onboarding') {
      let response:Response;
      try{response=await fetcher(`${base}/api/workflow-spaces/v1/onboarding`,{method:'GET',headers,redirect:'error'});}
      catch{throw new Error('Operator onboarding request failed');}
      if(!response.ok)throw new Error(`Operator onboarding returned HTTP ${response.status}`);
      let data:RecordValue;
      try{data=record(await response.json(),'onboarding');}
      catch{throw new Error('Invalid operator onboarding response');}
      const subject=record(data.subject,'onboarding.subject');
      const subjectKind=string(subject.kind,'onboarding.subject.kind');
      if(!['service','human'].includes(subjectKind)||!string(subject.id,'onboarding.subject.id')||
        !string(subject.cacheScope,'onboarding.subject.cacheScope')||typeof data.canCreateSpace!=='boolean')
        throw new Error('Invalid operator onboarding response');
      const externalAgent=subject.externalAgent===undefined?null:record(subject.externalAgent,'onboarding.subject.externalAgent');
      if((subjectKind==='service'&&!externalAgent)||(externalAgent&&
        (!string(externalAgent.id,'onboarding.agent.id')||!string(externalAgent.sessionId,'onboarding.agent.sessionId')||
          !['design','observer'].includes(String(externalAgent.role)))))
        throw new Error('Invalid operator onboarding subject');
      const allowed=stringList(data.allowedSpaceIds,'onboarding.allowedSpaceIds');
      if(new Set(allowed).size!==allowed.length||!allowed.includes(spaceId))throw new Error('Operator target Space is outside host scope');
      const catalog=list(data.spaces,'onboarding.spaces').map(space=>{
        const entryId=id(string(space.id,'onboarding.space.id'),'onboarding.space.id');
        if(!allowed.includes(entryId))throw new Error('Operator onboarding catalog is outside host scope');
        const rawScope=space.designScope??space.scope;
        const scopeValue=rawScope===undefined||rawScope===null?null:record(rawScope,'onboarding.space.scope');
        const scopeValueSafe=scopeValue?{workflowId:id(string(scopeValue.workflowId,'onboarding.space.workflowId'),'onboarding.space.workflowId'),
          entrypoint:id(string(scopeValue.entrypoint,'onboarding.space.entrypoint'),'onboarding.space.entrypoint')}:null;
        const rawState=space.businessState;
        const state=rawState===undefined||rawState===null?null:record(rawState,'onboarding.space.businessState');
        const fields=['workflowVersions','understandingRevisions','methodDesignRevisions','cases','runs','businessAssets','assetVersions','adoptions'];
        return {id:entryId,purpose:string(space.purpose,'onboarding.space.purpose'),...(scopeValueSafe?{scope:scopeValueSafe}:{}),
          ...(state?{businessState:{...Object.fromEntries(fields.map(field=>[field,count(state[field],`onboarding.space.businessState.${field}`)])),
            understandingRevisionId:nullableString(state.understandingRevisionId,'onboarding.space.businessState.understandingRevisionId')}}:{})};
      });
      if(new Set(catalog.map(space=>space.id)).size!==catalog.length)throw new Error('Invalid operator onboarding catalog');
      output={subject:{id:subject.id,cacheScope:subject.cacheScope,kind:subjectKind,
        ...(externalAgent?{externalAgent:{id:externalAgent.id,sessionId:externalAgent.sessionId,role:externalAgent.role}}:{})},
        canCreateSpace:data.canCreateSpace,allowedSpaceIds:allowed,spaces:catalog};
    } else if (command === 'space-create') {
      if(!isAbsolute(second!))throw new Error('Space creation request file must be absolute');
      let body:RecordValue;
      try{body=record(JSON.parse(await readFile(second!,'utf8')),'Space creation request');}
      catch{throw new Error('Invalid Space creation request file');}
      if(Object.keys(body).sort().join(',')!=='id,idempotencyKey,purpose,scope')throw new Error('Invalid Space creation request');
      const requestId=id(string(body.id,'request.id'),'request.id');
      const purpose=string(body.purpose,'request.purpose').trim();
      const key=id(string(body.idempotencyKey,'request.idempotencyKey'),'request.idempotencyKey');
      const requestedScope=record(body.scope,'request.scope');
      if(Object.keys(requestedScope).sort().join(',')!=='entrypoint,workflowId'||!purpose.trim()||requestId!==spaceId)
        throw new Error('Invalid Space creation request');
      const workflowId=id(string(requestedScope.workflowId,'request.workflowId'),'request.workflowId');
      const entrypoint=id(string(requestedScope.entrypoint,'request.entrypoint'),'request.entrypoint');
      const onboardUrl=`${base}/api/workflow-spaces/v1/onboarding`;
      let onboardResponse:Response;
      try{onboardResponse=await fetcher(onboardUrl,{method:'GET',headers,redirect:'error'});}
      catch{throw new Error('Operator onboarding request failed');}
      if(!onboardResponse.ok)throw new Error(`Operator onboarding returned HTTP ${onboardResponse.status}`);
      let onboarding:RecordValue;
      try{onboarding=record(await onboardResponse.json(),'onboarding');}
      catch{throw new Error('Invalid operator onboarding response');}
      const subject=record(onboarding.subject,'onboarding.subject');
      const agent=record(subject.externalAgent,'onboarding.subject.externalAgent');
      if(subject.kind!=='service'||agent.role!=='design'||!string(subject.id,'subject.id')||
        !string(subject.cacheScope,'subject.cacheScope')||!string(agent.id,'agent.id')||!string(agent.sessionId,'agent.sessionId')||
        onboarding.canCreateSpace!==true||!stringList(onboarding.allowedSpaceIds,'onboarding.allowedSpaceIds').includes(spaceId))
        throw new Error('Design Agent is not allowed to create this Space');
      const csrf=string(onboarding.csrfToken,'onboarding.csrfToken');
      if(!csrf)throw new Error('Operator onboarding requires a CSRF token');
      let response:Response;
      try{response=await fetcher(`${base}/api/workflow-spaces/v1/spaces`,{method:'POST',headers:{...headers,'content-type':'application/json','x-space-csrf':csrf,origin:new URL(base).origin},
        body:JSON.stringify({id:requestId,purpose,scope:{workflowId,entrypoint},idempotencyKey:key}),redirect:'error'});}
      catch{throw new Error('Operator API request failed');}
      if(!response.ok)throw new Error(`Operator API returned HTTP ${response.status}`);
      let result:RecordValue;
      try{result=record(await response.json(),'Space creation receipt');}
      catch{throw new Error('Invalid Space creation receipt');}
      const created=record(result.space,'receipt.space'),returnedScope=record(result.scope,'receipt.scope');
      const creator=record(result.createdBy,'receipt.createdBy'),counts=record(result.initialCounts,'receipt.initialCounts');
      const fields=['workflowVersions','understandingRevisions','methodDesignRevisions','cases','runs','businessAssets','assetVersions','adoptions'];
      const spaceScope=created.designScope===undefined?null:record(created.designScope,'receipt.space.designScope');
      const spaceCreator=created.provisionedBy===undefined?null:record(created.provisionedBy,'receipt.space.provisionedBy');
      if(created.id!==requestId||created.purpose!==purpose||returnedScope.workflowId!==workflowId||returnedScope.entrypoint!==entrypoint||
        (spaceScope&&(spaceScope.workflowId!==workflowId||spaceScope.entrypoint!==entrypoint))||
        (spaceCreator&&(spaceCreator.agentId!==agent.id||spaceCreator.sessionId!==agent.sessionId||spaceCreator.principalId!==subject.id))||
        creator.agentId!==agent.id||creator.sessionId!==agent.sessionId||creator.principalId!==subject.id||
        Object.keys(counts).sort().join(',')!==[...fields].sort().join(',')||fields.some(field=>counts[field]!==0))
        throw new Error('Operator API returned a different Space creation receipt');
      output={space:{id:requestId,purpose,owner:string(created.owner,'receipt.space.owner'),status:string(created.status,'receipt.space.status'),createdAt:string(created.createdAt,'receipt.space.createdAt')},
        scope:{workflowId,entrypoint},createdBy:{agentId:agent.id,sessionId:agent.sessionId,principalId:subject.id},initialCounts:Object.fromEntries(fields.map(field=>[field,0]))};
    } else if (command === 'space') {
      const data = await get('/summary');
      const method = record(data.methodScope, 'summary.methodScope');
      output = { id: string(data.id, 'summary.id'), title: string(data.title, 'summary.title'), purpose: string(data.purpose, 'summary.purpose'),
        methodScope: { workflowId: string(method.workflowId, 'summary.workflowId'), entrypoint: string(method.entrypoint, 'summary.entrypoint'), adoptionSlot: optionalString(method.adoptionSlot, 'summary.adoptionSlot') },
        adoptedVersionId: nullableString(data.adoptedVersionId, 'summary.adoptedVersionId'), latestVersionId: nullableString(data.latestVersionId, 'summary.latestVersionId'), snapshotAt: string(data.snapshotAt, 'summary.snapshotAt') };
      if(data.businessState!==undefined){const state=record(data.businessState,'summary.businessState');
        const fields=['workflowVersions','understandingRevisions','methodDesignRevisions','cases','runs','businessAssets','assetVersions','adoptions'];
        output.businessState={...Object.fromEntries(fields.map(field=>[field,count(state[field],`summary.businessState.${field}`)])),
          understandingRevisionId:nullableString(state.understandingRevisionId,'summary.businessState.understandingRevisionId')};}
      if (output.id !== spaceId) throw new Error('Operator API returned a different Space');
    } else if (command === 'versions') {
      const items: RecordValue[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const data = await get(`/versions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        items.push(...list(data.items, 'versions.items').map(version));
        cursor = nullableString(data.nextCursor, 'versions.nextCursor');
        if (!cursor) break;
        if (seen.has(cursor) || page === 99) throw new Error('Operator API version pagination did not finish');
        seen.add(cursor);
      }
      output = { spaceId, versions: items };
    } else if (command === 'version') {
      const versionId = id(first, 'version ID');
      const data = await get(`/versions/${encodeURIComponent(versionId)}`);
      if (data.id !== versionId) throw new Error('Operator API returned a different version');
      const adoptionStatus = string(data.adoptionStatus, 'version.adoptionStatus');
      if (!['recorded', 'unknown'].includes(adoptionStatus)) throw new Error('Invalid version adoption status');
      output = { spaceId, ...version(data), hash: string(data.hash, 'version.hash'), purpose: optionalString(data.purpose, 'version.purpose'),
        adoptionStatus, adoptionSlots: Array.isArray(data.adoptionSlots) ? data.adoptionSlots.map(value => string(value, 'version.adoptionSlot')) : [],
        nodes: list(data.nodes, 'version.nodes').map(node), expectedAssets: expectedAssets(data.expectedAssets) };
    } else if (command === 'cases') {
      output={spaceId,cases:await pages('/cases','cases',caseSummary)};
    } else if (command === 'case') {
      const caseId=id(first,'case ID');
      const selected=caseSummary(await get(`/cases/${encodeURIComponent(caseId)}`));
      if(selected.id!==caseId)throw new Error('Operator API returned a different Case');
      const [runs,assets]=await Promise.all([
        pages(`/cases/${encodeURIComponent(caseId)}/runs`,'case runs',runSummary),
        pages(`/assets?caseId=${encodeURIComponent(caseId)}`,'case assets',assetSummary),
      ]);
      if(runs.some(run=>run.caseId!==caseId))throw new Error('Operator API returned an unrelated run');
      output={spaceId,case:selected,runs,assets};
    } else if (command === 'run-evidence') {
      output=await collectRunEvidence({get:getRaw,spaceId,...evidenceArgs!,project:{run:runDetail,inputs:inputManifest,process:processReading,occurrence:occurrenceDetail,asset:assetSummary}});
    } else if (command === 'run' || command === 'run-inputs') {
      const runId=id(first,'run ID');
      const inputs=inputManifest(await get(`/runs/${encodeURIComponent(runId)}/inputs`));
      if(inputs.runId!==runId)throw new Error('Operator API returned a different input manifest');
      if(command==='run-inputs')output={spaceId,...inputs};
      else{
        const detail=runDetail(await get(`/runs/${encodeURIComponent(runId)}`));
        if(detail.id!==runId||detail.inputManifestId!==inputs.inputManifestId||detail.inputManifestHash!==inputs.inputManifestHash||detail.caseId!==inputs.caseId||detail.versionId!==inputs.versionId)throw new Error('Operator API returned a different run');
        output={spaceId,...detail,inputManifest:inputs};
      }
    } else if (command === 'process') {
      const runId=id(first,'run ID');
      const process=processReading(await get(`/runs/${encodeURIComponent(runId)}/process`));
      if(process.runId!==runId)throw new Error('Operator API returned a different process');
      output={spaceId,...process,sessionEvents:'use run-trace <run-id> <session-id> to read saved events when available'};
    } else if (command === 'occurrence' || command === 'trace') {
      const runId=id(first,'run ID'),occurrenceId=id(second,'occurrence ID');
      const selected=occurrenceDetail(await get(`/runs/${encodeURIComponent(runId)}/occurrences/${encodeURIComponent(occurrenceId)}`));
      if(selected.runId!==runId||selected.id!==occurrenceId)throw new Error('Operator API returned a different occurrence');
      output={spaceId,...selected,...(command==='trace'?{sessionEvents:'use run-trace <run-id> <session-id> to read saved events when available'}:{})};
    } else if (command === 'runtime') {
      const runId=id(first,'run ID'),occurrenceId=id(second,'occurrence ID'),attemptId=id(third,'attempt ID');
      const events:RecordValue[]=[],calls=new Map<string,RecordValue>();
      let after=0,hasMore=true,firstPage:RecordValue|undefined;
      for(let pageNumber=0;hasMore&&pageNumber<100;pageNumber++){
        const page=await get(`/runs/${encodeURIComponent(runId)}/occurrences/${encodeURIComponent(occurrenceId)}/runtime?attemptId=${encodeURIComponent(attemptId)}&after=${after}&limit=100`);
        if(page.runId!==runId||page.occurrenceId!==occurrenceId||page.attemptId!==attemptId||page.sanitized!==true)throw new Error('Operator API returned a different runtime attempt');
        if(!firstPage)firstPage=page;
        else if(page.versionId!==firstPage.versionId||page.stepRunId!==firstPage.stepRunId||page.contextId!==firstPage.contextId||page.sessionId!==firstPage.sessionId)throw new Error('Operator API changed the runtime attempt');
        const next=count(page.nextCursor,'runtime.nextCursor');
        if(next<after||typeof page.hasMore!=='boolean'||page.scanComplete!==!page.hasMore||(page.hasMore&&next<=after))throw new Error('Operator API returned an invalid runtime cursor');
        for(const event of list(page.events,'runtime.events')){
          if(event.attemptId!==attemptId||!['siwc.started','siwc.tool_call','siwc.tool_result','siwc.tool_failed'].includes(String(event.type)))throw new Error('Operator API returned an invalid runtime event');
          events.push(event);
        }
        for(const call of list(page.calls,'runtime.calls')){
          const callId=string(call.callId,'runtime.callId'),prior=calls.get(callId);
          calls.set(callId,{...prior,...call,
            callEventId:call.callEventId??prior?.callEventId??null,callSeq:call.callSeq??prior?.callSeq??null,
            outcomeEventId:call.outcomeEventId??prior?.outcomeEventId??null,outcomeSeq:call.outcomeSeq??prior?.outcomeSeq??null,
            status:call.outcomeEventId?call.status:prior?.outcomeEventId?prior.status:call.status});
        }
        after=next;hasMore=page.hasMore;
      }
      if(!firstPage)throw new Error('Operator API returned no runtime page');
      output={spaceId,runId,occurrenceId,attemptId,versionId:string(firstPage.versionId,'runtime.versionId'),
        stepRunId:string(firstPage.stepRunId,'runtime.stepRunId'),contextId:string(firstPage.contextId,'runtime.contextId'),sessionId:string(firstPage.sessionId,'runtime.sessionId'),
        frozenPrompt:nullableString(firstPage.frozenPrompt,'runtime.frozenPrompt'),frozenPromptCoverage:string(firstPage.frozenPromptCoverage,'runtime.frozenPromptCoverage'),
        contextInstructions:string(firstPage.contextInstructions,'runtime.contextInstructions'),contextInstructionsCoverage:string(firstPage.contextInstructionsCoverage,'runtime.contextInstructionsCoverage'),
        effectiveConfig:safeConfig(firstPage.effectiveConfig),events,calls:[...calls.values()],nextCursor:after,hasMore,scanComplete:!hasMore,
        observedCallCount:hasMore?null:events.filter(event=>event.type==='siwc.tool_call').length,
        bodyCoverage:events.some(event=>event.bodyCoverage==='truncated')?'truncated':'full',evidenceScope:'saved-runner-events-only',sanitized:true};
    } else if (command === 'occurrence-responses') {
      const runId=id(first,'run ID'),occurrenceId=id(second,'occurrence ID');
      const data=await get(`/runs/${encodeURIComponent(runId)}/occurrences/${encodeURIComponent(occurrenceId)}/responses`);
      if(data.runId!==runId||data.occurrenceId!==occurrenceId)throw new Error('Operator API returned a different occurrence response');
      output={spaceId,runId,occurrenceId,responses:list(data.responses,'responses').map(value=>{
        const item=record(value,'response');
        if(item.publication!=='unpublished'||!['full','truncated'].includes(String(item.coverage)))throw new Error('Invalid response provenance');
        const body=string(item.output,'response.output');if(Buffer.byteLength(body,'utf8')>1_048_576)throw new Error('Invalid response length');
        const reading=record(item.reading,'response.reading');const readerStatus=string(reading.readerStatus,'response.reading.readerStatus');
        if(!['registered','fallback'].includes(readerStatus))throw new Error('Invalid response reader status');
        const sections=list(reading.sections,'response.reading.sections').map(value=>{const section=record(value,'response section');return {title:string(section.title,'response section.title'),text:string(section.text,'response section.text'),...(section.pointer===undefined?{}:{pointer:string(section.pointer,'response section.pointer')}),...(section.sourceRefs===undefined?{}:{sourceRefs:Array.isArray(section.sourceRefs)?section.sourceRefs.map(value=>string(value,'response section.sourceRef')):[]}),...(section.view===undefined?{}:{view:string(section.view,'response section.view')})};});
        if(Buffer.byteLength(JSON.stringify(sections),'utf8')>1_048_576)throw new Error('Invalid response reading length');
        return {stepRunId:string(item.stepRunId,'response.stepRunId'),attemptId:string(item.attemptId,'response.attemptId'),sessionId:string(item.sessionId,'response.sessionId'),eventId:string(item.eventId,'response.eventId'),eventSeq:count(item.eventSeq,'response.eventSeq'),publication:'unpublished',output:body,coverage:item.coverage,reading:{title:string(reading.title,'response.reading.title'),sections,readerStatus,reason:nullableString(reading.reason,'response.reading.reason')}};
      })};
    } else if (command === 'run-trace') {
      const runId=id(first,'run ID'),sessionId=id(second,'session ID');
      const events:RecordValue[]=[];let after=0,hasMore=true;
      for(let page=0;hasMore&&page<100;page++){
        const data=await get(`/runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(sessionId)}/events?after=${after}&limit=100`);
        if(data.runId!==runId||data.sessionId!==sessionId)throw new Error('Operator API returned a different run session');
        const next=count(data.nextCursor,'trace.nextCursor');
        if(next<after||typeof data.hasMore!=='boolean'||(data.hasMore&&next<=after))throw new Error('Operator API returned an invalid trace cursor');
        events.push(...list(data.items,'trace.items').map(value=>({id:string(value.id,'event.id'),seq:count(value.seq,'event.seq'),attemptId:string(value.attemptId,'event.attemptId'),
          kind:string(value.kind,'event.kind'),body:value.body,createdAt:string(value.createdAt,'event.createdAt')})));
        after=next;hasMore=data.hasMore;
        if(page===99&&hasMore)throw new Error('Operator API trace pagination did not finish');
      }
      output={spaceId,runId,sessionId,events,complete:!hasMore};
    } else if(command==='blob-upload'){
      if(!isAbsolute(second!))throw new Error('Attachment path must be absolute');
      const info=await stat(second!);if(!info.isFile()||info.size<1||info.size>16*1024*1024)throw new Error('Attachment must be a file between 1 byte and 16 MiB');
      const bytes=await readFile(second!);if(bytes.byteLength!==info.size)throw new Error('Attachment changed while reading');
      const mediaType=id(fourth,'media type');
      const summary=await get('/summary');
      if(record(summary.capabilities,'summary.capabilities').attachmentWrite!==true)throw new Error('Attachment writes unavailable');
      const csrf=string(summary.csrfToken,'summary.csrfToken');if(!csrf)throw new Error('Attachment upload requires CSRF token');
      let response:Response;
      try{response=await fetcher(`${scope}/attachments/blobs`,{method:'POST',headers:{...headers,'content-type':mediaType,'x-space-csrf':csrf,origin:new URL(base).origin},body:bytes,redirect:'error'});}
      catch{throw new Error('Operator API request failed');}
      if(!response.ok)throw new Error(`Operator API returned HTTP ${response.status}`);
      const blob=record(await response.json(),'attachment');
      const sha256=createHash('sha256').update(bytes).digest('hex');
      if(blob.id!==sha256||blob.sha256!==sha256||blob.size!==bytes.byteLength||blob.mediaType!==mediaType)throw new Error('Operator API returned a different attachment');
      output={id:sha256,sha256,size:bytes.byteLength,mediaType};
    } else if(command==='asset-import'){
      const body=await saveFile(second!);
      const assetId=id(string(body.assetId,'assetId'),'assetId');
      const schema=record(body.schema,'schema');for(const field of ['namespace','revision','hash'])id(string(schema[field],`schema.${field}`),`schema.${field}`);
      const expectedHead=body.expectedHead===null?null:id(string(body.expectedHead,'expectedHead'),'expectedHead');
      id(string(body.idempotencyKey,'idempotencyKey'),'idempotencyKey');
      const blobIds=body.blobIds;
      if(typeof body.description!=='string'||!body.description.trim()||!Array.isArray(blobIds)||!blobIds.length||blobIds.some(value=>typeof value!=='string'||!value))throw new Error('Asset import requires description and blobIds');
      if(!Object.hasOwn(body,'payload'))throw new Error('Asset import requires schema payload');
      const saved=await securedPost('/attachments/imports',body,'attachmentWrite');
      if(saved.assetId!==assetId||typeof saved.assetVersionId!=='string'||!saved.assetVersionId||!Number.isInteger(saved.version)||saved.payloadHash===undefined)throw new Error('Operator API returned a different asset import');
      const attachments=list(saved.attachments,'attachments');
      if(attachments.length!==blobIds.length||attachments.some(item=>!blobIds.includes(item.id)))throw new Error('Operator API returned different attachments');
      output={assetVersionId:saved.assetVersionId,assetId,version:saved.version,payloadHash:string(saved.payloadHash,'payloadHash'),attachments:attachments.map(item=>({id:string(item.id,'attachment.id'),sha256:string(item.sha256,'attachment.sha256'),size:count(item.size,'attachment.size'),mediaType:string(item.mediaType,'attachment.mediaType')})),expectedHead};
    } else if(command==='attachment-download'){
      const versionId=id(first,'asset version ID'),blobId=id(second,'attachment ID'),destination=fourth!;
      if(!isAbsolute(destination))throw new Error('Download destination must be absolute');
      const path=`/assets/${encodeURIComponent(versionId)}/attachments`;
      const manifest=await get(path);
      if(manifest.assetVersionId!==versionId)throw new Error('Operator API returned a different asset version');
      const matching=list(manifest.items,'asset attachments').filter(item=>item.id===blobId);
      if(matching.length!==1)throw new Error('Attachment is not bound to the selected asset version');
      const attachment=matching[0]!,sha256=string(attachment.sha256,'attachment.sha256'),size=count(attachment.size,'attachment.size'),mediaType=string(attachment.mediaType,'attachment.mediaType');
      if(!/^[a-f0-9]{64}$/u.test(sha256)||sha256!==blobId||size>16*1024*1024)throw new Error('Invalid attachment manifest');
      let response:Response;
      try{response=await fetcher(`${scope}${path}/${encodeURIComponent(blobId)}/content`,{method:'GET',headers,redirect:'error'});}catch{throw new Error('Operator API request failed');}
      if(!response.ok)throw new Error(`Operator API returned HTTP ${response.status}`);
      if(response.headers.get('x-content-sha256')!==sha256||response.headers.get('content-type')!==mediaType||Number(response.headers.get('content-length'))!==size)throw new Error('Attachment response does not match saved manifest');
      const reader=response.body?.getReader();if(!reader)throw new Error('Attachment response has no body');
      const parts:Uint8Array[]=[];let read=0;
      for(;;){const chunk=await reader.read();if(chunk.done)break;read+=chunk.value.byteLength;if(read>size||read>16*1024*1024){await reader.cancel();throw new Error('Attachment response exceeds saved size');}parts.push(chunk.value);}
      const bytes=Buffer.concat(parts,read);
      if(read!==size||createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error('Attachment bytes do not match saved manifest');
      const file=await open(destination,'wx',0o600);
      try{await file.writeFile(bytes);}finally{await file.close();}
      output={assetVersionId:versionId,blobId,sha256,size,mediaType,outputPath:destination};
    } else if (command === 'asset') {
      const assetId=id(first,'asset ID');
      const [reading,relations]=await Promise.all([
        get(`/assets/${encodeURIComponent(assetId)}/reading`).then(assetReading),
        get(`/assets/${encodeURIComponent(assetId)}/relations`).then(assetRelations),
      ]);
      if((reading.asset as RecordValue).id!==assetId||relations.assetId!==assetId)throw new Error('Operator API returned a different asset');
      const consumers=[...(relations.consumers as RecordValue[])];let cursor=relations.nextCursor as string|null;const seen=new Set<string>();
      for(let page=0;cursor&&page<100;page++){
        if(seen.has(cursor))throw new Error('Operator API asset relation pagination did not finish');seen.add(cursor);
        const next=assetRelations(await get(`/assets/${encodeURIComponent(assetId)}/relations?cursor=${encodeURIComponent(cursor)}`));
        if(next.assetId!==assetId)throw new Error('Operator API returned a different asset relation');
        consumers.push(...next.consumers as RecordValue[]);cursor=next.nextCursor as string|null;
        if(page===99&&cursor)throw new Error('Operator API asset relation pagination did not finish');
      }
      output={spaceId,reading,relations:{...relations,consumers,nextCursor:null}};
    } else if (command === 'review-subjects') {
      const runId=id(first,'run ID'),data=await get(`/runs/${encodeURIComponent(runId)}/review-subjects`);
      if(data.runId!==runId)throw new Error('Operator API returned different review subjects');
      const standard=data.standard===null?null:(()=>{const value=record(data.standard,'review standard');return {id:string(value.id,'standard.id'),revision:string(value.revision,'standard.revision'),content:string(value.content,'standard.content')};})();
      output={spaceId,runId,caseId:string(data.caseId,'subjects.caseId'),versionId:string(data.versionId,'subjects.versionId'),standard,
        subjects:list(data.subjects,'subjects').map(value=>{const kind=string(value.kind,'subject.kind'),itemStandard=value.standard===undefined?undefined:value.standard===null?null:(()=>{const selected=record(value.standard,'subject.standard');return {id:string(selected.id,'subject.standard.id'),revision:string(selected.revision,'subject.standard.revision'),content:string(selected.content,'subject.standard.content')};})();if(kind==='asset'){const asset=assetSummary(value.asset),target=publishedAssetTarget(value.target);if(target.runId!==runId||target.assetVersionId!==asset.id)throw new Error('Operator API returned an unrelated published asset');return {kind,asset,target,...(itemStandard===undefined?{}:{standard:itemStandard})};}if(kind==='response'){const target=responseTarget(value.target);if(target.runId!==runId)throw new Error('Operator API returned an unrelated saved response');return {kind,target,occurrenceLabel:string(value.occurrenceLabel,'subject.occurrenceLabel'),...(itemStandard===undefined?{}:{standard:itemStandard})};}throw new Error('Invalid review subject');}),
        failures:list(data.failures,'failures').map(value=>({stepRunId:string(value.stepRunId,'failure.stepRunId'),key:string(value.key,'failure.key'),error:string(value.error,'failure.error')}))};
    } else if (command === 'observe-response') {
      const body=await saveFile(second!),target=responseTarget(body.target),runId=id(target.runId as string,'run ID');
      const data=await securedPost(`/runs/${encodeURIComponent(runId)}/review-observations`,{target},'observationWrite');
      const receipt=observationReceipt(data.receipt),response=record(data.response,'observation response');
      if((receipt.target as RecordValue).runId!==runId||JSON.stringify(receipt.target)!==JSON.stringify(target)||response.publication!=='unpublished'||response.coverage!=='full')throw new Error('Operator API returned a different Agent observation');
      const outputText=string(response.output,'observation.output');
      if(Buffer.byteLength(outputText,'utf8')>1_000_000)throw new Error('Invalid observed response length');
      const reading=record(response.reading,'observation.reading');
      output={spaceId,receipt,response:{publication:'unpublished',coverage:'full',output:outputText,reading:{title:string(reading.title,'observation.reading.title'),readerStatus:string(reading.readerStatus,'observation.reading.readerStatus'),reason:nullableString(reading.reason,'observation.reading.reason'),sections:list(reading.sections,'observation.reading.sections').map(section=>({title:string(section.title,'section.title'),text:string(section.text,'section.text'),...(section.pointer===undefined?{}:{pointer:string(section.pointer,'section.pointer')}),...(section.sourceRefs===undefined?{}:{sourceRefs:Array.isArray(section.sourceRefs)?section.sourceRefs.map(value=>string(value,'section.sourceRef')):[]})}))}}};
    } else if (command === 'observe-asset') {
      const body=await saveFile(second!),target=publishedAssetTarget(body.target),runId=id(target.runId as string,'run ID');
      const data=await securedPost(`/runs/${encodeURIComponent(runId)}/asset-observations`,{target},'observationWrite');
      const receipt=observationReceipt(data.receipt),asset=record(data.asset,'observed asset');
      if(receipt.delivery!=='published-asset-read'||JSON.stringify(receipt.target)!==JSON.stringify(target)||asset.publication!=='published'||asset.coverage!=='full'||JSON.stringify(publishedAssetTarget(asset.target))!==JSON.stringify(target))throw new Error('Operator API returned a different published asset observation');
      const payload=string(asset.payload,'observed asset payload');
      if(Buffer.byteLength(payload,'utf8')>1_000_000)throw new Error('Invalid observed asset length');
      const reading=record(asset.reading,'observed asset reading');
      const sections=list(reading.sections,'asset.reading.sections').map(section=>({title:string(section.title,'section.title'),text:string(section.text,'section.text'),...(section.pointer===undefined?{}:{pointer:string(section.pointer,'section.pointer')}),...(section.sourceRefs===undefined?{}:{sourceRefs:Array.isArray(section.sourceRefs)?section.sourceRefs.map(value=>string(value,'section.sourceRef')):[]}),...(section.view===undefined?{}:{view:string(section.view,'section.view')})}));
      output={spaceId,receipt,asset:{target,publication:'published',coverage:'full',payload,reading:{title:string(reading.title,'asset.reading.title'),readerStatus:string(reading.readerStatus,'asset.reading.readerStatus'),reason:nullableString(reading.reason,'asset.reading.reason'),sections}}};
    } else if (command === 'observation') {
      const runId=id(first,'run ID'),receiptId=id(second,'receipt ID');
      const receipt=observationReceipt(await get(`/runs/${encodeURIComponent(runId)}/review-observations/${encodeURIComponent(receiptId)}`));
      if(receipt.id!==receiptId||(receipt.target as RecordValue).runId!==runId)throw new Error('Operator API returned a different Agent observation');
      output={spaceId,receipt};
    } else if (command === 'reviews' || command === 'dispositions') {
      const runId=id(first,'run ID'),isReview=command==='reviews';
      const items=await pages(`/runs/${encodeURIComponent(runId)}/${command}`,command,isReview?review:disposition);
      if(items.some(value=>value.runId!==runId||(isReview&&value.spaceId!==spaceId)||(!isReview&&value.confirmation!=='unconfirmed')))throw new Error('Operator API returned an unrelated run record');
      output={spaceId,runId,[command]:items};
    } else if (command === 'review' || command === 'disposition') {
      const runId=id(first,'run ID'),recordId=id(second,command==='review'?'review ID':'disposition revision ID'),plural=command==='review'?'reviews':'dispositions';
      const selected=(command==='review'?review:disposition)(await get(`/runs/${encodeURIComponent(runId)}/${plural}/${encodeURIComponent(recordId)}`));
      if(selected.id!==recordId||selected.runId!==runId||(command==='review'&&selected.spaceId!==spaceId))throw new Error('Operator API returned a different run record');
      output={spaceId,...selected};
    } else if (command === 'review-save' || command === 'disposition-save') {
      const body=await saveFile(second!),runId=id(typeof body.runId==='string'?body.runId:undefined,'run ID');
      if(command==='review-save'){
        const judge=record(body.judge,'review judge'),kind=string(judge.kind,'review judge kind');
        const summary=await get('/summary'),subject=record(summary.subject,'summary.subject');
        if(kind==='human'){
          if(subject.kind==='service'||judge.id!==subject.id)throw new Error('Human review judge must match authenticated subject');
        }else if(kind==='agent'){
          const agent=record(subject.externalAgent,'authenticated external Agent');
          const hasAsset=Array.isArray(body.assetVersionIds)&&body.assetVersionIds.length===1;
          if(subject.kind!=='service'||judge.id!==agent.id||judge.sessionId!==agent.sessionId||!body.observationReceiptId||(!!body.responseTarget===hasAsset))throw new Error('Agent review requires authenticated observation and matching identity');
        }else throw new Error('Invalid review judge kind');
        const saved=review(await securedPost(`/runs/${encodeURIComponent(runId)}/reviews`,body,'reviewWrite'));
        if(saved.runId!==runId||saved.spaceId!==spaceId||saved.id!==body.id)throw new Error('Operator API returned a different review');
        output={spaceId,...saved};
      }else{
        const summary=await get('/summary'),subject=record(summary.subject,'summary.subject');
        if(subject.kind==='service'&&(!subject.externalAgent||!body.observationReceiptId))throw new Error('Agent disposition requires authenticated observation');
        const saved=disposition(await securedPost(`/runs/${encodeURIComponent(runId)}/dispositions`,body,'dispositionWrite'));
        if(saved.runId!==runId||saved.previousRevisionId!==body.expectedRevisionId)throw new Error('Operator API returned a different disposition');
        output={spaceId,...saved};
      }
    } else if (command === 'diagnosis') {
      const runId=id(first,'run ID'),revisionId=second?id(second,'diagnosis revision ID'):undefined;
      const selected=await getRaw(`/runs/${encodeURIComponent(runId)}/${revisionId?`diagnoses/${encodeURIComponent(revisionId)}`:'diagnosis'}`);
      if(selected===null){if(revisionId)throw new Error('Operator API returned a missing diagnosis revision');output={spaceId,runId,diagnosis:null};}
      else {const value=diagnosis(selected);if(value.runId!==runId||(revisionId&&value.id!==revisionId))throw new Error('Operator API returned a different run diagnosis');output={spaceId,diagnosis:value};}
    } else if (command === 'diagnoses') {
      const runId=id(first,'run ID'),items=await pages(`/runs/${encodeURIComponent(runId)}/diagnoses`,'diagnoses',diagnosis);
      if(items.some(value=>value.runId!==runId))throw new Error('Operator API returned an unrelated run diagnosis');
      output={spaceId,runId,diagnoses:items};
    } else if (command === 'diagnosis-save') {
      const body=await saveFile(second!),runId=id(typeof body.runId==='string'?body.runId:undefined,'run ID');
      const summary=await get('/summary'),subject=record(summary.subject,'summary.subject');
      if(subject.kind==='service'&&(!subject.externalAgent||!body.observationReceiptId))throw new Error('Agent diagnosis requires authenticated observation');
      const saved=diagnosis(await securedPost(`/runs/${encodeURIComponent(runId)}/diagnoses`,body,'diagnosisWrite'));
      if(saved.runId!==runId||saved.previousRevisionId!==body.expectedRevisionId)throw new Error('Operator API returned a different diagnosis revision');
      output={spaceId,diagnosis:saved};
    } else if (command === 'understanding') {
      output = understanding(await get(`/understanding${second ? `?revision=${encodeURIComponent(id(second, 'revision ID'))}` : ''}`));
      if(second&&output.id!==second)throw new Error('Operator API returned a different understanding revision');
    } else if (command === 'understanding-history') {
      const items: RecordValue[] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < 100; page++) {
        const data = await get(`/understanding/revisions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        items.push(...list(data.items, 'understanding.items').map(understanding));
        cursor = nullableString(data.nextCursor, 'understanding.nextCursor');
        if (!cursor) break;
        if (seen.has(cursor) || page === 99) throw new Error('Operator API understanding pagination did not finish');
        seen.add(cursor);
      }
      output = { spaceId, revisions: items };
    } else if (command === 'understanding-save') {
      let body:RecordValue;
      try{body=record(JSON.parse(await readFile(second!, 'utf8')),'understanding save file');}
      catch{throw new Error('Invalid understanding save file');}
      const authorship = record(body.authorship, 'authorship');
      if (authorship.kind !== 'agent') throw new Error('CLI saves require explicit agent authorship');
      const summary = await get('/summary');
      const capabilities = record(summary.capabilities, 'summary.capabilities');
      if (capabilities.understandingWrite !== true) throw new Error('Understanding save is unavailable');
      const subject=record(summary.subject,'summary.subject');
      if(subject.kind==='service'){
        const agent=record(subject.externalAgent,'authenticated design Agent');
        if(agent.role!=='design'||authorship.name!==agent.id||authorship.sessionId!==agent.sessionId)
          throw new Error('Understanding authorship must match the authenticated design Agent');
      }
      const csrf = string(summary.csrfToken, 'summary.csrfToken');
      if (!csrf) throw new Error('Understanding save requires a CSRF token');
      let response: Response;
      try { response = await fetcher(`${scope}/understanding/revisions`, {method:'POST',headers:{...headers,'content-type':'application/json','x-space-csrf':csrf,origin:new URL(base).origin},body:JSON.stringify(body),redirect:'error'}); }
      catch { throw new Error('Operator API request failed'); }
      if (!response.ok) throw new Error(`Operator API returned HTTP ${response.status}`);
      let saved: unknown;
      try { saved = await response.json(); } catch { throw new Error('Operator API returned invalid JSON'); }
      output = understanding(saved);
      if(output.previousRevisionId!==body.expectedRevisionId||output.title!==body.title||output.content!==body.content)throw new Error('Operator API returned a different understanding revision');
    } else if (command === 'execution-state') {
      output=record(await get('/method-execution'),'method execution state');
    } else if (command === 'method-command') {
      if(!isAbsolute(second!))throw new Error('Method command file must be absolute');
      const body=await saveFile(second!);
      if(Object.keys(body).length!==2||!Object.hasOwn(body,'operation')||!Object.hasOwn(body,'input'))
        throw new Error('Method command file must contain only operation and input');
      const operation=string(body.operation,'method command operation');
      if(!['case-create','inputs-freeze','release','start','dispatch'].includes(operation))throw new Error('Invalid method command operation');
      record(body.input,'method command input');
      output=await securedPost('/method-execution/commands',body,'methodExecutionWrite',summary=>{
        const subject=record(summary.subject,'summary.subject');
        if(subject.kind!=='service')throw new Error('Method commands require a design Agent credential');
        const agent=record(subject.externalAgent,'authenticated design Agent');
        if(agent.role!=='design'||!string(agent.id,'design Agent ID')||!string(agent.sessionId,'design Agent session ID'))
          throw new Error('Method commands require a design Agent credential');
        const scope=record(summary.methodScope,'summary.methodScope');
        if(!string(scope.workflowId,'method workflow ID')||!string(scope.entrypoint,'method entrypoint'))
          throw new Error('Method command scope is unavailable');
      });
    } else if (command === 'capability-prepare'||command === 'design-prepare') {
      const kind:PrepareKind=command==='capability-prepare'?'capability':'design';
      const request=await prepareRequest(kind,{get:getRaw,spaceId,baseUrl:base,inputFile:second!,...(fourth?{outFile:fourth}:{})});
      output={spaceId,...preparedSummary(kind,request,fourth??second!,!fourth)};
    } else if (command === 'capability') {
      output=record(await get(`/method-capability${second?`?revision=${encodeURIComponent(id(second,'revision ID'))}`:''}`),'method capability');
      if(second&&output.id!==second)throw new Error('Operator API returned a different method capability revision');
    } else if (command === 'capability-history') {
      output={spaceId,revisions:await pages('/method-capability/revisions','method capability',value=>record(value,'method capability revision'))};
    } else if (command === 'capability-save') {
      if(!isAbsolute(second!))throw new Error('Capability save file must be absolute');
      const body=await saveFile(second!);
      const authorship=record(body.authorship,'authorship');
      if(authorship.kind!=='agent')throw new Error('CLI saves require explicit agent authorship');
      if(body.expectedRevisionId!==null&&typeof body.expectedRevisionId!=='string')throw new Error('Expected capability revision ID is required');
      const authenticated:{agent:RecordValue|null;id:string|null}={agent:null,id:null};
      const saved=await securedPost('/method-capability/revisions',body,'methodCapabilityWrite',summary=>{
        const subject=record(summary.subject,'summary.subject');
        if(subject.kind!=='service')throw new Error('Capability saves require a design Agent credential');
        const agent=record(subject.externalAgent,'authenticated design Agent');
        if(agent.role!=='design'||authorship.name!==agent.id||authorship.sessionId!==agent.sessionId)
          throw new Error('Method capability authorship must match the authenticated design Agent');
        authenticated.agent=agent;authenticated.id=string(subject.id,'summary.subject.id');
      });
      const inputUnderstanding=record(body.understanding,'understanding'),inputProvider=record(body.provider,'provider');
      const savedUnderstanding=record(saved.understanding,'saved understanding'),savedProvider=record(saved.provider,'saved provider');
      if(saved.previousRevisionId!==body.expectedRevisionId||saved.workflowId!==body.workflowId||saved.entrypoint!==body.entrypoint||
        savedUnderstanding.revisionId!==inputUnderstanding.revisionId||savedUnderstanding.payloadHash!==inputUnderstanding.payloadHash||
        savedProvider.id!==inputProvider.id||savedProvider.contractRevision!==inputProvider.contractRevision)throw new Error('Operator API returned a different method capability revision');
      if(authenticated.agent&&(saved.recordedBy!==authenticated.id||record(saved.authorship,'saved authorship').name!==authenticated.agent.id||
        record(saved.authorship,'saved authorship').sessionId!==authenticated.agent.sessionId))throw new Error('Operator API returned a method capability with different Agent authorship');
      output=saved;
    } else if (command === 'design') {
      output=design(await get(`/method-design${second?`?revision=${encodeURIComponent(id(second,'revision ID'))}`:''}`));
      if(second&&output.id!==second)throw new Error('Operator API returned a different method design revision');
    } else if (command === 'design-history') {
      const items:RecordValue[]=[];let cursor:string|null=null;const seen=new Set<string>();
      for(let page=0;page<100;page++){
        const data=await get(`/method-design/revisions?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);
        items.push(...list(data.items,'method design.items').map(design));
        cursor=nullableString(data.nextCursor,'method design.nextCursor');
        if(!cursor)break;
        if(seen.has(cursor)||page===99)throw new Error('Operator API method design pagination did not finish');
        seen.add(cursor);
      }
      output={spaceId,revisions:items};
    } else if (command === 'design-save') {
      const body=await saveFile(second!);
      const authorship=record(body.authorship,'authorship');
      if(authorship.kind!=='agent')throw new Error('CLI saves require explicit agent authorship');
      const authenticated:{agent:RecordValue|null;id:string|null}={agent:null,id:null};
      const saved=design(await securedPost('/method-design/revisions',body,'methodDesignWrite',summary=>{
        const subject=record(summary.subject,'summary.subject');
        if(subject.kind==='service'){
          const agent=record(subject.externalAgent,'authenticated design Agent');
          if(agent.role!=='design'||authorship.name!==agent.id||authorship.sessionId!==agent.sessionId)
            throw new Error('Method design authorship must match the authenticated design Agent');
          authenticated.agent=agent;authenticated.id=string(subject.id,'summary.subject.id');
        }
      }));
      if(authenticated.agent&&(saved.recordedBy!==authenticated.id||
        record(saved.authorship,'saved authorship').name!==authenticated.agent.id||
        record(saved.authorship,'saved authorship').sessionId!==authenticated.agent.sessionId))
        throw new Error('Operator API returned a method design with different Agent authorship');
      const submittedRef=record(body.understanding,'understanding');
      const returnedRef=record(saved.understanding,'saved understanding');
      if(saved.previousRevisionId!==body.expectedRevisionId||saved.title!==body.title||saved.content!==body.content||
        saved.workflowId!==body.workflowId||saved.entrypoint!==body.entrypoint||
        returnedRef.revisionId!==submittedRef.revisionId||returnedRef.payloadHash!==submittedRef.payloadHash)throw new Error('Operator API returned a different method design revision');
      output=saved;
    } else if (command === 'design-definition') {
      const revisionId=id(second,'design revision ID');
      const definition=await get(`/method-design/definition?revision=${encodeURIComponent(revisionId)}`);
      if(definition.designRevisionId!==revisionId)throw new Error('Operator API returned a different method design definition');
      record(definition.version,'method design definition version');
      list(definition.schemas,'method design definition schemas');
      output=definition;
    } else if (command === 'method-preview') {
      const revisionId=id(second,'design revision ID');
      const data=await get(`/method-design/preview?revision=${encodeURIComponent(revisionId)}`);
      const availability=string(data.availability,'preview.availability');
      if(data.designRevisionId!==revisionId||!['available','unavailable','unknown'].includes(availability))throw new Error('Invalid method preview response');
      output={versionId:string(data.versionId,'preview.versionId'),workflowId:string(data.workflowId,'preview.workflowId'),entrypoint:string(data.entrypoint,'preview.entrypoint'),
        designRevisionId:revisionId,designHash:string(data.designHash,'preview.designHash'),understandingRevisionId:string(data.understandingRevisionId,'preview.understandingRevisionId'),
        understandingHash:string(data.understandingHash,'preview.understandingHash'),availability,
        ...(data.blockers===undefined?{}:{blockers:Array.isArray(data.blockers)?data.blockers.map(value=>string(value,'preview.blocker')):(()=>{throw new Error('Invalid preview blockers')})()})};
    } else if (command === 'method-publish') {
      const designRevisionId=id(second,'design revision ID'),expectedCandidateId=id(fourth,'candidate ID');
      const data=await securedPost('/method-design/publications',{designRevisionId,expectedCandidateId},'methodPublish',async summary=>{
        const subject=record(summary.subject,'summary.subject');
        if(subject.kind==='service'){
          const agent=record(subject.externalAgent,'authenticated design Agent');
          if(agent.role!=='design')throw new Error('Design Agent credential required');
          const draft=design(await get(`/method-design?revision=${encodeURIComponent(designRevisionId)}`));
          const authored=record(draft.authorship,'method design authorship');
          if(draft.id!==designRevisionId||draft.recordedBy!==subject.id||authored.kind!=='agent'||
            authored.name!==agent.id||authored.sessionId!==agent.sessionId)
            throw new Error('Method design revision does not belong to the authenticated design Agent');
        }
      });
      if(data.versionId!==expectedCandidateId||data.designRevisionId!==designRevisionId)throw new Error('Operator API returned a different method publication');
      output={versionId:expectedCandidateId,designRevisionId,understandingRevisionId:string(data.understandingRevisionId,'publication.understandingRevisionId')};
    } else if (command === 'method-basis') {
      const versionId=id(first,'version ID');
      const data=await get(`/versions/${encodeURIComponent(versionId)}/design`);
      output={versionId,design:design(data.design),understanding:understanding(data.understanding)};
      const reference=record((output.design as RecordValue).understanding,'design understanding');
      if(reference.revisionId!==(output.understanding as RecordValue).id||reference.payloadHash!==(output.understanding as RecordValue).payloadHash)throw new Error('Operator API returned a mismatched method basis');
    } else {
      const versionId = id(first, 'version ID'), nodeId = id(second, 'node ID');
      const data = await get(`/versions/${encodeURIComponent(versionId)}/nodes/${encodeURIComponent(nodeId)}`);
      if (data.id !== nodeId || data.versionId !== versionId) throw new Error('Operator API returned a different node');
      const declaration=agentDeclaration(data.agentDeclaration);
      const declarationCoverage=data.agentDeclarationCoverage===undefined||data.agentDeclarationCoverage===null?null:string(data.agentDeclarationCoverage,'node.agentDeclarationCoverage');
      if(declarationCoverage!==null&&!['full','truncated'].includes(declarationCoverage))throw new Error('Invalid Agent declaration coverage');
      if((declaration===null)!==(declarationCoverage===null))throw new Error('Agent declaration and coverage mismatch');
      output = { spaceId, versionId, ...node(data), instructions: nullableString(data.instructions, 'node.instructions'), configuration: safeConfig(data.configuration),
        agentDeclaration:declaration,agentDeclarationCoverage:declarationCoverage };
    }
    write(JSON.stringify(output, null, 2));
    return 0;
  } catch (cause) {
    error(cause instanceof Error ? cause.message : 'Operator CLI failed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runOperatorCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
