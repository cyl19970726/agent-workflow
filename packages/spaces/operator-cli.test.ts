import { describe, expect, it, vi } from 'vitest';
import { runOperatorCli } from './operator-cli.js';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

const env = { WORKFLOW_OPERATOR_BASE_URL: 'http://127.0.0.1:4397', WORKFLOW_OPERATOR_SPACE_ID: 'space-a', WORKFLOW_OPERATOR_AUTHORIZATION: 'Bearer private-token' };
const version = { id: 'v1', label: 'Readable label', revision: '1', createdAt: '2026-10-09T00:00:00Z', changeReason: '', predecessorId: null,
  entrypoint: 'main', definitionAvailability: 'recorded', availability: { state: 'available', reason: null }, runCount: 1, caseCount: 1 };
const node = { id: 'writer', versionId: 'v1', label: 'Writer', kind: 'agent', purpose: 'Draft', definitionRecorded: true,
  executor: { family: 'siwc-responses', adapter: null }, model: 'example', tools: ['read'], inputs: [], outputs: [],
  instructions: 'Private prompt text', configuration: { model: 'example', apiKey: 'private-secret', stageDeclaration: { apiKey: 'nested-secret', model: 'safe' } } };

function cli(fetch: typeof globalThis.fetch, args: string[]) {
  const stdout = vi.fn(), stderr = vi.fn();
  return { result: runOperatorCli(args, { fetch, env, stdout, stderr }), stdout, stderr };
}

describe('attachment operator CLI',()=>{
  it('downloads only a bound exact version and verifies bytes before creating the destination',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'attachment-download-cli-'));
    try{
      const bytes=Buffer.from('Synthetic attachment\n'),sha256=createHash('sha256').update(bytes).digest('hex'),destination=join(directory,'download.txt');
      let corrupt=false;
      const fetch=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/content')?
        new Response(corrupt?Buffer.from('Wrong attachment'):bytes,{headers:{'content-type':'text/plain','content-length':String(bytes.length),'x-content-sha256':sha256}}):
        Response.json({assetVersionId:'asset-version-1',assetId:'source-doc',version:1,items:[{id:sha256,sha256,size:bytes.length,mediaType:'text/plain'}]})) as typeof globalThis.fetch;
      const good=cli(fetch,['attachment-download','asset-version-1',sha256,'--out',destination]);expect(await good.result).toBe(0);
      expect(await readFile(destination)).toEqual(bytes);
      const repeat=cli(fetch,['attachment-download','asset-version-1',sha256,'--out',destination]);expect(await repeat.result).toBe(1);
      corrupt=true;const missing=join(directory,'corrupt.txt');
      const bad=cli(fetch,['attachment-download','asset-version-1',sha256,'--out',missing]);expect(await bad.result).toBe(1);
      await expect(readFile(missing)).rejects.toThrow();
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('uploads bounded bytes, checks the returned hash, then imports an explicit asset revision',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'attachment-cli-'));
    try{
      const file=join(directory,'source.txt'),requestFile=join(directory,'import.json'),bytes=Buffer.from('Representative source document\n');
      await writeFile(file,bytes);
      const sha256=createHash('sha256').update(bytes).digest('hex');
      const request={assetId:'source-doc',expectedHead:null,schema:{namespace:'evidence/source',revision:'1',hash:'registered'},payload:{title:'Source'},description:'Imported source',blobIds:[sha256],idempotencyKey:'source-1'};
      await writeFile(requestFile,JSON.stringify(request));
      const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        if(String(input).endsWith('/summary'))return Response.json({capabilities:{attachmentWrite:true},csrfToken:'csrf'});
        if(String(input).endsWith('/attachments/blobs')){
          expect(init).toMatchObject({method:'POST',headers:{'content-type':'text/plain',origin:'http://127.0.0.1:4397','x-space-csrf':'csrf'}});
          expect(Buffer.from(init!.body as Uint8Array)).toEqual(bytes);
          return Response.json({id:sha256,sha256,size:bytes.length,mediaType:'text/plain',key:'private-key'});
        }
        expect(String(input)).toContain('/attachments/imports');expect(JSON.parse(String(init!.body))).toEqual(request);
        return Response.json({assetVersionId:'revision-1',assetId:'source-doc',version:1,payloadHash:'payload-hash',attachments:[{id:sha256,sha256,size:bytes.length,mediaType:'text/plain',key:'private-key'}]});
      }) as typeof globalThis.fetch;
      const uploaded=cli(fetch,['blob-upload','--file',file,'--media-type','text/plain']);expect(await uploaded.result).toBe(0);
      expect(JSON.parse(uploaded.stdout.mock.calls[0]![0])).toEqual({id:sha256,sha256,size:bytes.length,mediaType:'text/plain'});
      const imported=cli(fetch,['asset-import','--file',requestFile]);expect(await imported.result).toBe(0);
      expect(JSON.parse(imported.stdout.mock.calls[0]![0])).toMatchObject({assetVersionId:'revision-1',assetId:'source-doc',attachments:[{id:sha256}]});
      expect(imported.stdout.mock.calls[0]![0]).not.toContain('private-key');
      await writeFile(requestFile,JSON.stringify({...request,expectedHead:undefined}));
      const invalid=cli(fetch,['asset-import','--file',requestFile]);expect(await invalid.result).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(4);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});

