/** Installed management source selects endpoint per consumer project. A caller
 * cannot supply a URL, credential index, or another project's configured route. */
export function selectModelTarget(targets,entry_id,project_id){
 const available=targets.filter(x=>x.entry_id===entry_id&&x.enabled===true);
 return available.find(x=>x.project_id===project_id)??available.find(x=>!x.project_id);
}
export function selectCredentialPool(pool,target){
 if(target.credential_index===undefined)return pool;
 const index=target.credential_index;
 if(!Number.isSafeInteger(index)||index<0||index>=pool.length)throw Object.assign(Error('registered_holder_index_unavailable'),{statusCode:403});
 return [pool[index]];
}
