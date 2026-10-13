import { describe, expect, it } from 'vitest';
import { SchemaRegistry, type SchemaDefinition } from '@signal-room/workflow-space-contracts';
import { createBusinessUnderstandingStore, BUSINESS_UNDERSTANDING_ASSET_ID } from './business-understanding.js';
import type { WorkflowSpaceService } from './service.js';
import type { AssetVersion, AssetWrite } from './types.js';

function fixture() {
  const assets: AssetVersion[] = [];
  const commits = new Map<string,{request:string;version:AssetVersion}>();
  const calls = {head:0,history:0,exact:0,registrations:0};
  const registry = new SchemaRegistry();
  let ensured = false;
  const service = {
    async registerSchemas(_spaceId:string, definitions:SchemaDefinition[]) {
      calls.registrations++;
      ensured = true;
      return definitions.map(definition=>registry.registerSchema(definition));
    },
    async readAssetHead(_spaceId:string,assetId:string) {
      calls.head++;
      return assets.filter(asset=>asset.assetId===assetId).at(-1)??null;
    },
    async readAssetHistory(_spaceId:string,assetId:string) {
      calls.history++;
      return assets.filter(asset=>asset.assetId===assetId);
    },
    async readAsset(_spaceId:string,id:string) {
      calls.exact++;
      const asset=assets.find(asset=>asset.id===id);
      if(!asset)throw new Error('Record not found in authorized space');
      return {...asset,state:'imported'};
    },
    async importAsset(spaceId:string,input:AssetWrite & {description:string}) {
      if (!ensured) throw new Error('Unknown schema revision');
      registry.validatePayload(input.schema,input.payload);
      const request=JSON.stringify(input),prior=commits.get(input.idempotencyKey);
      if(prior) {
        if(prior.request!==request)throw new Error('Idempotency conflict');
        return prior.version;
      }
      const head=assets.at(-1);
      if(head && head.id!==input.expectedHead)throw new Error('Asset version conflict: expected head required');
      if(!head && input.expectedHead)throw new Error('Asset version conflict: no head');
      if(JSON.stringify(input.dependencies??[])!==JSON.stringify(head?[head.id]:[]))throw new Error('Incorrect version dependency');
      const version:AssetVersion={id:`revision-${assets.length+1}`,spaceId,assetId:input.assetId!,version:assets.length+1,
        schema:input.schema,payload:input.payload,payloadHash:`hash-${assets.length+1}`,
        source:{kind:'import',actorId:'authenticated-principal',description:input.description},
        dependencies:input.dependencies??[],attachments:[],initialState:'imported',createdAt:`2026-10-09T00:00:0${assets.length}Z`};
      assets.push(version);commits.set(input.idempotencyKey,{request,version});
      return version;
    },
  } as unknown as WorkflowSpaceService;
  return {store:createBusinessUnderstandingStore(service),assets,calls};
}

const draft={title:'Business purpose',content:'# Business purpose\n\nCreate useful work.',
  sources:[{kind:'document' as const,ref:'docs/product.md',title:'Product'}],
  authorship:{kind:'agent' as const,name:'Codex',sessionId:'session-1'},changeReason:'Initial synthesis'};

describe('business understanding revisions',()=>{
  it('requires explicit schema setup and keeps initial, current, exact and history reads distinct',async()=>{
    const {store,calls,assets}=fixture();
    expect(await store.current('space')).toBeNull();
    expect(calls.registrations).toBe(0);
    await expect(store.save('space',{...draft,expectedRevisionId:null,idempotencyKey:'first'})).rejects.toThrow('Unknown schema revision');
    await store.ensure('space');
    const first=await store.save('space',{...draft,expectedRevisionId:null,idempotencyKey:'first'});
    expect(first).toMatchObject({id:'revision-1',assetId:BUSINESS_UNDERSTANDING_ASSET_ID,revision:1,
      previousRevisionId:null,recordedBy:'authenticated-principal',confirmation:'unconfirmed'});
    const second=await store.save('space',{...draft,title:'Updated purpose',changeReason:'New evidence',expectedRevisionId:first.id,idempotencyKey:'second'});
    expect(second).toMatchObject({revision:2,previousRevisionId:first.id,title:'Updated purpose'});
    expect(assets[0]?.dependencies).toEqual([]);
    expect(assets[1]?.dependencies).toEqual([first.id]);
    expect((await store.current('space'))?.id).toBe(second.id);
    expect((await store.read('space',first.id)).title).toBe(first.title);
    expect((await store.history('space')).map(item=>item.id)).toEqual([first.id,second.id]);
    expect(calls).toMatchObject({head:2,history:1,exact:1,registrations:1});
    expect(assets).toHaveLength(2);
  });

  it('preserves optimistic conflict and idempotent retry semantics',async()=>{
    const {store,assets}=fixture();await store.ensure('space');
    const input={...draft,expectedRevisionId:null,idempotencyKey:'first'};
    const first=await store.save('space',input);
    expect(await store.save('space',input)).toEqual(first);
    await expect(store.save('space',{...input,idempotencyKey:'different'})).rejects.toThrow('expected head');
    await expect(store.save('space',{...input,title:'Different'})).rejects.toThrow('Idempotency conflict');
    await expect(store.save('space',{...draft,expectedRevisionId:undefined as never,idempotencyKey:'missing'})).rejects.toThrow('Expected revision ID');
    await expect(store.save('space',{...draft,expectedRevisionId:first.id,title:'',idempotencyKey:'invalid'})).rejects.toThrow();
    await expect(store.save('space',{...draft,expectedRevisionId:first.id,title:'   ',idempotencyKey:'blank-title'})).rejects.toThrow('title must be nonempty');
    await expect(store.save('space',{...draft,expectedRevisionId:first.id,content:'\n ',idempotencyKey:'blank-content'})).rejects.toThrow('content must be nonempty');
    await expect(store.save('space',{...draft,expectedRevisionId:first.id,changeReason:'  ',idempotencyKey:'blank-reason'})).rejects.toThrow('changeReason must be nonempty');
    await expect(store.save('space',{...draft,expectedRevisionId:first.id,sources:[],idempotencyKey:'no-sources'})).rejects.toThrow();
    const withSelfReportedActor={...draft,expectedRevisionId:first.id,idempotencyKey:'second',recordedBy:'claimed-human'};
    expect((await store.save('space',withSelfReportedActor)).recordedBy).toBe('authenticated-principal');
    expect(assets).toHaveLength(2);
  });

  it('rejects an exact revision from another logical asset',async()=>{
    const {store,assets}=fixture();await store.ensure('space');
    const first=await store.save('space',{...draft,expectedRevisionId:null,idempotencyKey:'first'});
    assets.push({...assets[0]!,id:'unrelated',assetId:'another-asset'});
    await expect(store.read('space','unrelated')).rejects.toThrow('not a business understanding');
    expect((await store.read('space',first.id)).id).toBe(first.id);
  });
});
