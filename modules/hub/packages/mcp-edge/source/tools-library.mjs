import {createHash} from 'node:crypto';

const BASE='https://tools.example.invalid/agent/v1';
const BLOCKED=new Set(['account_password_read','account_notes_read','account_history','account_save','account_members','account_group_delete','account_access_read','account_access_save','account_member_access_read','account_member_access_save','account_member_visibility_save','skill_package_read','hardware_file_read']);
const fail=(code,status=400)=>{throw Object.assign(Error(code),{status});};
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const fields={action:{type:'string',enum:['help','call','operation','knowledge_search']},operation:{type:'string'},arguments:{type:'object'},idempotency_key:{type:'string',minLength:8,maxLength:120,pattern:'^[A-Za-z0-9_.:-]+$'},query:{type:'string'},category:{type:'string'},business_project:{type:'string',description:'知识相关业务项目名；匹配项目标签，不是存放权限项目'},tags:{type:'array',items:{type:'string'},maxItems:12},limit:{type:'integer',minimum:1,maximum:50}};
export const toolsLibraryTool={name:'tools.library',description:'工具库统一入口：help读取本人当前可用知识/Skill/HTML等操作和原生参数，call按原契约执行；写入提供稳定idempotency_key，operation查询原效果。knowledge_search按业务项目、分类、标签有限返回知识候选，读正文判断适用。沿当前中枢身份，无需另装MCP；不返回账号密码等敏感能力。',inputSchema:{type:'object',properties:fields,required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}};
const tagsOf=row=>new Set(String(row.tags||'').split(/[,，\n]/).map(s=>s.trim()).filter(Boolean));
const visibleOperation=o=>object(o)&&/^[A-Za-z0-9_-]{1,100}$/.test(o.name||'')&&!BLOCKED.has(o.name)&&o.agentAvailable===true&&!o.sensitive&&object(o.inputSchema);
const operationKey=(actor,key)=>'hub-tools:'+createHash('sha256').update(actor+'\0'+key).digest('hex');

async function request(path,credential,{body,key,fetcher}){
 const reject=(code,status=502)=>fail(key&&status>=500?'tools_result_unknown_query_original_key':code,status);
 let response;
 try{response=await fetcher(BASE+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+credential,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(body===undefined?25000:120000)});}
 catch{fail(body===undefined?'tools_library_unavailable':'tools_result_unknown_query_original_key',503);}
 if(!response.body)reject('tools_response_invalid');
 const reader=response.body.getReader();let size=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)reject('tools_response_too_large');chunks.push(value);}}
 catch(error){if(error.status)throw error;reject('tools_response_incomplete');}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 let packet;try{packet=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reject('tools_response_invalid');}
 if(!response.ok||packet?.ok===false)reject(response.status===403?'tools_forbidden':response.status===401?'tools_unauthenticated':response.status===409?'tools_revision_or_key_conflict':response.status===404?'tools_operation_not_found':'tools_request_failed',response.status>=400?response.status:502);
 const result=packet?.result??packet;if(!object(result))reject('tools_response_invalid');return result;
}

export async function invokeToolsLibrary(input,credential,{fetcher=fetch,expectedActorId}={}){
 if(!object(input)||Object.keys(input).some(k=>!Object.hasOwn(fields,k))||!fields.action.enum.includes(input.action))fail('invalid_tools_library_input');
 if(typeof credential!=='string'||!credential.startsWith('hub2_'))fail('current_member_credential_required',401);
 if(input.arguments!==undefined&&!object(input.arguments))fail('invalid_tools_library_arguments');
 const catalog=await request('/capabilities',credential,{fetcher});
 const actor=catalog.identity?.actorId;
 if(typeof actor!=='string'||!actor||(expectedActorId&&actor!==expectedActorId))fail('tools_member_identity_mismatch',403);
 const operations=(catalog.operations||[]).filter(visibleOperation);
 if(input.action==='help')return {state:'catalog',identity:catalog.identity,operations,invoke:{tool:'tools.library',arguments:{action:'call',operation:'<name from operations>',arguments:{}}},knowledge_organization:{category:'知识性质，项目实践/外部参考/方法说明',tags:['项目:<业务项目>','平台:<平台>','场景:<场景>','有效性:当前|历史|撤销|被替代'],placement:'projectId为原件权限归属；业务项目使用标签，不复制正文',verification:'status表示证据程度，与当前有效性分开'},authority:'same_current_member;upstream_validates_every_effect'};
 const validKey=()=>{if(typeof input.idempotency_key!=='string'||!/^[A-Za-z0-9_.:-]{8,120}$/.test(input.idempotency_key))fail('stable_idempotency_key_required');return operationKey(actor,input.idempotency_key);};
 if(input.action==='operation')return request('/operations/'+encodeURIComponent(validKey()),credential,{fetcher});
 if(input.action==='knowledge_search'){
  const op=operations.find(o=>o.name==='knowledge_list');if(!op)fail('tools_operation_not_authorized',403);
  const limit=input.limit??10;if(!Number.isSafeInteger(limit)||limit<1||limit>50)fail('invalid_knowledge_search_limit');
  if(input.tags!==undefined&&(!Array.isArray(input.tags)||input.tags.length>12||input.tags.some(t=>typeof t!=='string'||!t.trim())))fail('invalid_knowledge_search_tags');
  for(const field of ['query','category','business_project'])if(input[field]!==undefined&&(typeof input[field]!=='string'||input[field].length>500))fail('invalid_knowledge_search_filter');
  const filterTags=[...(input.tags||[]),...(input.business_project?['项目:'+input.business_project.trim()]:[])];
  const args={...(input.query?{query:input.query}:{}),...(input.category?{category:input.category}:{})};
  const result=await request('/call',credential,{body:{operation:'knowledge_list',arguments:args},fetcher});
  if(!Array.isArray(result.items))fail('knowledge_directory_invalid',502);
  const matches=result.items.filter(row=>{const tags=tagsOf(row);return !row.archivedAt&&!['有效性:历史','有效性:撤销','有效性:被替代'].some(t=>tags.has(t))&&(!input.category||row.category===input.category)&&filterTags.every(t=>tags.has(t));});
  return {state:'read',items:matches.slice(0,limit),returned_count:Math.min(matches.length,limit),total_matching:matches.length,truncated:matches.length>limit,coverage:{upstream:'current_authorized_directory;upstream_has_no_pagination_or_delta',complete:matches.length<=limit,filtering:'metadata_only;read_selected_document_before_adoption'},next_step:'call knowledge_read with selected id;check body and scope;unclassified_legacy_entries_are_not_assumed_verified'};
 }
 const operation=operations.find(o=>o.name===input.operation);if(!operation)fail('tools_operation_not_authorized',403);
 const args=input.arguments||{};
 // Validate top-level fields against the live contract without dropping unsupported input.
 const rule=operation.inputSchema;
 if((rule.required||[]).some(k=>!Object.hasOwn(args,k))||(rule.additionalProperties===false&&Object.keys(args).some(k=>!Object.hasOwn(rule.properties||{},k))))fail('tools_arguments_do_not_match_current_contract');
 const writing=operation.write===true,key=writing?validKey():undefined;
 if(Buffer.byteLength(JSON.stringify(args))>8*1024*1024)fail('tools_arguments_too_large',413);
 const result=await request('/call',credential,{body:{operation:operation.name,arguments:args},key,fetcher});
 return writing?{...result,_hub_tools:{idempotency_key:input.idempotency_key,recovery:{tool:'tools.library',arguments:{action:'operation',idempotency_key:input.idempotency_key}},knowledge_validation:'saved_is_not_method_verified'}}:result;
}
