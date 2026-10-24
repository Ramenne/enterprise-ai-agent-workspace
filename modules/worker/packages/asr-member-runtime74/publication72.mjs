import{archivePublishedASR749}from'/srv/workspace';
import{open}from'node:fs/promises';import{Readable}from'node:stream';import{createHash}from'node:crypto';
const refBody=x=>({material_id:x.material_id,version_id:x.version_id,sha256:x.sha256});
/** apiFactory resolves only a controlled server credential_ref to the approved member client.
 * postJson/getIdentity retain existing Hub2 member/client/SourceClosure/HTTP contracts.
 * No raw bearer/key is accepted in any checkpoint or relay URL. */
export function createHub2Ports({apiFactory,fixedInput,makeApprovedRelayUrl,signedPutEnabled=false,fetcher=fetch}){
 const api=async binding=>{if(!binding?.credential_ref)throw Error('controlled_credential_ref_required');return apiFactory(binding.credential_ref);};
 const authority={async checkCurrent({binding,ref}){if(!['project_id','material_id','version_id','sha256','size'].every(k=>ref[k]===fixedInput[k]))throw Error('pinned_fixed_ref_required');const client=await api(binding),identity=await client.getIdentity();if(identity.actor_id!==binding.member_id||identity.client_id!==binding.client_id)throw Error('binding_identity_changed');const view=await client.postJson('/v2/files/read-chunk',{project_id:ref.project_id,material_id:ref.material_id,version_id:ref.version_id,offset:0,limit:1,encoding:'base64'});if(view.fixed_ref?.sha256!==ref.sha256||Number(view.fixed_ref?.size)!==ref.size)throw Error('fixed_reference_changed');return{member_id:identity.actor_id,client_id:identity.client_id};}};
 const readFixed=async({binding,ref})=>(async function*(){const client=await api(binding);let offset=0;while(offset<ref.size){const result=await client.postJson('/v2/files/read-chunk',{project_id:ref.project_id,material_id:ref.material_id,version_id:ref.version_id,offset,limit:65536,encoding:'base64'});if(result.fixed_ref?.sha256!==ref.sha256||Number(result.fixed_ref?.size)!==ref.size||result.range?.start!==offset)throw Error('fixed_chunk_scope_or_range_changed');const bytes=Buffer.from(result.bytes_base64,'base64');if(bytes.length===0||result.range.end_exclusive!==offset+bytes.length||offset+bytes.length>ref.size)throw Error('invalid_fixed_chunk');offset+=bytes.length;yield bytes;}})();
 const processing={
  async prepare({binding,input,recipe,idempotency_key}){const client=await api(binding);return client.postJson('/v2/processing-runs',{project_id:input.project_id,idempotency_key,inputs:[refBody(input)],output_kind:'transcript',semantic_kind:'new_asr_transcription',recipe:Object.fromEntries(Object.entries(recipe).filter(([k])=>['name','version','provider','model','parameters'].includes(k))),coverage:'unknown',declaration:{new_provider_job_required:true,existing_supplier_transcript_import:false,input_coverage:'whole_fixed_original',original_recipe:recipe}});},
  async providerRelayUrl({opaque_path,expires_at,input}){if(!makeApprovedRelayUrl)throw Error('external_relay_route_not_activated');const result=await makeApprovedRelayUrl({opaque_path,expires_at,input});const url=new URL(result);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.hostname.endsWith('.myqcloud.com'))throw Error('approved_opaque_HTTPS_relay_required_no_COS_public_URL');return url.toString();},
  async finish({binding,run,input,output,idempotency_key}){const client=await api(binding);const current=await client.postJson('/v2/processing-runs/query',{project_id:input.project_id,run_id:run.run_id});const notify=async result=>{let callback;try{callback=await archivePublishedASR749({client,binding,run,input,output})}catch{callback={state:'callback_pending'}}return{...result,archive_callback:callback}};if(current.technical_state==='succeeded'||current.state==='succeeded')return notify({state:'succeeded',historical:true});const resumed=await client.postJson('/v2/processing-runs/resume',{project_id:input.project_id,run_id:run.run_id,idempotency_key});return notify(await client.postJson('/v2/processing-runs/finish',{project_id:input.project_id,run_id:run.run_id,attempt:resumed.attempt,fencing_token:resumed.fencing_token,output_kind:'transcript',outputs:[refBody(output)]}));}
 };
 const publisher={async publish({binding,project_id,input,artifact,recipe,provider_job,idempotency_key}){
  const client=await api(binding);let op=await client.postJson('/v2/uploads',{project_id,idempotency_key,expected_revision:0,expected_version_id:null,logical_path:'ASR/'+idempotency_key.split(':').at(-1)+'/provider-result.json',sha256:artifact.sha256,size:artifact.size,origin_kind:'agent_processed',producer:'hub2-asr-filetrans.v1',properties:{provider:recipe.provider,model:recipe.model,provider_task_id:provider_job.task_id,provider_submit_request_id:provider_job.request_id,input_fixed_ref:refBody(input),raw_provider_json:true}});
  const queried=await client.postJson('/v2/operations/query',{project_id,operation_id:op.operation_id});if(queried.state==='published'){const fixed=queried.receipt?.fixed_refs?.[0];if(!fixed)throw Error('publication_receipt_missing');return{fixed_ref:fixed,receipt:queried.receipt};}
  let published;
  if(queried.state==='verified'&&queried.attempt&&queried.fencing_token&&new Date(queried.lease_until).getTime()>Date.now()){published=await client.postJson('/v2/uploads/'+op.operation_id+'/publish',{project_id,attempt:queried.attempt,fencing_token:queried.fencing_token});}
  else{
   if(!['verifying','verified','conflict'].includes(queried.state)){
    let ticket,status;try{status=await client.postJson('/v2/uploads/'+op.operation_id+'/put/status',{project_id});}catch(error){if(error.code!=='upload_mode_conflict')throw error;ticket=await client.postJson('/v2/uploads/'+op.operation_id+'/put-ticket',{project_id});status={state:'uploading'};}
    if(status.state!=='staging_complete'){
     if(!signedPutEnabled)throw Error('result_cloud_publication_not_activated');ticket??=await client.postJson('/v2/uploads/'+op.operation_id+'/put-ticket',{project_id});const put=ticket.ticket??ticket;const url=new URL(put.url);if(url.protocol!=='https:'||!url.hostname.endsWith('.myqcloud.com')||url.username||url.password||put.method!=='PUT')throw Error('existing_controlled_signed_PUT_only');
     const fd=await open(artifact.path,'r');const stream=fd.createReadStream({autoClose:false});try{const response=await fetcher(url,{method:'PUT',redirect:'error',headers:put.required_headers??{},body:Readable.toWeb(stream),duplex:'half',signal:AbortSignal.timeout(30000)});await response.body?.cancel();if(!response.ok)throw Error('signed_result_PUT_unknown_or_failed');}finally{stream.destroy();await fd.close();}
     await client.postJson('/v2/uploads/'+op.operation_id+'/put/complete',{project_id});
    }
   }
   published=await client.postJson('/v2/uploads/'+op.operation_id+'/publish',{project_id});
  }
  const fixed=published.fixed_refs?.[0];if(published.state!=='published'||!fixed)throw Error('fixed_result_publication_pending');return{fixed_ref:fixed,receipt:published};
 }};
 return{authority,readFixed,processing,publisher};
}
