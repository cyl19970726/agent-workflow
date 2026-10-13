import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {runOperatorCli} from './operator-cli.js';

const env={WORKFLOW_OPERATOR_BASE_URL:'http://127.0.0.1:4400',WORKFLOW_OPERATOR_SPACE_ID:'s',WORKFLOW_OPERATOR_AUTHORIZATION:'Bearer synthetic-private-token'};
const summary={id:'s',methodScope:{workflowId:'content',entrypoint:'main'},
  subject:{kind:'service',id:'external-agent:thread',externalAgent:{id:'designer',sessionId:'thread',role:'design'}},
  capabilities:{methodCapabilityWrite:true,methodDesignWrite:true},csrfToken:'synthetic-csrf-secret'};
const understanding={id:'u',assetId:'space-business-understanding',payloadHash:'u-hash'};
const capability={id:'cap',workflowId:'content',entrypoint:'main',payloadHash:'cap-hash',understanding:{revisionId:'u',payloadHash:'u-hash'}};
const authoredCapability={provider:{id:'provider',contractRevision:'1'},nodes:{research:{instructions:'  原文\n',outputSchema:{content:'{"type":"object"}'},model:'model',reasoningEffort:'high'}},validation:'{"checks":[]}',predecessorVersionId:null,changeReason:'Fixture preparation'};
const authoredDesign={title:'Design',content:'# Actual design\n',sources:[{kind:'document',ref:'docs/source.md',title:'Source'}],changeReason:'Fixture preparation'};
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function files(input:unknown){
  const directory=await mkdtemp(join(tmpdir(),'operator-cli-usability-'));directories.push(directory);
  const authored=join(directory,'authored.json'),ready=join(directory,'ready.json');
  await writeFile(authored,JSON.stringify(input));return {authored,ready};
}
function cli(fetch:typeof globalThis.fetch,args:string[]){
  const stdout=vi.fn(),stderr=vi.fn();
  return {result:runOperatorCli(args,{fetch,env,stdout,stderr}),stdout,stderr};
}
function preparationApi(kind:'capability'|'design'){
  let head:string|null=null;const bodies:unknown[]=[];
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(String(input)),path=url.pathname.replace('/api/workflow-spaces/v1/spaces/s','')+url.search;
    if(path==='/summary')return Response.json(summary);
    if(path==='/understanding'||path==='/understanding?revision=u')return Response.json(understanding);
    if(path==='/understanding?revision=old-u')return Response.json({...understanding,id:'old-u',payloadHash:'old-hash'});
    if(path==='/versions/prior')return Response.json({id:'prior',entrypoint:'main',label:'Prior'});
    if(path===`/method-${kind}`)return head?Response.json({id:head,workflowId:'content',entrypoint:'main'}):new Response('private error body',{status:404});
    if(path==='/method-capability'||path==='/method-capability?revision=cap')return Response.json(capability);
    if(path===`/method-${kind}/revisions`&&init?.method==='POST'){
      const body=JSON.parse(String(init.body));bodies.push(body);
      return Response.json({...body,id:'saved',assetId:`method-${kind}:content`,revision:1,payloadHash:'saved-hash',createdAt:'2026-10-12T00:00:00Z',
        previousRevisionId:body.expectedRevisionId,recordedBy:summary.subject.id,confirmation:'unconfirmed'});
    }
    throw Error('Unexpected fixture request');
  }) as typeof globalThis.fetch;
  return {fetch,bodies,advance:()=>{head='advanced';}};
}

const asset=(id:string,sourceKind:'import'|'node'='node')=>({id,title:id,kind:'draft',state:'candidate',createdAt:'now',schema:{namespace:'draft',revision:'1',hash:'schema'},sourceKind,
  runId:sourceKind==='node'?'r':null,versionId:sourceKind==='node'?'v':null,caseId:'c',nodeId:sourceKind==='node'?'research':null,occurrenceId:sourceKind==='node'?'o':null,round:null});