describe('read-only operator CLI', () => {
  it('reads a bounded native ledger page without printing unprojected fields',async()=>{
    const fetch=vi.fn(async(input:RequestInfo|URL)=>{
      expect(String(input)).toContain('/runs/run-1/native-events?after=2&limit=1');
      return Response.json({runId:'run-1',executionMode:'external-host',items:[{id:'event-3',seq:3,type:'siwc.transport_error',
        timestamp:'2026-10-14T00:00:00Z',stepRunId:'step-1',attemptId:'attempt-1',turn:5,requestAttempt:2,httpStatus:503,
        transport:{phase:'request',errorName:'FetchError',causeCode:'ECONNRESET',bytesRead:0,retrying:false},response:null,tool:null,
        rawBody:'private-body'}],nextCursor:null,hasMore:false,snapshotAt:'2026-10-14T00:00:00Z',sanitized:true,
        children:[{runId:'child-1',workflowId:'post.review',state:'failed',parentStepRunId:'step-1',binding:'bound'}],secret:'private-secret'});
    }) as typeof globalThis.fetch;
    const call=cli(fetch,['native-events','run-1','--after','2','--limit','1']);
    expect(await call.result).toBe(0);
    expect(JSON.parse(call.stdout.mock.calls[0]![0])).toMatchObject({spaceId:'space-a',runId:'run-1',items:[{turn:5,httpStatus:503}],
      children:[{runId:'child-1',binding:'bound'}]});
    expect(call.stdout.mock.calls[0]![0]).not.toContain('private-');
    expect(await cli(fetch,['native-events','run-1','--limit','101']).result).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('merges paged runtime tool calls by call ID and preserves exact attempt coverage',async()=>{
    const common={runId:'run-1',occurrenceId:'occ-1',versionId:'v1',stepRunId:'step-1',attemptId:'attempt-1',contextId:'context-1',sessionId:'session-1',
      frozenPrompt:'Frozen prompt',frozenPromptCoverage:'full',contextInstructions:'Context prompt',contextInstructionsCoverage:'full',effectiveConfig:{model:'model-1',apiKey:'must-not-print'},snapshotAt:'2026-10-10T00:00:00Z',sanitized:true};
    const fetch=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('after=0')?Response.json({...common,
      events:[{id:'event-1',seq:1,attemptId:'attempt-1',type:'siwc.tool_call',callId:'call-1'}],
      calls:[{callId:'call-1',name:'read_bound_asset',turn:1,callEventId:'event-1',callSeq:1,outcomeEventId:null,outcomeSeq:null,status:'pending-or-later-page'}],
      nextCursor:1,hasMore:true,scanComplete:false,observedCallCount:null}):Response.json({...common,
      events:[{id:'event-2',seq:2,attemptId:'attempt-1',type:'siwc.tool_result',callId:'call-1'}],
      calls:[{callId:'call-1',name:'read_bound_asset',turn:1,callEventId:null,callSeq:null,outcomeEventId:'event-2',outcomeSeq:2,status:'returned'}],
      nextCursor:2,hasMore:false,scanComplete:true,observedCallCount:null})) as typeof globalThis.fetch;
    const call=cli(fetch,['runtime','run-1','occ-1','attempt-1']);
    expect(await call.result).toBe(0);
    const output=JSON.parse(call.stdout.mock.calls[0]![0]);
    expect(output).toMatchObject({scanComplete:true,observedCallCount:1,calls:[{callId:'call-1',callEventId:'event-1',outcomeEventId:'event-2',status:'returned'}]});
    expect(JSON.stringify(output)).not.toContain('must-not-print');
    expect(fetch).toHaveBeenCalledTimes(2);
    const program=cli(vi.fn(async()=>new Response('',{status:409})) as typeof globalThis.fetch,['runtime','run-1','occ-1','program-attempt']);
    expect(await program.result).toBe(1);
    expect(program.stderr.mock.calls[0]![0]).toContain('HTTP 409');
  });
  it('reads review subjects and exact records through allowlisted same-run projections',async()=>{
    const target={runId:'r',occurrenceId:'author',stepRunId:'write',attemptId:'attempt',sessionId:'session',eventId:'event',eventSeq:3,outputHash:'a'.repeat(64)};
    const review={id:'review-1',spaceId:'space-a',runId:'r',assetVersionIds:[],responseTarget:target,standard:{id:'standard',revision:'hash',content:'Frozen standard'},judge:{kind:'human',id:'alice'},evidence:[],answers:{good:'Good',bad:'Bad',improvement:'Revise',unresolved:'Unknown'},createdAt:'2026-10-09T00:00:00Z',apiKey:'private'};
    const disposition={id:'disposition-1',assetId:'run-disposition:r',runId:'r',revision:1,payloadHash:'hash',createdAt:'2026-10-09T00:00:00Z',previousRevisionId:null,recordedBy:'alice',author:{id:'alice',kind:'human'},confirmation:'unconfirmed',reviewIds:['review-1'],action:'revise',reason:'Revise',unknowns:['Audience'],evidenceRefs:[{kind:'response',target,pointer:'/script'}],apiKey:'private'};
    const fetch=vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);
      if(url.includes('/review-subjects'))return Response.json({runId:'r',caseId:'c',versionId:'v',standard:{id:'standard',revision:'hash',content:'Frozen standard'},subjects:[{kind:'response',target,occurrenceLabel:'Author'}],failures:[],apiKey:'private'});
      if(url.includes('/reviews/review-1'))return Response.json(review);
      if(url.includes('/reviews'))return Response.json({items:[review],nextCursor:null});
      if(url.includes('/dispositions/disposition-1'))return Response.json(disposition);
      return Response.json({items:[disposition],nextCursor:null});
    }) as typeof globalThis.fetch;
    for(const args of [['review-subjects','r'],['reviews','r'],['review','r','review-1'],['dispositions','r'],['disposition','r','disposition-1']]){
      const call=cli(fetch,args);expect(await call.result).toBe(0);expect(call.stdout.mock.calls[0]![0]).not.toContain('private');
    }
  });
  it('does not post a human review whose declared judge differs from the authenticated subject',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'review-cli-'));
    try{
      const file=join(directory,'review.json');
      await writeFile(file,JSON.stringify({id:'review-1',runId:'r',judge:{kind:'human',id:'someone-else'}}));
      const fetch=vi.fn(async()=>Response.json({subject:{id:'alice'}})) as typeof globalThis.fetch;
      const call=cli(fetch,['review-save','--file',file]);
      expect(await call.result).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(call.stderr.mock.calls[0]![0]).toContain('authenticated subject');
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('reads a private Agent credential file and receives an exact observation without printing its token',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agent-observation-cli-'));
    try{
      const credential=join(directory,'credential.json'),request=join(directory,'target.json');
      const target={runId:'r',occurrenceId:'author',stepRunId:'write',attemptId:'attempt',sessionId:'producer',eventId:'event',eventSeq:3,outputHash:'a'.repeat(64)};
      await writeFile(credential,JSON.stringify({version:1,spaceId:'space-a',token:'private-agent-token',principal:{id:'service',kind:'service',externalAgent:{id:'reader',sessionId:'agent-session'}}}),{mode:0o600});
      await writeFile(request,JSON.stringify({target}));
      const receipt={id:'receipt-1',assetId:'observation',payloadHash:'hash',createdAt:'2026-10-10T00:00:00Z',target,observer:{id:'reader',sessionId:'agent-session',servicePrincipalId:'service'},delivery:'saved-response-read'};
      const fetch=vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>String(input).endsWith('/summary')?Response.json({capabilities:{observationWrite:true},csrfToken:'csrf'}):Response.json({receipt,response:{publication:'unpublished',coverage:'full',output:'{"script":"saved"}',reading:{title:'Saved response',sections:[],readerStatus:'fallback',reason:'No reader'}}})) as typeof globalThis.fetch;
      const stdout=vi.fn(),stderr=vi.fn();
      expect(await runOperatorCli(['observe-response','--file',request],{fetch,env:{...env,WORKFLOW_OPERATOR_AUTHORIZATION:undefined,WORKFLOW_OPERATOR_TOKEN_FILE:credential},stdout,stderr})).toBe(0);
      expect(fetch.mock.calls[0]![1]).toMatchObject({headers:{authorization:'Bearer private-agent-token'}});
      expect(fetch.mock.calls[1]![1]).toMatchObject({method:'POST',headers:{authorization:'Bearer private-agent-token','x-space-csrf':'csrf',origin:'http://127.0.0.1:4397'}});
      expect(stdout.mock.calls[0]![0]).toContain('receipt-1');
      expect(stdout.mock.calls[0]![0]).not.toContain('private-agent-token');
      expect(stderr).not.toHaveBeenCalled();
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('reads one published asset through its exact Agent receipt and keeps other response fields out',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agent-asset-cli-'));
    try{
      const request=join(directory,'asset-target.json'),target={runId:'r',assetVersionId:'research-1',payloadHash:'a'.repeat(64)};
      await writeFile(request,JSON.stringify({target}));
      const receipt={id:'asset-receipt',assetId:'observation',payloadHash:'receipt-hash',createdAt:'2026-10-10T00:00:00Z',target,
        source:{kind:'node',runId:'r',stepRunId:'research-step',attemptId:'attempt',nodeId:'researcher',producer:'agent',sessionId:'producer',contextId:'context'},
        observer:{id:'reader',sessionId:'agent-session',servicePrincipalId:'service'},producerNativeSessionIds:['native-producer'],delivery:'published-asset-read',apiKey:'private'};
      const fetch=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/summary')?Response.json({capabilities:{observationWrite:true},csrfToken:'csrf'}):
        Response.json({receipt,asset:{target,publication:'published',coverage:'full',payload:'{"body":"Research"}',reading:{title:'Research',sections:[{title:'Body',text:'Research',pointer:'/body'}],readerStatus:'registered',reason:null}},apiKey:'private'})) as typeof globalThis.fetch;
      const call=cli(fetch,['observe-asset','--file',request]);expect(await call.result).toBe(0);
      const printed=call.stdout.mock.calls[0]![0];expect(printed).toContain('Research');expect(printed).toContain('asset-receipt');expect(printed).not.toContain('private');
      expect(fetch.mock.calls[1]![0]).toContain('/runs/r/asset-observations');
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('allows a trusted external Agent to save a single observed asset review',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agent-asset-review-cli-'));
    try{
      const file=join(directory,'review.json'),standard={id:'research-standard',revision:'frozen',content:'Research evidence'},judge={kind:'agent',id:'reader',sessionId:'agent-session'};
      const body={id:'review-research',runId:'r',assetVersionIds:['research-1'],observationReceiptId:'asset-receipt',standard,judge,evidence:[],answers:{good:'Good',bad:'Bad',improvement:'Improve',unresolved:'Unknown'}};
      await writeFile(file,JSON.stringify(body));
      const fetch=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('/summary')?Response.json({subject:{id:'service',kind:'service',externalAgent:{id:'reader',sessionId:'agent-session'}},capabilities:{reviewWrite:true},csrfToken:'csrf'}):Response.json({...body,spaceId:'space-a',createdAt:'2026-10-10T00:00:00Z',apiKey:'private'})) as typeof globalThis.fetch;
      const call=cli(fetch,['review-save','--file',file]);expect(await call.result).toBe(0);
      expect(fetch.mock.calls.at(-1)![0]).toContain('/runs/r/reviews');
      expect(call.stdout.mock.calls[0]![0]).toContain('review-research');
      expect(call.stdout.mock.calls[0]![0]).not.toContain('private');
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('reads every diagnosis field and saves a CAS revision through the safe API',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'diagnosis-cli-'));
    try{
      const file=join(directory,'diagnosis.json'),evidence={kind:'review',reviewId:'review-1'};
      const issue={id:'issue-1',title:'Research issue',expected:'Current source',observed:'Old source',evidenceRefs:[evidence],
        hypotheses:[{id:'hypothesis-1',category:'handoff',explanation:'Context lost',supportRefs:[evidence],counterRefs:[],unknowns:['Cause'],discriminatingCheck:'Inspect trace'}],
        unknowns:['Timing'],decision:{route:'change-method',reason:'Handoff may lose detail'}};
      const candidateDraft={predecessorVersionId:'v',issueIds:['issue-1'],hypothesisIds:['hypothesis-1'],changes:[{target:'author prompt',before:'Brief',after:'Detailed',reason:'Preserve research'}],expectedBenefits:['Fewer omissions'],risks:['More tokens'],validationPlan:'Repeat frozen case',falsificationConditions:['No improvement'],conditions:['Same inputs']};
      const request={runId:'r',reviewIds:['review-1'],dispositionRevisionId:'disposition-1',dispositionPayloadHash:'d'.repeat(64),issues:[issue],candidateDraft,expectedRevisionId:null,idempotencyKey:'diagnose-1'};
      const saved={...request,id:'diagnosis-1',assetId:'run-diagnosis:r',revision:1,payloadHash:'f'.repeat(64),createdAt:'2026-10-10T00:00:00Z',workflowVersionId:'v',previousRevisionId:null,
        author:{id:'alice',kind:'human'},recordedBy:'alice',confirmation:'unconfirmed',candidateStatus:'unregistered-unvalidated-unadopted',apiKey:'private'};
      await writeFile(file,JSON.stringify(request));
      const fetch=vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);
        if(url.endsWith('/summary'))return Response.json({subject:{id:'alice',kind:'human'},capabilities:{diagnosisWrite:true},csrfToken:'csrf'});
        if(url.includes('/diagnoses?'))return Response.json({items:[saved],nextCursor:null});
        return Response.json(saved);
      }) as typeof globalThis.fetch;
      for(const args of [['diagnosis','r'],['diagnoses','r'],['diagnosis','r','diagnosis-1'],['diagnosis-save','--file',file]]){
        const call=cli(fetch,args);expect(await call.result,JSON.stringify(call.stderr.mock.calls)).toBe(0);
        const printed=call.stdout.mock.calls[0]![0];expect(printed).toContain('Context lost');expect(printed).toContain('unregistered-unvalidated-unadopted');expect(printed).not.toContain('private');
      }
      expect(fetch.mock.calls.some(call=>String(call[0]).endsWith('/runs/r/diagnoses')&&call[1]?.method==='POST')).toBe(true);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('rejects an Agent diagnosis save without its authenticated observation',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'diagnosis-agent-cli-'));
    try{
      const file=join(directory,'diagnosis.json');await writeFile(file,JSON.stringify({runId:'r'}));
      const fetch=vi.fn(async()=>Response.json({subject:{id:'service',kind:'service',externalAgent:{id:'reader',sessionId:'agent-session'}},capabilities:{diagnosisWrite:true},csrfToken:'csrf'})) as typeof globalThis.fetch;
      const call=cli(fetch,['diagnosis-save','--file',file]);expect(await call.result).toBe(1);
      expect(call.stderr.mock.calls[0]![0]).toContain('authenticated observation');
      expect(fetch.mock.calls.every(call=>String(call[0]).endsWith('/summary'))).toBe(true);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('shows an absent current diagnosis without inventing a revision',async()=>{
    const fetch=vi.fn(async()=>Response.json(null)) as typeof globalThis.fetch;
    const call=cli(fetch,['diagnosis','r']);expect(await call.result).toBe(0);
    expect(JSON.parse(call.stdout.mock.calls[0]![0])).toEqual({spaceId:'space-a',runId:'r',diagnosis:null});
  });
  it('uses the authenticated safe summary and does not expose CSRF or subject data', async () => {
    const fetch = vi.fn(async () => Response.json({ id: 'space-a', title: 'Content', purpose: 'Create content', methodScope: { workflowId: 'content', entrypoint: 'main', adoptionSlot: 'content' },
      adoptedVersionId: 'v1', defaultVersionId:'v-main', latestVersionId: 'v2', snapshotAt: '2026-10-09', csrfToken: 'private-csrf', subject: { id: 'person' } })) as typeof globalThis.fetch;
    const call = cli(fetch, ['space']);
    expect(await call.result).toBe(0);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4397/api/workflow-spaces/v1/spaces/space-a/summary',
      { method: 'GET', headers: { accept: 'application/json', authorization: 'Bearer private-token' }, redirect: 'error' });
    expect(call.stdout.mock.calls[0]![0]).toContain('Create content');
    expect(JSON.parse(call.stdout.mock.calls[0]![0])).toMatchObject({adoptedVersionId:'v1',defaultVersionId:'v-main',latestVersionId:'v2'});
    expect(call.stdout.mock.calls[0]![0]).not.toMatch(/private-csrf|private-token|person/u);
  });

  it('keeps missing design motive missing and pages exact versions', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('cursor=next')
      ? { items: [{ ...version, id: 'v2', predecessorId: 'v1', changeReason: 'Revise argument' }], nextCursor: null }
      : { items: [version], nextCursor: 'next' })) as typeof globalThis.fetch;
    const call = cli(fetch, ['versions']);
    expect(await call.result).toBe(0);
    const output = JSON.parse(call.stdout.mock.calls[0]![0]) as { versions: typeof version[] };
    expect(output.versions).toHaveLength(2);
    expect(output.versions[0]!.changeReason).toBe('');
    expect(output.versions[1]!.predecessorId).toBe('v1');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('projects exact version adoption and expected assets without arbitrary fields', async () => {
    const fetch = vi.fn(async () => Response.json({ ...version, hash: 'version-hash', purpose: 'Business presentation', adoptionStatus: 'recorded', adoptionSlots: ['content'], nodes: [],
      expectedAssets: { assets: [{ id: 'expected:output:writer:draft', label: 'Draft', source: { kind: 'node-output', nodeId: 'writer', port: 'draft' },
        schema: { namespace: 'draft', revision: '1', hash: 'schema-hash' }, producer: { nodeId: 'writer', port: 'draft' }, consumers: [], resultRoles: ['primary'], purpose: { resultRoles: ['primary'], consumerNodeIds: [] }, missing: [], privateBody: 'secret' }],
        dependencies: [], gaps: [] }, privateKey: 'secret' })) as typeof globalThis.fetch;
    const call = cli(fetch, ['version', 'v1']);
    expect(await call.result).toBe(0);
    const output = JSON.parse(call.stdout.mock.calls[0]![0]) as { hash: string; adoptionStatus: string; adoptionSlots: string[]; expectedAssets: { assets: { schema: { hash: string } }[] } };
    expect(output.hash).toBe('version-hash');
    expect(output.adoptionStatus).toBe('recorded');
    expect(output.adoptionSlots).toEqual(['content']);
    expect(output.expectedAssets.assets).toHaveLength(1);
    expect(output.expectedAssets.assets[0]!.schema.hash).toBe('schema-hash');
    expect(call.stdout.mock.calls[0]![0]).not.toContain('secret');
  });

  it('shows the authorized exact prompt and method fields while withholding unknown configuration', async () => {
    const fetch = vi.fn(async () => Response.json({ ...node, inputs: [{ slot: 'research', label: 'Research', schema: { namespace: 'research', revision: '1', hash: 'schema-hash' },
      optional: false, states: ['ready'], projection: { version: '1', fields: ['summary'] }, requiredInputs: ['source'],
      sources: [{ kind: 'run-input', source: 'brief', port: null, selection: 'frozen-input', when: 'initial-round' }] }] })) as typeof globalThis.fetch;
    const call = cli(fetch, ['node', 'v1', 'writer']);
    expect(await call.result).toBe(0);
    const output = call.stdout.mock.calls[0]![0] as string;
    expect(output).toContain('Private prompt text');
    expect(output).toContain('siwc-responses');
    expect(output).toContain('schema-hash');
    expect(output).toContain('frozen-input');
    expect(output).toContain('initial-round');
    expect(output).not.toMatch(/private-secret|nested-secret|apiKey|private-token/u);
    expect(JSON.parse(output)).toMatchObject({agentDeclaration:null,agentDeclarationCoverage:null});
  });
  it('preserves the authorized Agent tool and output schemas with explicit declaration coverage',async()=>{
    const declaration={reasoningEffort:'high',timeoutMs:900000,maxTurns:4,maxToolCalls:9,outputFormat:'json',
      outputSchema:{type:'object',properties:{draft:{type:'string'}},required:['draft']},
      skills:[{name:'method',sourceRef:'skill://method@v1',revision:'v1'}],
      tools:[{name:'read_bound_asset',description:'Read exact bound input',parameters:{type:'object',properties:{slot:{enum:['materials','opportunity','research']}},required:['slot']},required:['slot'],outputSchema:{type:'object',properties:{text:{type:'string'}}},coverage:'recorded'}],
      permissions:{revision:'read-only-v1',sandboxMode:'read-only',approvalPolicy:'never',webSearchMode:null,conditionalWebSearchMode:null,conditionalPermissionsRevision:null,additionalDirectoryCount:1}};
    for(const coverage of ['full','truncated'] as const){
      const fetch=vi.fn(async()=>Response.json({...node,agentDeclaration:declaration,agentDeclarationCoverage:coverage,unsafeExtra:'private-secret'})) as typeof globalThis.fetch;
      const call=cli(fetch,['node','v1','writer']);expect(await call.result).toBe(0);
      const output=JSON.parse(call.stdout.mock.calls[0]![0]);
      expect(output).toMatchObject({agentDeclarationCoverage:coverage,agentDeclaration:{outputSchema:{required:['draft']},tools:[{parameters:{properties:{slot:{enum:['materials','opportunity','research']}}},outputSchema:{properties:{text:{type:'string'}}},coverage:'recorded'}]}});
      expect(JSON.stringify(output)).not.toContain('private-secret');
    }
    const nonAgent=cli(vi.fn(async()=>Response.json({...node,kind:'decision',agentDeclaration:null,agentDeclarationCoverage:null})) as typeof globalThis.fetch,['node','v1','writer']);
    expect(await nonAgent.result).toBe(0);
    expect(JSON.parse(nonAgent.stdout.mock.calls[0]![0])).toMatchObject({agentDeclaration:null,agentDeclarationCoverage:null});
    const invalid=cli(vi.fn(async()=>Response.json({...node,agentDeclaration:declaration,agentDeclarationCoverage:'unknown'})) as typeof globalThis.fetch,['node','v1','writer']);
    expect(await invalid.result).toBe(1);
  });

  it('does not follow redirects or print API error bodies or credentials', async () => {
    const fetch = vi.fn(async () => new Response('private-token', { status: 401 })) as typeof globalThis.fetch;
    const call = cli(fetch, ['version', 'v1']);
    expect(await call.result).toBe(1);
    expect(call.stdout).not.toHaveBeenCalled();
    expect(call.stderr.mock.calls[0]![0]).toBe('Operator API returned HTTP 401');
  });
});

