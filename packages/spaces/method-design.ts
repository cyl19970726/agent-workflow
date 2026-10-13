import { JSON_SCHEMA_DIALECT, SchemaRegistry, type SchemaDefinition, type SchemaRef } from '@signal-room/workflow-space-contracts';
import type { WorkflowSpaceService } from './service.js';
import { createBusinessUnderstandingStore, BUSINESS_UNDERSTANDING_ASSET_ID,
  type BusinessUnderstandingAuthorship, type BusinessUnderstandingRevision, type BusinessUnderstandingSource } from './business-understanding.js';
import type { AssetVersion } from './types.js';
import {createMethodCapabilityStore,type MethodCapabilityRevision} from './method-capability.js';

export const METHOD_DESIGN_SCHEMA_NAMESPACE = 'workflow/method-design';
export const methodDesignAssetId = (workflowId:string):string => `method-design:${workflowId}`;

export interface MethodDesignSave {
  workflowId:string;
  entrypoint:string;
  understanding:{revisionId:string;payloadHash:string};
  capability?:{revisionId:string;payloadHash:string};
  expectedRevisionId:string|null;
  idempotencyKey:string;
  title:string;
  content:string;
  sources:BusinessUnderstandingSource[];
  authorship:BusinessUnderstandingAuthorship;
  changeReason:string;
}
export interface MethodDesignRevision extends Omit<MethodDesignSave,'expectedRevisionId'|'idempotencyKey'> {
  id:string;
  assetId:string;
  revision:number;
  payloadHash:string;
  createdAt:string;
  previousRevisionId:string|null;
  recordedBy:string;
  confirmation:'unconfirmed';
}
export interface MethodDesignBasis {
  design:MethodDesignRevision;
  understanding:BusinessUnderstandingRevision;
  capability?:MethodCapabilityRevision;
}

const definition:SchemaDefinition={
  namespace:METHOD_DESIGN_SCHEMA_NAMESPACE,revision:'1',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{
    workflowId:{type:'string',minLength:1},entrypoint:{type:'string',minLength:1},
    understanding:{type:'object',properties:{revisionId:{type:'string',minLength:1},payloadHash:{type:'string',minLength:1}},required:['revisionId','payloadHash'],additionalProperties:false},
    title:{type:'string',minLength:1},content:{type:'string',minLength:1},
    sources:{type:'array',minItems:1,items:{type:'object',properties:{
      kind:{type:'string',enum:['document','case','asset','user-request']},ref:{type:'string',minLength:1},title:{type:'string',minLength:1},excerpt:{type:'string'},
    },required:['kind','ref','title'],additionalProperties:false}},
    authorship:{type:'object',properties:{kind:{type:'string',enum:['agent','human']},name:{type:'string',minLength:1},sessionId:{type:'string',minLength:1}},required:['kind','name'],additionalProperties:false},
    changeReason:{type:'string',minLength:1},previousRevisionId:{type:['string','null']},
  },required:['workflowId','entrypoint','understanding','title','content','sources','authorship','changeReason','previousRevisionId'],additionalProperties:false},
};
const frozen=new SchemaRegistry().registerSchema(definition);
export const METHOD_DESIGN_SCHEMA_REF:SchemaRef={namespace:frozen.namespace,revision:frozen.revision,hash:frozen.hash};
const baseSchema=definition.schema as {properties:Record<string,unknown>;required:string[];[key:string]:unknown};
const capabilityDefinition:SchemaDefinition={
  ...definition,revision:'2',schema:{...baseSchema,properties:{...baseSchema.properties,
    capability:{type:'object',properties:{revisionId:{type:'string',minLength:1},payloadHash:{type:'string',minLength:1}},required:['revisionId','payloadHash'],additionalProperties:false},
  },required:[...baseSchema.required,'capability']},
};
const capabilityFrozen=new SchemaRegistry().registerSchema(capabilityDefinition);
export const METHOD_DESIGN_SCHEMA_REF_V2:SchemaRef={namespace:capabilityFrozen.namespace,revision:capabilityFrozen.revision,hash:capabilityFrozen.hash};

/** Asset identity and frozen schema must agree before a draft can become a design basis. */
export function methodDesignRevision(version:AssetVersion):MethodDesignRevision {
  const schema=version.schema.revision==='2'?METHOD_DESIGN_SCHEMA_REF_V2:METHOD_DESIGN_SCHEMA_REF;
  if(version.schema.namespace!==schema.namespace || version.schema.revision!==schema.revision ||
    version.schema.hash!==schema.hash || version.source.kind!=='import')throw new Error('Asset is not a method design revision');
  const payload=version.payload as Omit<MethodDesignRevision,'id'|'assetId'|'revision'|'payloadHash'|'createdAt'|'recordedBy'|'confirmation'>;
  if(version.assetId!==methodDesignAssetId(payload.workflowId))throw new Error('Method design logical asset does not match workflow');
  return {id:version.id,assetId:version.assetId,revision:version.version,payloadHash:version.payloadHash,createdAt:version.createdAt,
    ...payload,recordedBy:version.source.actorId,confirmation:'unconfirmed'};
}

