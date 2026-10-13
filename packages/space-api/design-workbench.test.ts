import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {WorkflowSpaceService,SpacePrincipal,WorkflowSpace} from '@signal-room/workflow-spaces';
import {createDesignWorkbench,type DesignWorkbenchOptions} from './design-workbench.js';

const owner:SpacePrincipal={id:'owner',kind:'human'};
const designer:SpacePrincipal={id:'designer',kind:'service',externalAgent:{id:'design-agent',sessionId:'session-1',role:'design'}};
const observer:SpacePrincipal={id:'observer',kind:'service',externalAgent:{id:'observer-agent',sessionId:'session-2',role:'observer'}};
const outsider:SpacePrincipal={id:'outside',kind:'service',externalAgent:{id:'outside-agent',sessionId:'session-3',role:'observer'}};
const credentials=[{token:'d'.repeat(32),principal:designer,spaceIds:['target-space']},{token:'o'.repeat(32),principal:observer,spaceIds:['target-space']},{token:'x'.repeat(32),principal:outsider,spaceIds:[]}];
const active:Array<{server:Server;directory:string}>=[];
const counts={workflowVersions:0,understandingRevisions:0,methodDesignRevisions:0,cases:0,runs:0,businessAssets:0,assetVersions:0,adoptions:0};
async function start(options:{service?:Partial<WorkflowSpaceService>;methodHostFor?:NonNullable<DesignWorkbenchOptions['methodHostFor']>}={}){
  const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=(reservation.address() as AddressInfo).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const directory=await mkdtemp(join(tmpdir(),'design-workbench-'));
  await writeFile(join(directory,'index.html'),'<html><div id="root"></div></html>');
  const spaces:WorkflowSpace[]=[];
  const calls:Array<{input:unknown;principal:SpacePrincipal}>=[];
  const source={
    listSpaces:async()=>spaces,
    designSpaceState:async(id:string)=>({space:spaces.find(value=>value.id===id)!,scope:spaces.find(value=>value.id===id)!.designScope!,counts,understandingRevisionId:null}),
    spaceSummary:async(id:string)=>({space:spaces.find(value=>value.id===id)!,versionCount:0,caseCount:0,runCount:0,assetCount:0,latestVersionId:null,adoptedVersionId:null}),
    readAssetHead:async()=>null,readAssetHistory:async()=>[],readAsset:async()=>{throw new Error('not found')},...options.service,
  } as unknown as WorkflowSpaceService;
  const ownerService={provisionDesignSpace:async(input:{id:string;purpose:string;scope:{workflowId:string;entrypoint:string}},principal:SpacePrincipal)=>{
    calls.push({input,principal});const space:WorkflowSpace={id:input.id,purpose:input.purpose,owner:owner.id,status:'active',createdAt:'2026-10-11T00:00:00Z',designScope:input.scope,provisionedBy:{agentId:designer.externalAgent!.id,sessionId:designer.externalAgent!.sessionId,principalId:designer.id}};
    spaces.push(space);return {space,scope:input.scope,createdBy:space.provisionedBy,initialCounts:counts};
  }} as unknown as WorkflowSpaceService;
  const server=createDesignWorkbench({ownerService,serviceFor:()=>source,ownerPrincipal:owner,credentials,allowedSpaceIds:['target-space'],webRoot:directory,publicOrigin:`http://127.0.0.1:${port}`,methodHostFor:options.methodHostFor});
  await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));
  active.push({server,directory});
  return {server,directory,spaces,calls};
}
afterEach(async()=>{for(const item of active.splice(0)){await new Promise<void>(resolve=>item.server.close(()=>resolve()));await rm(item.directory,{recursive:true,force:true});}});

