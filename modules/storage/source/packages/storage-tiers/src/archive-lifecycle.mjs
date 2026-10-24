import {TierError,classifyHead,providerFailure} from './cos-tier-provider.mjs';
const invoke=(client,name,p)=>new Promise((resolve,reject)=>client[name](p,(e,r)=>e?reject(e):resolve(r)));
const fixed = x=>x&&typeof x.version_id==='string'&&!['','null','undefined'].includes(x.version_id);
/** Wrap before passing the provider to storage-tier-flow. Known successful
 * server-side fixed-version COPY and HEAD are distinct from unknown-copy discovery.
 * SQL verified_objects binds the previously verified fixed source; no extra GET
 * is required just to archive. Target wholeSHA is not claimed by HEAD/COPY. */
export function withCopyLineage(provider) {
 return new Proxy(provider,{get(p,k){
  if(k==='copy')return async(ticket,dispatch,...verification)=>({...await p.copy(ticket,dispatch,...verification),copy_lineage_verified:true,
   verification_basis:'SQL_verified_fixed_source_and_known_server_side_COPY',source_locator:ticket.locator});
  if(k==='reconcileCopy')return async(ticket)=>({...await p.reconcileCopy(ticket),copy_lineage_verified:false,
   verification_basis:'HEAD_discovery_requires_restore_and_stream_SHA_before_retirement'});
  const v=Reflect.get(p,k,p);return typeof v==='function'?v.bind(p):v;
 }});
}
/** Exact one-physical-version retirement, never whole-object GC.destroy.
 * No bucket lifecycle, DeleteMarker/latest deletion, source rewrite, or blind retry. */
export class PhysicalRetirement {
 constructor(provider){this.provider=provider;}
 async retire(ticket,claim) {
  if(!fixed(ticket.hot)||!fixed(ticket.cold)||ticket.hot.key===ticket.cold.key&&ticket.hot.version_id===ticket.cold.version_id)
   throw new TierError('invalid_physical_retirement',400);
  const p=this.provider,{client,base,bag}=await p.session(ticket.hot,'retire_hot');
  const cold=await p.head(ticket.cold);
  if(cold.size!==Number(ticket.size)||!['STANDARD_IA','ARCHIVE','DEEP_ARCHIVE'].includes(cold.storage_class))throw new TierError('cold_successor_unavailable');
  let hot;try{hot=await p.head(ticket.hot);}catch(error){if(error.statusCode===404)return this.reconcile(ticket);throw error;}if(hot.size!==Number(ticket.size))throw new TierError('hot_source_changed');
  // Database claim rechecks current action, every version's primary mapping,
  // explicit physical references, use leases and existing recovery hold windows.
  await claim();
  try{await p.journal(ticket.retirement_id,{phase:'retire_dispatch',hot:ticket.hot,cold:ticket.cold});}
  catch{throw new TierError('no_provider_send');}
  try {
   const response=await invoke(client,'deleteObject',{...base,Key:ticket.hot.key,VersionId:ticket.hot.version_id});
   await p.journal(ticket.retirement_id,{phase:'retire_response',request_id:response.headers?.['x-cos-request-id']??null});
  }catch(e){const code=providerFailure(e);await p.journal(ticket.retirement_id,{phase:'retire_unknown',code});throw new TierError(code==='provider_denied'?'retirement_provider_denied_no_effect':'retirement_outcome_unknown');}
  return this.reconcile(ticket);
 }
 async reconcile(ticket) {
  const p=this.provider,{client,base,bag}=await p.session(ticket.hot,'head');
  // Current exact successor is the positive control; cold is allowed to require
  // restore. It must exist as the recorded fixed physical version with equal size.
  const control=await p.head(ticket.cold);
  if(control.size!==Number(ticket.size)||!['STANDARD_IA','ARCHIVE','DEEP_ARCHIVE'].includes(control.storage_class))throw new TierError('cold_successor_unavailable');
  try {
   const h=await invoke(client,'headObject',{...base,Key:ticket.hot.key,VersionId:ticket.hot.version_id});
   classifyHead(h,ticket.hot);return {state:'retirement_unknown',hot_absent:false,automatic_delete_retry:false};
  }catch(e){
   if(e.statusCode!==404)throw new TierError('retirement_outcome_unknown');
   const receipt={state:'hot_retired',hot:ticket.hot,cold:ticket.cold,hot_absent:true,
    method:'exact_fixed_HEAD404_with_current_cold_HEAD200',logical_identity_unchanged:true,
    cold_restore_state:control.state,hot_request_id:e.headers?.['x-cos-request-id']??null,cold_request_id:control.request_id};
   await p.journal(ticket.retirement_id,{phase:'retire_reconciled',receipt});return receipt;
  }
 }
}

/** Called automatically after copy_created (same request authority), or by an
 * adopted current narrow service job. No human confirmation or old bearer replay.
 * call is current Hufu/SQL path; it must not be a raw role bypass. */
export function createArchiveLifecycle({call,provider,loadKnownCopyEvidence,loadKnownRetirementDenial}) {
 const retirement=new PhysicalRetirement(provider);
 return async(token,source,body,{switchOnly=false,queryOnly=false}={})=>{
  const cmd=(phase,extra={})=>call(token,source,'storage_tier_retirement',phase==='status'?'mem.read':'mem.write',{...body,phase,...extra});
  // Adopting pre-733 known COPY uses its current private machine journal, never
  // caller text/boolean or a HEAD-only guess. Failure leaves hot unchanged.
  if(!queryOnly&&loadKnownCopyEvidence){
   const evidence=await loadKnownCopyEvidence(body.operation_id).catch(()=>null);
   if(evidence)await cmd('attest_known',{server_evidence:evidence});
  }
  let ticket=await cmd('status');
  if(!queryOnly&&ticket.state==='unknown'&&loadKnownRetirementDenial&&await loadKnownRetirementDenial(ticket).catch(()=>false)){
   ticket=await cmd('outcome',{outcome:'no_effect'});
  }
  if(!queryOnly){ticket=await cmd('switch',{expected_storage_revision:ticket.storage_revision});}
  if(queryOnly||switchOnly||ticket.state==='retired'||ticket.state==='held')return ticket;
  if(['dispatched','unknown'].includes(ticket.state)){
   const r=await retirement.reconcile(ticket);
   if(r.hot_absent)return cmd('outcome',{outcome:'retired',receipt:r});
   return {...ticket,state:'unknown',automatic_delete_retry:false};
  }
  if(queryOnly)return ticket;
  let claimed=false;
  try {
   const r=await retirement.retire(ticket,async()=>{ticket=await cmd('claim',{expected_storage_revision:ticket.storage_revision});
    if(ticket.state!=='dispatched')throw new TierError('retirement_held');claimed=true;});
   return r.hot_absent?cmd('outcome',{outcome:'retired',receipt:r}):cmd('outcome',{outcome:'unknown'});
  }catch(e){
   if(claimed)return cmd('outcome',{outcome:['no_provider_send','retirement_provider_denied_no_effect'].includes(e.code)?'no_effect':'unknown'});
   if(['tier_capability_unavailable','fixed_version_absence_not_verified','retirement_held'].includes(e.code))return {...ticket,state:'held',reason:ticket.reason??e.code};
   throw e;
  }
 };
}
