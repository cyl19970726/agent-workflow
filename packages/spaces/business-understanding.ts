import { JSON_SCHEMA_DIALECT, SchemaRegistry, type SchemaDefinition, type SchemaRef } from '@signal-room/workflow-space-contracts';
import type { WorkflowSpaceService } from './service.js';
import type { AssetVersion } from './types.js';

export const BUSINESS_UNDERSTANDING_ASSET_ID = 'space-business-understanding';
export const BUSINESS_UNDERSTANDING_SCHEMA_NAMESPACE = 'workflow/business-understanding';

export interface BusinessUnderstandingSource {
  kind: 'document' | 'case' | 'asset' | 'user-request';
  ref: string;
  title: string;
  excerpt?: string;
}
export interface BusinessUnderstandingAuthorship {
  kind: 'agent' | 'human';
  name: string;
  sessionId?: string;
}
export interface BusinessUnderstandingSave {
  expectedRevisionId: string | null;
  idempotencyKey: string;
  title: string;
  content: string;
  sources: BusinessUnderstandingSource[];
  authorship: BusinessUnderstandingAuthorship;
  changeReason: string;
}
export interface BusinessUnderstandingRevision {
  id: string;
  assetId: string;
  revision: number;
  payloadHash: string;
  createdAt: string;
  previousRevisionId: string | null;
  changeReason: string;
  title: string;
  content: string;
  sources: BusinessUnderstandingSource[];
  authorship: BusinessUnderstandingAuthorship;
  recordedBy: string;
  confirmation: 'unconfirmed';
}

/** Frozen definition used by explicit setup and atomic design-Space provisioning. */
export const BUSINESS_UNDERSTANDING_SCHEMA_DEFINITION: SchemaDefinition = {
  namespace: BUSINESS_UNDERSTANDING_SCHEMA_NAMESPACE,
  revision: '1',
  dialect: JSON_SCHEMA_DIALECT,
  schema: {
    $schema: JSON_SCHEMA_DIALECT,
    type: 'object',
    properties: {
      title: {type:'string',minLength:1},
      content: {type:'string',minLength:1},
      sources: {type:'array',minItems:1,items:{type:'object',properties:{
        kind:{type:'string',enum:['document','case','asset','user-request']},
        ref:{type:'string',minLength:1},title:{type:'string',minLength:1},excerpt:{type:'string'},
      },required:['kind','ref','title'],additionalProperties:false}},
      authorship: {type:'object',properties:{kind:{type:'string',enum:['agent','human']},name:{type:'string',minLength:1},sessionId:{type:'string',minLength:1}},required:['kind','name'],additionalProperties:false},
      changeReason: {type:'string',minLength:1},
      previousRevisionId: {type:['string','null']},
    },
    required:['title','content','sources','authorship','changeReason','previousRevisionId'],
    additionalProperties:false,
  },
};
const definition = BUSINESS_UNDERSTANDING_SCHEMA_DEFINITION;
const registered = new SchemaRegistry().registerSchema(definition);
export const BUSINESS_UNDERSTANDING_SCHEMA_REF: SchemaRef = {namespace:registered.namespace,revision:registered.revision,hash:registered.hash};
const schema = BUSINESS_UNDERSTANDING_SCHEMA_REF;

function revision(version: AssetVersion): BusinessUnderstandingRevision {
  if (version.assetId !== BUSINESS_UNDERSTANDING_ASSET_ID || version.schema.namespace !== schema.namespace ||
    version.schema.revision !== schema.revision || version.schema.hash !== schema.hash) {
    throw new Error('Asset is not a business understanding revision');
  }
  if (version.source.kind !== 'import') throw new Error('Business understanding source must be an authenticated import');
  const payload = version.payload as Omit<BusinessUnderstandingRevision,'id'|'assetId'|'revision'|'payloadHash'|'createdAt'|'recordedBy'|'confirmation'>;
  return {
    id:version.id,assetId:version.assetId,revision:version.version,payloadHash:version.payloadHash,
    createdAt:version.createdAt,...payload,recordedBy:version.source.actorId,confirmation:'unconfirmed',
  };
}

/** Domain facade over the Space's immutable, optimistic-concurrency asset versions. */
export function createBusinessUnderstandingStore(service: WorkflowSpaceService) {
  return {
    /** Explicit owner setup; never run from service startup or a read path. */
    async ensure(spaceId: string): Promise<SchemaRef> {
      const [frozen] = await service.registerSchemas(spaceId,[definition]);
      if (!frozen || frozen.hash !== schema.hash) throw new Error('Business understanding schema registration failed');
      return schema;
    },
    async current(spaceId: string): Promise<BusinessUnderstandingRevision | null> {
      const head = await service.readAssetHead(spaceId,BUSINESS_UNDERSTANDING_ASSET_ID);
      return head ? revision(head) : null;
    },
    async read(spaceId: string, revisionId: string): Promise<BusinessUnderstandingRevision> {
      const value = await service.readAsset(spaceId,revisionId);
      return revision(value);
    },
    async history(spaceId: string): Promise<BusinessUnderstandingRevision[]> {
      return (await service.readAssetHistory(spaceId,BUSINESS_UNDERSTANDING_ASSET_ID)).map(revision);
    },
    async save(spaceId: string, input: BusinessUnderstandingSave): Promise<BusinessUnderstandingRevision> {
      if (input.expectedRevisionId === undefined) throw new Error('Expected revision ID is required; use null for the first revision');
      if (input.expectedRevisionId !== null && !input.expectedRevisionId.trim()) throw new Error('Expected revision ID must be nonempty');
      for (const field of ['title','content','changeReason'] as const) {
        if (typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`${field} must be nonempty`);
      }
      const {expectedRevisionId,idempotencyKey,title,content,sources,authorship,changeReason} = input;
      const version = await service.importAsset(spaceId,{
        assetId:BUSINESS_UNDERSTANDING_ASSET_ID,
        ...(expectedRevisionId ? {expectedHead:expectedRevisionId} : {}),
        schema,
        payload:{title,content,sources,authorship,changeReason,previousRevisionId:expectedRevisionId},
        dependencies:expectedRevisionId ? [expectedRevisionId] : [],
        description:`Business understanding revision: ${changeReason}`,
        idempotencyKey,
      });
      return revision(version);
    },
  };
}
