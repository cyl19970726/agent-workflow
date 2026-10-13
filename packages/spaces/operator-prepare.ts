import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,unlink} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

export type PrepareKind='capability'|'design';
export interface PrepareRequestOptions {
  /** Authenticated, Space-scoped GET supplied by the existing operator CLI. */
  get:(path:string)=>Promise<unknown>;
  spaceId:string;
  baseUrl:string;
  inputFile:string;
  outFile?:string;
}
type Row=Record<string,unknown>;
const sha=(content:string)=>createHash('sha256').update(content,'utf8').digest('hex');
const object=(value:unknown,label:string):Row=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${label} must be an object`);
  return value as Row;
};
const only=(value:Row,keys:readonly string[],label:string):void=>{
  if(Object.keys(value).some(key=>!keys.includes(key)))throw new Error(`${label} has unsupported fields`);
};
const nonempty=(value:unknown,label:string):string=>{
  if(typeof value!=='string'||!value.trim())throw new Error(`${label} must be nonempty`);
  return value;
};
const optionalId=(value:unknown,label:string):string|null=>value===null?null:nonempty(value,label);
const exactRef=(value:unknown,label:string):{revisionId:string;payloadHash?:string}=>{
  const row=object(value,label);only(row,['revisionId','payloadHash'],label);
  return {revisionId:nonempty(row.revisionId,`${label}.revisionId`),
    ...(row.payloadHash===undefined?{}:{payloadHash:nonempty(row.payloadHash,`${label}.payloadHash`)})};
};
const httpStatus=(error:unknown):number|undefined=>{
  const status=(error&&typeof error==='object'&&'status'in error)?(error as {status?:unknown}).status:undefined;
  return typeof status==='number'&&Number.isInteger(status)?status:undefined;
};
async function getSafe(get:PrepareRequestOptions['get'],path:string,optional404=false):Promise<Row|null>{
  try{return object(await get(path),'API response');}
  catch(error){
    const status=httpStatus(error);
    if(optional404&&status===404)return null;
    throw new Error(status?`Operator API read failed (HTTP ${status})`:'Operator API read failed');
  }
}
function content(value:unknown,label:string,parse:'json'|'schema'|null=null):{content:string;sha256:string}{
  let raw:string,digest:string|undefined;
  if(typeof value==='string')raw=value;
  else{
    const row=object(value,label);only(row,['content','sha256'],label);
    raw=nonempty(row.content,`${label}.content`);
    if(row.sha256!==undefined)digest=nonempty(row.sha256,`${label}.sha256`);
  }
  if(!raw.trim())throw new Error(`${label} must be nonempty`);
  const actual=sha(raw);
  if(digest!==undefined&&(digest!==actual||!/^[a-f0-9]{64}$/u.test(digest)))
    throw new Error(`${label} SHA-256 mismatch`);
  if(parse){
    let parsed:unknown;
    try{parsed=JSON.parse(raw);}catch{throw new Error(`${label} must contain valid JSON`);}
    if(parse==='schema'&&(!parsed||typeof parsed!=='object'||Array.isArray(parsed)))
      throw new Error(`${label} must contain a JSON schema object`);
  }
  return {content:raw,sha256:actual};
}
async function readInput(path:string):Promise<Row>{
  if(!isAbsolute(path))throw new Error('Input file must be absolute');
  let handle;
  try{
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>5_000_000)throw new Error('Invalid preparation input file');
    const raw=await handle.readFile();
    let parsed:unknown;
    try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}
    catch{throw new Error('Preparation input must be UTF-8 JSON');}
    return object(parsed,'Preparation input');
  }catch(error){
    if(error instanceof Error&&/^(?:Invalid preparation|Preparation input)/u.test(error.message))throw error;
    throw new Error('Cannot safely read preparation input file');
  }finally{await handle?.close();}
}
async function writeReady(path:string,value:Row):Promise<void>{
  let handle;
  try{
    handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await handle.writeFile(`${JSON.stringify(value,null,2)}\n`,'utf8');
    await handle.sync();
  }catch(error){
    if(handle){await handle.close();await unlink(path).catch(()=>undefined);}
    if(error&&typeof error==='object'&&'code'in error&&(error as {code?:unknown}).code==='EEXIST')
      throw new Error('Output already exists; use the ready file for recheck');
    throw new Error('Cannot safely create private ready file');
  }finally{await handle?.close();}
}
const hasDigest=(value:unknown):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
  typeof (value as Row).content==='string'&&typeof (value as Row).sha256==='string';
const isReady=(kind:PrepareKind,input:Row):boolean=>{
  if(!['workflowId','entrypoint','understanding','expectedRevisionId','idempotencyKey','authorship']
    .every(key=>Object.hasOwn(input,key)))return false;
  if(kind==='design')return Object.hasOwn(input,'title')&&Object.hasOwn(input,'content')&&Object.hasOwn(input,'sources');
  if(!Object.hasOwn(input,'provider')||!Object.hasOwn(input,'nodes')||!hasDigest(input.validation)||
    !input.nodes||typeof input.nodes!=='object'||Array.isArray(input.nodes))return false;
  return Object.values(input.nodes as Row).every(node=>node&&typeof node==='object'&&!Array.isArray(node)&&
    hasDigest((node as Row).instructions)&&hasDigest((node as Row).outputSchema));
};
const scoped=(row:Row,scope:{workflowId:string;entrypoint:string},label:string):void=>{
  if(row.workflowId!==scope.workflowId||row.entrypoint!==scope.entrypoint)
    throw new Error(`${label} workflow/entrypoint scope mismatch`);
};

/** Prepare a pure existing Save body, or recheck an already prepared private body without changing it. */
export async function prepareRequest(kind:PrepareKind,options:PrepareRequestOptions):Promise<Record<string,unknown>>{
  if(kind!=='capability'&&kind!=='design')throw new Error('Unsupported preparation kind');
  const spaceId=nonempty(options.spaceId,'Space ID');
  let base:URL;
  try{base=new URL(options.baseUrl);}catch{throw new Error('Invalid operator base URL');}
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||
    (base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname)))
    throw new Error('Invalid operator base URL');
  const input=await readInput(options.inputFile),complete=isReady(kind,input),ready=!options.outFile&&complete;
  if(options.outFile){
    if(!isAbsolute(options.outFile)||resolve(options.outFile)===resolve(options.inputFile))
      throw new Error('Output must be a distinct absolute path');
  }else if(!ready)throw new Error('Authored input requires --out; ready request recheck does not write a file');
  if(ready){
    const handle=await open(options.inputFile,constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>{throw new Error('Cannot safely read ready file');});
    try{if(((await handle.stat()).mode&0o077)!==0)throw new Error('Ready file must be private (0600)');}
    finally{await handle.close();}
  }
  const summary=await getSafe(options.get,'/summary');
  if(!summary||summary.id!==spaceId)throw new Error('Operator summary Space mismatch');
  const methodScope=object(summary.methodScope,'summary.methodScope');
  const scope={workflowId:nonempty(methodScope.workflowId,'workflow ID'),entrypoint:nonempty(methodScope.entrypoint,'entrypoint')};
  const subject=object(summary.subject,'summary.subject'),agent=object(subject.externalAgent,'summary.subject.externalAgent');
  if(subject.kind!=='service'||agent.role!=='design')throw new Error('Preparation requires the authenticated design Agent');
  const agentId=nonempty(agent.id,'design Agent ID'),sessionId=nonempty(agent.sessionId,'design Agent session ID');
  nonempty(subject.id,'subject ID');
  const capabilities=object(summary.capabilities,'summary.capabilities');
  if(capabilities[kind==='capability'?'methodCapabilityWrite':'methodDesignWrite']!==true)
    throw new Error('Authenticated design Agent lacks this save capability');
  const current=await getSafe(options.get,kind==='capability'?'/method-capability':'/method-design',true);
  if(current)scoped(current,scope,'Current revision');
  const expected=current?nonempty(current.id,'Current revision ID'):null;
  if(input.expectedRevisionId!==undefined&&optionalId(input.expectedRevisionId,'expectedRevisionId')!==expected)
    throw new Error('Revision head conflict; prepare again against current head');
  const authorship={kind:'agent',name:agentId,sessionId};
  if(input.authorship!==undefined){
    const supplied=object(input.authorship,'authorship');only(supplied,['kind','name','sessionId'],'authorship');
    if(supplied.kind!==authorship.kind||supplied.name!==agentId||supplied.sessionId!==sessionId)
      throw new Error('Authorship differs from authenticated design Agent');
  }
  if(input.workflowId!==undefined&&input.workflowId!==scope.workflowId||
    input.entrypoint!==undefined&&input.entrypoint!==scope.entrypoint)
    throw new Error('Preparation scope mismatch');
  const choose=async(value:unknown,path:string,label:string,optional404=false):Promise<{revisionId:string;payloadHash:string}|null>=>{
    const selector=value===undefined?null:exactRef(value,label);
    const response=await getSafe(options.get,selector?`${path}?revision=${encodeURIComponent(selector.revisionId)}`:path,optional404&&!selector);
    if(!response)return null;
    const revisionId=nonempty(response.id,`${label} revision ID`),payloadHash=nonempty(response.payloadHash,`${label} payload hash`);
    if(selector&&(revisionId!==selector.revisionId||selector.payloadHash!==undefined&&payloadHash!==selector.payloadHash))
      throw new Error(`${label} exact revision/hash mismatch`);
    return {revisionId,payloadHash};
  };
  const understanding=await choose(input.understanding,'/understanding','Understanding');
  if(!understanding)throw new Error('Business understanding is required');
  const common={workflowId:scope.workflowId,entrypoint:scope.entrypoint,understanding,
    expectedRevisionId:expected,idempotencyKey:input.idempotencyKey===undefined?randomUUID():nonempty(input.idempotencyKey,'idempotencyKey'),
    authorship};
  let result:Row;
  if(kind==='capability'){
    only(input,['workflowId','entrypoint','understanding','provider','nodes','validation','predecessorVersionId',
      'changeReason','authorship','expectedRevisionId','idempotencyKey'],'Capability input');
    const provider=object(input.provider,'provider');only(provider,['id','contractRevision'],'provider');
    const nodes=object(input.nodes,'nodes');if(!Object.keys(nodes).length)throw new Error('At least one node is required');
    const preparedNodes:Record<string,unknown>={};
    for(const [key,value] of Object.entries(nodes)){
      if(!key.trim())throw new Error('Node key must be nonempty');
      const node=object(value,`Node ${key}`);only(node,['instructions','outputSchema','model','reasoningEffort'],`Node ${key}`);
      preparedNodes[key]={instructions:content(node.instructions,`Node ${key} instructions`),
        outputSchema:content(node.outputSchema,`Node ${key} output schema`,'schema'),
        model:nonempty(node.model,`Node ${key} model`),reasoningEffort:nonempty(node.reasoningEffort,`Node ${key} reasoning effort`)};
    }
    if(!Object.hasOwn(input,'predecessorVersionId'))throw new Error('predecessorVersionId is required');
    const predecessor=optionalId(input.predecessorVersionId,'predecessorVersionId');
    if(predecessor){
      const version=await getSafe(options.get,`/versions/${encodeURIComponent(predecessor)}`);
      if(!version||version.id!==predecessor||version.entrypoint!==scope.entrypoint)
        throw new Error('Predecessor workflow/entrypoint mismatch');
    }
    result={...common,provider:{id:nonempty(provider.id,'provider.id'),
      contractRevision:nonempty(provider.contractRevision,'provider.contractRevision')},nodes:preparedNodes,
      validation:content(input.validation,'validation','json'),predecessorVersionId:predecessor,
      changeReason:nonempty(input.changeReason,'changeReason')};
  }else{
    only(input,['workflowId','entrypoint','understanding','capability','title','content','sources',
      'changeReason','authorship','expectedRevisionId','idempotencyKey'],'Design input');
    const sources=input.sources;
    if(!Array.isArray(sources)||!sources.length)throw new Error('Design sources are required');
    const preparedSources=sources.map((value,index)=>{
      const source=object(value,`source ${index}`);only(source,['kind','ref','title','excerpt'],`source ${index}`);
      if(!['document','case','asset','user-request'].includes(String(source.kind)))throw new Error(`Invalid source ${index} kind`);
      if(source.excerpt!==undefined&&typeof source.excerpt!=='string')throw new Error(`Invalid source ${index} excerpt`);
      return {kind:source.kind,ref:nonempty(source.ref,`source ${index} ref`),title:nonempty(source.title,`source ${index} title`),
        ...(source.excerpt===undefined?{}:{excerpt:source.excerpt})};
    });
    const capability=input.capability===null||complete&&input.capability===undefined?null:
      await choose(input.capability,'/method-capability','Capability',true);
    if(capability){
      const exact=await getSafe(options.get,`/method-capability?revision=${encodeURIComponent(capability.revisionId)}`);
      if(!exact)throw new Error('Capability revision is missing');
      scoped(exact,scope,'Capability');
      const linked=object(exact.understanding,'capability.understanding');
      if(linked.revisionId!==understanding.revisionId||linked.payloadHash!==understanding.payloadHash)
        throw new Error('Capability and understanding basis mismatch');
    }
    result={...common,...(capability?{capability}:{}),title:nonempty(input.title,'title'),
      content:nonempty(input.content,'content'),sources:preparedSources,
      changeReason:nonempty(input.changeReason,'changeReason')};
  }
  if(complete&&!isDeepStrictEqual(result,input))
    throw new Error('Ready request differs from its exact reviewed bytes');
  if(options.outFile)await writeReady(options.outFile,result);
  return ready?input:result;
}