describe('understanding operator CLI',()=>{
  const revision={id:'rev-1',assetId:'space-business-understanding',revision:1,payloadHash:'hash',createdAt:'2026-10-09T00:00:00Z',previousRevisionId:null,changeReason:'Evidence',title:'Audience',content:'# Audience',sources:[{kind:'document',ref:'docs/a.md',title:'Interview'}],authorship:{kind:'agent',name:'Research'},recordedBy:'alice',confirmation:'unconfirmed'};
  it('reads an exact revision and pages history',async()=>{
    const fetch=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).includes('/revisions?')?{items:[{...revision,apiKey:'secret'}],nextCursor:null}:{...revision,apiKey:'secret'})) as typeof globalThis.fetch;
    const exact=cli(fetch,['understanding','--revision','rev-1']);
    expect(await exact.result).toBe(0);
    expect(fetch.mock.calls[0]![0]).toContain('/understanding?revision=rev-1');
    expect(exact.stdout.mock.calls[0]![0]).not.toContain('secret');
    const history=cli(fetch,['understanding-history']);
    expect(await history.result).toBe(0);
    expect(JSON.parse(history.stdout.mock.calls[0]![0])).toMatchObject({spaceId:'space-a',revisions:[revision]});
    expect(history.stdout.mock.calls[0]![0]).not.toContain('secret');
  });
  it('sends an explicit agent revision with session CSRF and Origin',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'understanding-cli-'));
    try{
      const file=join(directory,'revision.json');
      const payload={expectedRevisionId:null,idempotencyKey:'save-1',title:'Audience',content:'# Audience\n',sources:revision.sources,authorship:revision.authorship,changeReason:'Evidence'};
      await writeFile(file,JSON.stringify(payload));
      let mismatched=false;
      const fetch=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).endsWith('/summary')?{subject:{id:'alice',kind:'human'},capabilities:{understandingWrite:true},csrfToken:'csrf'}:{...revision,content:mismatched?'# Other':payload.content})) as typeof globalThis.fetch;
      const call=cli(fetch,['understanding-save','--file',file]);
      expect(await call.result).toBe(0);
      expect(fetch.mock.calls[1]![1]).toMatchObject({method:'POST',headers:{origin:'http://127.0.0.1:4397','x-space-csrf':'csrf',authorization:'Bearer private-token'}});
      expect(JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body))).toMatchObject(payload);
      mismatched=true;
      const wrongReceipt=cli(fetch,['understanding-save','--file',file]);
      expect(await wrongReceipt.result).toBe(1);
      expect(wrongReceipt.stderr.mock.calls[0]![0]).toBe('Operator API returned a different understanding revision');
      await writeFile(file,JSON.stringify({...payload,authorship:{kind:'human',name:'Alice'}}));
      const rejected=cli(fetch,['understanding-save','--file',file]);
      expect(await rejected.result).toBe(1);
      expect(fetch).toHaveBeenCalledTimes(4);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('checks trusted design Agent authorship before posting an understanding revision',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'understanding-agent-cli-'));
    try{
      const file=join(directory,'revision.json');
      const payload={expectedRevisionId:null,idempotencyKey:'save-agent',title:'Goal',content:'# Goal\n',sources:revision.sources,
        authorship:{kind:'agent',name:'cognition-root',sessionId:'trusted-thread'},changeReason:'Evidence'};
      await writeFile(file,JSON.stringify(payload));
      const summary={subject:{id:'trusted-service',kind:'service',externalAgent:{id:'cognition-root',sessionId:'trusted-thread',role:'design'}},capabilities:{understandingWrite:true},csrfToken:'csrf'};
      const fetch=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).endsWith('/summary')?summary:{...revision,...payload,id:'saved',recordedBy:'trusted-service'})) as typeof globalThis.fetch;
      expect(await cli(fetch,['understanding-save','--file',file]).result).toBe(0);
      await writeFile(file,JSON.stringify({...payload,authorship:{...payload.authorship,sessionId:'forged-thread'}}));
      const forged=cli(fetch,['understanding-save','--file',file]);expect(await forged.result).toBe(1);
      expect(forged.stderr.mock.calls[0]![0]).toContain('authenticated design Agent');
      expect(fetch).toHaveBeenCalledTimes(3);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});

