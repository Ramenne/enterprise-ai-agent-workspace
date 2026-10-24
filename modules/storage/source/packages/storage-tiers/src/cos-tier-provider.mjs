import {createHash} from 'node:crypto';
import {Writable} from 'node:stream';
import {finished} from 'node:stream/promises';

export class TierError extends Error {
 constructor(code, status=503){super(code);this.code=code;this.status=status;}
}
const cold = new Set(['ARCHIVE','DEEP_ARCHIVE']);
const fixed = x => x && typeof x.version_id==='string' && !['','null','undefined'].includes(x.version_id)
 && typeof x.key==='string' && x.key.length>0 && typeof x.bucket==='string';
const headers = r => Object.fromEntries(Object.entries(r?.headers??{}).map(([k,v])=>[k.toLowerCase(),String(v)]));
export function classifyHead(r, locator, now=Date.now()) {
 const h=headers(r), version=r?.VersionId??h['x-cos-version-id'];
 if(version!==locator.version_id)throw new TierError('object_version_mismatch');
 const storage_class=h['x-cos-storage-class']??r.StorageClass??'STANDARD';
 const size=Number(h['content-length']??r.ContentLength);
 if(!Number.isSafeInteger(size)||size<0)throw new TierError('invalid_object_size');
 const restore=h['x-cos-restore']??r.Restore??'';
 const ongoing=/ongoing-request="true"/.test(restore);
 const expiry=restore.match(/expiry-date="([^"]+)"/)?.[1];
 const expires=expiry?Date.parse(expiry):NaN;
 const restored=cold.has(storage_class)&&/ongoing-request="false"/.test(restore)&&Number.isFinite(expires)&&expires>now;
 return {storage_class,size,version_id:version,state:!cold.has(storage_class)?'readable':restored?'restored':ongoing?'restoring':'restore_required',
  restore_expires_at:restored?new Date(expires).toISOString():null,request_id:h['x-cos-request-id']??null};
}
export function providerFailure(e) {
 const code=e?.code??e?.Code??e?.name;
 if(code==='InvalidObjectState')return 'restore_required';
 if(code==='RestoreAlreadyInProgress')return 'restoring';
 // A generic 403 means permission failure, never object loss.
 if(e?.statusCode===403)return 'provider_denied';
 if(e?.statusCode===404)return 'not_found';
 if(e instanceof TierError)return e.code;
 return 'provider_outcome_unknown';
}
function invoke(client, method, params) {
 return new Promise((resolve,reject)=>client[method](params,(e,r)=>e?reject(e):resolve(r)));
}
/** The client factory and own KV supplier are machine configuration, never request data.
 * COS native SDK is intentional: restore XML uses CASJobParameters, not AWS GlacierJobParameters.
 * Root must lock/pin cos-nodejs-sdk-v5 before integration. No default credentials/Parent fallback. */
