import type pg from 'pg';
import {DeleteObjectCommand,HeadObjectCommand,S3Client} from '@aws-sdk/client-s3';
export interface Locator {provider:string;bucket:string;key:string;version_id:string}
export interface DeleteProvider {deleteExact(locator:Locator,signal:AbortSignal):Promise<{request_id:string}>; presentExact(locator:Locator,signal:AbortSignal):Promise<boolean>}
export class ExactS3Delete implements DeleteProvider {
 constructor(private client:S3Client,private allow:{provider:string;bucket:string;prefix:string;fixed_version_absence_verified?:boolean}){
  if(!allow.prefix || allow.prefix==='/' || !allow.prefix.endsWith('/'))throw new Error('explicit_gc_prefix_required');
 }
 private checked(l:Locator){if(l.provider!==this.allow.provider||l.bucket!==this.allow.bucket||!l.key.startsWith(this.allow.prefix)||!l.version_id||['null','undefined'].includes(l.version_id))throw new Error('gc_provider_scope_rejected');}
 async deleteExact(l:Locator,signal:AbortSignal){this.checked(l);const r=await this.client.send(new DeleteObjectCommand({Bucket:l.bucket,Key:l.key,VersionId:l.version_id}),{abortSignal:signal});
  if(r.DeleteMarker||r.VersionId&&r.VersionId!==l.version_id||!r.$metadata.requestId)throw new Error('gc_delete_receipt_unknown');
  return {request_id:r.$metadata.requestId};
 }
 async presentExact(l:Locator,signal:AbortSignal){this.checked(l);
  try{const r=await this.client.send(new HeadObjectCommand({Bucket:l.bucket,Key:l.key,VersionId:l.version_id}),{abortSignal:signal});
   if(r.$metadata.httpStatusCode!==200||r.VersionId!==l.version_id||r.DeleteMarker)throw new Error('gc_fixed_head_response_unknown');
   return true;
  }catch(error){const e=error as {name?:string;$metadata?:{httpStatusCode?:number}};
   if(this.allow.fixed_version_absence_verified===true&&e.$metadata?.httpStatusCode===404&&['NotFound','NoSuchVersion','NoSuchKey'].includes(e.name??''))return false;
   throw error;
  }
 }

}
/** Dedicated pool has only dispatch/finish/reconcile, no actor impersonation or plan/seal authority. */
export async function executeGC(pool:pg.Pool,provider:DeleteProvider,plan:string,token:string){
 const r=await pool.query('select mem.gc_dispatch($1::uuid,$2::uuid) result',[plan,token]);const claim=r.rows[0].result as {locator:Locator;locators?:Locator[];lease_until:string};
 const left=new Date(claim.lease_until).getTime()-Date.now();let outcome:'succeeded'|'failed'|'unknown'='unknown';let receipt:Record<string,unknown>;
 if(left<=0){outcome='failed';receipt={code:'lease_expired_before_provider_dispatch',deletion_attempted:false,locator:claim.locator};}
 else{const effects:Array<Record<string,unknown>>=[];try{for(const target of claim.locators??[claim.locator]){const remaining=new Date(claim.lease_until).getTime()-Date.now();if(remaining<=0)throw new Error('gc_execution_lease_expired');const deleted=await provider.deleteExact(target,AbortSignal.timeout(Math.max(1,Math.min(remaining,240000))));effects.push({...deleted,locator:target,exact_version:true});}outcome='succeeded';receipt={locator:claim.locator,effects,all_owned_locators_deleted:true,deletion_attempted:true};}
 catch(error){const e=error as {name?:string;$metadata?:{httpStatusCode?:number;requestId?:string}};const definitive=e.$metadata?.httpStatusCode===403;outcome=definitive?'failed':'unknown';receipt={code:definitive?'provider_denied':'provider_outcome_unknown',provider_code:e.name??'unknown',request_id:e.$metadata?.requestId??null,locator:claim.locator,effects,deletion_attempted:true};}}
 const finished=await pool.query('select mem.gc_finish($1::uuid,$2::uuid,$3::text,$4::jsonb) result',[plan,token,outcome,JSON.stringify(receipt)]);return finished.rows[0].result;
}
export async function reconcileGC(pool:pg.Pool,provider:DeleteProvider,plan:string,token:string,locator:Locator,locators:Locator[]=[locator]){
 // Caller supplies fixed locator but DB compares it to its retained sealed tuple.
 let present=false;for(const target of locators){if(await provider.presentExact(target,AbortSignal.timeout(60000)))present=true;}
 const result=await pool.query('select mem.gc_reconcile($1::uuid,$2::uuid,$3::jsonb) result',[plan,token,JSON.stringify({locator,locators,present,scan_complete:true,method:'authenticated_exact_version_HEAD',coverage:'sealed_locators_only'})]);return result.rows[0].result;
}