const run={id:'r',label:'Trial',versionId:'v',caseId:'c',entrypoint:'main',executionMode:'research-trial',state:'completed',taskState:'completed',reason:null,progress:null,startedAt:null,
  assetCount:1,draftCount:0,primaryAssetId:'result',inputManifestId:'m',inputManifestHash:'m-hash',configHash:'config-hash',inputAssets:[asset('input','import')],versionLabel:'1',caseTitle:'Case'};
const inputs={runId:'r',versionId:'v',caseId:'c',inputManifestId:'m',inputManifestHash:'m-hash',slots:[{slot:'material',asset:asset('input','import'),payloadHash:'input-hash'}]};
const occurrence={id:'o',nodeId:'research',label:'Research',round:null,branch:null,route:null,provenance:'observed',state:'completed',terminalFailure:null,
  inputs:[asset('input','import')],outputs:[asset('result')],contextIds:['agent','retry','program'],sessionIds:['agent','retry','program'],attemptCount:3,agentAttemptCount:2,
  technicalStepCount:3,technicalSteps:[{id:'step',key:'research',kind:'agent',state:'completed',error:null}],failureDetails:[]};
const process={runId:'r',versionId:'v',caseId:'c',contractSource:'method',coverage:'partial',unmappedStepIds:['unmapped-1','unmapped-2'],nodes:[],occurrences:[occurrence],graphUrl:null};
const context=(attemptId:string,producer:'agent'|'program')=>({id:attemptId,nodeId:'research',stepRunId:attemptId,attemptId,producer,sessionId:attemptId,
  instructions:'synthetic-private-prompt',model:producer==='agent'?'model':null,reasoningEffort:null,effectiveConfig:{apiKey:'synthetic-private-config'}});
function evidenceApi(changes:Record<string,unknown>={},failures:Record<string,number>={}){
  const values:Record<string,unknown>={'/summary':summary,'/runs/r':run,'/runs/r/inputs':inputs,'/runs/r/process':process,
    '/runs/r/occurrences/o':{...occurrence,runId:'r',versionId:'v',contexts:[context('agent','agent'),context('retry','agent'),context('program','program')]},
    '/runs/r/occurrences/o/runtime?attemptId=agent&after=0&limit=100':{runId:'r',versionId:'v',occurrenceId:'o',attemptId:'agent',stepRunId:'agent',contextId:'agent',sessionId:'agent',sanitized:true,nextCursor:1,hasMore:true,scanComplete:false,events:[{attemptId:'agent',body:'synthetic-private-event'}],calls:[]},
    '/runs/r/sessions/agent/events?after=0&limit=1':{runId:'r',sessionId:'agent',nextCursor:1,hasMore:true,items:[{attemptId:'agent',body:'synthetic-private-trace'}]},
    '/runs/r/sessions/retry/events?after=0&limit=1':{runId:'r',sessionId:'retry',nextCursor:0,hasMore:false,items:[]},...changes};
  const fetch=vi.fn(async(input:RequestInfo|URL)=>{
    const url=new URL(String(input)),path=url.pathname.replace('/api/workflow-spaces/v1/spaces/s','')+url.search;
    if(path in failures)return new Response('synthetic-private-error',{status:failures[path]});
    if(!(path in values))throw Error('Unexpected fixture request');return Response.json(values[path]);
  }) as typeof globalThis.fetch;
  return fetch;
}