export class CosTierProvider {
 constructor({COS,scopeProvider,journal,copyLimitBytes=5*1024**3}) {
  this.COS=COS;this.scopeProvider=scopeProvider;this.journal=journal;
  this.copyLimitBytes=copyLimitBytes;
 }
 async session(locator, operation, context={}) {
  if(!fixed(locator))throw new TierError('fixed_object_required',400);
  const bag=await this.scopeProvider(locator,operation,context);
  if(!bag?.scope_verified||bag.provider!=='cos'||bag.bucket!==locator.bucket||
    typeof bag.archive_prefix!=='string'||!bag.archive_prefix.endsWith('/')||
    !Array.isArray(bag.source_prefixes)||!(locator.key.startsWith(bag.archive_prefix)||bag.source_prefixes.some(p=>typeof p==='string'&&p.endsWith('/')&&locator.key.startsWith(p)))||
    !Number.isFinite(Date.parse(bag.valid_until))||Date.parse(bag.valid_until)<=Date.now()+30000||
    !bag.actions?.includes(operation))throw new TierError('tier_capability_unavailable');
  if(!/^[a-z0-9-]+$/.test(bag.region)||!bag.access_key_id||!bag.secret_access_key||!bag.session_token)
   throw new TierError('tier_capability_unavailable');
  // New client per operation reads current own bag. Expiry is never extended here.
  const client=new this.COS({SecretId:bag.access_key_id,SecretKey:bag.secret_access_key,SecurityToken:bag.session_token,
   Protocol:'https:',RetryTimes:0,Timeout:600000});
  return {client,bag,base:{Bucket:bag.bucket,Region:bag.region}};
 }
 async head(locator){
  const {client,base}=await this.session(locator,'head');
  return classifyHead(await invoke(client,'headObject',{...base,Key:locator.key,VersionId:locator.version_id}),locator);
 }
 async verify(locator, expected, beforeChunk=async()=>{}) {
  const {client,base}=await this.session(locator,'read');
  const hash=createHash('sha256');let size=0;
  const output=new Writable({highWaterMark:65536,write(chunk,encoding,done){
   Promise.resolve().then(beforeChunk).then(()=>{size+=chunk.length;if(size>expected.size)throw new TierError('object_integrity_mismatch');hash.update(chunk);done();},done).catch(done);
  }});
  // COS SDK streams into Output; no whole-object RAM buffer or temporary original copy.
  output.on('error',()=>{});
  try {
   const r=await invoke(client,'getObject',{...base,Key:locator.key,VersionId:locator.version_id,Output:output});
   await finished(output);
   const version=r.VersionId??headers(r)['x-cos-version-id'];
   if(version!==locator.version_id)throw new TierError('object_version_mismatch');
   const sha256=hash.digest('hex');if(size!==expected.size||sha256!==expected.sha256)throw new TierError('object_integrity_mismatch');
   return {sha256,size,request_id:headers(r)['x-cos-request-id']??null};
  }finally{output.destroy();}
 }
 async copy(ticket, beforeSend, beforeChunk=async()=>{},verifySource) {
  const locator=ticket.locator, storage=ticket.tier==='archive'?'ARCHIVE':ticket.tier==='deep_archive'?'DEEP_ARCHIVE':ticket.tier==='infrequent'?'STANDARD_IA':ticket.tier==='standard'?'STANDARD':null;
  if(!storage||!fixed(locator)||!Number.isSafeInteger(ticket.size)||ticket.size>this.copyLimitBytes)
   throw new TierError(storage?'multipart_copy_required':'invalid_storage_tier',400);
  const {client,bag,base}=await this.session(locator,'copy',{operation_id:ticket.operation_id});
  const key=bag.archive_prefix+ticket.operation_id;
  if(!/^[a-f0-9-]{36}$/i.test(ticket.operation_id)||key===locator.key)throw new TierError('invalid_tier_operation',400);
  const sourceHead=await this.head(locator);
  if(sourceHead.size!==ticket.size)throw new TierError('object_integrity_mismatch');
  if(sourceHead.state==='restore_required'||sourceHead.state==='restoring')throw new TierError('restore_required',409);
  if(bag.verify_source_bytes){if(verifySource)await verifySource(locator);else await this.verify(locator,{sha256:ticket.sha256,size:ticket.size},beforeChunk);}
  // Preflight errors occur before the SQL dispatch claim, so same logical request remains usable.
  if(Date.parse(bag.valid_until)<=Date.now()+30000)throw new TierError('tier_capability_unavailable');
  await beforeSend({target_key:key});
  try{await this.journal(ticket.operation_id,{phase:'copy_dispatch',key,source:locator,tier:ticket.tier,sha256:ticket.sha256,size:ticket.size});}
  catch{throw new TierError('no_provider_send');}
  let r;
  try {r=await invoke(client,'putObjectCopy',{...base,Key:key,StorageClass:storage,MetadataDirective:'Copy',
   CopySource:`${bag.bucket}.cos.${bag.region}.myqcloud.com/`+locator.key.split('/').map(encodeURIComponent).join('/')+'?versionId='+encodeURIComponent(locator.version_id)});}
  catch(e){await this.journal(ticket.operation_id,{phase:'copy_unknown',code:providerFailure(e)});throw new TierError('provider_outcome_unknown');}
  // No second COPY on missing response version. Unique destination is scoped to this durable operation.
  const actualVersion=r.VersionId??headers(r)['x-cos-version-id'];
  if(!actualVersion||['null','undefined'].includes(actualVersion)){
   await this.journal(ticket.operation_id,{phase:'copy_unknown',code:'missing_actual_target_version'});throw new TierError('provider_outcome_unknown');
  }
  const target={provider:locator.provider,bucket:locator.bucket,key,version_id:actualVersion};
  await this.journal(ticket.operation_id,{phase:'copy_response',locator:target,request_id:headers(r)['x-cos-request-id']??null});
  const targetHead=await this.head(target);
  if(targetHead.size!==ticket.size||targetHead.storage_class!==storage)throw new TierError('archive_copy_observation_mismatch');
  const receipt={locator:target,tier:ticket.tier,...targetHead,state:'archive_copy_created',
   sha256:ticket.sha256,source_sha256_verified:true,target_sha256_verified:false,standard_source_retained:true};
  await this.journal(ticket.operation_id,{phase:'copy_observed',receipt});return receipt;
 }
 async reconcileCopy(ticket) {
  const {client,bag,base}=await this.session(ticket.locator,'head',{operation_id:ticket.operation_id,reconcile_target:true});
  const key=bag.archive_prefix+ticket.operation_id;
  if(ticket.target_key!==key)throw new TierError('tier_target_binding_changed');
  // HEAD latest here only discovers the actual VersionId at an operation-owned
  // write-once key. All subsequent reads/restore are pinned to that actual ID.
  // Root scope must exclude every other writer from this archive prefix.
  const r=await invoke(client,'headObject',{...base,Key:key});
  const version=r.VersionId??headers(r)['x-cos-version-id'];
  if(!version||['null','undefined'].includes(version))throw new TierError('provider_outcome_unknown');
  const locator={...ticket.locator,key,version_id:version};
  const observation=classifyHead(r,locator);
  if(observation.size!==ticket.size||observation.storage_class!==(ticket.tier==='archive'?'ARCHIVE':ticket.tier==='infrequent'?'STANDARD_IA':ticket.tier==='standard'?'STANDARD':'DEEP_ARCHIVE'))
   throw new TierError('archive_copy_observation_mismatch');
  const receipt={...observation,locator,state:'archive_copy_created',tier:ticket.tier,sha256:ticket.sha256,
   source_sha256_verified:true,target_sha256_verified:false,standard_source_retained:true};
  await this.journal(ticket.operation_id,{phase:'copy_reconciled',receipt});return receipt;
 }
 async restore(ticket, beforeSend) {
  const {client,base}=await this.session(ticket.locator,'restore');
  const observed=await this.head(ticket.locator);
  if(observed.state==='readable'||observed.state==='restored')return {...observed,state:'readable'};
  if(observed.state==='restoring')return {...observed,state:'restoring'};
  if(!Number.isInteger(ticket.days)||ticket.days<1||ticket.days>365||!['Standard','Bulk','Expedited'].includes(ticket.retrieval)||
    (observed.storage_class==='DEEP_ARCHIVE'&&ticket.retrieval==='Expedited'))throw new TierError('invalid_restore_request',400);
  await beforeSend({target_key:null});
  try{await this.journal(ticket.operation_id,{phase:'restore_dispatch',locator:ticket.locator,days:ticket.days,retrieval:ticket.retrieval});}
  catch{throw new TierError('no_provider_send');}
  try {
   const r=await invoke(client,'restoreObject',{...base,Key:ticket.locator.key,VersionId:ticket.locator.version_id,
    RestoreRequest:{Days:ticket.days,CASJobParameters:{Tier:ticket.retrieval}}});
   const receipt={state:'restore_requested',request_id:headers(r)['x-cos-request-id']??null,temporary_copy:true};
   await this.journal(ticket.operation_id,{phase:'restore_response',receipt});return receipt;
  }catch(e){
   const code=providerFailure(e);
   if(code==='restoring'){const receipt={state:'restoring',temporary_copy:true};await this.journal(ticket.operation_id,{phase:'restore_response',receipt});return receipt;}
   await this.journal(ticket.operation_id,{phase:'restore_unknown',code});throw new TierError('provider_outcome_unknown');
  }
 }
}
