import { JSON_SCHEMA_DIALECT, SchemaRegistry, type SchemaDefinition, type SchemaRef } from '@signal-room/workflow-space-contracts';
import {artifactPayloadSha256} from '@signal-room/workflow';
import type { WorkflowSpaceService } from './service.js';
import type { AssetVersion, SavedResponseTarget } from './types.js';

export const RUN_DISPOSITION_SCHEMA_NAMESPACE='workflow/run-disposition';
export const runDispositionAssetId=(runId:string):string=>`run-disposition:${runId}`;
export type RunDispositionAction='keep'|'revise'|'supplement'|'change-method'|'stop'|'defer';
export type RunDispositionEvidenceRef=
  | {kind:'asset';assetVersionId:string;pointer?:string}
  | {kind:'response';target:SavedResponseTarget;pointer?:string}
  | {kind:'run';runId:string;stepRunId?:string};
export interface RunDispositionSave {
  runId:string;reviewIds:string[];action:RunDispositionAction;reason:string;unknowns:string[];
  evidenceRefs:RunDispositionEvidenceRef[];expectedRevisionId:string|null;idempotencyKey:string;
  observationReceiptId?:string;
}
export interface RunDispositionRevision extends Omit<RunDispositionSave,'expectedRevisionId'|'idempotencyKey'> {
  id:string;assetId:string;revision:number;payloadHash:string;createdAt:string;
  /** Verified observation dependencies, projected without changing the frozen revision-2 payload. */
  observationReceiptIds:string[];
  previousRevisionId:string|null;author:{id:string;kind:'human'}|{id:string;kind:'agent';sessionId:string;servicePrincipalId:string};
  recordedBy:string;confirmation:'unconfirmed';
}

const pointerExists=(root:unknown,pointer:string):boolean=>{
  if(pointer==='')return true;
  if(!pointer.startsWith('/')||/~(?![01])/.test(pointer))return false;
  let value:unknown=root;
  for(const segment of pointer.slice(1).split('/')) {
    const key=segment.replace(/~1/g,'/').replace(/~0/g,'~');
    if(!value||typeof value!=='object'||!Object.hasOwn(value,key))return false;
    value=(value as Record<string,unknown>)[key];
  }
  return true;
};
const nonempty=(value:unknown,name:string):void=>{
  if(typeof value!=='string'||!value.trim())throw new Error(`${name} is required`);
};
const definition:SchemaDefinition={
  namespace:RUN_DISPOSITION_SCHEMA_NAMESPACE,revision:'2',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{
    runId:{type:'string',minLength:1},reviewIds:{type:'array',minItems:1,uniqueItems:true,items:{type:'string',minLength:1}},
    action:{type:'string',enum:['keep','revise','supplement','change-method','stop','defer']},reason:{type:'string',minLength:1},
    unknowns:{type:'array',items:{type:'string',minLength:1}},
    evidenceRefs:{type:'array',items:{oneOf:[
      {type:'object',properties:{kind:{const:'asset'},assetVersionId:{type:'string',minLength:1},pointer:{type:'string'}},required:['kind','assetVersionId'],additionalProperties:false},
      {type:'object',properties:{kind:{const:'response'},target:{type:'object',properties:{
        runId:{type:'string',minLength:1},occurrenceId:{type:'string',minLength:1},stepRunId:{type:'string',minLength:1},
        attemptId:{type:'string',minLength:1},sessionId:{type:'string',minLength:1},eventId:{type:'string',minLength:1},
        eventSeq:{type:'integer',minimum:1},outputHash:{type:'string',minLength:1},
      },required:['runId','occurrenceId','stepRunId','attemptId','sessionId','eventId','eventSeq','outputHash'],additionalProperties:false},
        pointer:{type:'string'}},required:['kind','target'],additionalProperties:false},
      {type:'object',properties:{kind:{const:'run'},runId:{type:'string',minLength:1},stepRunId:{type:'string',minLength:1}},required:['kind','runId'],additionalProperties:false},
    ]}},previousRevisionId:{type:['string','null']},
    observationReceiptId:{type:'string',minLength:1},
    author:{oneOf:[
      {type:'object',properties:{id:{type:'string',minLength:1},kind:{const:'human'}},required:['id','kind'],additionalProperties:false},
      {type:'object',properties:{id:{type:'string',minLength:1},kind:{const:'agent'},sessionId:{type:'string',minLength:1},servicePrincipalId:{type:'string',minLength:1}},
        required:['id','kind','sessionId','servicePrincipalId'],additionalProperties:false},
    ]},
  },required:['runId','reviewIds','action','reason','unknowns','evidenceRefs','previousRevisionId','author'],additionalProperties:false},
};
// Revision 1 was registered before external Agent authorship. Keep its exact
// frozen shape for historical human disposition reads; never rewrite it.
const legacySchema=structuredClone(definition.schema) as {properties:Record<string,unknown>};
delete legacySchema.properties.observationReceiptId;
legacySchema.properties.author={type:'object',properties:{id:{type:'string',minLength:1},kind:{const:'human'}},
  required:['id','kind'],additionalProperties:false};