describe('method design operator CLI',()=>{
  const understanding={id:'rev-1',assetId:'space-business-understanding',revision:1,payloadHash:'understanding-hash',createdAt:'2026-10-09T00:00:00Z',previousRevisionId:null,changeReason:'Evidence',title:'Audience',content:'# Audience\n',sources:[{kind:'document',ref:'docs/a.md',title:'Interview'}],authorship:{kind:'agent',name:'Research'},recordedBy:'alice',confirmation:'unconfirmed'};
  const design={...understanding,id:'design-1',assetId:'method-design:content',payloadHash:'design-hash',workflowId:'content',entrypoint:'main',understanding:{revisionId:'rev-1',payloadHash:'understanding-hash'}};
  it('preserves exact capability references and complete private definition bytes',async()=>{
    const withCapability={...design,capability:{revisionId:'cap-1',payloadHash:'cap-hash'}};
    const definition={candidateId:'candidate',designRevisionId:'design-1',version:{entrypoints:{main:{nodeDefinitions:{author:{instructions:'Complete prompt'}}}}},schemas:[{schema:{properties:{answer:{description:'Deep schema'}}}}],diagramUrl:'/diagram'};
    const fetch=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).includes('/definition?')?definition:withCapability)) as typeof globalThis.fetch;
    const read=cli(fetch,['design']);expect(await read.result).toBe(0);
    expect(JSON.parse(read.stdout.mock.calls[0]![0]).capability).toEqual(withCapability.capability);
    const full=cli(fetch,['design-definition','--revision','design-1']);expect(await full.result).toBe(0);
    expect(JSON.parse(full.stdout.mock.calls[0]![0])).toEqual(definition);
  });
  it('saves a complete capability after exact expected-revision and trusted identity preflight',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'method-capability-cli-'));
    try{
      const file=join(directory,'capability.json');
      const authorship={kind:'agent',name:'designer',sessionId:'thread-1'};
      const payload={workflowId:'content',entrypoint:'main',understanding:design.understanding,provider:{id:'provider',contractRevision:'1'},nodes:{author:{instructions:{content:'Full prompt',sha256:'hash'},outputSchema:{content:'{}',sha256:'hash'},model:'model',reasoningEffort:'high'}},validation:{content:'{}',sha256:'hash'},predecessorVersionId:null,changeReason:'New',authorship,expectedRevisionId:null,idempotencyKey:'cap-save'};
      await writeFile(file,JSON.stringify(payload));
      const saved={...payload,id:'cap-1',assetId:'method-capability:content',revision:1,payloadHash:'cap-hash',createdAt:'2026-10-11',previousRevisionId:null,recordedBy:'external-agent:thread-1'};
      let priorRequest:string|null=null,posts=0;
      const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        const url=String(input);
        if(url.endsWith('/summary'))return Response.json({capabilities:{methodCapabilityWrite:true},csrfToken:'csrf',subject:{id:'external-agent:thread-1',kind:'service',externalAgent:{id:'designer',sessionId:'thread-1',role:'design'}}});
        if(init?.method==='POST'){posts++;const request=String(init.body);if(priorRequest&&request!==priorRequest)return new Response('',{status:409});priorRequest=request;return Response.json(saved);}
        throw new Error('Unexpected request');
      }) as typeof globalThis.fetch;
      const result=cli(fetch,['capability-save','--file',file]);expect(await result.result).toBe(0);
      expect(JSON.parse(result.stdout.mock.calls[0]![0]).nodes.author.instructions.content).toBe('Full prompt');
      expect(posts).toBe(1);
      expect(await cli(fetch,['capability-save','--file',file]).result).toBe(0);
      expect(posts).toBe(2);
      await writeFile(file,JSON.stringify({...payload,idempotencyKey:'different'}));
      expect(await cli(fetch,['capability-save','--file',file]).result).toBe(1);
      expect(posts).toBe(3);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('reads current, history and exact frozen basis with allowlisted fields',async()=>{
    const fetch=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).includes('/versions/v1/design')?{design:{...design,apiKey:'secret'},understanding}:String(input).includes('/revisions?')?{items:[design],nextCursor:null}:{...design,apiKey:'secret'})) as typeof globalThis.fetch;
    const current=cli(fetch,['design']);expect(await current.result).toBe(0);expect(current.stdout.mock.calls[0]![0]).not.toContain('secret');
    const history=cli(fetch,['design-history']);expect(await history.result).toBe(0);
    expect(JSON.parse(history.stdout.mock.calls[0]![0])).toMatchObject({revisions:[design]});
    const basis=cli(fetch,['method-basis','v1']);expect(await basis.result).toBe(0);
    expect(JSON.parse(basis.stdout.mock.calls[0]![0])).toMatchObject({versionId:'v1',design,understanding});
  });
  it('saves an agent draft and previews an unavailable exact candidate',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'method-design-cli-'));
    try{
      const file=join(directory,'design.json');
      const payload={expectedRevisionId:null,idempotencyKey:'design-save',workflowId:'content',entrypoint:'main',understanding:design.understanding,title:design.title,content:design.content,sources:design.sources,authorship:design.authorship,changeReason:'Evidence'};
      await writeFile(file,JSON.stringify(payload));
      const preview={versionId:'v1',workflowId:'content',entrypoint:'main',designRevisionId:'design-1',designHash:'design-hash',understandingRevisionId:'rev-1',understandingHash:'understanding-hash',availability:'unavailable',blockers:['No executor']};
      const fetch=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).endsWith('/summary')?{capabilities:{methodDesignWrite:true},csrfToken:'csrf',subject:{id:'alice',kind:'human'}}:String(input).includes('/preview?')?preview:design)) as typeof globalThis.fetch;
      const saved=cli(fetch,['design-save','--file',file]);expect(await saved.result).toBe(0);
      expect(fetch.mock.calls[1]![1]).toMatchObject({method:'POST',headers:{origin:'http://127.0.0.1:4397','x-space-csrf':'csrf'}});
      const shown=cli(fetch,['method-preview','--design','design-1']);expect(await shown.result).toBe(0);
      expect(JSON.parse(shown.stdout.mock.calls[0]![0])).toMatchObject(preview);
      await writeFile(file,JSON.stringify({...payload,authorship:{kind:'human',name:'Alice'}}));
      const refused=cli(fetch,['design-save','--file',file]);expect(await refused.result).toBe(1);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it.each(['available','unknown'] as const)('preserves %s preview availability without implying publication',async availability=>{
    const preview={versionId:'v1',workflowId:'content',entrypoint:'main',designRevisionId:'design-1',designHash:'design-hash',understandingRevisionId:'rev-1',understandingHash:'understanding-hash',availability,blockers:[]};
    const fetch=vi.fn(async()=>Response.json(preview)) as typeof globalThis.fetch;
    const call=cli(fetch,['method-preview','--design','design-1']);
    expect(await call.result).toBe(0);
    expect(JSON.parse(call.stdout.mock.calls[0]![0])).toMatchObject({availability,designRevisionId:'design-1'});
  });
  it('publishes only the previewed candidate identity through an explicit POST',async()=>{
    const fetch=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).endsWith('/summary')?{capabilities:{methodPublish:true},csrfToken:'csrf',subject:{id:'alice',kind:'human'}}:{versionId:'v1',designRevisionId:'design-1',understandingRevisionId:'rev-1'})) as typeof globalThis.fetch;
    const published=cli(fetch,['method-publish','--design','design-1','--expected','v1']);
    expect(await published.result).toBe(0);
    expect(JSON.parse(published.stdout.mock.calls[0]![0])).toEqual({versionId:'v1',designRevisionId:'design-1',understandingRevisionId:'rev-1'});
    expect(JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body))).toEqual({designRevisionId:'design-1',expectedCandidateId:'v1'});
  });
  it('binds Agent method writes to the credential role, identity and exact saved draft',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'agent-design-cli-'));
    try{
      const file=join(directory,'design.json');
      const authorship={kind:'agent',name:'designer',sessionId:'thread-1'};
      const own={...design,recordedBy:'external-agent:thread-1',authorship};
      const payload={expectedRevisionId:null,idempotencyKey:'agent-save',workflowId:'content',entrypoint:'main',
        understanding:design.understanding,title:design.title,content:design.content,sources:design.sources,
        authorship,changeReason:'Evidence'};
      await writeFile(file,JSON.stringify(payload));
      let role:'design'|'observer'='design';let returned=own;let posts=0;
      const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        const url=String(input);
        if(url.endsWith('/summary'))return Response.json({capabilities:{methodDesignWrite:true,methodPublish:true},csrfToken:'csrf',
          subject:{id:'external-agent:thread-1',kind:'service',externalAgent:{id:'designer',sessionId:'thread-1',role}}});
        if(url.includes('/method-design?revision='))return Response.json(returned);
        if(init?.method==='POST'){posts++;return Response.json(url.endsWith('/publications')?
          {versionId:'v1',designRevisionId:'design-1',understandingRevisionId:'rev-1'}:own);}
        throw new Error('Unexpected request');
      }) as typeof globalThis.fetch;
      expect(await cli(fetch,['design-save','--file',file]).result).toBe(0);
      expect(await cli(fetch,['method-publish','--design','design-1','--expected','v1']).result).toBe(0);
      expect(posts).toBe(2);
      returned={...own,recordedBy:'alice'};
      const old=cli(fetch,['method-publish','--design','design-1','--expected','v1']);
      expect(await old.result).toBe(1);expect(posts).toBe(2);
      expect(old.stderr.mock.calls[0]![0]).toContain('does not belong');
      role='observer';
      expect(await cli(fetch,['design-save','--file',file]).result).toBe(1);
      expect(await cli(fetch,['method-publish','--design','design-1','--expected','v1']).result).toBe(1);
      expect(posts).toBe(2);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});

