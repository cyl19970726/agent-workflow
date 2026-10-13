import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,lstat,symlink,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {prepareRequest} from './operator-prepare.js';

const sha=(content:string)=>createHash('sha256').update(content,'utf8').digest('hex');
const missing=()=>Object.assign(new Error('private response'),{status:404});
const summary={id:'space',methodScope:{workflowId:'workflow',entrypoint:'content'},
  subject:{id:'external-agent:session',kind:'service',externalAgent:{id:'designer',sessionId:'session',role:'design'}},
  capabilities:{methodCapabilityWrite:true,methodDesignWrite:true},csrfToken:'never-copy-this',snapshotAt:'today'};
const understanding={id:'understanding-current',assetId:'space-business-understanding',payloadHash:'u-current'};
const oldUnderstanding={id:'understanding-old',assetId:'space-business-understanding',payloadHash:'u-old'};
const capability={id:'capability-current',workflowId:'workflow',entrypoint:'content',payloadHash:'c-current',
  understanding:{revisionId:'understanding-current',payloadHash:'u-current'}};
const oldCapability={id:'capability-old',workflowId:'workflow',entrypoint:'content',payloadHash:'c-old',
  understanding:{revisionId:'understanding-old',payloadHash:'u-old'}};
const design={id:'design-current',workflowId:'workflow',entrypoint:'content',payloadHash:'d-current'};
const directories:string[]=[];
async function files(input:unknown){
  const directory=await mkdtemp(join(tmpdir(),'operator-prepare-'));directories.push(directory);
  const authored=join(directory,'authored.json'),ready=join(directory,'ready.json');
  await writeFile(authored,JSON.stringify(input));return {directory,authored,ready};
}
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});
function api(options:{capabilityHead?:typeof capability|null;designHead?:typeof design|null;understandingHead?:typeof understanding|null;
  old?:boolean}={}){
  const calls:string[]=[];
  const rows:Record<string,unknown>={
    '/summary':summary,'/understanding':options.understandingHead===undefined?understanding:options.understandingHead,
    '/understanding?revision=understanding-current':understanding,
    '/understanding?revision=understanding-old':oldUnderstanding,
    '/method-capability':options.capabilityHead===undefined?capability:options.capabilityHead,
    '/method-capability?revision=capability-current':capability,
    '/method-capability?revision=capability-old':oldCapability,
    '/method-design':options.designHead===undefined?design:options.designHead,
    '/versions/prior':{id:'prior',label:'Prior version',labelSource:'recorded',revision:'1',createdAt:'2026-10-12T00:00:00Z',
      changeReason:'prior',predecessorId:null,entrypoint:'content',definitionAvailability:'recorded',
      availability:{state:'available',reason:null},runCount:0,caseCount:0,planIds:[],hash:'version-hash',purpose:null,
      nodes:[],graphUrl:null,expectedAssets:{assets:[],dependencies:[],gaps:[]},adoptionSlots:[],adoptionStatus:'unknown'},
  };
  return {calls,get:async(path:string)=>{calls.push(path);if(!(path in rows)||rows[path]===null)throw missing();return rows[path];}};
}
const authoredCapability={provider:{id:'provider',contractRevision:'1'},nodes:{researcher:{
  instructions:'  Exact instruction bytes\n',outputSchema:'{"type":"object"}',model:'model',reasoningEffort:'high'}},
  validation:'{"checks":[]}',predecessorVersionId:null,changeReason:'Prepared fixture'};
const authoredDesign={title:'Method title',content:'# Exact design\n',sources:[{kind:'document',ref:'source-1',title:'Source'}],
  changeReason:'Prepared fixture'};
const options=(get:(path:string)=>Promise<unknown>,inputFile:string,outFile?:string)=>({get,spaceId:'space',baseUrl:'http://127.0.0.1:4400',inputFile,
  ...(outFile?{outFile}:{})});

