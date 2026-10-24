// Human status cards consume the same authenticated MCP project/runtime view.
const safeCode=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,119}$/.test(value)&&!value.startsWith('hub2_')?value:'current_project_state_unavailable';
function statusError(value,status){
 const code=safeCode(value);return Object.assign(Error(code),{error_code:code,status:status||(code==='unauthenticated'?401:code==='forbidden'?403:503),next_step:['unauthenticated','forbidden'].includes(code)?'refresh_current_member_connection_and_read_current_project_rights':'retry_current_status_or_inspect_reported_upstream_code'});
}

export async function projectStatus(token,call,refresh=false){
 let response;try{response=await call('http://127.0.0.1:8939/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'portal-status-'+Date.now(),method:'tools/call',params:{name:'hub.services',arguments:{limit:100,refresh}}})});}catch(e){throw statusError(e.message,e.status);}
 let result;try{result=response.result?.structuredContent??JSON.parse(response.result?.content?.[0]?.text||'{}');}catch{throw statusError('invalid_status_response');}
 if(response.error||response.result?.isError)throw statusError(result?.error_code||response.error?.message||result?.state);
 if(!Array.isArray(result?.items))throw statusError('invalid_status_response');
 const all={};for(const item of result.items){
  if(item.service_id.startsWith('project:'))continue;
  const process=item.running_service?.state;const http=item.public_entry?.http_status;
  const state=process==='active'?'online':['inactive','failed','not_configured'].includes(process)?process:item.public_entry?.state==='reachable'?'reachable':[301,302,303,307,308,401,403].includes(http)?'authentication_required':'unknown';
  all[item.service_id]={state,checked_at:item.observed_at,deployed_release:item.deployed_release,workspace_commit:item.workspace_commit,public_entry:item.public_entry,health:item.health,business_ready:item.business_ready,responsibility:item.responsibility,recent_work:item.recent_work,drift:item.drift,source_coverage:item.source_coverage,notes:item.notes};
 }
 all.database={state:all.hufu?.health?.database==='connected'?'online':'unknown',checked_at:all.hufu?.checked_at,source:'hufu_current_readiness_database_connection;business_transaction_not_verified'};
 all.coverage=result.coverage;return all;
}
