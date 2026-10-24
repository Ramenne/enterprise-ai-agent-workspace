/** Canonical source: Hufu packages/platform/src/failure-contract.mjs.
 * Other core repositories carry hash-checked copies of this shared contract. */
export function infrastructureFailure(error,{permissionCode}={}){
 if(error.code==='42501')return error.message==='unauthenticated'
  ?{code:'unauthenticated',status:401,retryable:false,cause_category:'identity_rejected'}
  :{code:domainErrorCode(permissionCode,'forbidden'),status:403,retryable:false,cause_category:'permission_denied'};
 if(error.code==='55P03'||error.code==='57014')return{code:'dependency_busy',status:503,retryable:true,cause_category:error.code==='55P03'?'lock_unavailable':'query_cancelled'};
 if(error.code==='H2410'&&error.message==='fixed_object_destroyed')return{code:'fixed_object_destroyed',status:410,retryable:false,cause_category:'object_destroyed'};
 if(error.code==='H2409'&&error.message==='fixed_object_sealed_unavailable')return{code:'fixed_object_sealed_unavailable',status:409,retryable:true,cause_category:'object_sealed'};
 return null;
}
export const domainErrorCode=(value,fallback)=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,119}$/.test(value)?value:fallback;
export function infrastructureResponse(failure,requestId,{legacyCode}={}){
 return{status:failure.status,body:{state:'failed',error_code:legacyCode??failure.code,retryable:failure.retryable,...(requestId?{request_id:requestId}:{})},diagnostic:{error_code:failure.code,cause_category:failure.cause_category}};
}
export function platformFailure(error,{explicit=false,requestId}={}){
 const e=error,common=explicit?null:infrastructureFailure(e);
 const code=explicit?error.code:common?.code??(e.validation?'invalid_input':e.code==='23505'?'conflict':e.code==='40001'?'revision_conflict':'internal_error');
 const status=explicit?error.status:common?.status??(code.includes('conflict')?409:code==='invalid_input'?400:500);
 const cause_category=common?.cause_category??({'40001':'serialization_conflict','23505':'uniqueness_conflict'})[e.code]??(explicit?'domain_error':e.validation?'input_validation':'unclassified');
 return{status,body:{state:'failed',error_code:code,retryable:explicit?error.retryable:common?.retryable??false,retained_state:'unchanged_or_query_operation',next_step:code==='restore_required'?'request_mem.object.restore_then_query_same_operation':code==='fixed_object_destroyed'?'fixed_content_destroyed_history_preserved':status===503||code==='fixed_object_sealed_unavailable'?'retry_same_request':'inspect_error',request_id:requestId},diagnostic:{error_code:code,cause_category}};
}
