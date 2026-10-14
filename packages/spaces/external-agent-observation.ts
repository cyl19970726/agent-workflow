import { JSON_SCHEMA_DIALECT, SchemaRegistry, type SchemaDefinition, type SchemaRef } from '@signal-room/workflow-space-contracts';
import type { WorkflowSpaceService } from './service.js';
import type { AssetSource, AssetVersion, SavedResponseTarget } from './types.js';

export const EXTERNAL_AGENT_OBSERVATION_SCHEMA_NAMESPACE='workflow/external-agent-observation';
export const externalAgentObservationAssetId=(sessionId:string,eventId:string):string=>
  `external-agent-observation:${Buffer.from(JSON.stringify([sessionId,eventId]),'utf8').toString('hex')}`;
export interface ExternalAgentObservationReceipt {
  id:string;assetId:string;payloadHash:string;createdAt:string;
  target:SavedResponseTarget;
  observer:{id:string;sessionId:string;servicePrincipalId:string};
  producerNativeSessionId?:string;
  /** A trusted host delivered the exact saved output to this Agent session; comprehension is not asserted. */
  delivery:'saved-response-read';
}
export interface PublishedAssetTarget {runId:string;assetVersionId:string;payloadHash:string}
export interface ExternalAgentAssetObservationReceipt {
  id:string;assetId:string;payloadHash:string;createdAt:string;
  target:PublishedAssetTarget;
  source:Extract<AssetSource,{kind:'node'|'historical-artifact'|'external-artifact'}>;
  observer:{id:string;sessionId:string;servicePrincipalId:string};
  producerNativeSessionIds:string[];
  /** Trusted delivery of a published node asset, not proof of comprehension. */
  delivery:'published-asset-read';
}
export type AnyExternalAgentObservationReceipt=ExternalAgentObservationReceipt|ExternalAgentAssetObservationReceipt;
export const externalAgentAssetObservationAssetId=(sessionId:string,assetVersionId:string):string=>
  `external-agent-observation:${Buffer.from(JSON.stringify([sessionId,'asset',assetVersionId]),'utf8').toString('hex')}`;
const targetProperties={runId:{type:'string',minLength:1},occurrenceId:{type:'string',minLength:1},stepRunId:{type:'string',minLength:1},
  attemptId:{type:'string',minLength:1},sessionId:{type:'string',minLength:1},eventId:{type:'string',minLength:1},
  eventSeq:{type:'integer',minimum:1},outputHash:{type:'string',minLength:1}};
const definition:SchemaDefinition={namespace:EXTERNAL_AGENT_OBSERVATION_SCHEMA_NAMESPACE,revision:'1',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{
    target:{type:'object',properties:targetProperties,required:Object.keys(targetProperties),additionalProperties:false},
    observer:{type:'object',properties:{id:{type:'string',minLength:1},sessionId:{type:'string',minLength:1},servicePrincipalId:{type:'string',minLength:1}},
      required:['id','sessionId','servicePrincipalId'],additionalProperties:false},
    producerNativeSessionId:{type:'string',minLength:1},delivery:{const:'saved-response-read'},
  },required:['target','observer','delivery'],additionalProperties:false}};
const frozen=new SchemaRegistry().registerSchema(definition);
export const EXTERNAL_AGENT_OBSERVATION_SCHEMA_REF:SchemaRef={namespace:frozen.namespace,revision:frozen.revision,hash:frozen.hash};
const nodeSourceProperties={kind:{const:'node'},runId:{type:'string',minLength:1},stepRunId:{type:'string',minLength:1},
  attemptId:{type:'string',minLength:1},nodeId:{type:'string',minLength:1},producer:{type:'string',enum:['agent','program']},
  sessionId:{type:'string',minLength:1},contextId:{type:'string',minLength:1},generatedByContextId:{type:'string',minLength:1}};
