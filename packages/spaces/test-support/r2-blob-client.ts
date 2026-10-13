import {GetObjectCommand,PutObjectCommand,type S3Client} from '@aws-sdk/client-s3';

/** Deterministic in-memory S3 conditional-write behavior for adapter and service tests. */
export function fakeS3(){
  const objects=new Map<string,Uint8Array>();
  const puts:Array<{key:string;ifNoneMatch:string|undefined;contentType:string|undefined}>=[];
  const client={async send(command:PutObjectCommand|GetObjectCommand){
    if(command instanceof PutObjectCommand){
      const {Key,Body,IfNoneMatch,ContentType}=command.input;
      if(!Key||!(Body instanceof Uint8Array))throw new Error('Unexpected test PUT');
      puts.push({key:Key,ifNoneMatch:IfNoneMatch,contentType:ContentType});
      if(objects.has(Key)){const error=new Error('Already exists') as Error&{$metadata:{httpStatusCode:number}};error.name='PreconditionFailed';error.$metadata={httpStatusCode:412};throw error;}
      objects.set(Key,new Uint8Array(Body));return {};
    }
    if(command instanceof GetObjectCommand){
      const bytes=objects.get(command.input.Key??'');
      if(!bytes)throw new Error('Object missing');
      return {ContentLength:bytes.byteLength,Body:{async *[Symbol.asyncIterator](){yield new Uint8Array(bytes);}}};
    }
    throw new Error('Unexpected S3 command');
  }} as unknown as S3Client;
  return {client,objects,puts};
}
