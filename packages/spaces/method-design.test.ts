import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {SchemaRegistry,type SchemaDefinition} from '@signal-room/workflow-space-contracts';
import {createMethodDesignStore,methodDesignAssetId,METHOD_DESIGN_SCHEMA_REF,METHOD_DESIGN_SCHEMA_REF_V2} from './method-design.js';
import {methodCapabilityAssetId,METHOD_CAPABILITY_SCHEMA_REF} from './method-capability.js';
import {BUSINESS_UNDERSTANDING_ASSET_ID,BUSINESS_UNDERSTANDING_SCHEMA_REF} from './business-understanding.js';
import type {WorkflowSpaceService} from './service.js';
import {WorkflowSpaceService as SpaceService} from './service.js';
import {PostgresBlobStore} from './blob-store.js';
import {migrateWorkflowSpaces} from './migration.js';
import {createBusinessUnderstandingStore} from './business-understanding.js';
import type {AssetVersion,AssetWrite,WorkflowVersion} from './types.js';

const understanding=(id:string,hash:string):AssetVersion=>({id,spaceId:'space',assetId:BUSINESS_UNDERSTANDING_ASSET_ID,version:1,
  schema:BUSINESS_UNDERSTANDING_SCHEMA_REF,payload:{title:'Purpose',content:'Original purpose',sources:[{kind:'document',ref:'doc',title:'Doc'}],
    authorship:{kind:'agent',name:'Codex'},changeReason:'Initial',previousRevisionId:null},payloadHash:hash,
  source:{kind:'import',actorId:'authenticated-agent',description:'Purpose'},dependencies:[],attachments:[],initialState:'imported',createdAt:'2026-10-09T00:00:00Z'});
const draft={workflowId:'new-content',entrypoint:'content',understanding:{revisionId:'understanding-1',payloadHash:'understanding-hash'},
  title:'First method',content:'# Method\n\nReasoned design.',sources:[{kind:'document' as const,ref:'docs/product.md',title:'Product'}],
  authorship:{kind:'agent' as const,name:'Designer',sessionId:'session-1'},changeReason:'Initial design'};

function fixture() {
  const assets:AssetVersion[]=[understanding('understanding-1','understanding-hash')];
  const registry=new SchemaRegistry();
  const commits=new Map<string,{request:string;result:AssetVersion}>();
  let version:WorkflowVersion|undefined;
  const service={
    async registerSchemas(_spaceId:string,definitions:SchemaDefinition[]){return definitions.map(definition=>registry.registerSchema(definition));},
    async readAsset(_spaceId:string,id:string){const found=assets.find(asset=>asset.id===id);if(!found)throw new Error('Record not found in authorized space');return {...found,state:'imported'};},
    async readAssetHead(_spaceId:string,assetId:string){return assets.filter(asset=>asset.assetId===assetId).at(-1)??null;},
    async readAssetHistory(_spaceId:string,assetId:string){return assets.filter(asset=>asset.assetId===assetId);},
    async readWorkflowVersion(){if(!version)throw new Error('Workflow not found');return version;},
    async importAsset(spaceId:string,input:AssetWrite & {description:string}) {
      registry.validatePayload(input.schema,input.payload);
      const request=JSON.stringify(input),prior=commits.get(input.idempotencyKey);
      if(prior){if(prior.request!==request)throw new Error('Idempotency conflict');return prior.result;}
      const head=assets.filter(asset=>asset.assetId===input.assetId).at(-1);
      if(head?.id!==input.expectedHead && (head || input.expectedHead))throw new Error('Asset version conflict');
      const result:AssetVersion={id:`design-${assets.length}`,spaceId,assetId:input.assetId!,version:(head?.version??0)+1,
        schema:input.schema,payload:input.payload,payloadHash:`design-hash-${assets.length}`,source:{kind:'import',actorId:'authenticated-writer',description:input.description},
        dependencies:input.dependencies??[],attachments:[],initialState:'imported',createdAt:'2026-10-09T00:00:01Z'};
      assets.push(result);commits.set(input.idempotencyKey,{request,result});return result;
    },
  } as unknown as WorkflowSpaceService;
  return {store:createMethodDesignStore(service),assets,setVersion:(value:WorkflowVersion)=>{version=value;}};
}

