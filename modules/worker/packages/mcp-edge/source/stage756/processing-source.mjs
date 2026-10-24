/** Existing processing APIs, same current caller. No extra SQL/Source ACL. */
export function createProcessingSource({memberMem}){
 const fixed=r=>({material_id:r.material_id,version_id:r.version_id,sha256:r.sha256});
 const checked=async(a,p,b)=>{const r=await memberMem(a,p,b);if(r?.error_code)throw Object.assign(Error(r.error_code),{code:r.error_code,status:r.status??403});return r;};
 async function prepareSource(a,{target,source_fixed_ref,logical_key},checkpoint){
  const body={project_id:target.project_id,idempotency_key:logical_key+':processing',inputs:[fixed(source_fixed_ref)],output_kind:'other',semantic_kind:'other',recipe:{name:'byte_copy',version:'1'},coverage:'raw_export',declaration:{workflow:'MCP_stage_copy',byte_copy:true,output_sha256:source_fixed_ref.sha256,logical_path:target.path},reuse:false};
  await checkpoint({state:'start_intent',body});
  // Same idempotency key recovers an uncertain start; never a new run/key.
  const r=await checked(a,'/v2/processing-runs',body);
  if(typeof r.run_id!=='string'||!Number.isSafeInteger(r.attempt)||r.attempt<1||typeof r.fencing_token!=='string')throw Object.assign(Error('processing_run_not_prepared'),{code:'processing_run_not_prepared',status:409});
  const cp={project_id:target.project_id,run_id:r.run_id,attempt:r.attempt,fencing_token:r.fencing_token,output_kind:'other'};await checkpoint({state:'prepared',...cp});return cp;
 }
 async function commitSource(a,cp,output){
  return checked(a,'/v2/processing-runs/finish',{...cp,outputs:[fixed(output)]});
 }
 return{prepareSource,commitSource};
}