describe('operator Save request preparation',()=>{
  it('prepares exact capability bytes privately, then rechecks the same body/key/Agent using GET only',async()=>{
    const {authored,ready}=await files(authoredCapability),remote=api({capabilityHead:null});
    const first=await prepareRequest('capability',options(remote.get,authored,ready));
    expect(first).toMatchObject({workflowId:'workflow',entrypoint:'content',expectedRevisionId:null,
      understanding:{revisionId:'understanding-current',payloadHash:'u-current'},
      authorship:{kind:'agent',name:'designer',sessionId:'session'},
      nodes:{researcher:{instructions:{content:'  Exact instruction bytes\n',sha256:sha('  Exact instruction bytes\n')}}}});
    expect(first.idempotencyKey).toEqual(expect.any(String));
    expect((await lstat(ready)).mode&0o777).toBe(0o600);
    expect(JSON.parse(await readFile(ready,'utf8'))).toEqual(first);
    expect(await readFile(ready,'utf8')).not.toContain('never-copy-this');
    expect(await prepareRequest('capability',options(remote.get,ready))).toEqual(first);
    expect(remote.calls.every(path=>path.startsWith('/'))).toBe(true);
    await expect(prepareRequest('capability',options(remote.get,authored,ready))).rejects.toThrow('already exists');
  });
  it('pins an explicitly old understanding, never silently replacing it with current',async()=>{
    const {authored,ready}=await files({...authoredCapability,understanding:{revisionId:'understanding-old',payloadHash:'u-old'},
      predecessorVersionId:'prior'}),remote=api({capabilityHead:null});
    const result=await prepareRequest('capability',options(remote.get,authored,ready));
    expect(result.understanding).toEqual({revisionId:'understanding-old',payloadHash:'u-old'});
    expect(remote.calls).toContain('/understanding?revision=understanding-old');
    expect(remote.calls).not.toContain('/understanding');
    expect(remote.calls).toContain('/versions/prior');
    expect(await prepareRequest('capability',options(remote.get,ready))).toEqual(result);
  });
  it('accepts authored content objects without hashes and verifies every supplied hash',async()=>{
    const instructions='  原文 UTF-8\n',schema='{"type":"object","properties":{"answer":{"type":"string"}}}',validation=' {"checks":[]}\n';
    const authored={...authoredCapability,nodes:{researcher:{...authoredCapability.nodes.researcher,
      instructions:{content:instructions},outputSchema:{content:schema,sha256:sha(schema)}}},validation:{content:validation}};
    const {authored:inputFile,ready}=await files(authored),remote=api({capabilityHead:null});
    const prepared=await prepareRequest('capability',options(remote.get,inputFile,ready));
    expect(prepared.nodes).toEqual({researcher:{instructions:{content:instructions,sha256:sha(instructions)},
      outputSchema:{content:schema,sha256:sha(schema)},model:'model',reasoningEffort:'high'}});
    expect(prepared.validation).toEqual({content:validation,sha256:sha(validation)});
    expect(await prepareRequest('capability',options(remote.get,ready))).toEqual(prepared);
    const bad=await files({...authored,validation:{content:validation,sha256:sha('different')}});
    await expect(prepareRequest('capability',options(remote.get,bad.authored,bad.ready))).rejects.toThrow('SHA-256 mismatch');
  });
  it('uses the public predecessor VersionDetail entrypoint and rejects a different entrypoint',async()=>{
    const input={...authoredCapability,predecessorVersionId:'prior'};
    const valid=await files(input),remote=api({capabilityHead:null});
    await expect(prepareRequest('capability',options(remote.get,valid.authored,valid.ready))).resolves.toMatchObject({
      predecessorVersionId:'prior'});
    const invalid=await files(input);
    const get=async(path:string)=>path==='/versions/prior'?{id:'prior',entrypoint:'other'}:remote.get(path);
    await expect(prepareRequest('capability',options(get,invalid.authored,invalid.ready)))
      .rejects.toThrow('Predecessor workflow/entrypoint mismatch');
    await expect(lstat(invalid.ready)).rejects.toMatchObject({code:'ENOENT'});
  });
  it('accepts supplied valid scope, authorship and key without replacing them',async()=>{
    const {authored,ready}=await files({...authoredCapability,workflowId:'workflow',entrypoint:'content',
      understanding:{revisionId:'understanding-current',payloadHash:'u-current'},expectedRevisionId:null,
      idempotencyKey:'authored-fixed-key',authorship:{kind:'agent',name:'designer',sessionId:'session'}});
    const result=await prepareRequest('capability',options(api({capabilityHead:null}).get,authored,ready));
    expect(result.idempotencyKey).toBe('authored-fixed-key');
    expect(await prepareRequest('capability',options(api({capabilityHead:null}).get,ready))).toEqual(result);
  });
  it('prepares design with exact current capability and preserves explicit no-capability on recheck',async()=>{
    const first=await files(authoredDesign),remote=api({designHead:null});
    const prepared=await prepareRequest('design',options(remote.get,first.authored,first.ready));
    expect(prepared).toMatchObject({expectedRevisionId:null,capability:{revisionId:'capability-current',payloadHash:'c-current'},
      understanding:{revisionId:'understanding-current',payloadHash:'u-current'}});
    expect(await prepareRequest('design',options(remote.get,first.ready))).toEqual(prepared);
    const second=await files({...authoredDesign,capability:null}),bare=await prepareRequest('design',options(remote.get,second.authored,second.ready));
    expect(bare).not.toHaveProperty('capability');
    expect(await prepareRequest('design',options(remote.get,second.ready))).toEqual(bare);
  });
  it('rechecks a ready head without changing its idempotency key and rejects an advanced head',async()=>{
    const {authored,ready}=await files(authoredCapability),first=api({capabilityHead:null});
    const prepared=await prepareRequest('capability',options(first.get,authored,ready));
    const advanced=api({capabilityHead:capability});
    await expect(prepareRequest('capability',options(advanced.get,ready))).rejects.toThrow('head conflict');
    expect(JSON.parse(await readFile(ready,'utf8')).idempotencyKey).toBe(prepared.idempotencyKey);
  });
  it('preserves an explicit old design basis instead of substituting current understanding or capability',async()=>{
    const {authored,ready}=await files({...authoredDesign,understanding:{revisionId:'understanding-old'},
      capability:{revisionId:'capability-old'}}),remote=api({designHead:null});
    const prepared=await prepareRequest('design',options(remote.get,authored,ready));
    expect(prepared).toMatchObject({understanding:{revisionId:'understanding-old',payloadHash:'u-old'},
      capability:{revisionId:'capability-old',payloadHash:'c-old'}});
    expect(remote.calls).not.toContain('/understanding');
    expect(await prepareRequest('design',options(remote.get,ready))).toEqual(prepared);
  });
  it('rejects wrong hashes, shapes, heads, scope, and Agent authorship without creating output',async()=>{
    const bads=[
      {...authoredCapability,nodes:{researcher:{...authoredCapability.nodes.researcher,instructions:{content:'Changed',sha256:sha('Other')}}}},
      {...authoredCapability,nodes:{researcher:{...authoredCapability.nodes.researcher,outputSchema:'[]'}}},
      {...authoredCapability,validation:'{bad'},
      {...authoredCapability,unknown:'private'},
      {...authoredCapability,expectedRevisionId:'stale'},
      {...authoredCapability,workflowId:'other'},
      {...authoredCapability,authorship:{kind:'agent',name:'wrong',sessionId:'session'}},
      {...authoredCapability,understanding:{revisionId:'understanding-old',payloadHash:'wrong'}},
    ];
    for(const item of bads){
      const {authored,ready}=await files(item),remote=api();
      await expect(prepareRequest('capability',options(remote.get,authored,ready))).rejects.toThrow();
      await expect(lstat(ready)).rejects.toMatchObject({code:'ENOENT'});
    }
    const {authored,ready}=await files({...authoredDesign,capability:{revisionId:'capability-current',payloadHash:'wrong'}});
    await expect(prepareRequest('design',options(api().get,authored,ready))).rejects.toThrow('hash mismatch');
  });
  it('rejects unsafe output, symlink input and world-readable ready recheck',async()=>{
    const {directory,authored,ready}=await files(authoredCapability),remote=api({capabilityHead:null});
    await writeFile(ready,'existing');
    await expect(prepareRequest('capability',options(remote.get,authored,ready))).rejects.toThrow('already exists');
    expect(await readFile(ready,'utf8')).toBe('existing');
    const outputLink=join(directory,'output-link.json');await symlink(ready,outputLink);
    await expect(prepareRequest('capability',options(remote.get,authored,outputLink))).rejects.toThrow();
    expect(await readFile(ready,'utf8')).toBe('existing');
    const link=join(directory,'link.json');await symlink(authored,link);
    await expect(prepareRequest('capability',options(remote.get,link,join(directory,'different.json'))))
      .rejects.toThrow('safely read');
    const privateReady=join(directory,'private-ready.json');
    await prepareRequest('capability',options(remote.get,authored,privateReady));
    await chmod(privateReady,0o644);
    await expect(prepareRequest('capability',options(remote.get,privateReady))).rejects.toThrow('private');
    await expect(prepareRequest('capability',options(remote.get,authored,authored))).rejects.toThrow('distinct');
  });
  it('does not expose API errors or credentials in preparation failures',async()=>{
    const {authored,ready}=await files(authoredCapability);
    const failing=async(path:string)=>{if(path==='/summary')return summary;
      throw Object.assign(new Error('Bearer private-token; body has secret source text'),{status:503});};
    await expect(prepareRequest('capability',options(failing,authored,ready)))
      .rejects.toThrow('Operator API read failed (HTTP 503)');
    await expect(lstat(ready)).rejects.toMatchObject({code:'ENOENT'});
  });
});
