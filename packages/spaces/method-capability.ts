import {createHash} from 'node:crypto';
import {JSON_SCHEMA_DIALECT,SchemaRegistry,type SchemaDefinition,type SchemaRef} from '@signal-room/workflow-space-contracts';
import {BUSINESS_UNDERSTANDING_ASSET_ID,createBusinessUnderstandingStore,type BusinessUnderstandingAuthorship} from './business-understanding.js';
import type {WorkflowSpaceService} from './service.js';
import type {AssetVersion} from './types.js';

export const METHOD_CAPABILITY_SCHEMA_NAMESPACE='workflow/method-capability';
export const methodCapabilityAssetId=(workflowId:string):string=>`method-capability:${workflowId}`;

export interface CapabilityContent {content:string;sha256:string}
export interface MethodCapabilitySave {
  workflowId:string;
  entrypoint:string;
  understanding:{revisionId:string;payloadHash:string};
  provider:{id:string;contractRevision:string};
  nodes:Record<string,{instructions:CapabilityContent;outputSchema:CapabilityContent;model:string;reasoningEffort:string}>;
  validation:CapabilityContent;
  predecessorVersionId:string|null;
  changeReason:string;
  authorship:BusinessUnderstandingAuthorship;
  expectedRevisionId:string|null;
  idempotencyKey:string;
}
export interface MethodCapabilityRevision extends Omit<MethodCapabilitySave,'expectedRevisionId'|'idempotencyKey'> {
  id:string;assetId:string;revision:number;payloadHash:string;createdAt:string;previousRevisionId:string|null;recordedBy:string;
}

const contentSchema={type:'object',properties:{content:{type:'string',minLength:1},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['content','sha256'],additionalProperties:false};
export const METHOD_CAPABILITY_SCHEMA_DEFINITION:SchemaDefinition={
  namespace:METHOD_CAPABILITY_SCHEMA_NAMESPACE,revision:'1',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{
    workflowId:{type:'string',minLength:1},entrypoint:{type:'string',minLength:1},
    understanding:{type:'object',properties:{revisionId:{type:'string',minLength:1},payloadHash:{type:'string',minLength:1}},required:['revisionId','payloadHash'],additionalProperties:false},
    provider:{type:'object',properties:{id:{type:'string',minLength:1},contractRevision:{type:'string',minLength:1}},required:['id','contractRevision'],additionalProperties:false},
    nodes:{type:'object',minProperties:1,propertyNames:{minLength:1},additionalProperties:{type:'object',properties:{
      instructions:contentSchema,outputSchema:contentSchema,model:{type:'string',minLength:1},reasoningEffort:{type:'string',minLength:1},
    },required:['instructions','outputSchema','model','reasoningEffort'],additionalProperties:false}},
    validation:contentSchema,predecessorVersionId:{type:['string','null']},changeReason:{type:'string',minLength:1},
    authorship:{type:'object',properties:{kind:{type:'string',enum:['agent','human']},name:{type:'string',minLength:1},sessionId:{type:'string',minLength:1}},required:['kind','name'],additionalProperties:false},
    previousRevisionId:{type:['string','null']},
  },required:['workflowId','entrypoint','understanding','provider','nodes','validation','predecessorVersionId','changeReason','authorship','previousRevisionId'],additionalProperties:false},
};
const registered=new SchemaRegistry().registerSchema(METHOD_CAPABILITY_SCHEMA_DEFINITION);
export const METHOD_CAPABILITY_SCHEMA_REF:SchemaRef={namespace:registered.namespace,revision:registered.revision,hash:registered.hash};

function checkContent(value:CapabilityContent,label:string,parse:'schema'|'json'|null=null):void {
  if(!value || typeof value.content!=='string' || !value.content.trim() || typeof value.sha256!=='string' ||
    createHash('sha256').update(value.content,'utf8').digest('hex')!==value.sha256)throw new Error(`${label} content/hash mismatch`);
  if(parse){
    let parsed:unknown;
    try {parsed=JSON.parse(value.content);} catch {throw new Error(`${label} must contain valid JSON`);}
    if(parse==='schema' && (!parsed || typeof parsed!=='object' || Array.isArray(parsed)))throw new Error(`${label} must contain a JSON schema object`);
  }
}

