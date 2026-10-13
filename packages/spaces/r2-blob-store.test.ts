import {describe,expect,it} from 'vitest';
import {R2BlobStore,RoutedBlobStore,bytesHash,createR2BlobStore,MAX_SINGLE_BLOB_BYTES} from './blob-store.js';
import {fakeS3} from './test-support/r2-blob-client.js';

describe('R2 single-object blob adapter',()=>{
  it('uses immutable keys and conditional PUT, verifies actual bytes, and reconciles equal retries',async()=>{
    const fake=fakeS3(),store=new R2BlobStore(fake.client,'private-bucket',{keyPrefix:'creator/content'});
    const bytes=new TextEncoder().encode('saved report');
    const key=store.keyFor('space/one',bytesHash(bytes));
    expect(key).toBe(`r2/v1/creator/content/space%2Fone/${bytesHash(bytes)}`);
    await store.put(key,bytes,'text/plain');
    await store.put(key,bytes,'text/plain');
    expect(fake.puts).toEqual([{key,ifNoneMatch:'*',contentType:'text/plain'},{key,ifNoneMatch:'*',contentType:'text/plain'}]);
    expect(await store.get(key)).toEqual(bytes);
    await expect(store.put(key,new TextEncoder().encode('wrong bytes'))).rejects.toThrow('does not match bytes');
    fake.objects.set(key,new TextEncoder().encode('tampered'));
    await expect(store.get(key)).rejects.toThrow('integrity');
    await expect(store.put(key,bytes)).rejects.toThrow('integrity');
  });
  it('routes all R2 key prefixes to the object store and retains old PostgreSQL keys',async()=>{
    const fake=fakeS3(),r2=new R2BlobStore(fake.client,'private-bucket',{keyPrefix:'new-prefix'});
    const bytes=new Uint8Array([1,2,3]),sha=bytesHash(bytes),legacyKey=`space/${sha}`;
    const legacy={put:async()=>{},get:async(key:string)=>{expect(key).toBe(legacyKey);return bytes;}};
    const routed=new RoutedBlobStore(legacy,r2);
    expect(await routed.get(legacyKey)).toEqual(bytes);
    const oldPrefixKey=new R2BlobStore(fake.client,'private-bucket',{keyPrefix:'old-prefix'}).keyFor('space',sha);
    fake.objects.set(oldPrefixKey,bytes);
    expect(await routed.get(oldPrefixKey)).toEqual(bytes);
    expect(routed.keyFor('space',sha)).toContain('/new-prefix/');
    await expect(routed.get('r2/v1/bad/not-a-sha')).rejects.toThrow('Invalid R2');
  });
  it('rejects unsafe configuration and blobs above the declared nonstreaming bound',async()=>{
    expect(()=>createR2BlobStore({endpoint:'http://r2.example',bucket:'private',accessKeyId:'test',secretAccessKey:'test'})).toThrow('HTTPS');
    expect(()=>createR2BlobStore({endpoint:'https://r2.example/path',bucket:'private',accessKeyId:'test',secretAccessKey:'test'})).toThrow('endpoint');
    expect(()=>new R2BlobStore(fakeS3().client,'private',{keyPrefix:'../escape'})).toThrow('prefix');
    expect(()=>new R2BlobStore(fakeS3().client,'private',{maxBytes:MAX_SINGLE_BLOB_BYTES+1})).toThrow('16 MiB');
    const fake=fakeS3(),store=new R2BlobStore(fake.client,'private');
    const oversized=new Uint8Array(MAX_SINGLE_BLOB_BYTES+1),key=store.keyFor('space',bytesHash(oversized));
    await expect(store.put(key,oversized)).rejects.toThrow('16 MiB');
    expect(fake.puts).toHaveLength(0);
  });
});
