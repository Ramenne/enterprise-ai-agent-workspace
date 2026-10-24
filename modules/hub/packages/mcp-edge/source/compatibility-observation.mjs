import {legacyAliasNames} from './tool-compatibility.mjs';
const tools=new Set([...legacyAliasNames,'hufu_whoami','hufu_context','hufu_vault_list','hufu_vault_reveal','mengchu_get','mengchu_note','mengchu_search','mengchu_upload','hub_api']);
const routes=new Set([...tools].map(name=>'tool:'+name).concat(['identity:legacy_bridge','backend:legacy_mcp','http:legacy_auth']));
const callers=new Set(['native_member_principal','native_service_principal','native_other_principal','legacy_credential']);
/** Best-effort dependency evidence only. Never receives request bodies or credentials. */
export function createCompatibilityObservation(emit=entry=>console.log(JSON.stringify(entry))){
 const seen=new WeakMap();
 const observe=(route,caller_class,request)=>{
  if(!routes.has(route)||!callers.has(caller_class))return;
  if(request&&typeof request==='object'){
   let used=seen.get(request);if(!used){used=new Set();seen.set(request,used);}
   if(used.has(route))return;used.add(route);
  }
  try{emit({event:'hub_compatibility_use',schema:1,route,caller_class});}catch{}
 };
 return{
  started(){try{emit({event:'hub_compatibility_observation_started',schema:1,component:'mcp_edge',coverage:'recognized_tool_entries_and_legacy_bridge_backend;not_success_or_unique_user_counts'});}catch{}},
  tool(name,caller,request){if(tools.has(name))observe('tool:'+name,caller,request);},
  observe
 };
}