describe('method design draft and frozen basis',()=>{
  it('saves immutable revisions and retains the exact understanding when current understanding changes',async()=>{
    const {store,assets,setVersion}=fixture();
    await store.ensure('space');
    const first=await store.save('space',{...draft,expectedRevisionId:null,idempotencyKey:'design-1'});
    expect(first).toMatchObject({assetId:methodDesignAssetId('new-content'),revision:1,previousRevisionId:null,
      recordedBy:'authenticated-writer',confirmation:'unconfirmed'});
    expect(assets[1]?.dependencies).toEqual(['understanding-1']);
    const second=await store.save('space',{...draft,title:'Revised method',expectedRevisionId:first.id,idempotencyKey:'design-2'});
    expect(assets[2]?.dependencies).toEqual(['understanding-1',first.id]);
    expect((await store.current('space','new-content'))?.id).toBe(second.id);
    expect((await store.history('space','new-content')).map(item=>item.id)).toEqual([first.id,second.id]);
    expect((await store.read('space',first.id)).title).toBe('First method');
    setVersion({id:'version-1',spaceId:'space',revision:'1',changeReason:'Initial',config:{},entrypoints:{content:{workflowId:'new-content'} as never},
      designBasis:{designRevisionId:first.id,designPayloadHash:first.payloadHash,understandingRevisionId:'understanding-1',understandingPayloadHash:'understanding-hash'},
      hash:'version-hash',createdAt:'2026-10-09T00:00:02Z'});
    assets.push(understanding('understanding-2','new-understanding-hash'));
    expect(await store.readBasis('space','version-1')).toMatchObject({design:{id:first.id},understanding:{id:'understanding-1'}});
  });

  it('rejects foreign or false understanding references, blank drafts, and stale design heads',async()=>{
    const {store,assets}=fixture();await store.ensure('space');
    await expect(store.save('space',{...draft,understanding:{...draft.understanding,payloadHash:'wrong'},expectedRevisionId:null,idempotencyKey:'wrong-hash'})).rejects.toThrow('mismatch');
    await expect(store.save('space',{...draft,content:'  ',expectedRevisionId:null,idempotencyKey:'blank'})).rejects.toThrow('content must be nonempty');
    await expect(store.save('space',{...draft,sources:[],expectedRevisionId:null,idempotencyKey:'no-source'})).rejects.toThrow();
    assets.push({...understanding('foreign','foreign-hash'),assetId:'another-logical-asset'});
    await expect(store.save('space',{...draft,understanding:{revisionId:'foreign',payloadHash:'foreign-hash'},expectedRevisionId:null,idempotencyKey:'foreign'})).rejects.toThrow();
    const first=await store.save('space',{...draft,expectedRevisionId:null,idempotencyKey:'first'});
    expect((await store.save('space',{...draft,expectedRevisionId:null,idempotencyKey:'first'})).id).toBe(first.id);
    await expect(store.save('space',{...draft,expectedRevisionId:null,idempotencyKey:'stale'})).rejects.toThrow('conflict');
    expect(first.assetId).toBe(methodDesignAssetId('new-content'));
    expect(METHOD_DESIGN_SCHEMA_REF.namespace).toBe('workflow/method-design');
  });

  it('links exact capability and verifies it again when reading a published basis',async()=>{
    const {store,assets,setVersion}=fixture();await store.ensure('space');
    const capability:AssetVersion={id:'capability-1',spaceId:'space',assetId:methodCapabilityAssetId('new-content'),version:1,
      schema:METHOD_CAPABILITY_SCHEMA_REF,payload:{workflowId:'new-content',entrypoint:'content',understanding:draft.understanding,
        provider:{id:'agent-sdk',contractRevision:'1'},nodes:{},validation:{content:'{}',sha256:'hash'},predecessorVersionId:null,
        authorship:{kind:'agent',name:'Designer'},changeReason:'Initial',previousRevisionId:null},payloadHash:'capability-hash',
      source:{kind:'import',actorId:'writer',description:'Capability'},dependencies:['understanding-1'],attachments:[],initialState:'imported',createdAt:'2026-10-09T00:00:00Z'};
    assets.push(capability);
    const reference={revisionId:capability.id,payloadHash:capability.payloadHash};
    await expect(store.save('space',{...draft,capability:{...reference,payloadHash:'wrong'},expectedRevisionId:null,idempotencyKey:'wrong-cap'})).rejects.toThrow('mismatch');
    const design=await store.save('space',{...draft,capability:reference,expectedRevisionId:null,idempotencyKey:'linked'});
    expect(assets.at(-1)?.schema).toEqual(METHOD_DESIGN_SCHEMA_REF_V2);
    expect(assets.at(-1)?.dependencies).toEqual(['understanding-1',capability.id]);
    setVersion({id:'version-linked',spaceId:'space',revision:'1',changeReason:'Initial',config:{},entrypoints:{content:{workflowId:'new-content'} as never},
      designBasis:{designRevisionId:design.id,designPayloadHash:design.payloadHash,understandingRevisionId:'understanding-1',understandingPayloadHash:'understanding-hash'},
      hash:'version-hash',createdAt:'2026-10-09T00:00:02Z'});
    expect((await store.readBasis('space','version-linked'))?.capability?.id).toBe(capability.id);
    assets[1]={...capability,payloadHash:'tampered'};
    await expect(store.readBasis('space','version-linked')).rejects.toThrow('capability is inconsistent');
  });
});