export function methodCapabilityRevision(version:AssetVersion):MethodCapabilityRevision {
  if(version.schema.namespace!==METHOD_CAPABILITY_SCHEMA_REF.namespace || version.schema.revision!==METHOD_CAPABILITY_SCHEMA_REF.revision ||
    version.schema.hash!==METHOD_CAPABILITY_SCHEMA_REF.hash || version.source.kind!=='import')throw new Error('Asset is not a method capability revision');
  const payload=version.payload as Omit<MethodCapabilityRevision,'id'|'assetId'|'revision'|'payloadHash'|'createdAt'|'recordedBy'>;
  if(version.assetId!==methodCapabilityAssetId(payload.workflowId))throw new Error('Method capability logical asset does not match workflow');
  return {id:version.id,assetId:version.assetId,revision:version.version,payloadHash:version.payloadHash,createdAt:version.createdAt,
    ...payload,recordedBy:version.source.actorId};
}

export function createMethodCapabilityStore(service:WorkflowSpaceService) {
  const understandingStore=createBusinessUnderstandingStore(service);
  return {
    async ensure(spaceId:string):Promise<SchemaRef> {
      const [frozen]=await service.registerSchemas(spaceId,[METHOD_CAPABILITY_SCHEMA_DEFINITION]);
      if(!frozen || frozen.hash!==METHOD_CAPABILITY_SCHEMA_REF.hash)throw new Error('Method capability schema registration failed');
      return METHOD_CAPABILITY_SCHEMA_REF;
    },
    async current(spaceId:string,workflowId:string):Promise<MethodCapabilityRevision|null> {
      const head=await service.readAssetHead(spaceId,methodCapabilityAssetId(workflowId));
      return head?methodCapabilityRevision(head):null;
    },
    async read(spaceId:string,revisionId:string):Promise<MethodCapabilityRevision> {
      return methodCapabilityRevision(await service.readAsset(spaceId,revisionId));
    },
    async history(spaceId:string,workflowId:string):Promise<MethodCapabilityRevision[]> {
      return (await service.readAssetHistory(spaceId,methodCapabilityAssetId(workflowId))).map(methodCapabilityRevision);
    },
    async save(spaceId:string,input:MethodCapabilitySave):Promise<MethodCapabilityRevision> {
      for(const field of ['workflowId','entrypoint','changeReason','idempotencyKey'] as const)
        if(typeof input[field]!=='string'||!input[field].trim())throw new Error(`${field} must be nonempty`);
      if(input.expectedRevisionId===undefined || (input.expectedRevisionId!==null && !input.expectedRevisionId.trim()))throw new Error('Expected revision ID is required; use null for the first revision');
      if(input.predecessorVersionId!==null && (typeof input.predecessorVersionId!=='string'||!input.predecessorVersionId.trim()))throw new Error('predecessorVersionId must be null or nonempty');
      if(input.predecessorVersionId){
        const predecessor=await service.readWorkflowVersion(spaceId,input.predecessorVersionId);
        if(predecessor.id!==input.predecessorVersionId || predecessor.entrypoints[input.entrypoint]?.workflowId!==input.workflowId)
          throw new Error('Method capability predecessor workflow/entrypoint mismatch');
      }
      if(!input.provider || !input.provider.id?.trim() || !input.provider.contractRevision?.trim())throw new Error('Provider identity and contract revision are required');
      if(!input.nodes || typeof input.nodes!=='object' || Array.isArray(input.nodes) || !Object.keys(input.nodes).length)throw new Error('At least one node is required');
      for(const [key,node] of Object.entries(input.nodes)) {
        if(!key.trim())throw new Error('Node key must be nonempty');
        if(!node || !node.model?.trim() || !node.reasoningEffort?.trim())throw new Error(`Node ${key} model and reasoning effort are required`);
        checkContent(node.instructions,`Node ${key} instructions`);
        checkContent(node.outputSchema,`Node ${key} output schema`,'schema');
      }
      checkContent(input.validation,'Validation','json');
      const understanding=await understandingStore.read(spaceId,input.understanding.revisionId);
      if(understanding.id!==input.understanding.revisionId || understanding.payloadHash!==input.understanding.payloadHash ||
        understanding.assetId!==BUSINESS_UNDERSTANDING_ASSET_ID)throw new Error('Method capability understanding revision/hash mismatch');
      const {expectedRevisionId,idempotencyKey,...payload}=input;
      const version=await service.importAsset(spaceId,{assetId:methodCapabilityAssetId(input.workflowId),
        ...(expectedRevisionId?{expectedHead:expectedRevisionId}:{}),schema:METHOD_CAPABILITY_SCHEMA_REF,
        payload:{...payload,previousRevisionId:expectedRevisionId},
        dependencies:expectedRevisionId?[input.understanding.revisionId,expectedRevisionId]:[input.understanding.revisionId],
        description:`Method capability revision: ${input.changeReason}`,idempotencyKey});
      return methodCapabilityRevision(version);
    },
  };
}
