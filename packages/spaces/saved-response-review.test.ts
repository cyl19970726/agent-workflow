import { describe, expect, it, vi } from 'vitest';
import { artifactPayloadSha256 } from '@signal-room/workflow';
import { WorkflowSpaceService } from './service.js';
import {EXTERNAL_AGENT_OBSERVATION_SCHEMA_REF,externalAgentObservationAssetId} from './external-agent-observation.js';
import type { SavedResponseTarget } from './types.js';

async function fixture() {
  const output={script:{title:'Saved reply',sections:[{text:'Unpublished manuscript'}]}};
  const target:SavedResponseTarget={runId:'run-1',occurrenceId:'occ-1',stepRunId:'step-1',attemptId:'attempt-1',
    sessionId:'session-1',eventId:'event-1',eventSeq:7,outputHash:await artifactPayloadSha256(output)};
  const event={id:target.eventId,sessionId:target.sessionId,seq:target.eventSeq,attemptId:target.attemptId,
    kind:'message' as const,body:{role:'assistant',output,validation:'valid'},createdAt:'2026-10-10T00:00:00Z'};
  const pool={query:vi.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT m.role'))return {rows:[{role:'owner',document:{status:'active'}}]};
    if(sql.startsWith('SELECT id,document FROM ws_contexts'))return {rows:[{id:'context-1',document:{id:'context-1',producer:'agent',
      runId:'run-1',stepRunId:'step-1',attemptId:'attempt-1',sessionId:'session-1'}}]};
    if(sql.startsWith('SELECT context_id,dedup_key,document FROM ws_session_events'))return {rows:[{context_id:'context-1',dedup_key:'agent-result',document:event}]};
    throw new Error(`Unexpected query: ${sql}`);
  })};
  const service=new WorkflowSpaceService(pool as never,{} as never,{id:'human-1',kind:'human'});
  vi.spyOn(service,'process').mockResolvedValue({occurrences:[{id:'occ-1',stepRunIds:['step-1'],attemptIds:['attempt-1'],contextIds:['context-1'],
    state:'failed',outputBindings:[]}]} as never);
  vi.spyOn(service as never,'ledger').mockReturnValue({getRun:vi.fn(async()=>({state:'failed'}))});
  return {service,target,pool,event};
}