export function createMethodDesignStore(service:WorkflowSpaceService) {
  const understandingStore=createBusinessUnderstandingStore(service);
  const capabilityStore=createMethodCapabilityStore(service);
  return {
    /** Explicit owner setup; never called by reads or server startup. */
    async ensure(spaceId:string):Promise<SchemaRef> {
      const [registered,registeredV2]=await service.registerSchemas(spaceId,[definition,capabilityDefinition]);
      if(!registered || registered.hash!==METHOD_DESIGN_SCHEMA_REF.hash || !registeredV2 || registeredV2.hash!==METHOD_DESIGN_SCHEMA_REF_V2.hash)throw new Error('Method design schema registration failed');
      return METHOD_DESIGN_SCHEMA_REF;
    },
    async current(spaceId:string,workflowId:string):Promise<MethodDesignRevision|null> {
      const head=await service.readAssetHead(spaceId,methodDesignAssetId(workflowId));
      return head?methodDesignRevision(head):null;
    },
    async read(spaceId:string,revisionId:string):Promise<MethodDesignRevision> {
      return methodDesignRevision(await service.readAsset(spaceId,revisionId));
    },
    async history(spaceId:string,workflowId:string):Promise<MethodDesignRevision[]> {
      return (await service.readAssetHistory(spaceId,methodDesignAssetId(workflowId))).map(methodDesignRevision);
    },
    async save(spaceId:string,input:MethodDesignSave):Promise<MethodDesignRevision> {
      for(const field of ['workflowId','entrypoint','title','content','changeReason'] as const) {
        if(typeof input[field]!=='string'||!input[field].trim())throw new Error(`${field} must be nonempty`);
      }
      if(input.expectedRevisionId===undefined || (input.expectedRevisionId!==null && !input.expectedRevisionId.trim()))throw new Error('Expected revision ID is required; use null for the first revision');
      const understanding=await understandingStore.read(spaceId,input.understanding.revisionId);
      if(understanding.id!==input.understanding.revisionId || understanding.payloadHash!==input.understanding.payloadHash ||
        understanding.assetId!==BUSINESS_UNDERSTANDING_ASSET_ID)throw new Error('Method design understanding revision/hash mismatch');
      if(input.capability) {
        const capability=await capabilityStore.read(spaceId,input.capability.revisionId);
        if(capability.id!==input.capability.revisionId || capability.payloadHash!==input.capability.payloadHash ||
          capability.workflowId!==input.workflowId || capability.entrypoint!==input.entrypoint ||
          capability.understanding.revisionId!==input.understanding.revisionId ||
          capability.understanding.payloadHash!==input.understanding.payloadHash)throw new Error('Method design capability revision/hash/scope mismatch');
      }
      const {expectedRevisionId,idempotencyKey,...payload}=input;
      const version=await service.importAsset(spaceId,{assetId:methodDesignAssetId(input.workflowId),
        ...(expectedRevisionId?{expectedHead:expectedRevisionId}:{}),schema:input.capability?METHOD_DESIGN_SCHEMA_REF_V2:METHOD_DESIGN_SCHEMA_REF,
        payload:{...payload,previousRevisionId:expectedRevisionId},
        dependencies:[input.understanding.revisionId,...(input.capability?[input.capability.revisionId]:[]),...(expectedRevisionId?[expectedRevisionId]:[])],
        description:`Method design revision: ${input.changeReason}`,idempotencyKey});
      return methodDesignRevision(version);
    },
    async readBasis(spaceId:string,versionId:string):Promise<MethodDesignBasis|null> {
      const version=await service.readWorkflowVersion(spaceId,versionId);
      if(!version.designBasis)return null;
      const {designRevisionId,designPayloadHash,understandingRevisionId,understandingPayloadHash}=version.designBasis;
      const design=await this.read(spaceId,designRevisionId);
      const understanding=await understandingStore.read(spaceId,understandingRevisionId);
      if(design.payloadHash!==designPayloadHash || design.understanding.revisionId!==understandingRevisionId ||
        design.understanding.payloadHash!==understandingPayloadHash || understanding.payloadHash!==understandingPayloadHash ||
        !Object.hasOwn(version.entrypoints,design.entrypoint) || version.entrypoints[design.entrypoint]?.workflowId!==design.workflowId) {
        throw new Error('Published method design basis is inconsistent');
      }
      if(design.capability) {
        const capability=await capabilityStore.read(spaceId,design.capability.revisionId);
        if(capability.payloadHash!==design.capability.payloadHash || capability.workflowId!==design.workflowId ||
          capability.entrypoint!==design.entrypoint || capability.understanding.revisionId!==understandingRevisionId ||
          capability.understanding.payloadHash!==understandingPayloadHash)throw new Error('Published method design capability is inconsistent');
        return {design,understanding,capability};
      }
      return {design,understanding};
    },
  };
}