describe('design workbench authorization and empty catalog',()=>{
  it('forwards evaluation reads but grants observation, review and assessment writes only to the design credential',async()=>{
    const never=async()=>{throw new Error('synthetic operation');};
    const {server,spaces}=await start({service:{
      readSavedResponseTarget:never,readPublishedAssetTarget:never,readExternalAgentObservation:never,
      observeSavedResponseTarget:never,observePublishedAsset:never,recordReview:never,
    },methodHostFor:async()=>({reviewStandard:async()=>({id:'standard',revision:'1',content:'Check the actual output'}),
      runDisposition:{current:async()=>null,read:never,list:async()=>[],save:never},
      runDiagnosis:{current:async()=>null,read:never,list:async()=>[],save:never}})});
    spaces.push({id:'target-space',purpose:'Synthetic design',owner:owner.id,status:'active',createdAt:'2026-10-11T00:00:00Z',
      designScope:{workflowId:'test-workflow',entrypoint:'entry'},
      provisionedBy:{agentId:designer.externalAgent!.id,sessionId:designer.externalAgent!.sessionId,principalId:designer.id}});
    const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const route=`${origin}/api/workflow-spaces/v1/spaces/target-space/summary`;
    const designerSummary=await fetch(route,{headers:{authorization:`Bearer ${credentials[0]!.token}`}});
    expect(designerSummary.status).toBe(200);
    expect(await designerSummary.json()).toMatchObject({capabilities:{observationRead:true,observationWrite:true,reviewWrite:true,
      dispositionRead:true,dispositionWrite:true,diagnosisRead:true,diagnosisWrite:true}});
    const observerSummary=await fetch(route,{headers:{authorization:`Bearer ${credentials[1]!.token}`}});
    expect(observerSummary.status).toBe(200);
    expect(await observerSummary.json()).toMatchObject({capabilities:{observationRead:true,observationWrite:false,reviewWrite:false,
      dispositionRead:true,dispositionWrite:false,diagnosisRead:true,diagnosisWrite:false}});
  });
  it('keeps the catalog empty and does not provision on GET',async()=>{
    const {server,calls}=await start();const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response=await fetch(`${origin}/api/workflow-spaces/v1/onboarding`);
    expect(response.status).toBe(200);expect((await response.json()).spaces).toEqual([]);
    const page=await fetch(`${origin}/space-workbench`);expect(page.status).toBe(200);expect(await page.text()).toContain('尚无可访问的 Space');
    const oldLogin=await fetch(`${origin}/space-workbench/login`);expect(oldLogin.status).toBe(200);expect(new URL(oldLogin.url).pathname).toBe('/space-workbench');
    expect(calls).toEqual([]);
  });
  it('requires the design credential, exact ID and same-origin CSRF before provisioning',async()=>{
    const {server,calls}=await start();const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request={id:'target-space',purpose:'Synthetic design',scope:{workflowId:'test-workflow',entrypoint:'entry'},idempotencyKey:'first-create'};
    const route=`${origin}/api/workflow-spaces/v1/spaces`;
    const post=(token:string,body:unknown,headers:Record<string,string>={})=>fetch(route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:JSON.stringify(body)});
    expect((await post(credentials[0]!.token,request)).status).toBe(403);
    const onboarding=await fetch(`${origin}/api/workflow-spaces/v1/onboarding`,{headers:{authorization:`Bearer ${credentials[0]!.token}`}});
    expect(onboarding.status).toBe(200);const view=await onboarding.json();
    expect(view.subject.id).toBe(designer.id);expect(view.canCreateSpace).toBe(true);expect(view.allowedSpaceIds).toEqual(['target-space']);
    expect((await post(credentials[0]!.token,request,{origin:'http://wrong.example','x-space-csrf':view.csrfToken})).status).toBe(403);
    expect((await post(credentials[1]!.token,request,{origin,'x-space-csrf':view.csrfToken})).status).toBe(403);
    expect((await post(credentials[0]!.token,{...request,id:'unknown-space'},{origin,'x-space-csrf':view.csrfToken})).status).toBe(400);
    expect((await post(credentials[0]!.token,{...request,principal:{id:'owner',kind:'human'}},{origin,'x-space-csrf':view.csrfToken})).status).toBe(400);
    expect(calls).toHaveLength(0);
    const created=await post(credentials[0]!.token,request,{origin,'x-space-csrf':view.csrfToken});
    expect(created.status).toBe(201);expect((await created.json()).space.id).toBe('target-space');
    expect(calls).toHaveLength(1);expect(calls[0]!.principal).toBe(designer);
    const directory=await fetch(`${origin}/space-workbench`);expect(await directory.text()).toContain('Synthetic design');
    expect((await fetch(`${origin}/space-workbench/unknown-space`)).status).toBe(404);
    expect((await fetch(`${origin}/space-workbench/target-space`)).status).toBe(200);
    const base=`${route}/target-space`;
    const summary=await fetch(`${base}/summary`,{headers:{authorization:`Bearer ${credentials[0]!.token}`}});
    expect(summary.status).toBe(200);expect((await summary.json()).businessState).toEqual({...counts,understandingRevisionId:null});
    const history=await fetch(`${base}/understanding/revisions`,{headers:{authorization:`Bearer ${credentials[0]!.token}`}});
    expect(history.status).toBe(200);expect((await history.json()).items).toEqual([]);
    const current=await fetch(`${base}/understanding`,{headers:{authorization:`Bearer ${credentials[0]!.token}`}});
    expect(current.status).toBe(404);
    const observerHistory=await fetch(`${base}/understanding/revisions`,{headers:{authorization:`Bearer ${credentials[1]!.token}`}});
    expect(observerHistory.status).toBe(200);
    const outsiderOnboarding=await fetch(`${origin}/api/workflow-spaces/v1/onboarding`,{headers:{authorization:`Bearer ${credentials[2]!.token}`}});
    const outsiderView=await outsiderOnboarding.json();expect(outsiderView.allowedSpaceIds).toEqual([]);expect(outsiderView.spaces).toEqual([]);
    expect((await fetch(`${base}/understanding/revisions`,{headers:{authorization:`Bearer ${credentials[2]!.token}`}})).status).toBe(401);
    const unknown=await fetch(`${route}/unknown-space/understanding/revisions`,{headers:{authorization:`Bearer ${credentials[0]!.token}`}});
    expect(unknown.status).toBe(401);
  });
});
