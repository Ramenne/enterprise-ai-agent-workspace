import { S3Client, CopyObjectCommand, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DomainError } from './http.js';

export interface S3Config { endpoint:string;region:string;bucket:string;accessKeyId:string;secretAccessKey:string;sessionToken?:string;
 forcePathStyle?:boolean;credentialProvider?:()=>Promise<{accessKeyId:string;secretAccessKey:string;sessionToken?:string;expiration?:Date}>; }
export interface StoredObject { provider:string;bucket:string;key:string;versionId:string; }
/** S3-compatible object capability. Credentials remain in the service process. */
export class S3Objects {
 readonly mode='real' as const;
 readonly client:S3Client;
 constructor(readonly config:S3Config){
  const endpoint=new URL(config.endpoint);if(endpoint.protocol!=='https:')throw new Error('Object storage must use TLS');
  this.client=new S3Client({endpoint:config.endpoint,region:config.region,forcePathStyle:config.forcePathStyle??true,
   credentials:config.credentialProvider??{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey,...(config.sessionToken?{sessionToken:config.sessionToken}:{})},
    requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',maxAttempts:2});
  if(endpoint.hostname.endsWith('.myqcloud.com'))this.client.middlewareStack.add((next,context)=>async args=>{
   const result=await next(args);
   const response=result.response as {statusCode?:number;headers?:Record<string,string>;body?:Uint8Array|AsyncIterable<Uint8Array>};
   if(context.commandName==='CopyObjectCommand'&&response.statusCode===200&&response.body&&response.headers&&!response.headers['x-amz-version-id']){
    const parts:Buffer[]=[];let size=0;
    if(response.body instanceof Uint8Array){parts.push(Buffer.from(response.body));size=response.body.byteLength;}
    else for await(const part of response.body){size+=part.byteLength;if(size>65536)throw new DomainError('copy_provider_response_invalid',503,true);parts.push(Buffer.from(part));}
    if(size>65536)throw new DomainError('copy_provider_response_invalid',503,true);
    const body=Buffer.concat(parts);response.body=body;
    const version=body.toString('utf8').match(/<VersionId>([^<]{1,512})<\/VersionId>/)?.[1];
    if(version&&version!=='null')response.headers['x-amz-version-id']=version;
   }
   return result;
  },{step:'deserialize',name:'hub2CosTargetVersion',priority:'low'});
 }
 async copyToImmutable(stagingKey:string,finalKey:string):Promise<StoredObject>{
  if(!stagingKey.startsWith('staging/')||!/^final\/[0-9a-f-]{36}$/i.test(finalKey))throw new DomainError('invalid_object_key');
  const head=await this.client.send(new HeadObjectCommand({Bucket:this.config.bucket,Key:stagingKey}));
  if(!head.VersionId||head.VersionId==='null')throw new DomainError('staging_object_version_unavailable',503,true);
  const source=this.config.bucket+'/'+stagingKey;
  const response=await this.client.send(new CopyObjectCommand({Bucket:this.config.bucket,Key:finalKey,
   CopySource:source.split('/').map(encodeURIComponent).join('/')+'?versionId='+encodeURIComponent(head.VersionId),MetadataDirective:'COPY'}));
  // COS can omit the target ID in CopyObject even with bucket versioning enabled.
  // The target is a freshly generated server UUID; resolve its real version, then
  // verifyFinal reads exactly that ID and verifies whole size/hash before publish.
  const versionId=response.VersionId&&response.VersionId!=='null'?response.VersionId:
   (await this.client.send(new HeadObjectCommand({Bucket:this.config.bucket,Key:finalKey}))).VersionId;
  if(!versionId||versionId==='null')throw new DomainError('copied_object_version_unavailable',503,true);
  return {provider:'s3-compatible',bucket:this.config.bucket,key:finalKey,versionId};
 }
 async read(object:StoredObject):Promise<AsyncIterable<Uint8Array>>{
  if(object.bucket!==this.config.bucket||!object.versionId||object.versionId==='null')throw new DomainError('invalid_fixed_object');
  const response=await this.client.send(new GetObjectCommand({Bucket:object.bucket,Key:object.key,VersionId:object.versionId}));
  if(response.VersionId&&response.VersionId!==object.versionId)throw new DomainError('object_version_mismatch',503);
  const body=response.Body;
  if(!body||!(Symbol.asyncIterator in body))throw new DomainError('object_stream_unavailable',503);
  return body as AsyncIterable<Uint8Array>;
 }
 async stagingTicket(stagingKey:string,expiresIn=300):Promise<{url:string;expires_in:number;method:'PUT'}>{
  if(!stagingKey.startsWith('staging/')||expiresIn<1||expiresIn>300)throw new DomainError('invalid_upload_ticket');
  return {url:await getSignedUrl(this.client,new PutObjectCommand({Bucket:this.config.bucket,Key:stagingKey}),{expiresIn}),expires_in:expiresIn,method:'PUT'};
 }
 async inspect(key:string,versionId:string){
  if(!versionId||versionId==='null')throw new DomainError('fixed_object_version_required');
  const response=await this.client.send(new HeadObjectCommand({Bucket:this.config.bucket,Key:key,VersionId:versionId}));
  return {size:response.ContentLength,versionId:response.VersionId};
 }
 close():void {this.client.destroy();}
}
