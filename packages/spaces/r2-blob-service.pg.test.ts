import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {describe,expect,it} from 'vitest';
import {JSON_SCHEMA_DIALECT} from '@signal-room/workflow-space-contracts';
import {PostgresBlobStore,R2BlobStore,RoutedBlobStore,bytesHash} from './blob-store.js';
import {migrateWorkflowSpaces} from './migration.js';
import {fakeS3} from './test-support/r2-blob-client.js';
import {WorkflowSpaceService} from './service.js';

const databaseUrl=process.env.WORKFLOW_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('R2 blob manifests with isolated PostgreSQL',()=>{
  it('reuses historical PG content and reconciles an object written before a failed manifest insert',async()=>{
    const schema=`r2_blob_${randomUUID().replaceAll('-','')}`;
    const admin=new Pool({connectionString:databaseUrl!});
    const pool=new Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`,max:8});
    try{
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await migrateWorkflowSpaces(pool);
      const postgres=new PostgresBlobStore(pool);await postgres.migrate();
      const principal={id:'blob-owner',kind:'human' as const};
      const legacyService=new WorkflowSpaceService(pool,postgres,principal);
      const space=await legacyService.createSpace({purpose:'Isolated R2 compatibility test'});
      const oldBytes=new TextEncoder().encode('historic PostgreSQL file');
      const oldManifest=await legacyService.uploadBlob(space.id,oldBytes,'text/plain');
      expect(oldManifest).toMatchObject({id:bytesHash(oldBytes),key:`${space.id}/${bytesHash(oldBytes)}`});
      expect(oldManifest.backend).toBeUndefined();

      const fake=fakeS3(),r2=new R2BlobStore(fake.client,'private-fixture',{keyPrefix:'test-scope'});
      const routed=new RoutedBlobStore(postgres,r2),service=new WorkflowSpaceService(pool,routed,principal);
      expect(await service.uploadBlob(space.id,oldBytes,'text/plain')).toEqual(oldManifest);
      expect(fake.puts).toHaveLength(0);
      expect(await service.readBlob(space.id,oldManifest.id)).toEqual(oldBytes);

      const newBytes=new TextEncoder().encode('new private R2 file');
      const key=r2.keyFor(space.id,bytesHash(newBytes));
      const originalQuery=pool.query.bind(pool);
      let failInsert=true;
      (pool as unknown as {query:(...args:unknown[])=>Promise<unknown>}).query=async(...args:unknown[])=>{
        if(failInsert&&typeof args[0]==='string'&&args[0].startsWith('INSERT INTO ws_blobs')){
          failInsert=false;throw new Error('fixture manifest insert failed after object write');
        }
        return (originalQuery as (...args:unknown[])=>Promise<unknown>)(...args);
      };
      try{await expect(service.uploadBlob(space.id,newBytes,'application/octet-stream')).rejects.toThrow('fixture manifest insert failed');}
      finally{(pool as unknown as {query:typeof pool.query}).query=originalQuery;}
      expect(fake.objects.get(key)).toEqual(newBytes);
      expect((await pool.query('SELECT id FROM ws_blobs WHERE space_id=$1',[space.id])).rows).toHaveLength(1);
      const resumed=await service.uploadBlob(space.id,newBytes,'application/octet-stream');
      expect(resumed).toMatchObject({id:bytesHash(newBytes),key,backend:'r2',size:newBytes.byteLength});
      expect(fake.puts.map(item=>item.ifNoneMatch)).toEqual(['*','*']);
      expect(await service.uploadBlob(space.id,newBytes,'application/octet-stream')).toEqual(resumed);
      await expect(service.uploadBlob(space.id,newBytes,'text/plain')).rejects.toThrow('media type conflict');

      const [registered]=await service.registerSchemas(space.id,[{namespace:'test/blob-report',revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:{type:'object'}}]);
      const asset=await service.importAsset(space.id,{schema:{namespace:registered!.namespace,revision:registered!.revision,hash:registered!.hash},
        payload:{title:'Both original files'},blobIds:[oldManifest.id,resumed.id],description:'Verified private files',idempotencyKey:'asset-with-both'});
      expect(asset.attachments.map(item=>[item.id,item.backend??'postgres'])).toEqual([[oldManifest.id,'postgres'],[resumed.id,'r2']]);
      const reopened=new WorkflowSpaceService(pool,new RoutedBlobStore(new PostgresBlobStore(pool),new R2BlobStore(fake.client,'private-fixture',{keyPrefix:'new-writes'})),principal);
      expect(await reopened.readBlob(space.id,oldManifest.id)).toEqual(oldBytes);
      expect(await reopened.readBlob(space.id,resumed.id)).toEqual(newBytes);
      await expect(new WorkflowSpaceService(pool,postgres,principal).readBlob(space.id,resumed.id)).rejects.toThrow('R2 blob requires configured object provider');
      expect((await reopened.readAsset(space.id,asset.id)).attachments).toEqual(asset.attachments);
      fake.objects.set(key,new TextEncoder().encode('tampered'));
      await expect(reopened.readBlob(space.id,resumed.id)).rejects.toThrow('integrity');
    }finally{
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