describe('saved assistant response review target',()=>{
  it('resolves only the exact failed, unpublished event and canonical saved output',async()=>{
    const {service,target}=await fixture();
    await expect(service.readSavedResponseTarget('space-1',target)).resolves.toEqual({target,
      output:{script:{title:'Saved reply',sections:[{text:'Unpublished manuscript'}]}}});
    await expect(service.readSavedResponseTarget('space-1',{...target,outputHash:'bad'})).rejects.toThrow('hash mismatch');
    await expect(service.readSavedResponseTarget('space-1',{...target,occurrenceId:'other'})).rejects.toThrow('occurrence');
  });
  it('rejects a published occurrence and an event from a different context',async()=>{
    const {service,target,pool}=await fixture();
    vi.spyOn(service,'process').mockResolvedValue({occurrences:[{id:'occ-1',stepRunIds:['step-1'],attemptIds:['attempt-1'],contextIds:['context-1'],
      state:'failed',outputBindings:[{contextId:'context-1',slot:'draft',assetVersionId:'asset-1'}]}]} as never);
    await expect(service.readSavedResponseTarget('space-1',target)).rejects.toThrow('failed and unpublished');
    vi.spyOn(service,'process').mockResolvedValue({occurrences:[{id:'occ-1',stepRunIds:['step-1'],attemptIds:['attempt-1'],contextIds:['context-1'],
      state:'failed',outputBindings:[]}]} as never);
    const original=pool.query.getMockImplementation()!;
    pool.query.mockImplementation(async(sql:string)=>sql.startsWith('SELECT context_id,dedup_key,document FROM ws_session_events')
      ?{rows:[{context_id:'another-context',dedup_key:'agent-result',document:{}}]}:original(sql));
    await expect(service.readSavedResponseTarget('space-1',target)).rejects.toThrow('context mismatch');
  });
  it('records a human review of a response without inventing an asset, and checks cited JSON pointers',async()=>{
    const {target}=await fixture();
    const stored:unknown[]=[];
    const db={query:vi.fn(async(sql:string,params?:unknown[])=>{
      if(sql.startsWith('SELECT m.role'))return {rows:[{role:'owner',document:{status:'active'}}]};
      if(sql.startsWith('SELECT id FROM ws_spaces'))return {rows:[{id:'space-1'}]};
      if(sql.startsWith('SELECT document FROM ws_runs'))return {rows:[{document:{runId:'run-1',caseId:'case-1'}}]};
      if(sql.startsWith('SELECT document FROM ws_reviews'))return {rows:[]};
      if(sql.startsWith('INSERT INTO ws_reviews')){stored.push(params);return {rows:[]};}
      if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
      throw new Error(`Unexpected query: ${sql}`);
    }),release:vi.fn()};
    const service=new WorkflowSpaceService({connect:vi.fn(async()=>db)} as never,{} as never,{id:'human-1',kind:'human'});
    vi.spyOn(service,'readSavedResponseTarget').mockResolvedValue({target,output:{script:{title:'Saved reply'}}});
    const review={id:'review-1',runId:'run-1',assetVersionIds:[],responseTarget:target,evidencePointers:['/script/title'],
      standard:{id:'draft-standard',revision:'1',content:'Check draft'},judge:{kind:'human' as const,id:'human-1'},
      evidence:[],answers:{good:'Clarity',bad:'Opening',improvement:'Reframe',unresolved:'Coverage'}};
    await expect(service.recordReview('space-1',review)).resolves.toMatchObject({id:'review-1',responseTarget:target});
    expect(stored).toHaveLength(1);
    await expect(service.recordReview('space-1',{...review,id:'review-2',evidencePointers:['/script/missing']}))
      .rejects.toThrow('pointer');
    await expect(service.recordReview('space-1',{...review,id:'review-3',judge:{kind:'agent',id:'judge',sessionId:'session-2'}}))
      .rejects.toThrow('observation receipt');
    expect(stored).toHaveLength(1);
  });
  it('issues a durable exact read receipt only to a trusted external Agent independent of producer',async()=>{
    const {target}=await fixture();
    const pool={query:vi.fn(async(sql:string)=>{
      if(sql.startsWith('SELECT m.role'))return {rows:[{role:'operator',document:{status:'active'}}]};
      if(sql.startsWith('SELECT document FROM ws_sessions'))return {rows:[{document:{id:'session-1',nativeSessionId:'producer-thread'}}]};
      throw new Error(`Unexpected query: ${sql}`);
    })};
    const principal={id:'agent-service-member',kind:'service' as const,externalAgent:{id:'codex-judge',sessionId:'judge-thread'}};
    const service=new WorkflowSpaceService(pool as never,{} as never,principal);
    vi.spyOn(service,'readSavedResponseTarget').mockResolvedValue({target,output:{script:{title:'Saved reply'}}});
    const importSpy=vi.spyOn(service,'importAsset').mockImplementation(async(_spaceId,input)=>({
      id:'receipt-1',assetId:input.assetId,version:1,schema:input.schema,payload:input.payload,payloadHash:'receipt-hash',
      createdAt:'2026-10-10T00:00:00Z',source:{kind:'import',actorId:principal.id},spaceId:'space-1',dependencies:[],attachments:[],initialState:'imported',
    }));
    const observed=await service.observeSavedResponseTarget('space-1',target);
    expect(observed.receipt).toMatchObject({id:'receipt-1',target,observer:{id:'codex-judge',sessionId:'judge-thread',servicePrincipalId:'agent-service-member'},
      delivery:'saved-response-read'});
    expect(importSpy).toHaveBeenCalledWith('space-1',expect.objectContaining({
      assetId:externalAgentObservationAssetId('judge-thread',target.eventId),schema:EXTERNAL_AGENT_OBSERVATION_SCHEMA_REF}));
    const human=new WorkflowSpaceService(pool as never,{} as never,{id:'owner',kind:'human'});
    vi.spyOn(human,'readSavedResponseTarget').mockResolvedValue({target,output:{}});
    await expect(human.observeSavedResponseTarget('space-1',target)).rejects.toThrow('credential required');
    const self=new WorkflowSpaceService(pool as never,{} as never,{...principal,externalAgent:{id:'codex-judge',sessionId:'producer-thread'}});
    vi.spyOn(self,'readSavedResponseTarget').mockResolvedValue({target,output:{}});
    await expect(self.observeSavedResponseTarget('space-1',target)).rejects.toThrow('independent');
  });
  it('accepts an external Agent four-question review with its exact receipt and rejects impersonation',async()=>{
    const {target}=await fixture();
    const stored:unknown[]=[];
    const db={query:vi.fn(async(sql:string,params?:unknown[])=>{
      if(sql.startsWith('SELECT m.role'))return {rows:[{role:'operator',document:{status:'active'}}]};
      if(sql.startsWith('SELECT id FROM ws_spaces'))return {rows:[{id:'space-1'}]};
      if(sql.startsWith('SELECT document FROM ws_runs'))return {rows:[{document:{runId:'run-1',caseId:'case-1'}}]};
      if(sql.startsWith('SELECT document FROM ws_reviews'))return {rows:[]};
      if(sql.startsWith('INSERT INTO ws_reviews')){stored.push(params);return {rows:[]};}
      if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
      throw new Error(`Unexpected query: ${sql}`);
    }),release:vi.fn()};
    const pool={connect:vi.fn(async()=>db),query:db.query};
    const observer={id:'codex-judge',sessionId:'judge-thread',servicePrincipalId:'agent-service-member'};
    const receipt={id:'receipt-1',assetId:externalAgentObservationAssetId(observer.sessionId,target.eventId),payloadHash:'hash',
      createdAt:'2026-10-10T00:00:00Z',target,observer,delivery:'saved-response-read' as const};
    const service=new WorkflowSpaceService(pool as never,{} as never,{id:observer.servicePrincipalId,kind:'service',externalAgent:observer});
    vi.spyOn(service,'readSavedResponseTarget').mockResolvedValue({target,output:{script:{title:'Saved reply'}}});
    vi.spyOn(service,'readExternalAgentObservation').mockResolvedValue(receipt);
    const review={id:'agent-review-1',runId:'run-1',assetVersionIds:[],responseTarget:target,observationReceiptId:receipt.id,
      standard:{id:'draft-standard',revision:'1',content:'Check draft'},judge:{kind:'agent' as const,id:observer.id,sessionId:observer.sessionId},
      evidence:[],evidencePointers:['/script/title'],answers:{good:'Clear',bad:'Opening',improvement:'Reframe',unresolved:'Coverage'}};
    await expect(service.recordReview('space-1',review)).resolves.toMatchObject({id:'agent-review-1',judge:review.judge,observationReceiptId:'receipt-1'});
    await expect(service.recordReview('space-1',{...review,id:'fake-id',judge:{kind:'agent',id:'other-agent',sessionId:observer.sessionId}}))
      .rejects.toThrow('identity');
    await expect(service.recordReview('space-1',{...review,id:'fake-target',responseTarget:{...target,outputHash:'wrong'}}))
      .rejects.toThrow('observed target');
    const human=new WorkflowSpaceService(pool as never,{} as never,{id:'human-1',kind:'human'});
    vi.spyOn(human,'readSavedResponseTarget').mockResolvedValue({target,output:{script:{title:'Saved reply'}}});
    await expect(human.recordReview('space-1',{...review,id:'human-forgery'})).rejects.toThrow('credential required');
    expect(stored).toHaveLength(1);
  });
});