const assetDefinition:SchemaDefinition={namespace:EXTERNAL_AGENT_OBSERVATION_SCHEMA_NAMESPACE,revision:'2',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{
    target:{type:'object',properties:{runId:{type:'string',minLength:1},assetVersionId:{type:'string',minLength:1},payloadHash:{type:'string',minLength:1}},
      required:['runId','assetVersionId','payloadHash'],additionalProperties:false},
    source:{type:'object',properties:nodeSourceProperties,required:['kind','runId','stepRunId','attemptId','nodeId','producer','sessionId','contextId'],additionalProperties:false},
    observer:{type:'object',properties:{id:{type:'string',minLength:1},sessionId:{type:'string',minLength:1},servicePrincipalId:{type:'string',minLength:1}},
      required:['id','sessionId','servicePrincipalId'],additionalProperties:false},
    producerNativeSessionIds:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}},delivery:{const:'published-asset-read'},
  },required:['target','source','observer','producerNativeSessionIds','delivery'],additionalProperties:false}};
const assetFrozen=new SchemaRegistry().registerSchema(assetDefinition);
export const EXTERNAL_AGENT_ASSET_OBSERVATION_SCHEMA_REF:SchemaRef={namespace:assetFrozen.namespace,revision:assetFrozen.revision,hash:assetFrozen.hash};
const historicalSourceProperties={kind:{const:'historical-artifact'},runId:{type:'string',minLength:1},stepRunId:{type:'string',minLength:1},
  attemptId:{type:'string',minLength:1},artifactId:{type:'string',minLength:1},sourceWorkspaceId:{type:'string',minLength:1},
  originalSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},originalUri:{type:'string'}};
const historicalAssetDefinition:SchemaDefinition={namespace:EXTERNAL_AGENT_OBSERVATION_SCHEMA_NAMESPACE,revision:'3',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{
    target:{type:'object',properties:{runId:{type:'string',minLength:1},assetVersionId:{type:'string',minLength:1},payloadHash:{type:'string',minLength:1}},
      required:['runId','assetVersionId','payloadHash'],additionalProperties:false},
    source:{type:'object',properties:historicalSourceProperties,required:Object.keys(historicalSourceProperties),additionalProperties:false},
    observer:{type:'object',properties:{id:{type:'string',minLength:1},sessionId:{type:'string',minLength:1},servicePrincipalId:{type:'string',minLength:1}},
      required:['id','sessionId','servicePrincipalId'],additionalProperties:false},
    producerNativeSessionIds:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}},delivery:{const:'published-asset-read'},
  },required:['target','source','observer','producerNativeSessionIds','delivery'],additionalProperties:false}};
const historicalAssetFrozen=new SchemaRegistry().registerSchema(historicalAssetDefinition);
export const EXTERNAL_AGENT_HISTORICAL_ASSET_OBSERVATION_SCHEMA_REF:SchemaRef={namespace:historicalAssetFrozen.namespace,
  revision:historicalAssetFrozen.revision,hash:historicalAssetFrozen.hash};
const externalSourceProperties={...historicalSourceProperties,kind:{const:'external-artifact'}};
const externalAssetDefinition:SchemaDefinition={namespace:EXTERNAL_AGENT_OBSERVATION_SCHEMA_NAMESPACE,revision:'4',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{
    target:{type:'object',properties:{runId:{type:'string',minLength:1},assetVersionId:{type:'string',minLength:1},payloadHash:{type:'string',minLength:1}},
      required:['runId','assetVersionId','payloadHash'],additionalProperties:false},
    source:{type:'object',properties:externalSourceProperties,required:Object.keys(externalSourceProperties),additionalProperties:false},
    observer:{type:'object',properties:{id:{type:'string',minLength:1},sessionId:{type:'string',minLength:1},servicePrincipalId:{type:'string',minLength:1}},
      required:['id','sessionId','servicePrincipalId'],additionalProperties:false},
    producerNativeSessionIds:{type:'array',uniqueItems:true,items:{type:'string',minLength:1}},delivery:{const:'published-asset-read'},
  },required:['target','source','observer','producerNativeSessionIds','delivery'],additionalProperties:false}};
