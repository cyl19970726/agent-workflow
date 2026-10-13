import { describe, expect, it, vi } from 'vitest';
import { createRunDispositionStore, RUN_DISPOSITION_SCHEMA_REF, LEGACY_RUN_DISPOSITION_SCHEMA_REF,
  runDispositionRevision, type RunDispositionSave } from './run-disposition.js';
import type { WorkflowSpaceService } from './service.js';

function fixture() {
  const imports:unknown[]=[];
  const service={
    authenticatedHumanWriter:vi.fn(async()=>({id:'human-1',kind:'human' as const})),
    registerSchemas:vi.fn(async()=>[{...RUN_DISPOSITION_SCHEMA_REF}]),
    readRun:vi.fn(async(_spaceId:string,runId:string)=>({runId,inputManifestId:'manifest-1'})),
    readReview:vi.fn(async(_spaceId:string,id:string)=>({id,runId:id==='cross-run'?'run-2':'run-1'})),
    readAsset:vi.fn(async()=>({id:'source-1',source:{kind:'import'},payload:{title:'Source'}})),
    readManifest:vi.fn(async()=>({assets:{source:'source-1'}})),
    readAssetHead:vi.fn(async()=>null),readAssetHistory:vi.fn(async()=>[]),
    readSavedResponseTarget:vi.fn(async(_spaceId:string,target:unknown)=>({target,output:{script:{title:'Saved'}}})),
    runtimeEvidence:vi.fn(async()=>({listSteps:vi.fn(async()=>[{id:'step-1'}])})),
    importAsset:vi.fn(async(_spaceId:string,input:{payload:unknown;assetId:string;schema:unknown;idempotencyKey:string})=>{
      imports.push(input);
      return {id:'revision-1',assetId:input.assetId,version:1,schema:input.schema,payload:input.payload,
        payloadHash:'payload-hash',createdAt:'2026-10-10T00:00:00Z',source:{kind:'import',actorId:'human-1'}};
    }),
  };
  const save:RunDispositionSave={runId:'run-1',reviewIds:['review-1'],action:'revise',reason:'Opening needs work',
    unknowns:['How much detail?'],evidenceRefs:[{kind:'asset',assetVersionId:'source-1',pointer:'/title'},
      {kind:'run',runId:'run-1',stepRunId:'step-1'}],expectedRevisionId:null,idempotencyKey:'case-action-1'};
  return {store:createRunDispositionStore(service as unknown as WorkflowSpaceService),service,save,imports};
}

describe('run disposition store',()=>{
  it('reads the exact frozen human-only revision 1 without changing its schema identity',()=>{
    expect(LEGACY_RUN_DISPOSITION_SCHEMA_REF.hash).toBe('c30b6d5e5f5e7fe22a456258353db1d56e0fffabd1922491869d53e5a5578eca');
    expect(RUN_DISPOSITION_SCHEMA_REF.revision).toBe('2');
    const old={id:'legacy-revision',assetId:'run-disposition:run-1',version:1,schema:LEGACY_RUN_DISPOSITION_SCHEMA_REF,
      payload:{runId:'run-1',reviewIds:['human-review'],action:'defer',reason:'More evidence',unknowns:[],evidenceRefs:[],
        previousRevisionId:null,author:{kind:'human',id:'human-1'}},payloadHash:'legacy-payload-hash',createdAt:'2026-10-09T00:00:00Z',
      source:{kind:'import',actorId:'human-1'}};
    expect(runDispositionRevision(old as never)).toMatchObject({id:'legacy-revision',author:{kind:'human',id:'human-1'},
      recordedBy:'human-1',confirmation:'unconfirmed'});
  });
  it('requires explicit schema setup and saves an unconfirmed, authenticated-source revision',async()=>{
    const {store,service,save,imports}=fixture();
    await expect(store.ensure('space-1')).resolves.toEqual(RUN_DISPOSITION_SCHEMA_REF);
    const revision=await store.save('space-1',save);
    expect(revision).toMatchObject({id:'revision-1',runId:'run-1',action:'revise',reviewIds:['review-1'],
      previousRevisionId:null,author:{id:'human-1',kind:'human'},recordedBy:'human-1',confirmation:'unconfirmed'});
    expect(imports).toHaveLength(1);
    expect(service.importAsset).toHaveBeenCalledWith('space-1',expect.objectContaining({
      assetId:'run-disposition:run-1',idempotencyKey:'run-disposition:run-1:case-action-1'}));
  });
  it('rejects cross-run reviews and unverifiable evidence before writing',async()=>{
    const {store,service,save}=fixture();
    await expect(store.save('space-1',{...save,reviewIds:['cross-run']})).rejects.toThrow('same run');
    await expect(store.save('space-1',{...save,evidenceRefs:[{kind:'asset',assetVersionId:'source-1',pointer:'/missing'}]}))
      .rejects.toThrow('pointer');
    await expect(store.save('space-1',{...save,evidenceRefs:[{kind:'run',runId:'run-2'}]})).rejects.toThrow('outside the run');
    expect(service.importAsset).not.toHaveBeenCalled();
  });
});
