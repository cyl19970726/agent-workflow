import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runWorkflow, defineAgent } from '../packages/core/dist/index.js';
import { JSON_SCHEMA_DIALECT } from '../packages/space-contracts/dist/index.js';
import { WorkflowSpaceService, PostgresBlobStore, migrateWorkflowSpaces, createSpaceRuntime, nodeReadTools } from '../packages/spaces/dist/index.js';
import { SiwcAuth, SiwcResponsesRunner } from '../packages/agent-sdk/dist/index.js';

// Opt-in live connection/storage check; never part of the offline test or examples scripts.
if (!process.env.WORKFLOW_DATABASE_URL || !process.env.WORKFLOW_SIWC_MODEL) throw new Error('Set WORKFLOW_DATABASE_URL and an explicitly selected WORKFLOW_SIWC_MODEL. Run workflow-siwc login first.');
const pool=new Pool({connectionString:process.env.WORKFLOW_DATABASE_URL});
try {
  await migrateWorkflowSpaces(pool);const blobs=new PostgresBlobStore(pool);await blobs.migrate();
  const service=new WorkflowSpaceService(pool,blobs,{id:'local-owner',kind:'human'});
  const space=await service.createSpace({purpose:'Live SIWC connection and durable node capability probe'});
  const [registered]=await service.registerSchemas(space.id,[{namespace:'probe/report',revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:{type:'object',properties:{answer:{type:'string',minLength:1}},required:['answer'],additionalProperties:false}}]);
  const schema={namespace:registered.namespace,revision:registered.revision,hash:registered.hash};
  const contract={workflowVersion:'probe-v1',nodes:{writer:{actorKinds:['agent','program'],inputs:{source:{schema,states:['imported']}},outputs:{report:{schema,agentOutputSchema:schema,requiredInputs:['source'],appendVersions:false,initialState:'candidate'}},actions:['readBoundInput','appendOutputVersion']}},stateRules:[]};
  await service.publishWorkflow(space.id,{id:'probe-v1',revision:'1',changeReason:'Verify official app authorization with one bounded live agent',config:{model:process.env.WORKFLOW_SIWC_MODEL},entrypoints:{probe:{workflowId:'space.siwc-probe',codeRevision:'1',storageContract:contract}}});
  const source=await service.importAsset(space.id,{schema,payload:{answer:'A Workflow Space keeps a business purpose, exact asset versions, sessions and review history together.'},description:'Synthetic public test sentence; not a creative deliverable',idempotencyKey:'source'});
  await service.createCase(space.id,{id:'probe',title:'SIWC storage probe',objective:'Read the bound source using its tool, summarize in one sentence, persist observed output.',constraints:['No web tools','No publication','No hidden reasoning requested']});
  const manifest=await service.freezeInputs(space.id,'probe',{source:source.id});
  const runner=new SiwcResponsesRunner({auth:new SiwcAuth(),maxTurns:2,maxToolCalls:1,tools:async request=>{
    const context=(await service.runtimeContexts(space.id,request.runId)).find(c=>c.attemptId===request.attemptId);
    if(!context) throw new Error('Harness context missing');
    return nodeReadTools(await service.nodeClient(space.id,context.id));
  }});
  const runtime=await createSpaceRuntime(service,space.id,{workflowVersionId:'probe-v1',entrypoint:'probe',inputManifestId:manifest.id},{underlyingRunner:runner,
    resolveAgent:()=>({nodeId:'writer',inputs:{source:source.id},instructions:'Read the source tool and summarize.'}),
    resolvePublication:async(artifact,api)=>({nodeId:'writer',inputs:{source:source.id},outputSlot:'report',generatedByContextId:(await api.contexts(artifact.producedBy.workflowRunId)).find(c=>c.producer==='agent')?.id}),
  });
  const agent=defineAgent({id:'writer',revision:'1',model:process.env.WORKFLOW_SIWC_MODEL,reasoningEffort:'low',promptRevision:'1',skillsRevision:'1',permissionsRevision:'read-bound-source-v1',config:{outputFormat:'json',instructions:'You must call read_bound_asset with slot source once before answering. Then return only a JSON object with one answer string containing a concise one-sentence paraphrase of the source. No other tools, output or reasoning.'}});
  const workflow={id:'space.siwc-probe',revision:'1',execute:async ctx=>{const value=await ctx.agent('write',agent,'Use the bound source slot.');return ctx.publish('report','probe/report',value,{validation:'valid'});}};
  const result=await runWorkflow({workflow,input:{requestId:randomUUID()},...runtime,signal:AbortSignal.timeout(90_000)});
  const overview=await service.overview(space.id);
  console.log(JSON.stringify({spaceId:space.id,runId:result.run.id,state:result.run.state,model:process.env.WORKFLOW_SIWC_MODEL,assets:overview.assets.length,sessions:overview.sessions.length,liveModel:true,creativeQualityAccepted:false},null,2));
  if(result.run.state!=='succeeded') process.exitCode=1;
} finally {await pool.end();}