const externalAssetFrozen=new SchemaRegistry().registerSchema(externalAssetDefinition);
export const EXTERNAL_AGENT_EXTERNAL_ASSET_OBSERVATION_SCHEMA_REF:SchemaRef={namespace:externalAssetFrozen.namespace,
  revision:externalAssetFrozen.revision,hash:externalAssetFrozen.hash};

export function externalAgentObservationReceipt(version:AssetVersion):ExternalAgentObservationReceipt {
  if(version.schema.namespace!==EXTERNAL_AGENT_OBSERVATION_SCHEMA_REF.namespace||
    version.schema.revision!==EXTERNAL_AGENT_OBSERVATION_SCHEMA_REF.revision||
    version.schema.hash!==EXTERNAL_AGENT_OBSERVATION_SCHEMA_REF.hash||version.source.kind!=='import')
    throw new Error('Asset is not an external Agent observation receipt');
  const payload=version.payload as Pick<ExternalAgentObservationReceipt,'target'|'observer'|'producerNativeSessionId'|'delivery'>;
  if(version.assetId!==externalAgentObservationAssetId(payload.observer.sessionId,payload.target.eventId)||
    version.source.actorId!==payload.observer.servicePrincipalId||payload.delivery!=='saved-response-read')
    throw new Error('External Agent observation identity mismatch');
  return {id:version.id,assetId:version.assetId,payloadHash:version.payloadHash,createdAt:version.createdAt,...payload};
}
export function externalAgentAssetObservationReceipt(version:AssetVersion):ExternalAgentAssetObservationReceipt {
  const expected=version.schema.revision==='4'?EXTERNAL_AGENT_EXTERNAL_ASSET_OBSERVATION_SCHEMA_REF:
    version.schema.revision==='3'?EXTERNAL_AGENT_HISTORICAL_ASSET_OBSERVATION_SCHEMA_REF:EXTERNAL_AGENT_ASSET_OBSERVATION_SCHEMA_REF;
  if(version.schema.namespace!==expected.namespace||version.schema.revision!==expected.revision||
    version.schema.hash!==expected.hash||version.source.kind!=='import')
    throw new Error('Asset is not a published asset observation receipt');
  const payload=version.payload as Pick<ExternalAgentAssetObservationReceipt,'target'|'source'|'observer'|'producerNativeSessionIds'|'delivery'>;
  if(version.assetId!==externalAgentAssetObservationAssetId(payload.observer.sessionId,payload.target.assetVersionId)||
    version.source.actorId!==payload.observer.servicePrincipalId||payload.delivery!=='published-asset-read')
    throw new Error('External Agent asset observation identity mismatch');
  return {id:version.id,assetId:version.assetId,payloadHash:version.payloadHash,createdAt:version.createdAt,...payload};
}
export function createExternalAgentObservationStore(service:WorkflowSpaceService) {
  return {
    /** Explicit owner setup, never server startup or ordinary reads. */
    async ensure(spaceId:string):Promise<SchemaRef> {
      const [registered,assetRegistered,historicalRegistered,externalRegistered]=await service.registerSchemas(spaceId,[definition,assetDefinition,historicalAssetDefinition,externalAssetDefinition]);
      if(!registered||registered.hash!==EXTERNAL_AGENT_OBSERVATION_SCHEMA_REF.hash||
        !assetRegistered||assetRegistered.hash!==EXTERNAL_AGENT_ASSET_OBSERVATION_SCHEMA_REF.hash||
        !historicalRegistered||historicalRegistered.hash!==EXTERNAL_AGENT_HISTORICAL_ASSET_OBSERVATION_SCHEMA_REF.hash||
        !externalRegistered||externalRegistered.hash!==EXTERNAL_AGENT_EXTERNAL_ASSET_OBSERVATION_SCHEMA_REF.hash)
        throw new Error('External Agent observation schema registration failed');
      return EXTERNAL_AGENT_OBSERVATION_SCHEMA_REF;
    },
    read:(spaceId:string,receiptId:string):Promise<AnyExternalAgentObservationReceipt>=>service.readExternalAgentObservation(spaceId,receiptId),
  };
}
