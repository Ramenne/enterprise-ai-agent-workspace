import {registerMaterialWarming}from'./material-warming.mjs';
import {registerMaterialProperties}from'./material-properties.mjs';
import{registerMaterialLocate}from'./material-locate.mjs';
import {registerReferenceResolve} from './reference-resolve.mjs';
import {registerLegacyLookup} from './legacy-lookup.mjs';
import {createArchiveLifecycle} from '../../../packages/storage-tiers/src/archive-lifecycle.mjs';
import {registerArchiveLifecycle} from '../../../packages/storage-tiers/src/archive-lifecycle-http.mjs';
import {knownCopyEvidence} from '../../../packages/storage-tiers/src/known-copy-evidence.mjs';
import {registerStorageTiers} from '../../../packages/storage-tiers/src/storage-tier-flow.mjs';
import{registerScopeMove}from'./scope-move-flow.js';
import {registerLegacyFlow} from './legacy-flow.js';
import {registerExternalModel,externalReleaseSchema,externalRevokeSchema,type ExternalModelConfig} from './external-model-flow.js';
import type {IOBudget,BudgetLease} from '../../../packages/platform/src/machine-budget.js';
import {Readable,Transform} from 'node:stream';
import {registerGC,type GCRelay} from './gc-flow.js';
import {recordSuccessfulCapability} from '../../../packages/platform/src/observed-scope.js';
import {registerCompensation} from './compensation.js';
import {registerObjectAvailability} from './object-availability.js';
import {registerVectorFlow} from './vector-flow.js';
import {registerDescriptionFlow} from './description-flow.js';
import {installChanges} from '../../../packages/platform/src/changes.js';
import {installUsage} from '../../../packages/platform/src/usage.js';
import {cacheFor} from './verified-cache.js';
import {AuthorizedDownload} from './authorized-download.js';
import type pg from 'pg';
import { z } from 'zod';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
import { server, bearer, DomainError } from '../../../packages/platform/src/http.js';
import { database, sqlFunction } from '../../../packages/platform/src/db.js';
import { decide, type DecisionConfig } from '../../../packages/platform/src/decision.js';
import { canonical,digest } from '../../../packages/platform/src/canonical.js';
import {registerAgentFlow} from './agent-flow.js';
import {registerProcessingFlow} from './processing-flow.js';
import {registerGovernanceFlow} from './governance-flow.js';
import {registerEquivalenceFlow} from './equivalence-flow.js';
import {registerMaterialNavigation} from './navigation-flow.js';
import {registerArchiveUpload} from './archive-upload.js';
import {registerUploads} from './upload-http.js';
import type {S3Uploads} from './s3-upload.js';
import { tokens,tokenRecipe } from './tokenize.js';
import { verifyFinal,prepareVerifiedRead,type ObjectAdapter,type FixedObject } from './objects.js';
export interface MemConfig extends DecisionConfig,ExternalModelConfig { databaseUrl: string; storageTierProvider?:object; ioBudget?:IOBudget; objectAdapter?: ObjectAdapter; pool?: pg.Pool; usagePool?:pg.Pool; usageSpoolDirectory?:string; uploads?:S3Uploads; legacyVectorWritesEnabled?:boolean; streamAuthorization?:{intervalMs?:number;timeoutMs?:number}; gcExecutor?:GCRelay; }
const uuid=z.uuid();
const fixedRef=z.object({material_id:uuid,version_id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new DomainError('invalid_input');return result.data;} 
const base={project_id:uuid};
const mutation={...base,idempotency_key:z.string().min(1).max(200)};
const upload=z.object({...base,idempotency_key:z.string().min(1).max(200),material_id:uuid.optional(),expected_version_id:uuid.nullable().optional(),expected_revision:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/),size:z.number().int().nonnegative(),logical_path:z.string().min(1).max(1024),origin_kind:z.enum(['member_submission','service_generated','agent_processed']).optional(),producer:z.string().max(200).optional(),properties:z.record(z.string(),z.unknown()).optional()}).strict();
const responseFields=new Set(['operation_id','state','domain_revision','content_revision','metadata_revision','fixed_refs','receipt','coverage','retryable','error_code','retained_state','next_step','material_id','staging_key','business_registration','snapshot_id','returned_count','total_count','next_cursor','expires_at','processing_pending','contract_version','items','recipe','run_id','inputs','outputs','technical_state','attempt','fencing_token','lease_until','semantic_status','placement_id','collection_id','read_receipt_id','invalidation_id','affected_count','disclosure_id','quality_status','version_id','maintenance']);
export function publicResponse(result:Record<string,unknown>):Record<string,unknown> { const out:Record<string,unknown>={};for(const[key,value]of Object.entries(result))if(responseFields.has(key))out[key]=value;if(result['id'])out['run_id']=result['id'];return out;}
export function createServer(config:MemConfig) {
 if(config.objectAdapter?.mode==='test')throw new Error('test object adapter cannot serve formal material API');
 const app=server('mem');if(config.objectAdapter)app.addHook('onClose',async()=>cacheFor(config.objectAdapter!,config.ioBudget).close());const pool=config.pool??database(config.databaseUrl);
 installUsage(app,pool,{...(config.usagePool?{pool:config.usagePool}:{}),...(config.usageSpoolDirectory?{directory:config.usageSpoolDirectory}:{})});installChanges(app,pool,config);if(!config.pool)app.addHook('onClose',async()=>pool.end());
 async function call(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>) {
  const resource={...body,project_id:body['project_id'],...(body['material_id']?{material_id:body['material_id']}:{})};
  const decision=await decide(config,token,action,resource,body,source);
  return sqlFunction<Record<string,unknown>>(pool,'mem.'+name,[decision.handle,digest(body),canonical(body)]);
 }
 registerMaterialLocate(app,{z,bearer,sourceFromRequest,DomainError,pool,sqlFunction,call,hufuUrl:config.hufuUrl});
 registerReferenceResolve(app,{z,bearer,sourceFromRequest,DomainError,pool,sqlFunction,call,hufuUrl:config.hufuUrl});
 const lifecycle=createArchiveLifecycle({call,provider:config.storageTierProvider,loadKnownCopyEvidence:knownCopyEvidence('/srv/workspace',process.getuid())});
registerArchiveLifecycle(app,{z,bearer,sourceFromRequest,DomainError,lifecycle,call});
registerStorageTiers(app,{z,bearer,sourceFromRequest,call,digest,DomainError,provider:config.storageTierProvider,budget:config.ioBudget,afterCopyCreated:(token,source,body)=>lifecycle(token,source,body)});
 registerScopeMove(app,pool,config);
 registerGC(app,call,config.gcExecutor);
 registerExternalModel(app,pool,call,config);
 registerLegacyFlow(app,call);
 registerLegacyLookup(app,{z,bearer,sourceFromRequest,call,DomainError});
 registerObjectAvailability(app,config.objectAdapter,call,config.ioBudget);
 registerCompensation(app,call);
 registerVectorFlow(app,call,{legacyWritesEnabled:config.legacyVectorWritesEnabled===true});
 registerDescriptionFlow(app,call);
 registerUploads(app,config.uploads,call);
 registerAgentFlow(app,config.objectAdapter,config.uploads,call,config.ioBudget);
 registerProcessingFlow(app,call);
 registerGovernanceFlow(app,call);
 registerMaterialProperties(app,{z,bearer,sourceFromRequest,call,DomainError,pool,sqlFunction});
 registerMaterialWarming(app,{z,bearer,sourceFromRequest,call,provider:config.storageTierProvider,DomainError});
 registerEquivalenceFlow(app,call);
 registerMaterialNavigation(app,call);
 registerArchiveUpload(app,config.objectAdapter,config.uploads,call,config.ioBudget);
 app.post('/v2/materials/fixed-reference',async request=>{const body=parse(z.object({...base,material_id:uuid,version_id:uuid}).strict(),request.body);const token=bearer(request),source=sourceFromRequest(request);const result=await call(token,source,'read_version','mem.read',body);await call(token,source,'gc_read_lease','mem.read',{...body,read_receipt_id:result['read_receipt_id'],command:'release'});return {state:'authorized_fixed_reference',fixed_ref:result['fixed_ref']};});
 const routes:Array<[string,string,string,z.ZodType]>=[
 ['/v2/uploads','begin_upload','mem.upload',upload],
 ['/v2/uploads/rebase','rebase_upload','mem.upload',z.object({...mutation,operation_id:uuid,expected_revision:z.number().int().nonnegative(),expected_version_id:uuid.nullable()}).strict()],
 ['/v2/material-enumerations','enumerate','mem.read',z.object(base).strict()],
 ['/v2/material-enumerations/page','enumeration_page','mem.read',z.object({...base,snapshot_id:uuid,cursor:z.number().int().nonnegative(),limit:z.number().int().min(1).max(500).optional()}).strict()],
 ['/v2/materials/search','search_materials','mem.read',z.object({...base,query:z.string().max(200).optional(),properties:z.record(z.string(),z.unknown()).optional(),limit:z.number().int().min(1).max(500).optional()}).strict()],
 ['/v2/operations/query','operation','mem.read',z.object({...base,operation_id:uuid}).strict()],
 ['/v2/collections','manage_collection','mem.write',z.object({...mutation,collection_id:uuid.optional(),expected_revision:z.number().int().nonnegative().optional(),name:z.string().min(1).max(500)}).strict()],
 ['/v2/materials/metadata','patch_metadata','mem.write',z.object({...mutation,material_id:uuid,expected_revision:z.number().int().nonnegative(),properties:z.record(z.string(),z.unknown()).optional(),collection_id:uuid.nullable().optional()}).strict()],
 ['/v2/placements/patch','patch_placement','mem.write',z.object({...mutation,placement_id:uuid,expected_revision:z.number().int().nonnegative(),logical_path:z.string().min(1).max(1024)}).strict()],
 ['/v2/materials/trash','trash_material','mem.delete',z.object({...mutation,material_id:uuid,expected_revision:z.number().int().nonnegative(),restore:z.boolean().optional()}).strict()],
 ['/v2/materials/restore-content','restore_content','mem.write',z.object({...mutation,material_id:uuid,version_id:uuid,expected_revision:z.number().int().nonnegative()}).strict()],
 ['/v2/processing-runs/retry','retry_processing','mem.process',z.object({...base,run_id:uuid,expected_attempt:z.number().int().positive()}).strict()],
 ['/v2/archive-callback/copy-source','archive_copy_source','mem.process',z.object({...base,idempotency_key:z.string().min(1).max(200),inputs:z.array(fixedRef).length(1),outputs:z.array(fixedRef).length(1)}).strict()],
 ['/v2/processing-runs/finish','finish_processing','mem.process',z.object({...base,run_id:uuid,fencing_token:uuid,attempt:z.number().int().positive(),outputs:z.array(fixedRef).min(1).max(100),output_kind:z.enum(['transcript','experience','skill','context','summary','other'])}).strict()],
 ['/v2/materials/index-text','index_text','mem.process',z.object({...base,version_id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/),text:z.string().max(500000),coverage:z.enum(['complete','partial','unknown'])}).strict()],
 ['/v2/disclosures','disclose_manifest','mem.share',z.object({...mutation,version_id:uuid,output_hash:z.string().regex(/^[a-f0-9]{64}$/),actual_source_closure:z.array(uuid).max(1000),audience_project_id:uuid,excluded_content:z.array(z.string()),scope:z.string().min(1),reshare_conditions:z.string().min(1),reason:z.string().min(1),continued_source_access:z.enum(['required','not_required'])}).strict()],
 ['/v2/disclosures/revoke','revoke_disclosure','mem.share',z.object({...mutation,disclosure_id:uuid}).strict()],
 ['/v2/sources/invalidate','invalidate_source','mem.correct',z.object({...mutation,version_id:uuid,reason:z.string().min(1).max(2000)}).strict()],
 ['/v2/read-receipts','record_read','mem.read',z.object({...base,read_receipt_id:uuid,state:z.enum(['acknowledged'])}).strict()]
 ];
 for(const [path,name,action,schema]of routes)app.post(path,async request=>{if(path==='/v2/disclosures'&&(request.body as Record<string,unknown>)?.['provider_target_id']){const value=parse(externalReleaseSchema,request.body);const {resource_selector,...body}=value;return call(bearer(request),sourceFromRequest(request),'external_release_create','mem.share',{...body,external_release_selector:resource_selector});}if(path==='/v2/disclosures/revoke'&&(request.body as Record<string,unknown>)?.['release_id'])return call(bearer(request),sourceFromRequest(request),'external_release_revoke','mem.share',parse(externalRevokeSchema,request.body));const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');const body=parsed.data as Record<string,unknown>;if(name==='index_text'){body['recipe']=tokenRecipe;body['token_text']=tokens(String(body['text'])).join(' ');}if(name==='search_materials')body['token_text']=tokens(String(body['query']??'')).join(' ');return publicResponse(await call(bearer(request),sourceFromRequest(request),name,action,body));});
 app.post('/v2/uploads/:id/publish',async request=>{
  const body=parse(z.object({...base,reason:z.string().max(500).optional(),attempt:z.number().int().positive().optional(),fencing_token:uuid.optional()}).strict(),request.body); const operation_id=parse(uuid,(request.params as {id:string}).id);const token=bearer(request);
  if(body.attempt!==undefined && body.fencing_token!==undefined)return call(token,sourceFromRequest(request),'publish_upload','mem.upload',{...body,operation_id});
  if(!config.objectAdapter)throw new DomainError('object_store_unconfigured',503,true);
  if(config.uploads){const staging=await call(token,sourceFromRequest(request),'upload_control','mem.upload',{project_id:body.project_id,operation_id,command:'list'});if(staging['state']!=='completed')throw new DomainError('staging_upload_incomplete',409);}
  const capacity=await config.ioBudget?.acquire('verify',0,{deadline:Date.now()+25000});try{const claimed=await call(token,sourceFromRequest(request),'claim_upload','mem.upload',{...body,operation_id});
  if(claimed['state']==='published')return claimed;capacity?.limitUntil(Date.parse(String(claimed['lease_until'])));
  const verified=await verifyFinal(config.objectAdapter,String(claimed['staging_key']),{sha256:String(claimed['expected_hash']),size:Number(claimed['expected_size'])},capacity?{configured:true,acquire:async()=>capacity,close:async()=>{},status:()=>({state:'held'})}:undefined,async()=>{await call(token,sourceFromRequest(request),'upload_effect_check','mem.upload',{project_id:body.project_id,operation_id,attempt:claimed['attempt'],fencing_token:claimed['fencing_token']});});
  const fence={...body,operation_id,attempt:claimed['attempt'],fencing_token:claimed['fencing_token']};
  await call(token,sourceFromRequest(request),'verify_upload','mem.upload',{...fence,provider:verified.provider,bucket:verified.bucket,object_key:verified.key,provider_version_id:verified.versionId,sha256:verified.sha256,size:verified.size});
  return call(token,sourceFromRequest(request),'publish_upload','mem.upload',fence);
 }finally{await capacity?.release();}
 });
 app.post('/v2/material-batches',async request=>{
  const item=z.discriminatedUnion('kind',[
   z.object({kind:z.literal('metadata'),material_id:uuid,expected_revision:z.number().int().nonnegative(),properties:z.record(z.string(),z.unknown()).optional(),collection_id:uuid.nullable().optional()}).strict(),
   z.object({kind:z.literal('placement'),placement_id:uuid,expected_revision:z.number().int().nonnegative(),logical_path:z.string().min(1).max(1024)}).strict(),
   z.object({kind:z.literal('trash'),material_id:uuid,expected_revision:z.number().int().nonnegative(),restore:z.boolean().optional()}).strict(),
   z.object({kind:z.literal('restore_content'),material_id:uuid,version_id:uuid,expected_revision:z.number().int().nonnegative()}).strict()
  ]);const body=parse(z.object({...mutation,items:z.array(item).min(1).max(100)}).strict(),request.body);const token=bearer(request);
  const source=sourceFromRequest(request);const batch=await call(token,source,'begin_batch','mem.read',body);
  const readOutcomes=()=>call(token,source,'batch_outcome','mem.read',{project_id:body.project_id,batch_id:batch['operation_id']});
  let saved=await readOutcomes();
  for(let index=0;index<body.items.length;index++){
   if(saved['complete']===true)break;
   const {kind,...input}=body.items[index]!;
   const effectBody:Record<string,unknown>={...input,project_id:body.project_id,idempotency_key:body.idempotency_key+':'+index,batch_operation_id:batch['operation_id'],batch_item_index:index};
   const resource={...effectBody,...(effectBody['material_id']?{material_id:effectBody['material_id']}:{})};
   let effectHandle:string|null=null;let decisionFailure:string|undefined;
   try{effectHandle=(await decide(config,token,kind==='trash'?'mem.delete':'mem.write',resource,effectBody,source)).handle;}
   catch(error){if(!(error instanceof DomainError)||error.status!==403)throw error;decisionFailure='forbidden';}
   const scope={project_id:body.project_id,batch_id:batch['operation_id'],item_index:index,...(decisionFailure?{decision_failure:decisionFailure}:{})};
   const readDecision=await decide(config,token,'mem.read',scope,scope,source);
   saved=await sqlFunction<Record<string,unknown>>(pool,'mem.batch_item_execute',[readDecision.handle,digest(scope),canonical(scope),effectHandle,digest(effectBody),canonical(effectBody)]);
   // SQL usage_context ignores unconsumed candidates (failed/replayed items); committed effects keep their real material/source scope.
   if(effectHandle)recordSuccessfulCapability([effectHandle,digest(effectBody),canonical(effectBody)]);
  }
  saved=await readOutcomes();
  return {operation_id:saved['operation_id'],state:saved['state'],items:saved['items'],coverage:'all_requested_items_attempted',next_step:'retry_same_batch_key_or_explicit_compensation'};
 });
 app.post('/v2/offline-exports',async request=>{const body=parse(z.object(base).strict(),request.body);const snapshot=await call(bearer(request),sourceFromRequest(request),'enumerate','mem.read',body);return {...snapshot,state:'prepared',export_contract:'mem-offline-v1',secrets_included:false,next_step:'fetch_all_export_pages_before_replacing_local_index'};});
 app.post('/v2/offline-exports/page',async (request,reply)=>{
  const body=parse(z.object({...base,snapshot_id:uuid,cursor:z.number().int().nonnegative(),limit:z.number().int().min(1).max(20).optional()}).strict(),request.body);const token=bearer(request);
  if(!config.objectAdapter)throw new DomainError('object_store_unconfigured',503,true);
  const closed=new AbortController();reply.raw.once('close',()=>closed.abort());const capacity=await config.ioBudget?.acquire('verify',0,{deadline:Date.now()+25000,signal:closed.signal});let transportOwned=false,capacityReleased=false;const releaseCapacity=async()=>{if(capacityReleased)return;capacityReleased=true;await capacity?.release();};try{const page=await call(token,sourceFromRequest(request),'enumeration_page','mem.read',body);const materials=page['items'] as Array<Record<string,unknown>>;const copies:Array<Record<string,unknown>>=[];let byteCount=0;
  for(const item of materials){
   const prepared=await call(token,sourceFromRequest(request),'read_version','mem.read',{project_id:body.project_id,material_id:item['material_id'],version_id:item['version_id']});const fixed=prepared['fixed_ref'] as {sha256:string;size:number};
   if(byteCount+fixed.size>32*1024*1024)throw new DomainError('export_page_byte_limit_reduce_page_or_fetch_fixed_file',409);
   const o=prepared['object'] as Record<string,string>;const object:FixedObject={provider:o['provider']!,bucket:o['bucket']!,key:o['key']!,versionId:o['version_id']!};const chunks:Buffer[]=[];
   let received=0;const input=await config.objectAdapter.read(object);for await(const chunk of capacity?await capacity.meter(input,false):input){received+=chunk.byteLength;if(received>fixed.size)throw new DomainError('object_integrity_mismatch',503,true);chunks.push(Buffer.from(chunk));}const bytes=Buffer.concat(chunks);const {sha256}=await import('../../../packages/platform/src/canonical.js');if(bytes.length!==fixed.size||sha256(bytes)!==fixed.sha256)throw new DomainError('object_integrity_mismatch',503,true);
   byteCount+=bytes.length;copies.push({material:item,fixed_ref:fixed,bytes_base64:bytes.toString('base64'),read_receipt_id:prepared['read_receipt_id'],delivery_state:'prepared'});
  }
  reply.raw.once('finish',()=>{for(const copy of copies)void call(token,sourceFromRequest(request),'record_read','mem.read',{project_id:body.project_id,read_receipt_id:copy['read_receipt_id'],state:'sent'}).catch(()=>request.log.warn({error_code:'read_receipt_pending'},'export delivery evidence pending'));});
  const result={state:'prepared',export_contract:'mem-offline-v1',snapshot_id:page['snapshot_id'],returned_count:copies.length,total_count:page['total_count'],next_cursor:page['next_cursor'],coverage:page['coverage'],copies,generated_at:new Date().toISOString(),secrets_included:false,next_step:'acknowledge_delivery_and_verify_all_pages_before_replacing_local_index'};if(capacity){await capacity.phase('read');const output=Readable.from(await capacity.meter((async function*(){yield Buffer.from(JSON.stringify(result));})(),false));reply.header('content-type','application/json; charset=utf-8');const release=()=>{void releaseCapacity();};reply.raw.once('finish',release);reply.raw.once('close',release);if(reply.raw.destroyed||request.raw.aborted)throw new DomainError('download_client_closed_no_body_sent',499);const sent=reply.send(output);transportOwned=true;return sent;}return result;
 }finally{if(!transportOwned)await releaseCapacity();}
 });
 app.post('/v2/files/read',async(request,reply)=>{
  const body=parse(z.object({...base,material_id:uuid,version_id:uuid}).strict(),request.body);const token=bearer(request);const source=sourceFromRequest(request);const closed=new AbortController();reply.raw.once('close',()=>closed.abort());
  if(!config.objectAdapter)throw new DomainError('object_store_unconfigured',503,true);
  const prepared=await call(token,source,'read_version','mem.read',body);const o=prepared['object'] as Record<string,string>;
  const object:FixedObject={provider:o['provider']!,bucket:o['bucket']!,key:o['key']!,versionId:o['version_id']!};
  const fixed=prepared['fixed_ref'] as {sha256:string;size:number};const preparedLease={...body,sha256:fixed.sha256,read_receipt_id:prepared['read_receipt_id'],ttl_seconds:10};let verified;try{verified=await cacheFor(config.objectAdapter,config.ioBudget).acquire(object,fixed,async()=>{await call(token,source,'gc_read_lease','mem.read',{...preparedLease,command:'renew'});});}catch(e){await call(token,source,'gc_read_lease','mem.read',{...preparedLease,command:'release'}).catch(()=>{});throw e;}const {createReadStream}=await import('node:fs');
  let outputCapacity:BudgetLease|undefined;let fresh;try{outputCapacity=await config.ioBudget?.acquire('read',0,{deadline:Date.now()+25000,signal:closed.signal});if(reply.raw.destroyed||request.raw.aborted)throw new DomainError('download_client_closed_no_body_sent',499);fresh=await call(token,source,'read_version','mem.read',body);}catch(error){await outputCapacity?.release();await verified.cleanup();throw error;}
  // SQL580 owns lease facts and object-destruction fencing. Every renewal uses
  // the same current fixed-version/source permission, never latest-head equality.
  const leaseBody={...body,sha256:fixed.sha256,read_receipt_id:fresh['read_receipt_id'],ttl_seconds:10};
  const input=createReadStream(verified.path);input.pause();let transportStarted=false;
  const delivery=outputCapacity?Readable.from(await outputCapacity.meter(input,false)):verified.meterOutput?Readable.from(await verified.meterOutput(input)):input;delivery.pause();
  const guarded=new AuthorizedDownload({expectedBytes:fixed.size,...config.streamAuthorization,cancelSource:()=>{input.destroy();delivery.destroy();},cancelTransport:()=>{if(transportStarted)reply.raw.destroy();},authorize:async signal=>{
   const effect={...leaseBody,command:'renew'};const decision=await decide(config,token,'mem.read',effect,effect,source);
   if(signal.aborted)throw new DomainError('download_authorization_timeout',503);
   const lease=await sqlFunction<Record<string,unknown>>(pool,'mem.gc_read_lease',[decision.handle,digest(effect),canonical(effect)]);
   if(signal.aborted)throw new DomainError('download_authorization_timeout',503);
   if(lease['state']!=='leased'||lease['physical_state']!=='retained'||lease['material_id']!==body.material_id||lease['sha256']!==fixed.sha256||lease['version_id']!==body.version_id)throw new DomainError('download_current_permission_denied',403);
   return {expiresAt:Math.min(Date.parse(decision.expires_at),Date.parse(String(lease['expires_at'])))};
  }});
  // Before reply.send owns the stream, failed initial checks still need an error listener.
  guarded.on('error',()=>undefined);input.on('error',()=>guarded.cancel('download_object_stream_failed'));delivery.on('error',()=>guarded.cancel('download_capacity_dependency_unknown'));outputCapacity?.signal.addEventListener('abort',()=>guarded.cancel('download_capacity_dependency_unknown'),{once:true});
  const release=()=>call(token,source,'gc_read_lease','mem.read',{...leaseBody,command:'release'}).catch(()=>request.log.warn({error_code:'read_use_lease_expiry_pending'},'read use lease expires without renewal'));
  try{
   await guarded.start();if(reply.raw.destroyed||request.raw.aborted)throw new DomainError('download_client_closed_no_body_sent',499);
   await call(token,source,'gc_read_lease','mem.read',{...body,sha256:fixed.sha256,read_receipt_id:prepared['read_receipt_id'],command:'release'});
  }catch(error){guarded.cancel('download_initial_permission_failed');await release();await outputCapacity?.release();await verified.cleanup();throw error;}
  reply.header('x-hub-read-receipt',String(fresh['read_receipt_id']));reply.header('content-type','application/octet-stream');
  const socket=reply.raw.socket;const socketBytesBefore=socket?.bytesWritten??0;
  reply.raw.once('finish',()=>{if(guarded.completeDelivery())void call(token,source,'record_read','mem.read',{project_id:body.project_id,read_receipt_id:fresh['read_receipt_id'],state:'sent'}).catch(()=>request.log.warn({error_code:'read_receipt_pending'},'delivery evidence pending'));});
  reply.raw.once('close',()=>{
   guarded.cancel('download_client_closed');
   request.log.info({event:'authorized_download_terminal',read_receipt_id:fresh['read_receipt_id'],...guarded.snapshot(),application_budget:config.ioBudget?.status(),socket_bytes_written_delta:Math.max(0,(socket?.bytesWritten??socketBytesBefore)-socketBytesBefore),socket_bytes_include_headers:true,client_received_bytes_not_asserted:true},'fixed download terminal');
   void release();void outputCapacity?.release();void verified.cleanup();
  });
  transportStarted=true;delivery.pipe(guarded);return reply.send(guarded);
 });
 return app;
}
