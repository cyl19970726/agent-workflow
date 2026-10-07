import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSON_SCHEMA_DIALECT, SchemaRegistry, type SchemaRef } from '@signal-room/workflow-space-contracts';
import { validateWorkflowPresentation, type WorkflowPresentationDraft } from './presentation.js';
import { WorkflowSpaceService } from './service.js';
import { PostgresBlobStore } from './blob-store.js';
import { migrateWorkflowSpaces } from './migration.js';

const registry = new SchemaRegistry();
const schema = registry.registerSchema({namespace:'test/presentation',revision:'1',dialect:JSON_SCHEMA_DIALECT,
  schema:{type:'object',properties:{title:{type:'string'},count:{type:'integer'},paragraphs:{type:'array',items:{type:'string'}},
    rows:{type:'array',items:{type:'object',properties:{heading:{type:'string'},body:{type:'string'}}}}}}});
const ref:SchemaRef={namespace:schema.namespace,revision:schema.revision,hash:schema.hash};
const draft=():WorkflowPresentationDraft=>({id:'report',revision:'1',entrypoint:'write',label:'Readable report',
  assetViews:[{schema:ref,label:'Report',titlePath:'/title',sections:[{path:'/paragraphs',label:'Body',component:'paragraphs'},
    {component:'items',path:'/rows',label:'Rows',headingPath:'/heading',fields:[{path:'/body',label:'Text',component:'paragraphs'}]}],
    compare:{fields:['/title','/paragraphs']}}],results:{primary:'final',supporting:[],assessments:[]}});

describe('WorkflowPresentation semantic contract',()=>{
  it('validates exact frozen refs, field paths, components and item-relative pointers',async()=>{
    await expect(validateWorkflowPresentation(draft(),registry)).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(validateWorkflowPresentation({...draft(),assetViews:[{...draft().assetViews[0]!,schema:{...ref,hash:'a'.repeat(64)}}]},registry)).rejects.toThrow('Unknown schema revision');
    await expect(validateWorkflowPresentation({...draft(),assetViews:[{...draft().assetViews[0]!,sections:[{path:'/missing',label:'Missing',component:'paragraphs'}]}]},registry)).rejects.toThrow('does not exist');
    await expect(validateWorkflowPresentation({...draft(),assetViews:[{...draft().assetViews[0]!,sections:[{path:'/count',label:'Count',component:'paragraphs'}]}]},registry)).rejects.toThrow('cannot display');
    await expect(validateWorkflowPresentation({...draft(),assetViews:[{...draft().assetViews[0]!,sections:[{component:'items',path:'/rows',label:'Rows',fields:[{path:'/missing',label:'Missing',component:'paragraphs'}]}]}]},registry)).rejects.toThrow('does not exist');
  });
  it('rejects unregistered readers, executable values and unsupported pointer segments',async()=>{
    const reader={...draft(),assetViews:[{schema:ref,label:'Report',reader:'missing',sections:[]}]};
    await expect(validateWorkflowPresentation(reader,registry)).rejects.toThrow('not deployed');
    await expect(validateWorkflowPresentation(reader,registry,['missing'])).resolves.toMatch(/^[0-9a-f]{64}$/);
    await expect(validateWorkflowPresentation(draft(),registry,[],['another-role'])).rejects.toThrow('result role final is not deployed');
    const code={...draft(),evil:()=>42};
    await expect(validateWorkflowPresentation(code,registry)).rejects.toThrow('only JSON data');
    await expect(validateWorkflowPresentation({...draft(),assetViews:[{...draft().assetViews[0]!,titlePath:'/rows/0/heading'}]},registry)).rejects.toThrow('unsupported field path');
  });
  it('requires a dedicated reader for complex schema paths',async()=>{
    const complex=new SchemaRegistry();
    const frozen=complex.registerSchema({namespace:'test/complex',revision:'1',dialect:JSON_SCHEMA_DIALECT,
      schema:{type:'object',properties:{title:{oneOf:[{type:'string'},{type:'integer'}]}}}});
    const d={...draft(),assetViews:[{schema:{namespace:frozen.namespace,revision:frozen.revision,hash:frozen.hash},label:'Complex',sections:[{path:'/title',label:'Title',component:'paragraphs' as const}]}]};
    await expect(validateWorkflowPresentation(d,complex)).rejects.toThrow('complex schema');
  });
});

