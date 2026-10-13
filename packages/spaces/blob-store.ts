import { createHash } from 'node:crypto';
import {GetObjectCommand, PutObjectCommand, S3Client} from '@aws-sdk/client-s3';
import type { Pool } from 'pg';

export interface BlobStore {
  /** Immutable content-addressed write. Return only after the bytes are durable. */
  put(key: string, bytes: Uint8Array, mediaType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  /** Optional new-write key policy; absent means the historical PostgreSQL key. */
  keyFor?(spaceId:string,sha256:string):string;
}
export const bytesHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const MAX_SINGLE_BLOB_BYTES=16*1024*1024;
const SHA256=/^[a-f0-9]{64}$/u;
const R2_PREFIX='r2/v1/';
export function isR2BlobKey(key:string,spaceId?:string,sha256?:string):boolean{
  if(!key.startsWith(R2_PREFIX))return false;
  const parts=key.slice(R2_PREFIX.length).split('/');
  if(parts.length<2||parts.some(part=>!part))return false;
  const digest=parts.at(-1)!,encodedSpace=parts.at(-2)!;
  if(!SHA256.test(digest)||sha256!==undefined&&digest!==sha256)return false;
  if(spaceId!==undefined&&encodedSpace!==encodeURIComponent(spaceId))return false;
  try{return encodeURIComponent(decodeURIComponent(encodedSpace))===encodedSpace;}catch{return false;}
}
function assertR2Key(key:string):string{
  if(!isR2BlobKey(key))throw new Error('Invalid R2 content-addressed blob key');
  return key.slice(key.lastIndexOf('/')+1);
}
function bounded(bytes:Uint8Array,maxBytes:number):void{
  if(bytes.byteLength>maxBytes)throw new Error('Blob exceeds 16 MiB single-upload limit');
}
function validPrefix(prefix:string):string{
  if(!prefix)return '';
  if(prefix.length>120||prefix.split('/').some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9._~-]+$/u.test(part)))
    throw new Error('Invalid R2 blob key prefix');
  return `${prefix}/`;
}