const legacyDefinition:SchemaDefinition={...definition,revision:'1',schema:legacySchema as SchemaDefinition['schema']};
const legacyFrozen=new SchemaRegistry().registerSchema(legacyDefinition);
export const LEGACY_RUN_DISPOSITION_SCHEMA_REF:SchemaRef={namespace:legacyFrozen.namespace,revision:legacyFrozen.revision,hash:legacyFrozen.hash};
const frozen=new SchemaRegistry().registerSchema(definition);
export const RUN_DISPOSITION_SCHEMA_REF:SchemaRef={namespace:frozen.namespace,revision:frozen.revision,hash:frozen.hash};

export function runDispositionRevision(version:AssetVersion):RunDispositionRevision {
  const exact=(ref:SchemaRef)=>version.schema.namespace===ref.namespace&&version.schema.revision===ref.revision&&version.schema.hash===ref.hash;
  if((!exact(RUN_DISPOSITION_SCHEMA_REF)&&!exact(LEGACY_RUN_DISPOSITION_SCHEMA_REF))||version.source.kind!=='import')
    throw new Error('Asset is not a run disposition revision');
  const payload=version.payload as Omit<RunDispositionRevision,'id'|'assetId'|'revision'|'payloadHash'|'createdAt'|'recordedBy'|'confirmation'|'observationReceiptIds'>;
  if(version.assetId!==runDispositionAssetId(payload.runId))throw new Error('Run disposition logical asset mismatch');
  if(!payload.author || (payload.author.kind==='human'?payload.author.id!==version.source.actorId||!!payload.observationReceiptId:
    payload.author.kind==='agent'?payload.author.servicePrincipalId!==version.source.actorId||!payload.observationReceiptId:true))
    throw new Error('Run disposition authenticated author mismatch');
  return {id:version.id,assetId:version.assetId,revision:version.version,payloadHash:version.payloadHash,createdAt:version.createdAt,
    ...payload,observationReceiptIds:[...new Set((version.dependencies??[]).filter(id=>id!==payload.previousRevisionId))],
    recordedBy:version.source.actorId,confirmation:'unconfirmed'};
}