const databaseUrl=process.env.WORKFLOW_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('method design publication with PostgreSQL fixture',()=>{
  let pool:Pool;
  beforeAll(async()=>{pool=new Pool({connectionString:databaseUrl});await migrateWorkflowSpaces(pool);});
  afterAll(async()=>{await pool?.end();});
  it('freezes exact design and understanding while preserving historic no-basis versions',async()=>{
    const service=new SpaceService(pool,new PostgresBlobStore(pool),{id:'method-design-owner',kind:'human'});
    const space=await service.createSpace({purpose:'Isolated design-basis fixture'});
    const understandingStore=createBusinessUnderstandingStore(service),designStore=createMethodDesignStore(service);
    await understandingStore.ensure(space.id);await designStore.ensure(space.id);
    const business=await understandingStore.save(space.id,{title:'Purpose',content:'Purpose details',sources:[{kind:'document',ref:'doc',title:'Doc'}],
      authorship:{kind:'agent',name:'Tester'},changeReason:'Initial',expectedRevisionId:null,idempotencyKey:'business'});
    const design=await designStore.save(space.id,{...draft,understanding:{revisionId:business.id,payloadHash:business.payloadHash},
      expectedRevisionId:null,idempotencyKey:'design'});
    const entry={workflowId:'new-content',codeRevision:'1',storageContract:{workflowVersion:'v1',nodes:{
      writer:{actorKinds:['agent'] as ['agent'],inputs:{},outputs:{},actions:[]},
    },stateRules:[]}};
    const base={id:'v1',revision:'1',changeReason:'Initial',config:{},entrypoints:{content:entry}};
    await expect(service.publishWorkflow(space.id,{...base,designBasis:{designRevisionId:design.id,designPayloadHash:'wrong',
      understandingRevisionId:business.id,understandingPayloadHash:business.payloadHash}})).rejects.toThrow('mismatch');
    await expect(service.publishWorkflow(space.id,{...base,entrypoints:{other:entry},designBasis:{designRevisionId:design.id,
      designPayloadHash:design.payloadHash,understandingRevisionId:business.id,understandingPayloadHash:business.payloadHash}})).rejects.toThrow('identity/entrypoint');
    const basis={designRevisionId:design.id,designPayloadHash:design.payloadHash,
      understandingRevisionId:business.id,understandingPayloadHash:business.payloadHash};
    const published=await service.publishWorkflow(space.id,{...base,designBasis:basis});
    expect(published.designBasis).toEqual(basis);
    const nextBusiness=await understandingStore.save(space.id,{title:'Changed purpose',content:'Changed',sources:[{kind:'document',ref:'doc',title:'Doc'}],
      authorship:{kind:'agent',name:'Tester'},changeReason:'Later evidence',expectedRevisionId:business.id,idempotencyKey:'business-2'});
    expect(nextBusiness.id).not.toBe(business.id);
    expect(await designStore.readBasis(space.id,published.id)).toMatchObject({design:{id:design.id},understanding:{id:business.id}});
    const historic=await service.publishWorkflow(space.id,{...base,id:'legacy',entrypoints:{content:{...entry,storageContract:{...entry.storageContract,workflowVersion:'legacy'}}}});
    expect(await designStore.readBasis(space.id,historic.id)).toBeNull();
  });
});
