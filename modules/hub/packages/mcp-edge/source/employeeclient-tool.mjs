// Small adapter in the existing hub MCP. EmployeeClient owns authentication and business rules.
export const employeeclientTool={name:'employeeclient',description:'员工客户端消息与协作。用户要求“发到员工客户端”“发到工作群”、分享讨论结论/链接/文件，或查看员工客户端消息时，直接使用此工具，无需本机Skill。action=help读取参数；members/conversations/messages/message查询，send/send_file发送。默认本人文件传输助手；用户明确选工作群用target=group，他人用真实成员ID。写入必须固定幂等键并核对message回执；沿当前本人权限，不共享账号或自动群发。',inputSchema:{type:'object',properties:{action:{type:'string',enum:['help','members','conversations','messages','message','send','send_file']},arguments:{type:'object',description:'按help返回的input_schema填写；不填写actor/角色或凭据。'},idempotency_key:{type:'string',minLength:1,maxLength:160,description:'发送必须提供；未知结果重试保持同一键及相同内容。'}},required:['action'],additionalProperties:false}};
const BASE='https://employeeclient.example.invalid/business/v1/integration';
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
export async function invokeEmployeeClient(input,credential,{fetcher=fetch}={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['action','arguments','idempotency_key'].includes(k))||!employeeclientTool.inputSchema.properties.action.enum.includes(input.action))fail('invalid_employeeclient_input');
 if(typeof credential!=='string'||!credential.startsWith('hub2_'))fail('current_member_credential_required',401);
 const action=input.action,a={...(input.arguments||{})};
 if(input.arguments!==undefined&&(!input.arguments||typeof input.arguments!=='object'||Array.isArray(input.arguments)))fail('invalid_employeeclient_input');
 let path=({help:'',members:'/members',conversations:'/conversations',messages:'/messages',send:'/messages',send_file:'/files/send'})[action];
 if(action==='message'){if(typeof a.message_id!=='string'||!a.message_id||a.message_id.length>128)fail('message_id_required');path='/messages/'+encodeURIComponent(a.message_id);delete a.message_id;}
 const writing=['send','send_file'].includes(action);
 if(writing&&(typeof input.idempotency_key!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(input.idempotency_key)))fail('idempotency_key_required');
 if(!writing&&Object.values(a).some(v=>!['string','number'].includes(typeof v)))fail('invalid_employeeclient_input');
 const query=!writing&&Object.keys(a).length?'?'+new URLSearchParams(a):'';
 let response;try{response=await fetcher(BASE+path+query,{method:writing?'POST':'GET',headers:{authorization:'Bearer '+credential,accept:'application/json',...(writing?{'content-type':'application/json','idempotency-key':input.idempotency_key}:{})},...(writing?{body:JSON.stringify(a)}:{}),redirect:'error',signal:AbortSignal.timeout(action==='send_file'?125000:25000)});}catch{fail('employeeclient_result_unknown_reuse_original_idempotency_key',503);}
 if(!response.body)fail('employeeclient_response_invalid',502);const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const{value,done}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024)fail('employeeclient_response_too_large',502);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('employeeclient_response_invalid',502);}
 if(!response.ok||body.error_code)fail(/^[a-z0-9_]+$/.test(body.error_code||'')?body.error_code:'employeeclient_request_failed',response.status>=400?response.status:502);
 return body;
}