/** Records an authenticated run assessment; no action here executes a workflow or adopts an asset. */
export function createRunDispositionStore(service:WorkflowSpaceService) {
  return {
    async ensure(spaceId:string):Promise<SchemaRef> {
      const [registered]=await service.registerSchemas(spaceId,[definition]);
      if(!registered||registered.hash!==RUN_DISPOSITION_SCHEMA_REF.hash)throw new Error('Run disposition schema registration failed');
      return RUN_DISPOSITION_SCHEMA_REF;
    },
    async current(spaceId:string,runId:string):Promise<RunDispositionRevision|null> {
      await service.readRun(spaceId,runId);
      const head=await service.readAssetHead(spaceId,runDispositionAssetId(runId));
      return head?runDispositionRevision(head):null;
    },
    async read(spaceId:string,revisionId:string):Promise<RunDispositionRevision> {
      return runDispositionRevision(await service.readAsset(spaceId,revisionId));
    },
    async list(spaceId:string,runId:string):Promise<RunDispositionRevision[]> {
      await service.readRun(spaceId,runId);
      return (await service.readAssetHistory(spaceId,runDispositionAssetId(runId))).map(runDispositionRevision);
    },
    async save(spaceId:string,input:RunDispositionSave):Promise<RunDispositionRevision> {
      nonempty(input.runId,'Run ID');nonempty(input.reason,'Disposition reason');nonempty(input.idempotencyKey,'Idempotency key');
      if(!['keep','revise','supplement','change-method','stop','defer'].includes(input.action))throw new Error('Unknown run disposition action');
      if(!Array.isArray(input.reviewIds)||!input.reviewIds.length||new Set(input.reviewIds).size!==input.reviewIds.length)
        throw new Error('Run disposition requires distinct reviews');
      if(!Array.isArray(input.unknowns)||input.unknowns.some(value=>typeof value!=='string'||!value.trim()))throw new Error('Invalid disposition unknowns');
      if(!Array.isArray(input.evidenceRefs))throw new Error('Invalid disposition evidence references');
      if(input.expectedRevisionId===undefined||(input.expectedRevisionId!==null&&(!input.expectedRevisionId.trim())))
        throw new Error('Expected revision ID is required; use null for the first revision');
      const current=await this.current(spaceId,input.runId);
      if(current?.id===input.expectedRevisionId && current && current.revision>0) {
        const head=await service.readAsset(spaceId,current.id);
        if(head.schema.revision==='1')throw new Error('Legacy run disposition needs explicit schema migration before revision 2');
      }
      const author=input.observationReceiptId?
        {kind:'agent' as const,...await service.authenticatedExternalAgentWriter(spaceId,input.observationReceiptId,input.runId)}:
        await service.authenticatedHumanWriter(spaceId);
      const run=await service.readRun(spaceId,input.runId);
      const ownReceiptIds=new Set<string>();
      for(const reviewId of input.reviewIds) {
        nonempty(reviewId,'Review ID');
        const review=await service.readReview(spaceId,reviewId);
        if(review.runId!==run.runId)throw new Error('Run disposition review must belong to the same run');
        if(author.kind==='agent'&&review.judge.kind==='agent') {
          if(review.judge.id!==author.id||review.judge.sessionId!==author.sessionId||!review.observationReceiptId)
            throw new Error('Agent disposition cannot claim another Agent review');
          await service.authenticatedExternalAgentWriter(spaceId,review.observationReceiptId,input.runId);
          const receipt=await service.readExternalAgentObservation(spaceId,review.observationReceiptId);
          if(receipt.delivery==='saved-response-read') {
            if(!review.responseTarget||review.assetVersionIds.length||
              await artifactPayloadSha256(review.responseTarget)!==await artifactPayloadSha256(receipt.target))
              throw new Error('Disposition review observation target mismatch');
          } else if(review.responseTarget||review.assetVersionIds.length!==1||
            review.assetVersionIds[0]!==receipt.target.assetVersionId)
            throw new Error('Disposition review observation target mismatch');
          ownReceiptIds.add(review.observationReceiptId);
        }
      }
      if(author.kind==='agent'&&(!ownReceiptIds.size||!ownReceiptIds.has(input.observationReceiptId!)))
        throw new Error('Agent disposition requires its own observed review');
      let manifestIds:Set<string>|undefined;
      for(const ref of input.evidenceRefs) {
        if(ref.kind==='asset') {
          const asset=await service.readAsset(spaceId,ref.assetVersionId);
          if((asset.source.kind!=='node'&&asset.source.kind!=='historical-artifact'&&asset.source.kind!=='external-artifact')||asset.source.runId!==run.runId) {
            manifestIds??=new Set(Object.values((await service.readManifest(spaceId,run.inputManifestId)).assets));
            if(!manifestIds.has(asset.id))throw new Error('Disposition asset evidence is outside the run');
          }
          if(ref.pointer!==undefined&&(!pointerExists(asset.payload,ref.pointer)))throw new Error('Disposition asset evidence pointer does not exist');
        } else if(ref.kind==='response') {
          if(ref.target.runId!==run.runId)throw new Error('Disposition response evidence is outside the run');
          const response=await service.readSavedResponseTarget(spaceId,ref.target);
          if(ref.pointer!==undefined&&!pointerExists(response.output,ref.pointer))throw new Error('Disposition response evidence pointer does not exist');
        } else if(ref.kind==='run') {
          if(ref.runId!==run.runId)throw new Error('Disposition run evidence is outside the run');
          if(ref.stepRunId) {
            const steps=await (await service.runtimeEvidence(spaceId)).listSteps(run.runId);
            if(!steps.some(step=>step.id===ref.stepRunId))throw new Error('Disposition run step evidence does not exist');
          }
        } else throw new Error('Unknown disposition evidence kind');
      }
      const {expectedRevisionId,idempotencyKey,...payload}=input;
      const version=await service.importAsset(spaceId,{assetId:runDispositionAssetId(input.runId),
        ...(expectedRevisionId?{expectedHead:expectedRevisionId}:{}),schema:RUN_DISPOSITION_SCHEMA_REF,
        payload:{...payload,previousRevisionId:expectedRevisionId,author},
        dependencies:[...(expectedRevisionId?[expectedRevisionId]:[]),...ownReceiptIds],
        description:`Run disposition: ${input.action}`,idempotencyKey:`run-disposition:${input.runId}:${idempotencyKey}`});
      return runDispositionRevision(version);
    },
  };
}
