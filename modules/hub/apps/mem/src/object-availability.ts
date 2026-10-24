import type {IOBudget} from '../../../packages/platform/src/machine-budget.js';
import {z} from 'zod';
import {GetObjectCommand,type S3Client} from '@aws-sdk/client-s3';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
import {digest} from '../../../packages/platform/src/canonical.js';
import {prepareVerifiedRead,type ObjectAdapter,type FixedObject} from './objects.js';
import type {FastifyInstance} from 'fastify';
const fixed=z.object({provider:z.literal('s3-compatible'),bucket:z.string().min(1).max(200),key:z.string().regex(/^final\/[0-9a-f-]{36}$/i),version_id:z.string().min(1).max(512).refine(x=>!['null','undefined'].includes(x))}).strict();
const sourceRef=z.object({project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid()}).strict();
const base={project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid(),idempotency_key:z.string().min(1).max(200),judgment:z.record(z.string(),z.unknown()).optional()};
type Locator=z.infer<typeof fixed>;
type Observation={locator:Locator;status:'verified'|'not_found'|'forbidden'|'timeout'|'integrity_mismatch'|'provider_error'|'restore_required'|'restoring';sha256?:string;size?:number;provider_code?:string};
export function providerFailure(error:unknown):Observation['status']{
 const e=error as {code?:string;name?:string;$metadata?:{httpStatusCode?:number}};
 if(['InvalidObjectState','restore_required'].includes(e.code??e.name??''))return'restore_required';
 if(['RestoreAlreadyInProgress','restoring'].includes(e.code??e.name??''))return'restoring';
 if(e.$metadata?.httpStatusCode===403)return'forbidden';if(e.$metadata?.httpStatusCode===404)return'not_found';
 if(['AbortError','TimeoutError','RequestTimeout','TimeoutError'].includes(e.name??'')||['ETIMEDOUT','ECONNABORTED','RequestTimeout'].includes(e.code??''))return'timeout';
 if(error instanceof DomainError&&['object_integrity_mismatch','object_version_mismatch'].includes(error.code))return'integrity_mismatch';return'provider_error';
}
export async function observeFixed(adapter:ObjectAdapter,locator:Locator,expected:{sha256:string;size:number},budget?:IOBudget,beforeRead?:()=>Promise<void>):Promise<Observation>{
 try{
  const actual:FixedObject={provider:locator.provider,bucket:locator.bucket,key:locator.key,versionId:locator.version_id};
  const s3=adapter as ObjectAdapter&{client?:S3Client;config?:{bucket:string}};
  const bounded:ObjectAdapter=s3.client&&s3.config?{mode:'real',copyToImmutable:(a,b)=>adapter.copyToImmutable(a,b),read:async object=>{
   if(object.bucket!==s3.config!.bucket)throw new DomainError('invalid_fixed_object');
   const r=await s3.client!.send(new GetObjectCommand({Bucket:object.bucket,Key:object.key,VersionId:object.versionId}),{abortSignal:AbortSignal.timeout(10000)});
   if(r.VersionId&&r.VersionId!==object.versionId)throw new DomainError('object_version_mismatch',503);if(!r.Body||!(Symbol.asyncIterator in r.Body))throw new DomainError('object_stream_unavailable',503);return r.Body as AsyncIterable<Uint8Array>;
  }}:adapter;
  const verified=await prepareVerifiedRead(bounded,actual,expected,budget,beforeRead);await verified.cleanup();return{locator,status:'verified',...expected};
 }catch(error){if(error instanceof DomainError&&error.code.startsWith('capacity_'))throw error;const status=providerFailure(error);return{locator,status,provider_code:status};}
}
export function registerObjectAvailability(app:FastifyInstance,adapter:ObjectAdapter|undefined,call:(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>,budget?:IOBudget){
 for(const command of ['probe','import_copy']as const)app.post(command==='probe'?'/v2/objects/probe':'/v2/objects/repair',async request=>{
  const schema=command==='probe'?z.object(base).strict():z.object({...base,fixed_copy:fixed.optional(),source_ref:sourceRef.optional()}).strict().refine(x=>Boolean(x.fixed_copy)!==Boolean(x.source_ref));const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');if(!adapter||adapter.mode!=='real')throw new DomainError('object_store_unconfigured',503,true);
  const body={...parsed.data,command},token=bearer(request),source=sourceFromRequest(request),action=command==='import_copy'?'mem.write':'mem.read';
  const prepared=await call(token,source,'object_probe_prepare',action,body);if(prepared['state']!=='prepared')return prepared;
  const input=parsed.data as unknown as {fixed_copy?:Locator;source_ref?:z.infer<typeof sourceRef>};
  let authorizedSource:Record<string,unknown>|undefined;
  if(input.source_ref)authorizedSource=await call(token,source,'read_version','mem.read',input.source_ref);
  const locators=command==='probe'?prepared['locators']as Locator[]:input.source_ref?[authorizedSource!['object']as Locator]:[input.fixed_copy!];
  if(command==='import_copy'&&!input.source_ref){const original=(prepared['locators']as Locator[])[0]!;const copy=locators[0]!;if(copy.provider!==original.provider||copy.bucket!==original.bucket||copy.key!==original.key)throw new DomainError('repair_copy_must_match_registered_target',403);}
  const observations:Observation[]=[];for(const locator of locators)observations.push(await observeFixed(adapter,locator,{sha256:String(prepared['sha256']),size:Number(prepared['size'])},budget,async()=>{await call(token,source,'object_probe_prepare',action,body);}));
  if(input.source_ref)await call(token,source,'read_version','mem.read',input.source_ref);
  return call(token,source,'object_probe_finish',action,{...body,operation_id:prepared['operation_id'],original_request_hash:digest(body),observations});
 });
}