export interface R2BlobConfiguration {
  endpoint:string;bucket:string;accessKeyId:string;secretAccessKey:string;keyPrefix?:string;maxBytes?:number;
}
function maxSingleBytes(value:number|undefined):number{
  if(value===undefined)return MAX_SINGLE_BLOB_BYTES;
  if(!Number.isSafeInteger(value)||value<1||value>MAX_SINGLE_BLOB_BYTES)throw new Error('R2 maxBytes must be between 1 and 16 MiB');
  return value;
}
/** One private S3-compatible bucket. The SDK client is injected for deterministic tests. */
export class R2BlobStore implements BlobStore {
  private readonly prefix:string;
  private readonly maxBytes:number;
  constructor(private readonly client:S3Client,private readonly bucket:string,options:{keyPrefix?:string;maxBytes?:number}={}){
    if(!bucket?.trim())throw new Error('R2 bucket is required');
    this.prefix=validPrefix(options.keyPrefix??'');this.maxBytes=maxSingleBytes(options.maxBytes);
  }
  keyFor(spaceId:string,sha256:string):string{
    if(!spaceId?.trim()||!SHA256.test(sha256))throw new Error('Invalid R2 blob identity');
    return `${R2_PREFIX}${this.prefix}${encodeURIComponent(spaceId)}/${sha256}`;
  }
  async put(key:string,bytes:Uint8Array,mediaType?:string):Promise<void>{
    const digest=assertR2Key(key);bounded(bytes,this.maxBytes);
    if(bytesHash(bytes)!==digest)throw new Error('R2 blob key does not match bytes');
    try{
      await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:bytes,ContentLength:bytes.byteLength,
        ...(mediaType?{ContentType:mediaType}:{}),IfNoneMatch:'*'}));
    }catch(error){
      const code=(error as {name?:string;$metadata?:{httpStatusCode?:number}});
      if(code.name!=='PreconditionFailed'&&code.$metadata?.httpStatusCode!==412)throw error;
    }
    const stored=await this.get(key);
    if(stored.byteLength!==bytes.byteLength||bytesHash(stored)!==digest)throw new Error('Immutable R2 blob key conflict');
  }
  async get(key:string):Promise<Uint8Array>{
    const digest=assertR2Key(key);
    const result=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key}));
    if(!result.Body)throw new Error('R2 blob missing or body empty');
    if(result.ContentLength!==undefined&&result.ContentLength>this.maxBytes)throw new Error('R2 blob exceeds 16 MiB read limit');
    const chunks:Buffer[]=[];let size=0;
    for await(const part of result.Body as AsyncIterable<Uint8Array>){
      const chunk=Buffer.from(part);size+=chunk.byteLength;
      if(size>this.maxBytes)throw new Error('R2 blob exceeds 16 MiB read limit');
      chunks.push(chunk);
    }
    const bytes=new Uint8Array(Buffer.concat(chunks,size));
    if(bytesHash(bytes)!==digest)throw new Error('R2 blob integrity check failed');
    return bytes;
  }
}
export function createR2BlobStore(config:R2BlobConfiguration):R2BlobStore{
  let endpoint:URL;
  try{endpoint=new URL(config.endpoint);}catch{throw new Error('R2 endpoint must be a private HTTPS URL');}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')
    throw new Error('R2 endpoint must be a private HTTPS URL');
  if(!config.accessKeyId?.trim()||!config.secretAccessKey?.trim())throw new Error('R2 credentials must be explicitly configured');
  const client=new S3Client({region:'auto',endpoint:endpoint.toString(),forcePathStyle:true,
    credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},requestChecksumCalculation:'WHEN_REQUIRED'});
  return new R2BlobStore(client,config.bucket,{keyPrefix:config.keyPrefix,maxBytes:config.maxBytes});
}
/** Read historical PostgreSQL keys unchanged, while new writes use the configured R2 bucket. */
export class RoutedBlobStore implements BlobStore {
  constructor(private readonly legacy:BlobStore,private readonly r2:R2BlobStore){}
  keyFor(spaceId:string,sha256:string):string{return this.r2.keyFor(spaceId,sha256);}
  put(key:string,bytes:Uint8Array,mediaType?:string):Promise<void>{
    if(key.startsWith(R2_PREFIX))return this.r2.put(key,bytes,mediaType);
    return this.legacy.put(key,bytes,mediaType);
  }
  get(key:string):Promise<Uint8Array>{
    if(key.startsWith(R2_PREFIX))return this.r2.get(key);
    return this.legacy.get(key);
  }
}

/** Portable baseline for small integration/media fixtures. No local file is the original.
 * Large production media should use a private object provider implementing BlobStore. */
export class PostgresBlobStore implements BlobStore {
  constructor(private readonly pool: Pool, readonly maxBytes = MAX_SINGLE_BLOB_BYTES) {}
  async migrate(): Promise<void> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(4832941, 3)');
      const existing = await db.query<{ table_name: string | null }>(
        "SELECT to_regclass(format('%I.%I', current_schema(), 'ws_blob_bytes'))::text AS table_name",
      );
      if (!existing.rows[0]?.table_name) {
        await db.query('CREATE TABLE ws_blob_bytes (key text PRIMARY KEY, bytes bytea NOT NULL, sha256 text NOT NULL)');
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    if(key.startsWith(R2_PREFIX))throw new Error('R2 blob requires configured object provider');
    if (bytes.byteLength > this.maxBytes) throw new Error('Blob exceeds PostgreSQL baseline size limit; configure a managed object provider');
    const hash = bytesHash(bytes);
    await this.pool.query('INSERT INTO ws_blob_bytes(key,bytes,sha256) VALUES ($1,$2,$3) ON CONFLICT(key) DO NOTHING', [key,Buffer.from(bytes),hash]);
    const stored = await this.get(key);
    if (bytesHash(stored) !== hash) throw new Error('Immutable blob key conflict');
  }
  async get(key: string): Promise<Uint8Array> {
    if(key.startsWith(R2_PREFIX))throw new Error('R2 blob requires configured object provider');
    const result = await this.pool.query<{bytes: Buffer; sha256: string}>('SELECT bytes,sha256 FROM ws_blob_bytes WHERE key=$1', [key]);
    const row = result.rows[0];
    if (!row || bytesHash(row.bytes) !== row.sha256) throw new Error('Blob missing or integrity check failed');
    return new Uint8Array(row.bytes);
  }
}