describe('operator usability command integration',()=>{
  it('prepares a private first capability against a real 404 head, preserves old refs, then feeds the unchanged request to the old save',async()=>{
    const file=await files({...authoredCapability,understanding:{revisionId:'old-u'},predecessorVersionId:'prior'}),api=preparationApi('capability');
    const prepared=cli(api.fetch,['capability-prepare','--file',file.authored,'--out',file.ready]);expect(await prepared.result).toBe(0);
    const original=await readFile(file.ready,'utf8'),body=JSON.parse(original);
    expect(body).toMatchObject({expectedRevisionId:null,workflowId:'content',entrypoint:'main',understanding:{revisionId:'old-u',payloadHash:'old-hash'},predecessorVersionId:'prior',authorship:{name:'designer',sessionId:'thread'}});
    expect(body.nodes.research.instructions).toEqual({content:'  原文\n',sha256:createHash('sha256').update('  原文\n','utf8').digest('hex')});
    expect((await lstat(file.ready)).mode&0o777).toBe(0o600);
    expect(api.fetch.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
    const review=JSON.parse(prepared.stdout.mock.calls[0]![0]);expect(review).toMatchObject({operation:'prepared',requestFile:file.ready,expectedRevisionId:null});
    expect(JSON.stringify(review)).not.toContain('原文');expect(original+JSON.stringify(review)).not.toContain('synthetic-private-token');expect(original+JSON.stringify(review)).not.toContain('synthetic-csrf-secret');
    const recheck=cli(api.fetch,['capability-prepare','--file',file.ready]);expect(await recheck.result).toBe(0);expect(await readFile(file.ready,'utf8')).toBe(original);
    const saved=cli(api.fetch,['capability-save','--file',file.ready]);expect(await saved.result).toBe(0);expect(api.bodies).toEqual([body]);
    api.advance();const conflict=cli(api.fetch,['capability-prepare','--file',file.ready]);expect(await conflict.result).toBe(1);expect(conflict.stderr.mock.calls[0]![0]).toContain('head conflict');expect(await readFile(file.ready,'utf8')).toBe(original);
  });
  it('prepares a first design, freezes its current capability basis, and uses the unchanged old design-save contract',async()=>{
    const file=await files(authoredDesign),api=preparationApi('design');
    const prepared=cli(api.fetch,['design-prepare','--file',file.authored,'--out',file.ready]);expect(await prepared.result).toBe(0);
    const body=JSON.parse(await readFile(file.ready,'utf8'));
    expect(body).toMatchObject({expectedRevisionId:null,capability:{revisionId:'cap',payloadHash:'cap-hash'},sources:authoredDesign.sources});
    expect(api.fetch.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
    const saved=cli(api.fetch,['design-save','--file',file.ready]);expect(await saved.result).toBe(0);expect(api.bodies).toEqual([body]);
    const overwrite=cli(api.fetch,['design-prepare','--file',file.authored,'--out',file.ready]);expect(await overwrite.result).toBe(1);expect(overwrite.stderr.mock.calls[0]![0]).toContain('already exists');
  });
  it('reports safe HTTP errors without copying response bodies or authentication',async()=>{
    const file=await files(authoredCapability),fetch=vi.fn(async()=>new Response('synthetic-private-token synthetic-csrf-secret',{status:403})) as typeof globalThis.fetch;
    const call=cli(fetch,['capability-prepare','--file',file.authored,'--out',file.ready]);expect(await call.result).toBe(1);
    expect(call.stderr.mock.calls[0]![0]).toContain('HTTP 403');expect(call.stderr.mock.calls[0]![0]).not.toContain('synthetic');expect(call.stdout).not.toHaveBeenCalled();
    await expect(readFile(file.ready)).rejects.toThrow();
  });
  it('delivers an overview using exactly four GETs and the same run/input/process facts as existing commands',async()=>{
    const fetch=evidenceApi(),call=cli(fetch,['run-evidence','r']);expect(await call.result).toBe(0);
    const output=JSON.parse(call.stdout.mock.calls[0]![0]);
    expect(fetch).toHaveBeenCalledTimes(4);expect(fetch.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
    expect(output).toMatchObject({run:{id:'r',executionMode:'research-trial',state:'completed'},inputManifest:{id:'m',hash:'m-hash'},
      process:{coverage:'partial',unmappedStepIds:['unmapped-1','unmapped-2']},occurrences:[{id:'o',attemptCount:3,attempts:null,runtime:null,trace:null}],coverage:{state:'partial',occurrenceDetail:'not-loaded'}});
    const oldRun=cli(fetch,['run','r']),oldProcess=cli(fetch,['process','r']);expect(await oldRun.result).toBe(0);expect(await oldProcess.result).toBe(0);
    const {spaceId:oldSpace,inputManifest:oldInputs,...oldRunDetail}=JSON.parse(oldRun.stdout.mock.calls[0]![0]);
    expect(oldSpace).toBe('s');expect(output.run).toEqual(oldRunDetail);
    expect(output.inputManifest.slots.map(({read,...slot}:Record<string,unknown>)=>slot)).toEqual(oldInputs.slots);
    expect(output.inputManifest.slots[0].read.asset).toEqual(['workflow-space-operator','asset','input']);
    expect(output.occurrences[0]).toMatchObject({agentAttemptCount:2,technicalStepCount:3,
      read:{evidence:['workflow-space-operator','run-evidence','r','--occurrence','o']},outputs:[{read:{asset:['workflow-space-operator','asset','result']}}]});
    expect(output.read).toMatchObject({reviews:['workflow-space-operator','reviews','r'],diagnosis:['workflow-space-operator','diagnosis','r']});
    expect(output.process.unmappedStepIds).toEqual(JSON.parse(oldProcess.stdout.mock.calls[0]![0]).unmappedStepIds);
    expect(JSON.stringify(output)).not.toContain('synthetic-private');expect(JSON.stringify(output)).not.toContain('synthetic-csrf-secret');
  });
  it('accepts bounded selected detail options, isolates attempts and exposes preview, cap and partial read failures',async()=>{
    const fetch=evidenceApi({}, {'/runs/r/occurrences/o/runtime?attemptId=retry&after=0&limit=100':500});
    const call=cli(fetch,['run-evidence','r','--occurrence','o','--max-pages','1','--max-occurrences','2']);expect(await call.result).toBe(0);
    const output=JSON.parse(call.stdout.mock.calls[0]![0]);
    expect(output.occurrences[0].attempts).toMatchObject([{attemptId:'agent',producer:'agent',runtime:{state:'truncated'},trace:{state:'preview',sampledEvents:1,scanComplete:false}},
      {attemptId:'retry',runtime:{state:'unavailable',httpStatus:500},trace:{state:'missing'}},{attemptId:'program',producer:'program',runtime:{state:'not-applicable'}}]);
    expect(output.coverage.state).toBe('partial');expect(JSON.stringify(output)).not.toContain('synthetic-private');
    expect(fetch.mock.calls.every(([,init])=>init?.method==='GET')).toBe(true);
  });
  it('rejects unrelated run identities and ambiguous or invalid options before reading',async()=>{
    const wrong=cli(evidenceApi({'/runs/r/inputs':{...inputs,versionId:'other'}}),['run-evidence','r']);expect(await wrong.result).toBe(1);expect(wrong.stdout).not.toHaveBeenCalled();
    for(const args of [['run-evidence','r','--max-pages','11'],['run-evidence','r','--max-pages','1','--max-pages','2'],['run-evidence','r','--occurrence'],['design-prepare','--file','/absolute/input','--out']]){
      const fetch=vi.fn() as typeof globalThis.fetch;expect(await cli(fetch,args).result).toBe(1);expect(fetch).not.toHaveBeenCalled();
    }
  });
  it.each([undefined,null,'research-trial','future-host-mode'])('preserves recorded optional executionMode %s without inferring from state',async mode=>{
    const fetch=evidenceApi({'/runs/r':{...run,executionMode:mode}}),call=cli(fetch,['run','r']);expect(await call.result).toBe(0);
    expect(JSON.parse(call.stdout.mock.calls[0]![0]).executionMode).toBe(mode??null);
  });
});
