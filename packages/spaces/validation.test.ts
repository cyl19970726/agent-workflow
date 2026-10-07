import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {JSON_SCHEMA_DIALECT} from '@signal-room/workflow-space-contracts';
import {artifactPayloadSha256} from '@signal-room/workflow';
import {SiwcResponsesRunner} from '../agent-sdk/src/responses.js';
import {PostgresBlobStore} from './blob-store.js';
import {migrateWorkflowSpaces} from './migration.js';
import {WorkflowSpaceService} from './service.js';
import type {ValidationPlanDraft,Review} from './types.js';

const url=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
let pool:Pool;
const owner=()=>new WorkflowSpaceService(pool,new PostgresBlobStore(pool),{id:'validation-owner',kind:'human'});
async function fixture() {
  const service=owner(),space=await service.createSpace({id:`validation-${randomUUID()}`,purpose:'Validation storage test'});
  const [schema]=await service.registerSchemas(space.id,[{namespace:'test/validation-report',revision:'1',dialect:JSON_SCHEMA_DIALECT,
    schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]);
  const ref={namespace:schema!.namespace,revision:schema!.revision,hash:schema!.hash};
  for(const id of ['v1','v2']) await service.publishWorkflow(space.id,{id,revision:'1',changeReason:id,config:{temperature:0},entrypoints:{main:{workflowId:'flow',codeRevision:'1',storageContract:{workflowVersion:id,nodes:{
    node:{actorKinds:['program'],inputs:{},outputs:{},actions:[]},
    writer:{actorKinds:['agent'],inputs:{},outputs:{report:{schema:ref,requiredInputs:[],appendVersions:false,initialState:'candidate'}},actions:['appendOutputVersion']},
    'judge-A':{actorKinds:['agent'],inputs:{subject:{schema:ref,states:['candidate']}},outputs:{},actions:['readBoundInput','evaluate']},
  },stateRules:[]}}}});
  for(const id of ['one','two','three']) await service.createCase(space.id,{id,title:id,objective:'Test',constraints:[]});
  const manifests=await Promise.all(['one','two','three'].map(id=>service.freezeInputs(space.id,id,{})));
  const draft:ValidationPlanDraft={id:`plan-${randomUUID()}`,kind:'prospective',question:'Which version works?',hypothesis:'Candidate improves',
    baseline:{workflowVersionId:'v1',entrypoint:'main'},candidate:{workflowVersionId:'v2',entrypoint:'main'},
    cases:manifests.map((manifest,index)=>({caseId:['one','two','three'][index]!,inputManifestId:manifest.id,repeats:index===0?2:1})),
    standard:{id:'four-questions',revision:'1',content:'Four questions'},judges:[{kind:'human',id:'validation-owner'},
      {kind:'agent',id:'judge-A',configuration:{model:'mimo-test'},instructions:'Judge independent report',tools:[]}],
    expectedVariables:[],exclusionRules:['unusable source']};
  return {service,space,manifests,draft,ref};
}
suite('frozen validation evidence',()=>{
  beforeAll(async()=>{pool=new Pool({connectionString:url!,max:10});await migrateWorkflowSpaces(pool);});
  afterAll(async()=>{await pool?.end();});

  it('freezes all cases and repeats, preserves missing denominator, and refuses a silent edit',async()=>{
    const f=await fixture();
    expect((await f.service.createValidationPlan(f.space.id,f.draft)).entries).toHaveLength(8);
    await f.service.freezeValidationPlan(f.space.id,f.draft.id);
    const summary=await f.service.validationSummary(f.space.id,f.draft.id);
    expect(summary.totals).toMatchObject({cases:3,plannedPairs:4,entries:8,attempts:0});
    expect(summary.totals.byStatus.missing).toBe(8);
    await expect(f.service.createValidationPlan(f.space.id,{...f.draft,hypothesis:'Changed'})).rejects.toThrow('immutable');
    await expect(f.service.excludeValidationEntry(f.space.id,f.draft.id,{entryId:summary.entries[0]!.entry.id,rule:'different rule',reason:'Problem'})).rejects.toThrow('not frozen');
    await f.service.excludeValidationEntry(f.space.id,f.draft.id,{entryId:summary.entries[0]!.entry.id,rule:'unusable source',reason:'Missing source'});
    expect((await f.service.validationSummary(f.space.id,f.draft.id)).totals.byStatus.excluded).toBe(1);
    await f.service.excludeValidationEntry(f.space.id,f.draft.id,{entryId:summary.entries[1]!.entry.id,rule:'unusable source',reason:'Missing source'});
    const partial=await f.service.validationSummary(f.space.id,f.draft.id);
    expect(partial.pairs[0]!.status).toBe('excluded');
    expect(partial.pairs[1]!.status).toBe('missing');
    expect(partial.cases[0]!.status).toBe('incomplete');
    expect(Object.values(partial.totals.byStatus).reduce((sum,n)=>sum+n,0)).toBe(partial.totals.entries);
  });

  it('links only exact post-freeze run, rejects wrong input, conditions, cross-Space, and duplicate attempt',async()=>{
    const f=await fixture(),plan=await f.service.createValidationPlan(f.space.id,f.draft);
    const old=await f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'main',inputManifestId:f.manifests[0]!.id,idempotencyKey:randomUUID()});
    await f.service.freezeValidationPlan(f.space.id,plan.id);
    const entry=plan.entries[0]!;
    await expect(f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry.id,runId:old.runId})).rejects.toThrow('pre-freeze');
    const wrong=await f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'main',inputManifestId:f.manifests[1]!.id,idempotencyKey:randomUUID()});
    await expect(f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry.id,runId:wrong.runId})).rejects.toThrow('binding mismatch');
    const changed=await f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'main',inputManifestId:f.manifests[0]!.id,effectiveConfig:{temperature:1},idempotencyKey:randomUUID()});
    await expect(f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry.id,runId:changed.runId})).rejects.toThrow('conditions mismatch');
    const good=await f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'main',inputManifestId:f.manifests[0]!.id,idempotencyKey:randomUUID()});
    await expect(f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry.id,runId:good.runId,attempt:2})).rejects.toThrow('sequential');
    await f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry.id,runId:good.runId});
    await expect(f.service.linkValidationRun(f.space.id,plan.id,{entryId:plan.entries[1]!.id,runId:good.runId})).rejects.toThrow();
    const other=await fixture();
    await expect(other.service.linkValidationRun(other.space.id,plan.id,{entryId:entry.id,runId:good.runId})).rejects.toThrow('authorized space');
    const summary=await f.service.validationSummary(f.space.id,plan.id);
    expect(summary.totals.attempts).toBe(1);
    expect(summary.entries[0]!.attempts[0]!.runId).toBe(good.runId);
  });

  it('rejects changed standards and forged Agent identity when linking reviews',async()=>{
    const f=await fixture(),plan=await f.service.createValidationPlan(f.space.id,f.draft);
    await f.service.freezeValidationPlan(f.space.id,plan.id);
    const entry=plan.entries[0]!;
    const run=await f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'main',inputManifestId:entry.inputManifestId,idempotencyKey:randomUUID()});
    await f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry.id,runId:run.runId});
    const base:Review={id:randomUUID(),spaceId:f.space.id,runId:run.runId,assetVersionIds:[],standard:plan.standard,
      judge:{kind:'human',id:'validation-owner'},evidence:[],answers:{good:'a',bad:'b',improvement:'c',unresolved:'d'},createdAt:new Date().toISOString()};
    const insert=async(review:Review)=>pool.query('INSERT INTO ws_reviews(space_id,id,run_id,baseline_id,session_id,document) VALUES($1,$2,$3,NULL,NULL,$4::jsonb)',[f.space.id,review.id,run.runId,JSON.stringify(review)]);
    const changed={...base,id:randomUUID(),standard:{...base.standard,revision:'2'}};
    await insert(changed);
    await expect(f.service.linkValidationReview(f.space.id,plan.id,{entryId:entry.id,runId:run.runId,reviewId:changed.id})).rejects.toThrow('standard changed');
    const fakeAgent={...base,id:randomUUID(),judge:{kind:'agent' as const,id:'judge-A',sessionId:'nonexistent'}};
    await insert(fakeAgent);
    await expect(f.service.linkValidationReview(f.space.id,plan.id,{entryId:entry.id,runId:run.runId,reviewId:fakeAgent.id})).rejects.toThrow('authorized space');
    await insert(base);
    await f.service.linkValidationReview(f.space.id,plan.id,{entryId:entry.id,runId:run.runId,reviewId:base.id});
    const summary=await f.service.validationSummary(f.space.id,plan.id);
    expect(summary.entries[0]!.status).toBe('running');
    expect(summary.entries[0]!.requiredJudgeCoverage.map(item=>item.reviewIds.length)).toEqual([1,0]);
  });

  it('keeps a human-only comparison incomplete when Agent A is required and guards adoption evidence',async()=>{
    const f=await fixture(),plan=await f.service.createValidationPlan(f.space.id,f.draft);
    await f.service.freezeValidationPlan(f.space.id,plan.id);
    const [baseline,candidate]=plan.entries;
    const a=await f.service.startRun(f.space.id,{workflowVersionId:'v1',entrypoint:'main',inputManifestId:baseline!.inputManifestId,idempotencyKey:randomUUID()});
    const b=await f.service.startRun(f.space.id,{workflowVersionId:'v2',entrypoint:'main',inputManifestId:candidate!.inputManifestId,idempotencyKey:randomUUID()});
    await f.service.linkValidationRun(f.space.id,plan.id,{entryId:baseline!.id,runId:a.runId});
    await f.service.linkValidationRun(f.space.id,plan.id,{entryId:candidate!.id,runId:b.runId});
    const review=(runId:string,baselineReviewId?:string):Review=>({id:randomUUID(),spaceId:f.space.id,runId,assetVersionIds:[],
      ...(baselineReviewId?{baselineReviewId}:{}),standard:plan.standard,judge:{kind:'human',id:'validation-owner'},evidence:[],
      answers:{good:'a',bad:'b',improvement:'c',unresolved:'d'},createdAt:new Date().toISOString()});
    const first=review(a.runId),second=review(b.runId,first.id);
    for(const item of [first,second]) await pool.query('INSERT INTO ws_reviews(space_id,id,run_id,baseline_id,session_id,document) VALUES($1,$2,$3,$4,NULL,$5::jsonb)',[f.space.id,item.id,item.runId,item.baselineReviewId??null,JSON.stringify(item)]);
    await f.service.linkValidationReview(f.space.id,plan.id,{entryId:baseline!.id,runId:a.runId,reviewId:first.id});
    await f.service.linkValidationReview(f.space.id,plan.id,{entryId:candidate!.id,runId:b.runId,reviewId:second.id});
    const paired=await f.service.compareValidationEntries(f.space.id,plan.id,{id:randomUUID(),baselineEntryId:baseline!.id,candidateEntryId:candidate!.id,baselineReviewId:first.id,candidateReviewId:second.id,conclusion:'Human saw improvement'});
    const summary=await f.service.validationSummary(f.space.id,plan.id);
    expect(summary.pairs[0]!.status).toBe('pending');
    expect(summary.pairs[0]!.requiredJudgeCoverage.map(item=>item.comparisonIds.length)).toEqual([1,0]);
    await expect(f.service.adopt(f.space.id,{idempotencyKey:randomUUID(),slot:'chosen',target:{kind:'workflow',id:'v1'},comparisonId:paired.id,validationPlanId:plan.id,reason:'Rollback'})).rejects.toThrow('target version mismatch');
    await expect(f.service.adopt(f.space.id,{idempotencyKey:randomUUID(),slot:'chosen',target:{kind:'workflow',id:'v2'},validationPlanId:plan.id,reason:'No evidence'})).rejects.toThrow('requires linked comparison');
    const adopted=await f.service.adopt(f.space.id,{idempotencyKey:randomUUID(),slot:'chosen',target:{kind:'workflow',id:'v2'},comparisonId:paired.id,validationPlanId:plan.id,reason:'Explicit choice'});
    expect(adopted.target.id).toBe('v2');
    expect(await f.service.adoptionHeads(f.space.id)).toEqual([adopted]);
  });

  it('requires genuine observed Agent A reviews and per-judge comparisons to complete a pair',async()=>{
    const f=await fixture(),plan=await f.service.createValidationPlan(f.space.id,f.draft);
    await f.service.freezeValidationPlan(f.space.id,plan.id);
    const [baseline,candidate]=plan.entries;
    const make=async(entry:typeof baseline)=>{
      const run=await f.service.startRun(f.space.id,{workflowVersionId:entry!.workflowVersionId,entrypoint:'main',inputManifestId:entry!.inputManifestId,idempotencyKey:randomUUID()});
      await f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry!.id,runId:run.runId});
      const writer=await f.service.startNode(f.space.id,{runId:run.runId,nodeId:'writer',key:'write',inputs:{},producer:'agent',instructions:'Write report',effectiveConfig:{}});
      const asset=(await (await f.service.nodeClient(f.space.id,writer.id)).submit({idempotencyKey:'report',outputs:[{slot:'report',payload:{text:entry!.side},dependencySlots:[]}]})).versions[0]!;
      const judge=await f.service.startNode(f.space.id,{runId:run.runId,nodeId:'judge-A',key:'evaluate',inputs:{subject:asset.id},producer:'agent',instructions:'Judge independent report',effectiveConfig:{model:'mimo-test'}});
      const judgeClient=await f.service.nodeClient(f.space.id,judge.id);
      await judgeClient.read('subject');
      const runner=new SiwcResponsesRunner({auth:{accessToken:async()=>'test-token'},
        fetch:async()=>new Response(`data: ${JSON.stringify({type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:'Observed assessment'}]}]}})}\n\n`,
          {headers:{'content-type':'text/event-stream'}})});
      let eventNumber=0;
      const result=await runner.run({runId:run.runId,stepRunId:judge.stepRunId,attemptId:judge.attemptId,
        definition:{id:'judge-A',revision:'1',model:'mimo-test',reasoningEffort:'low',promptRevision:'1',skillsRevision:'1',permissionsRevision:'1',config:{instructions:'Judge independent report'}},
        input:{assetVersionId:asset.id},signal:new AbortController().signal,
        emit:async(type,data)=>{await f.service.recordSessionEvent(f.space.id,judge.id,`runner-event:${++eventNumber}`,'trace',{type,data});}});
      expect(result.output).toBe('Observed assessment');
      await judgeClient.submit({idempotencyKey:'observation',outputs:[],result:result.output});
      return {runId:run.runId,assetId:asset.id,judgeClient};
    };
    const a=await make(baseline),b=await make(candidate);
    const answers={good:'Clear',bad:'Limited',improvement:'Improve',unresolved:'Unknown'};
    const humanA=await f.service.recordReview(f.space.id,{id:randomUUID(),runId:a.runId,assetVersionIds:[a.assetId],standard:plan.standard,judge:{kind:'human',id:'validation-owner'},evidence:[a.assetId],answers});
    const humanB=await f.service.recordReview(f.space.id,{id:randomUUID(),runId:b.runId,assetVersionIds:[b.assetId],baselineReviewId:humanA.id,standard:plan.standard,judge:{kind:'human',id:'validation-owner'},evidence:[b.assetId],answers});
    await f.service.linkValidationReview(f.space.id,plan.id,{entryId:baseline!.id,runId:a.runId,reviewId:humanA.id});
    await f.service.linkValidationReview(f.space.id,plan.id,{entryId:candidate!.id,runId:b.runId,reviewId:humanB.id});
    const agentA=await a.judgeClient.act('evaluate',{id:randomUUID(),runId:a.runId,assetVersionIds:[a.assetId],standard:plan.standard,evidence:[a.assetId],answers}) as Review;
    const agentB=await b.judgeClient.act('evaluate',{id:randomUUID(),runId:b.runId,assetVersionIds:[b.assetId],baselineReviewId:agentA.id,standard:plan.standard,evidence:[b.assetId],answers}) as Review;
    expect(agentA.judge).toMatchObject({kind:'agent',id:'judge-A'});
    expect(agentB.judge.sessionId).not.toBe(agentA.judge.sessionId);
    await f.service.linkValidationReview(f.space.id,plan.id,{entryId:baseline!.id,runId:a.runId,reviewId:agentA.id});
    await f.service.linkValidationReview(f.space.id,plan.id,{entryId:candidate!.id,runId:b.runId,reviewId:agentB.id});
    const before=await f.service.validationSummary(f.space.id,plan.id);
    expect(before.entries.slice(0,2).map(row=>row.status)).toEqual(['running','running']);
    expect(before.entries.slice(0,2).map(row=>row.requiredJudgeCoverage.map(judge=>judge.reviewIds.length))).toEqual([[1,1],[1,1]]);
    expect(before.pairs[0]!.status).toBe('pending');
    await f.service.compareValidationEntries(f.space.id,plan.id,{id:randomUUID(),baselineEntryId:baseline!.id,candidateEntryId:candidate!.id,baselineReviewId:humanA.id,candidateReviewId:humanB.id,conclusion:'Human comparison'});
    expect((await f.service.validationSummary(f.space.id,plan.id)).pairs[0]!.status).toBe('pending');
    await f.service.compareValidationEntries(f.space.id,plan.id,{id:randomUUID(),baselineEntryId:baseline!.id,candidateEntryId:candidate!.id,baselineReviewId:agentA.id,candidateReviewId:agentB.id,conclusion:'Agent comparison'});
    const active=await f.service.validationSummary(f.space.id,plan.id);
    expect(active.pairs[0]!.requiredJudgeCoverage.map(item=>item.comparisonIds.length)).toEqual([1,1]);
    expect(active.pairs[0]!.status).toBe('pending');
    await f.service.finishRun(f.space.id,a.runId);
    await f.service.finishRun(f.space.id,b.runId);
    await pool.query(`INSERT INTO ws_execution_tasks(space_id,run_id,workflow_version_id,entrypoint,input_manifest_id,case_id,executor_key,request_hash,status,lease_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'test','fingerprint','running',now()+interval '1 minute')`,
      [f.space.id,a.runId,baseline!.workflowVersionId,baseline!.entrypoint,baseline!.inputManifestId,baseline!.caseId]);
    const taskActive=await f.service.validationSummary(f.space.id,plan.id);
    expect(taskActive.entries[0]!.status).toBe('running');
    expect(taskActive.pairs[0]!.status).toBe('pending');
    await pool.query("UPDATE ws_execution_tasks SET status='completed' WHERE space_id=$1 AND run_id=$2",[f.space.id,a.runId]);
    const after=await f.service.validationSummary(f.space.id,plan.id);
    expect(after.entries.slice(0,2).map(row=>row.status)).toEqual(['reviewed','reviewed']);
    expect(after.pairs[0]!.status).toBe('compared');
    expect(after.pairs[0]!.requiredJudgeCoverage.map(item=>item.comparisonIds.length)).toEqual([1,1]);
    expect(after.cases[0]!.status).toBe('incomplete'); // A second planned repeat remains missing.
  });

  it('keeps historical Agent reviews unverified and rejects same-model instruction or tool drift',async()=>{
    const f=await fixture(),plan=await f.service.createValidationPlan(f.space.id,f.draft);
    await f.service.freezeValidationPlan(f.space.id,plan.id);
    const entry=plan.entries[0]!;
    const run=await f.service.startRun(f.space.id,{workflowVersionId:entry.workflowVersionId,entrypoint:'main',inputManifestId:entry.inputManifestId,idempotencyKey:randomUUID()});
    await f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry.id,runId:run.runId});
    const writer=await f.service.startNode(f.space.id,{runId:run.runId,nodeId:'writer',key:'write',inputs:{},producer:'agent',instructions:'Write report',effectiveConfig:{}});
    const asset=(await (await f.service.nodeClient(f.space.id,writer.id)).submit({idempotencyKey:'report',outputs:[{slot:'report',payload:{text:'Report'},dependencySlots:[]}]})).versions[0]!;
    const make=async(key:string,instructions:string,toolDefinitions:{name:string;description:string;parameters:unknown}[]|null,badHash=false)=>{
      const context=await f.service.startNode(f.space.id,{runId:run.runId,nodeId:'judge-A',key,inputs:{subject:asset.id},producer:'agent',instructions,effectiveConfig:{model:'mimo-test'}});
      if(toolDefinitions) await f.service.recordSessionEvent(f.space.id,context.id,'runner-event:1','trace',{type:'siwc.started',data:{model:'mimo-test',instructions,toolDefinitions,
        toolProfileHash:badHash?'0'.repeat(64):await artifactPayloadSha256(toolDefinitions)}});
      const client=await f.service.nodeClient(f.space.id,context.id);
      await client.read('subject');
      await client.submit({idempotencyKey:`observation-${key}`,outputs:[]});
      return client.act('evaluate',{id:randomUUID(),runId:run.runId,assetVersionIds:[asset.id],standard:plan.standard,evidence:[asset.id],answers:{good:'Clear',bad:'Limited',improvement:'Improve',unresolved:'Unknown'}}) as Promise<Review>;
    };
    const legacy=await make('legacy','Judge independent report',null);
    const legacyLink=await f.service.linkValidationReview(f.space.id,plan.id,{entryId:entry.id,runId:run.runId,reviewId:legacy.id});
    expect(legacyLink.judgeEvidence).toMatchObject({verified:false,differences:{toolProfileObservation:{observed:0}}});
    const wrongInstructions=await make('wrong-instructions','Different rubric',[]);
    await expect(f.service.linkValidationReview(f.space.id,plan.id,{entryId:entry.id,runId:run.runId,reviewId:wrongInstructions.id})).rejects.toThrow('profile mismatch:');
    const wrongTools=await make('wrong-tools','Judge independent report',[{name:'extra_read',description:'Extra reader',parameters:{type:'object'}}]);
    await expect(f.service.linkValidationReview(f.space.id,plan.id,{entryId:entry.id,runId:run.runId,reviewId:wrongTools.id})).rejects.toThrow('profile mismatch: tools');
    const badHash=await make('bad-hash','Judge independent report',[],true);
    expect((await f.service.linkValidationReview(f.space.id,plan.id,{entryId:entry.id,runId:run.runId,reviewId:badHash.id})).judgeEvidence.verified).toBe(false);
    const summary=await f.service.validationSummary(f.space.id,plan.id);
    const coverage=summary.entries[0]!.requiredJudgeCoverage[1]!;
    expect(coverage.reviewIds).toEqual([]);
    // Coverage identifies the exact evidence set; it does not promise insertion order.
    expect([...coverage.unverifiedReviewIds].sort()).toEqual([legacy.id,badHash.id].sort());
    expect(summary.entries[0]!.attempts[0]!.judgeEvidence.every(item=>!item.verified)).toBe(true);
  });

  it('shows an expired active task as interrupted without losing native run state',async()=>{
    const f=await fixture(),plan=await f.service.createValidationPlan(f.space.id,f.draft);
    await f.service.freezeValidationPlan(f.space.id,plan.id);
    const entry=plan.entries[0]!;
    const run=await f.service.startRun(f.space.id,{workflowVersionId:entry.workflowVersionId,entrypoint:entry.entrypoint,inputManifestId:entry.inputManifestId,idempotencyKey:randomUUID()});
    await f.service.linkValidationRun(f.space.id,plan.id,{entryId:entry.id,runId:run.runId});
    await pool.query(`INSERT INTO ws_execution_tasks(space_id,run_id,workflow_version_id,entrypoint,input_manifest_id,case_id,executor_key,request_hash,status,lease_expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'test','fingerprint','running',now()-interval '1 second')`,
      [f.space.id,run.runId,entry.workflowVersionId,entry.entrypoint,entry.inputManifestId,entry.caseId]);
    const summary=await f.service.validationSummary(f.space.id,plan.id);
    expect(summary.entries[0]!.status).toBe('interrupted');
    expect(summary.entries[0]!.attempts[0]).toMatchObject({task:{status:'interrupted'},run:{state:'running'}});
    expect(summary.totals.byStatus.interrupted).toBe(1);
    expect(Object.values(summary.totals.byStatus).reduce((sum,n)=>sum+n,0)).toBe(summary.totals.entries);
  });
});
