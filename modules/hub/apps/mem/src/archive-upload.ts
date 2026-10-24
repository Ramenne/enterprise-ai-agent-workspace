import type {IOBudget} from '../../../packages/platform/src/machine-budget.js';
/** Next-version opt-in integration. Not registered in the currently frozen Mem server. */
import type {FastifyInstance} from 'fastify';import {z} from 'zod';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';import {sourceFromRequest} from '../../../packages/platform/src/source.js';
import {verifyFinal,type ObjectAdapter} from './objects.js';import type {S3Uploads} from './s3-upload.js';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export function registerArchiveUpload(app:FastifyInstance,adapter:ObjectAdapter|undefined,uploads:S3Uploads|undefined,call:Call,budget?:IOBudget){
 app.post('/v2/uploads/:id/publish-archive',async request=>{
  const parsed=z.object({project_id:z.uuid(),expected_project_revision:z.number().int().positive(),expected_owner_id:z.uuid(),reason:z.string().max(500).optional(),attempt:z.number().int().positive().optional(),fencing_token:z.uuid().optional()}).strict().safeParse(request.body),id=z.uuid().safeParse((request.params as {id:string}).id);
  if(!parsed.success||!id.success)throw new DomainError('invalid_input');const b={...parsed.data,operation_id:id.data},token=bearer(request),source=sourceFromRequest(request);
  const invoke=(name:string,body:Record<string,unknown>)=>call(token,source,name,'mem.upload',body);
  if(b.attempt!==undefined&&b.fencing_token!==undefined)return invoke('publish_archive_upload',b);
  if(!adapter)throw new DomainError('object_store_unconfigured',503,true);
  if(uploads){const staging=await invoke('upload_control',{project_id:b.project_id,operation_id:b.operation_id,command:'list'});if(staging['state']!=='completed')throw new DomainError('staging_upload_incomplete',409);}
  const capacity=await budget?.acquire('verify',0,{deadline:Date.now()+25000});try{const claimed=await invoke('claim_archive_upload',b);if(claimed['state']==='published')return claimed;capacity?.limitUntil(Date.parse(String(claimed['lease_until'])));
  const verified=await verifyFinal(adapter,String(claimed['staging_key']),{sha256:String(claimed['expected_hash']),size:Number(claimed['expected_size'])},capacity?{configured:true,acquire:async()=>capacity,close:async()=>{},status:()=>({state:'held'})}:undefined,async()=>{await invoke('upload_effect_check',{project_id:b.project_id,operation_id:b.operation_id,attempt:claimed['attempt'],fencing_token:claimed['fencing_token']});});
  const fence={...b,attempt:claimed['attempt'],fencing_token:claimed['fencing_token']};
  await invoke('verify_upload',{...fence,provider:verified.provider,bucket:verified.bucket,object_key:verified.key,provider_version_id:verified.versionId,sha256:verified.sha256,size:verified.size});
  return invoke('publish_archive_upload',fence);
 }finally{await capacity?.release();}
 });
}