describe('method execution operator CLI',()=>{
  it('reads full status and sends only a strict command with a trusted design Agent credential',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'method-command-cli-'));
    try{
      const file=join(directory,'command.json');
      const body={operation:'release',input:{candidateId:'candidate',validationSha256:'a'.repeat(64)}};
      await writeFile(file,JSON.stringify(body));
      let posts=0;
      const status={stage:'ready',details:{complete:'Full private status'}};
      const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
        const url=String(input);
        if(url.endsWith('/summary'))return Response.json({capabilities:{methodExecutionWrite:true},csrfToken:'csrf',subject:{id:'external-agent:session-1',kind:'service',externalAgent:{id:'designer',sessionId:'session-1',role:'design'}},methodScope:{workflowId:'content',entrypoint:'main'}});
        if(url.endsWith('/method-execution')&&init?.method==='GET')return Response.json(status);
        if(url.endsWith('/method-execution/commands')&&init?.method==='POST'){posts++;expect(JSON.parse(String(init.body))).toEqual(body);return Response.json({receipt:{complete:'Full private receipt'}});}
        throw new Error('Unexpected request');
      }) as typeof globalThis.fetch;
      const state=cli(fetch,['execution-state']);expect(await state.result).toBe(0);
      expect(JSON.parse(state.stdout.mock.calls[0]![0])).toEqual(status);
      const command=cli(fetch,['method-command','--file',file]);expect(await command.result).toBe(0);
      expect(JSON.parse(command.stdout.mock.calls[0]![0])).toEqual({receipt:{complete:'Full private receipt'}});
      expect(posts).toBe(1);
      await writeFile(file,JSON.stringify({...body,process:{nodes:[]}}));
      expect(await cli(fetch,['method-command','--file',file]).result).toBe(1);
      expect(posts).toBe(1);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});

