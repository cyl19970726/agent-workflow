import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {SchemaRegistry,type SchemaDefinition} from '@signal-room/workflow-space-contracts';
import {BUSINESS_UNDERSTANDING_ASSET_ID,BUSINESS_UNDERSTANDING_SCHEMA_REF} from './business-understanding.js';
import {createMethodCapabilityStore,methodCapabilityAssetId,METHOD_CAPABILITY_SCHEMA_REF,type MethodCapabilitySave} from './method-capability.js';
import type {WorkflowSpaceService} from './service.js';
import type {AssetVersion,AssetWrite,WorkflowVersion} from './types.js';

const bytes=(content:string)=>({content,sha256:createHash('sha256').update(content,'utf8').digest('hex')});
const draft:MethodCapabilitySave={workflowId:'workflow',entrypoint:'create',understanding:{revisionId:'understanding',payloadHash:'understanding-hash'},
  provider:{id:'agent-sdk',contractRevision:'1'},nodes:{writer:{instructions:bytes('Write a useful result.'),outputSchema:bytes('{"type":"object"}'),model:'model',reasoningEffort:'medium'}},
  validation:bytes('{"checks":[]}'),predecessorVersionId:null,authorship:{kind:'agent',name:'Designer'},changeReason:'Initial',expectedRevisionId:null,idempotencyKey:'one'};
function fixture(){
  const assets:AssetVersion[]=[{id:'understanding',spaceId:'space',assetId:BUSINESS_UNDERSTANDING_ASSET_ID,version:1,schema:BUSINESS_UNDERSTANDING_SCHEMA_REF,
    payload:{title:'Purpose',content:'Purpose',sources:[{kind:'document',ref:'doc',title:'Doc'}],authorship:{kind:'agent',name:'Codex'},changeReason:'Initial',previousRevisionId:null},
    payloadHash:'understanding-hash',source:{kind:'import',actorId:'writer',description:'Purpose'},dependencies:[],attachments:[],initialState:'imported',createdAt:'2026-10-10T00:00:00Z'}];
  const registry=new SchemaRegistry(),commits=new Map<string,{request:string;result:AssetVersion}>();
  const predecessor:WorkflowVersion={id:'prior-version',spaceId:'space',revision:'1',changeReason:'Prior',config:{},
    entrypoints:{create:{workflowId:'workflow'} as never},hash:'prior-hash',createdAt:'2026-10-09T00:00:00Z'};
  const service={
    async registerSchemas(_spaceId:string,definitions:SchemaDefinition[]){return definitions.map(definition=>registry.registerSchema(definition));},
    async readAsset(_spaceId:string,id:string){const found=assets.find(asset=>asset.id===id);if(!found)throw new Error('Not found');return found;},
    async readAssetHead(_spaceId:string,assetId:string){return assets.filter(asset=>asset.assetId===assetId).at(-1)??null;},
    async readAssetHistory(_spaceId:string,assetId:string){return assets.filter(asset=>asset.assetId===assetId);},
    async readWorkflowVersion(_spaceId:string,id:string){if(id!==predecessor.id)throw new Error('Not found');return predecessor;},
    async importAsset(spaceId:string,input:AssetWrite & {description:string}){
      registry.validatePayload(input.schema,input.payload);
      const request=JSON.stringify(input),prior=commits.get(input.idempotencyKey);
      if(prior){if(prior.request!==request)throw new Error('Idempotency conflict');return prior.result;}
      const head=assets.filter(asset=>asset.assetId===input.assetId).at(-1);
      if(head?.id!==input.expectedHead && (head || input.expectedHead))throw new Error('Asset version conflict');
      const result:AssetVersion={id:`capability-${assets.length}`,spaceId,assetId:input.assetId!,version:(head?.version??0)+1,schema:input.schema,
        payload:input.payload,payloadHash:`capability-hash-${assets.length}`,source:{kind:'import',actorId:'authenticated-writer',description:input.description},
        dependencies:input.dependencies??[],attachments:[],initialState:'imported',createdAt:'2026-10-10T00:00:01Z'};
      assets.push(result);commits.set(input.idempotencyKey,{request,result});return result;
    },
  } as unknown as WorkflowSpaceService;
  return {store:createMethodCapabilityStore(service),assets,predecessor};
}

describe('immutable method capability',()=>{
  it('saves exact bytes with understanding dependency, CAS, idempotency, and history',async()=>{
    const {store,assets}=fixture();await store.ensure('space');
    const first=await store.save('space',draft);
    expect(first).toMatchObject({assetId:methodCapabilityAssetId('workflow'),revision:1,previousRevisionId:null,recordedBy:'authenticated-writer'});
    expect(assets[1]?.schema).toEqual(METHOD_CAPABILITY_SCHEMA_REF);
    expect(assets[1]?.dependencies).toEqual(['understanding']);
    expect((await store.save('space',draft)).id).toBe(first.id);
    await expect(store.save('space',{...draft,idempotencyKey:'stale'})).rejects.toThrow('conflict');
    const second=await store.save('space',{...draft,changeReason:'Updated instructions',expectedRevisionId:first.id,idempotencyKey:'two'});
    expect(assets[2]?.dependencies).toEqual(['understanding',first.id]);
    expect((await store.current('space','workflow'))?.id).toBe(second.id);
    expect((await store.history('space','workflow')).map(item=>item.id)).toEqual([first.id,second.id]);
    expect((await store.read('space',first.id)).nodes.writer?.instructions.content).toBe('Write a useful result.');
    const third=await store.save('space',{...draft,expectedRevisionId:second.id,idempotencyKey:'three',predecessorVersionId:'prior-version'});
    expect(third.predecessorVersionId).toBe('prior-version');
  });
  it('rejects false hashes, invalid JSON, false understanding, and a foreign asset type',async()=>{
    const {store,assets,predecessor}=fixture();await store.ensure('space');
    await expect(store.save('space',{...draft,nodes:{writer:{...draft.nodes.writer!,instructions:{...bytes('Changed'),sha256:bytes('Original').sha256}}}})).rejects.toThrow('hash mismatch');
    await expect(store.save('space',{...draft,nodes:{writer:{...draft.nodes.writer!,outputSchema:bytes('[]')}}})).rejects.toThrow('schema object');
    await expect(store.save('space',{...draft,validation:bytes('{bad')})).rejects.toThrow('valid JSON');
    await expect(store.save('space',{...draft,understanding:{...draft.understanding,payloadHash:'false'}})).rejects.toThrow('mismatch');
    await expect(store.save('space',{...draft,nodes:{' ':draft.nodes.writer!}})).rejects.toThrow('Node key');
    predecessor.entrypoints.create={workflowId:'other'} as never;
    await expect(store.save('space',{...draft,predecessorVersionId:'prior-version'})).rejects.toThrow('predecessor workflow/entrypoint mismatch');
    assets[0]={...assets[0]!,assetId:'foreign'};
    await expect(store.save('space',draft)).rejects.toThrow('business understanding');
  });
});
