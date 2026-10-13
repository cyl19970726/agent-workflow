import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {isAbsolute} from 'node:path';

export interface DesignWorkbenchCredential {
  version:2;
  spaceIds:string[];
  token:string;
  principal:{id:string;kind:'service';externalAgent:{id:string;sessionId:string;role:'design'|'observer'}};
}

const validId=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=240&&value!=='.'&&value!=='..';
const validToken=(value:unknown):value is string=>typeof value==='string'&&value.length>=24&&!/\s/u.test(value);
function parse(value:unknown):DesignWorkbenchCredential|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const data=value as Record<string,unknown>;
  if(data.version!==2||!Array.isArray(data.spaceIds)||!data.spaceIds.length||data.spaceIds.some(id=>!validId(id))||
    new Set(data.spaceIds).size!==data.spaceIds.length||!validToken(data.token))return null;
  const principal=data.principal as Record<string,unknown>|undefined;
  const agent=principal?.externalAgent as Record<string,unknown>|undefined;
  if(!principal||principal.kind!=='service'||!agent||!validId(agent.id)||!validId(agent.sessionId)||
    !['design','observer'].includes(String(agent.role))||principal.id!==`external-agent:${agent.sessionId}`)return null;
  return data as unknown as DesignWorkbenchCredential;
}

export async function readDesignWorkbenchCredential(path:string):Promise<DesignWorkbenchCredential|null>{
  if(!isAbsolute(path))return null;
  let file;
  try{
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await file.stat();
    if(!info.isFile()||(info.mode&0o077)!==0)return null;
    return parse(JSON.parse(await file.readFile('utf8')));
  }catch{return null;}
  finally{await file?.close();}
}

export async function provisionDesignWorkbenchCredential(path:string,input:{agentId:string;sessionId:string;spaceIds:string[];role:'design'|'observer'}):Promise<DesignWorkbenchCredential>{
  if(!isAbsolute(path)||!validId(input.agentId)||!validId(input.sessionId)||
    !Array.isArray(input.spaceIds)||!input.spaceIds.length||input.spaceIds.some(id=>!validId(id))||
    new Set(input.spaceIds).size!==input.spaceIds.length||!['design','observer'].includes(input.role))throw new Error('Invalid design workbench credential scope');
  const expected={id:`external-agent:${input.sessionId}`,kind:'service' as const,
    externalAgent:{id:input.agentId,sessionId:input.sessionId,role:input.role}};
  const credential:DesignWorkbenchCredential={version:2,spaceIds:[...input.spaceIds],token:randomBytes(32).toString('hex'),principal:expected};
  let file;
  try{
    file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await file.writeFile(`${JSON.stringify(credential)}\n`);
    return credential;
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const existing=await readDesignWorkbenchCredential(path);
    if(existing&&existing.principal.id===expected.id&&existing.principal.kind==='service'&&
      existing.principal.externalAgent.id===expected.externalAgent.id&&
      existing.principal.externalAgent.sessionId===expected.externalAgent.sessionId&&
      existing.principal.externalAgent.role===expected.externalAgent.role&&
      existing.spaceIds.length===input.spaceIds.length&&existing.spaceIds.every((id,index)=>id===input.spaceIds[index]))return existing;
    throw new Error('Existing design workbench credential has a different scope or invalid permissions');
  }finally{await file?.close();}
}
