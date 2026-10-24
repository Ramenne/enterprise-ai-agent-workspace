/** Existing narrow service scheduler hook. No stored human bearer, no global
 * bypass. loadDue is private trusted-server SQL; act issues current scope per row. */
export async function resumePhysicalRetirements({loadDue,act,maxItems=100}) {
 if(!Number.isInteger(maxItems)||maxItems<1||maxItems>200)throw Error('invalid_retirement_batch');
 const rows=await loadDue(maxItems),results=[];
 for(const row of rows){
  try{const r=await act({project_id:row.project_id,material_id:row.material_id,version_id:row.version_id,operation_id:row.operation_id});
   results.push({operation_id:row.operation_id,state:r.state,reason:r.reason??null});
  }catch(e){results.push({operation_id:row.operation_id,state:'held',reason:e.code??'current_authority_or_provider_unavailable'});}
 }
 return {attempted:rows.length,items:results};
}
