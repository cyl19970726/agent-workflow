import {describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runOperatorCli} from './operator-cli.js';

const request={id:'space-a',purpose:'Design purpose',scope:{workflowId:'workflow',entrypoint:'entry'},idempotencyKey:'create-once'};
const agent={id:'designer',sessionId:'session-1',role:'design'};
const subject={id:'external-agent:session-1',kind:'service',cacheScope:'private-cache',externalAgent:agent};
const counts={workflowVersions:0,understandingRevisions:0,methodDesignRevisions:0,cases:0,runs:0,businessAssets:0,assetVersions:0,adoptions:0};
const receipt={space:{id:'space-a',purpose:'Design purpose',owner:'owner',status:'active',createdAt:'2026-10-11T00:00:00Z'},scope:request.scope,
  createdBy:{agentId:'designer',sessionId:'session-1',principalId:subject.id},initialCounts:counts};
const env={WORKFLOW_OPERATOR_BASE_URL:'http://127.0.0.1:4397',WORKFLOW_OPERATOR_SPACE_ID:'space-a',WORKFLOW_OPERATOR_AUTHORIZATION:'Bearer private-token'};
async function setup(body:unknown=request){
  const dir=await mkdtemp(join(tmpdir(),'provision-cli-')),file=join(dir,'request.json');
  await writeFile(file,JSON.stringify(body));
  return {file,close:()=>rm(dir,{recursive:true,force:true})};
}
function mock(onboarding:unknown={subject,canCreateSpace:true,allowedSpaceIds:['space-a'],spaces:[],csrfToken:'csrf'},result:unknown=receipt){
  return vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    expect(url).not.toContain('/summary');
    if(url.endsWith('/onboarding'))return Response.json(onboarding);
    expect(url).toBe('http://127.0.0.1:4397/api/workflow-spaces/v1/spaces');
    expect(init).toMatchObject({method:'POST',headers:{origin:'http://127.0.0.1:4397','x-space-csrf':'csrf',authorization:'Bearer private-token'}});
    expect(JSON.parse(String(init!.body))).toEqual(request);
    return Response.json(result,{status:201});
  }) as typeof globalThis.fetch;
}
async function call(file:string,fetch:typeof globalThis.fetch,environment=env){
  const stdout=vi.fn(),stderr=vi.fn();
  const code=await runOperatorCli(['space-create','--file',file],{fetch,env:environment,stdout,stderr});
  return {code,stdout,stderr};
}
describe('empty design Space operator',()=>{
  it('reads a scoped onboarding catalog without leaking CSRF or host-only fields',async()=>{
    const fetch=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(url)).toBe('http://127.0.0.1:4397/api/workflow-spaces/v1/onboarding');
      expect(init).toMatchObject({method:'GET',redirect:'error'});
      return Response.json({subject:{...subject,token:'hidden'},canCreateSpace:true,allowedSpaceIds:['space-a'],csrfToken:'private-csrf',
        spaces:[{id:'space-a',purpose:'Design purpose',designScope:request.scope,businessState:{...counts,understandingRevisionId:null},privateData:'hidden'}]});
    }) as typeof globalThis.fetch;
    const stdout=vi.fn(),stderr=vi.fn();
    expect(await runOperatorCli(['onboarding'],{fetch,env,stdout,stderr})).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual({subject,canCreateSpace:true,allowedSpaceIds:['space-a'],
      spaces:[{id:'space-a',purpose:'Design purpose',scope:request.scope,businessState:{...counts,understandingRevisionId:null}}]});
    expect(stdout.mock.calls[0]![0]).not.toContain('private-csrf');
    expect(stdout.mock.calls[0]![0]).not.toContain('hidden');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects an onboarding response with a target or catalog outside host scope',async()=>{
    for(const data of [
      {subject,canCreateSpace:true,allowedSpaceIds:['other'],spaces:[],csrfToken:'csrf'},
      {subject,canCreateSpace:true,allowedSpaceIds:['space-a'],spaces:[{id:'other',purpose:'Other'}],csrfToken:'csrf'}]){
      const fetch=vi.fn(async()=>Response.json(data)) as typeof globalThis.fetch;
      const stdout=vi.fn(),stderr=vi.fn();
      expect(await runOperatorCli(['onboarding'],{fetch,env,stdout,stderr})).toBe(1);
      expect(stdout).not.toHaveBeenCalled();
    }
  });
  it('creates through onboarding before any Space summary exists and prints a safe exact receipt',async()=>{
    const input=await setup();try{
      const fetch=mock();const result=await call(input.file,fetch);
      expect(result.code).toBe(0);expect(fetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(result.stdout.mock.calls[0]![0])).toEqual(receipt);
      expect(result.stdout.mock.calls[0]![0]).not.toContain('private-token');
    }finally{await input.close();}
  });
  it('normalizes purpose whitespace to match the host schema and receipt',async()=>{
    const input=await setup({...request,purpose:'  Design purpose  '});try{
      const fetch=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
        if(String(url).endsWith('/onboarding'))return Response.json({subject,canCreateSpace:true,allowedSpaceIds:['space-a'],spaces:[],csrfToken:'csrf'});
        expect(JSON.parse(String(init!.body))).toEqual(request);
        return Response.json(receipt,{status:201});
      }) as typeof globalThis.fetch;
      const result=await call(input.file,fetch);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.mock.calls[0]![0])).toEqual(receipt);
    }finally{await input.close();}
  });
  it('rejects observer, unauthenticated, and disallowed host scope before POST',async()=>{
    const input=await setup();try{
      for(const onboarding of [
        {subject:{...subject,externalAgent:{...agent,role:'observer'}},canCreateSpace:false,allowedSpaceIds:['space-a'],csrfToken:'csrf'},
        {subject,canCreateSpace:true,allowedSpaceIds:['other-space'],csrfToken:'csrf'}]){
        const fetch=mock(onboarding);expect((await call(input.file,fetch)).code).toBe(1);expect(fetch).toHaveBeenCalledTimes(1);
      }
      const fetch=vi.fn(async()=>new Response('',{status:401})) as typeof globalThis.fetch;
      expect((await call(input.file,fetch)).code).toBe(1);expect(fetch).toHaveBeenCalledTimes(1);
    }finally{await input.close();}
  });
  it('rejects request and receipt scope or identity mismatch',async()=>{
    const mismatch=await setup({...request,id:'other-space'});try{const fetch=mock();expect((await call(mismatch.file,fetch)).code).toBe(1);expect(fetch).not.toHaveBeenCalled();}finally{await mismatch.close();}
    const input=await setup();try{
      for(const changed of [{...receipt,scope:{...request.scope,workflowId:'other'}},{...receipt,createdBy:{...receipt.createdBy,agentId:'other'}},{...receipt,initialCounts:{...counts,runs:1}}]){
        const result=await call(input.file,mock(undefined,changed));expect(result.code).toBe(1);expect(result.stdout).not.toHaveBeenCalled();
      }
    }finally{await input.close();}
  });
  it('accepts a private v2 credential scoped to the target Space',async()=>{
    const input=await setup();try{
      const credential=join(input.file,'../credential.json');
      await writeFile(credential,JSON.stringify({version:2,spaceIds:['space-a'],token:'v'.repeat(32),principal:{id:subject.id,kind:'service',externalAgent:agent}}),{mode:0o600});
      const fetch=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
        expect((init?.headers as Record<string,string>).authorization).toBe(`Bearer ${'v'.repeat(32)}`);
        return String(url).endsWith('/onboarding')?Response.json({subject,canCreateSpace:true,allowedSpaceIds:['space-a'],spaces:[],csrfToken:'csrf'}):Response.json(receipt,{status:201});
      }) as typeof globalThis.fetch;
      const result=await call(input.file,fetch,{...env,WORKFLOW_OPERATOR_AUTHORIZATION:undefined,WORKFLOW_OPERATOR_TOKEN_FILE:credential});
      expect(result.code).toBe(0);expect(result.stdout.mock.calls[0]![0]).not.toContain('vvvv');
    }finally{await input.close();}
  });
  it('includes the exact optional business counters in Space reading',async()=>{
    const fetch=vi.fn(async()=>Response.json({id:'space-a',title:'Design purpose',purpose:'Design purpose',methodScope:{workflowId:'workflow',entrypoint:'entry',adoptionSlot:null},
      adoptedVersionId:null,latestVersionId:null,snapshotAt:'2026-10-11T00:00:00Z',businessState:{...counts,understandingRevisionId:null}})) as typeof globalThis.fetch;
    const stdout=vi.fn(),stderr=vi.fn();
    expect(await runOperatorCli(['space'],{fetch,env,stdout,stderr})).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0]![0]).businessState).toEqual({...counts,understandingRevisionId:null});
  });
});