const url=process.env.WORKFLOW_TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
suite('WorkflowPresentation persistence',()=>{
  let pool:Pool;
  beforeAll(async()=>{pool=new Pool({connectionString:url!});await migrateWorkflowSpaces(pool);});
  afterAll(async()=>{await pool?.end();});
  it('registers immutable revisions and retains append-only exact workflow bindings without changing workflow hash',async()=>{
    const owner=new WorkflowSpaceService(pool,new PostgresBlobStore(pool),{id:'presentation-owner',kind:'human'},{resultRoleIds:['final']});
    const space=await owner.createSpace({purpose:'Presentation contract test'});
    await owner.registerSchemas(space.id,[{namespace:schema.namespace,revision:schema.revision,dialect:JSON_SCHEMA_DIALECT,schema:schema.schema}]);
    const workflow=await owner.publishWorkflow(space.id,{id:'workflow-v1',revision:'1',changeReason:'Baseline',config:{},entrypoints:{write:{workflowId:'write',codeRevision:'1',storageContract:{workflowVersion:'workflow-v1',nodes:{writer:{actorKinds:['program'],inputs:{},outputs:{},actions:[]}},stateRules:[]}}}});
    const first=await owner.registerPresentation(space.id,draft());
    expect((await owner.registerPresentation(space.id,draft())).hash).toBe(first.hash);
    await expect(owner.registerPresentation(space.id,{...draft(),id:'invented-role',results:{primary:'undeployed',supporting:[],assessments:[]}})).rejects.toThrow('not deployed');
    await expect(owner.registerPresentation(space.id,{...draft(),label:'Changed without revision'})).rejects.toThrow('immutable');
    const second=await owner.registerPresentation(space.id,{...draft(),revision:'2',label:'Improved report'});
    const a=await owner.bindPresentation(space.id,{workflowVersionId:workflow.id,entrypoint:'write',presentationId:first.id,revision:first.revision});
    const b=await owner.bindPresentation(space.id,{workflowVersionId:workflow.id,entrypoint:'write',presentationId:second.id,revision:second.revision});
    const resolved=await owner.resolvePresentation(space.id,workflow.id,'write');
    expect(resolved?.presentation.hash).toBe(second.hash);
    expect(resolved?.history.map(x=>x.id)).toEqual([a.id,b.id]);
    expect((await pool.query<{hash:string}>('SELECT hash FROM ws_workflows WHERE space_id=$1 AND id=$2',[space.id,workflow.id])).rows[0]?.hash).toBe(workflow.hash);
    await expect(owner.bindPresentation(space.id,{workflowVersionId:workflow.id,entrypoint:'missing',presentationId:first.id,revision:first.revision})).rejects.toThrow('Unknown workflow entrypoint');
    const viewer=new WorkflowSpaceService(pool,new PostgresBlobStore(pool),{id:'presentation-viewer',kind:'human'});
    await owner.grant(space.id,'presentation-viewer','viewer');
    expect((await viewer.resolvePresentation(space.id,workflow.id,'write'))?.binding.id).toBe(b.id);
    await expect(viewer.bindPresentation(space.id,{workflowVersionId:workflow.id,entrypoint:'write',presentationId:first.id,revision:first.revision})).rejects.toThrow('denied');
    await owner.createCase(space.id,{id:'case',title:'Presentation case',objective:'Read the evidence',constraints:[]});
    const asset=await owner.importAsset(space.id,{schema:ref,payload:{title:'Evidence'},description:'Test input',idempotencyKey:'input'});
    const manifest=await owner.freezeInputs(space.id,'case',{input:asset.id});
    const run=await owner.startRun(space.id,{workflowVersionId:workflow.id,entrypoint:'write',inputManifestId:manifest.id,idempotencyKey:'run'});
    const evidence=await viewer.runtimeEvidence(space.id);
    expect((await evidence.getRun(run.runId))?.id).toBe(run.runId);
    expect(await evidence.listSteps(run.runId)).toEqual([]);
    expect('createRun' in evidence).toBe(false);
    expect('updateRun' in evidence).toBe(false);
    await expect(evidence.getRun('another-space-run')).rejects.toThrow('not found');
    await expect(viewer.runtimeEvidence('another-space')).rejects.toThrow('denied');
  });
});

describe('bounded comparison descriptors',()=>{
  it('accepts labelled fields and item-relative paragraph/item layouts',async()=>{
    const value=draft();value.assetViews[0]!.compare={fields:['/title','/rows'],labels:{'/title':'标题','/rows':'正文'},sections:[{path:'/rows',label:'连续说明',kind:'paragraphs',fields:['/body']},{path:'/rows',label:'逐条说明',kind:'items',fields:['/heading','/body'],labels:{'/heading':'题目','/body':'正文'}}]};
    await expect(validateWorkflowPresentation(value,registry)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects undeclared labels, arbitrary executable expressions and object projections',async()=>{
    const withCompare=(compare:unknown)=>({...draft(),assetViews:[{...draft().assetViews[0]!,compare}]}) as WorkflowPresentationDraft;
    await expect(validateWorkflowPresentation(withCompare({fields:['/title'],labels:{'/missing':'不存在'}}),registry)).rejects.toThrow('undeclared field');
    await expect(validateWorkflowPresentation(withCompare({fields:['/title'],sections:[{path:'/rows',label:'正文',kind:'items',fields:['/missing']}]}),registry)).rejects.toThrow('does not exist');
    await expect(validateWorkflowPresentation(withCompare({fields:['/title'],sections:[{path:'/rows',label:'正文',kind:'paragraphs'}]}),registry)).rejects.toThrow('string items');
    await expect(validateWorkflowPresentation(withCompare({fields:['/title'],sections:[{path:'/rows',label:'正文',kind:'items',fields:['/body'],expression:'item.body'}]}),registry)).rejects.toThrow('unsupported property');
    await expect(validateWorkflowPresentation(withCompare({fields:['/title'],sections:[{path:'/rows',label:'正文',kind:'items',fields:['/0/body']}]}),registry)).rejects.toThrow('unsupported field path');
  });
});
