import {describe,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionDesignWorkbenchCredential,readDesignWorkbenchCredential} from './workbench-credentials.js';

const input={agentId:'designer',sessionId:'session-1',spaceIds:['space-a'],role:'design' as const};
describe('private design workbench credentials',()=>{
  it('creates a private v2 credential and reuses only the same scope and identity',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'design-credential-'));try{
      const path=join(dir,'agent.json');const created=await provisionDesignWorkbenchCredential(path,input);
      expect(created).toMatchObject({version:2,spaceIds:['space-a'],principal:{id:'external-agent:session-1',kind:'service',externalAgent:{id:'designer',role:'design'}}});
      expect(created.token).toMatch(/^[a-f0-9]{64}$/u);expect((await stat(path)).mode&0o777).toBe(0o600);
      expect(await readDesignWorkbenchCredential(path)).toEqual(created);
      expect(await provisionDesignWorkbenchCredential(path,input)).toEqual(created);
      await expect(provisionDesignWorkbenchCredential(path,{...input,spaceIds:['space-b']})).rejects.toThrow();
      expect(JSON.parse(await readFile(path,'utf8'))).toEqual(created);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
  it('rejects symlinks, group-readable files, invalid tokens, and mismatched identity',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'design-credential-'));try{
      const path=join(dir,'agent.json'),link=join(dir,'link.json');
      const created=await provisionDesignWorkbenchCredential(path,input);
      await symlink(path,link);expect(await readDesignWorkbenchCredential(link)).toBeNull();
      await expect(provisionDesignWorkbenchCredential(link,input)).rejects.toThrow();
      for(const changed of [{...created,token:'weak'},{...created,principal:{...created.principal,id:'other'}}]){
        await writeFile(path,JSON.stringify(changed),{mode:0o600});expect(await readDesignWorkbenchCredential(path)).toBeNull();
      }
      await writeFile(path,JSON.stringify(created),{mode:0o644});
      const {chmod}=await import('node:fs/promises');await chmod(path,0o644);
      expect(await readDesignWorkbenchCredential(path)).toBeNull();
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});