describe('Case evidence operator CLI',()=>{
  const caseValue={id:'case-1',title:'Exact brief',objective:'Answer questions',constraints:['Given materials only'],runCount:2,assetCount:1};
  const imported={id:'material-1',title:'Source',kind:'material',state:'imported',createdAt:'2026-10-09T00:00:00Z',schema:{namespace:'content/material',revision:'1',hash:'schema'},sourceKind:'import',runId:null,caseId:'case-1',versionId:null,nodeId:null,occurrenceId:null,round:null};
  const run={id:'run-1',label:'First run',versionId:'v1',caseId:'case-1',entrypoint:'main',state:'failed',taskState:'failed',reason:'transport closed',progress:null,startedAt:'2026-10-09T00:00:00Z',assetCount:0,draftCount:0,primaryAssetId:null};
  const other={...run,id:'run-2',label:'Second run',state:'queued',taskState:'queued',reason:null};
  const inputs={runId:'run-1',caseId:'case-1',versionId:'v1',inputManifestId:'manifest-1',inputManifestHash:'manifest-hash',slots:[{slot:'material',asset:imported,payloadHash:'payload-hash'}]};
  it('pages every Case run and asset while retaining failed and queued states',async()=>{
    const fetch=vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes('/cases/case-1/runs'))return Response.json(url.includes('cursor=next')?{items:[other],nextCursor:null}:{items:[run],nextCursor:'next'});
      if(url.includes('/assets?caseId='))return Response.json({items:[imported],nextCursor:null});
      return Response.json(caseValue);
    }) as typeof globalThis.fetch;
    const call=cli(fetch,['case','case-1']);expect(await call.result).toBe(0);
    const output=JSON.parse(call.stdout.mock.calls[0]![0]);
    expect(output).toMatchObject({case:caseValue,runs:[{id:'run-1',state:'failed',primaryAssetId:null},{id:'run-2',state:'queued'}],assets:[{id:'material-1',sourceKind:'import'}]});
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('reads a run and exact frozen slot hash without changing its failure state',async()=>{
    const fetch=vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).endsWith('/inputs')?inputs:{...run,inputManifestId:'manifest-1',inputManifestHash:'manifest-hash',configHash:'config',inputAssets:[imported],versionLabel:'1',caseTitle:'Exact brief'})) as typeof globalThis.fetch;
    const call=cli(fetch,['run','run-1']);expect(await call.result).toBe(0);
    const output=JSON.parse(call.stdout.mock.calls[0]![0]);
    expect(output).toMatchObject({id:'run-1',state:'failed',primaryAssetId:null,inputManifest:{inputManifestId:'manifest-1',slots:[{slot:'material',payloadHash:'payload-hash'}]}});
    const mismatch=cli(vi.fn(async(input:RequestInfo|URL)=>Response.json(String(input).endsWith('/inputs')?{...inputs,runId:'wrong'}:run)) as typeof globalThis.fetch,['run-inputs','run-1']);
    expect(await mismatch.result).toBe(1);
  });
  it('reads saved process, occurrence, asset body and paged session events',async()=>{
    const occurrence={id:'occ-1',nodeId:'writer',label:'Writer',round:1,branch:null,route:null,provenance:'observed',state:'failed',terminalFailure:{state:'failed',provenance:'derived',failedAncestorStepId:'phase',failedAncestorStepKey:'draft',error:'citation unresolved'},inputs:[imported],outputs:[],contextIds:['context'],sessionIds:['session'],attemptCount:1,agentAttemptCount:1,technicalStepCount:1,technicalSteps:[{id:'step',key:'write',kind:'agent',state:'failed',error:'transport closed'}],failureDetails:[{id:'step',key:'write',kind:'agent',state:'failed',error:'transport closed'}]};
    const fetch=vi.fn(async(input:RequestInfo|URL)=>{
      const url=String(input);
      if(url.includes('/process'))return Response.json({runId:'run-1',versionId:'v1',caseId:'case-1',contractSource:'method',coverage:'partial',unmappedStepIds:[],nodes:[],occurrences:[occurrence],graphUrl:null});
      if(url.includes('/occurrences/'))return Response.json({...occurrence,runId:'run-1',versionId:'v1',contexts:[
        {id:'context',nodeId:'writer',stepRunId:'step',attemptId:'attempt',producer:'agent',instructions:'Write',model:'gpt-6-luna',reasoningEffort:'high',effectiveConfig:{model:'gpt-6-luna',apiKey:'secret'},sessionId:'session'},
        {id:'publish-context',nodeId:'writer',stepRunId:'publish',attemptId:'publish-attempt',producer:'program',instructions:'Publish writer',model:null,reasoningEffort:null,effectiveConfig:{},sessionId:'publish-session'}]});
      if(url.includes('/reading'))return Response.json({asset:imported,title:'Source',sections:[{title:'Body',text:'Saved source text'}],readerStatus:'registered',sourceLinks:[],payloadHash:'payload-hash',apiKey:'secret'});
      if(url.includes('/relations'))return Response.json({assetId:'material-1',producer:null,dependencies:[],previousDraft:null,assessments:[],consumers:[],reviews:[],nextCursor:null,snapshotAt:'2026-10-09T00:00:00Z'});
      if(url.includes('/events?after=0'))return Response.json({runId:'run-1',sessionId:'session',items:[{id:'event-1',seq:1,attemptId:'attempt',kind:'error',body:{message:'transport closed'},createdAt:'2026-10-09T00:00:00Z'}],nextCursor:1,hasMore:true});
      return Response.json({runId:'run-1',sessionId:'session',items:[{id:'event-2',seq:2,attemptId:'attempt',kind:'trace',body:{message:'retry failed'},createdAt:'2026-10-09T00:00:01Z'}],nextCursor:2,hasMore:false});
    }) as typeof globalThis.fetch;
    const process=cli(fetch,['process','run-1']);expect(await process.result).toBe(0);
    expect(JSON.parse(process.stdout.mock.calls[0]![0])).toMatchObject({coverage:'partial',occurrences:[{id:'occ-1',state:'failed',outputs:[]}]});
    const detail=cli(fetch,['occurrence','run-1','occ-1']);expect(await detail.result).toBe(0);
    expect(JSON.parse(detail.stdout.mock.calls[0]![0])).toMatchObject({terminalFailure:{failedAncestorStepId:'phase',error:'citation unresolved'}});
    expect(JSON.parse(detail.stdout.mock.calls[0]![0]).contexts).toMatchObject([{producer:'agent',attemptId:'attempt'},{producer:'program',attemptId:'publish-attempt',model:null}]);
    expect(detail.stdout.mock.calls[0]![0]).not.toContain('secret');
    const asset=cli(fetch,['asset','material-1']);expect(await asset.result).toBe(0);
    expect(JSON.parse(asset.stdout.mock.calls[0]![0])).toMatchObject({reading:{sections:[{text:'Saved source text'}]},relations:{dependencies:[]}});
    expect(asset.stdout.mock.calls[0]![0]).not.toContain('secret');
    const trace=cli(fetch,['run-trace','run-1','session']);expect(await trace.result).toBe(0);
    expect(JSON.parse(trace.stdout.mock.calls[0]![0])).toMatchObject({events:[{id:'event-1'},{id:'event-2'}],complete:true});
  });
  it('reads only the allowlisted unpublished response and its exact provenance',async()=>{
    const fetch=vi.fn(async()=>Response.json({runId:'run-1',occurrenceId:'occ-1',responses:[{stepRunId:'step',attemptId:'attempt',sessionId:'session',eventId:'event',eventSeq:4586,publication:'unpublished',output:'{"script":{"title":"Saved"}}',coverage:'full',reading:{title:'未发布口播',sections:[{title:'正文',text:'Saved manuscript',view:'evidence',sourceRefs:['material-1','material-2']}],readerStatus:'registered',reason:null,privateKey:'secret'},privateKey:'secret'}],privateKey:'secret'})) as typeof globalThis.fetch;
    const call=cli(fetch,['occurrence-responses','run-1','occ-1']);expect(await call.result).toBe(0);
    const output=JSON.parse(call.stdout.mock.calls[0]![0]);
    expect(output).toMatchObject({runId:'run-1',occurrenceId:'occ-1',responses:[{eventId:'event',eventSeq:4586,publication:'unpublished',coverage:'full',output:'{"script":{"title":"Saved"}}',reading:{readerStatus:'registered',sections:[{text:'Saved manuscript',sourceRefs:['material-1','material-2']}]}}]});
    expect(JSON.stringify(output)).not.toContain('secret');
  });
});
