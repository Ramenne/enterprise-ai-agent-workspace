import {createHash,createHmac} from 'node:crypto';
const need=(v,code)=>{if(!v){const e=new Error(code);e.code=code;e.status=403;throw e}};
const sha=s=>createHash('sha256').update(s).digest('hex');
/** Dedicated CVM read-only TC3 signer. Fixed endpoint/version/action and no
 * automatic retries. Existing Lighthouse code cannot call this CVM endpoint. */
export async function cvmDescribe(region,instanceId,credential){
 need(/^ap-[a-z]+$/.test(region)&&/^ins-[a-z0-9]+$/.test(instanceId),'registered_CVM_scope_required');
 need(typeof credential.secret_id==='string'&&typeof credential.secret_key==='string','CVM_machine_credential_required');
 const service='cvm',host='cvm.tencentcloudapi.com',time=Math.floor(Date.now()/1000),date=new Date(time*1000).toISOString().slice(0,10),payload=JSON.stringify({InstanceIds:[instanceId],Limit:1});
 const headers='content-type:application/json; charset=utf-8\nhost:'+host+'\n',scope=date+'/'+service+'/tc3_request';
 const canonical='POST\n/\n\n'+headers+'\ncontent-type;host\n'+sha(payload),h=(k,v)=>createHmac('sha256',k).update(v).digest();
 const signingKey=h(h(h('TC3'+credential.secret_key,date),service),'tc3_request');
 const signature=createHmac('sha256',signingKey).update('TC3-HMAC-SHA256\n'+time+'\n'+scope+'\n'+sha(canonical)).digest('hex');
 const response=await fetch('https://'+host+'/',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json; charset=utf-8',host,authorization:'TC3-HMAC-SHA256 Credential='+credential.secret_id+'/'+scope+', SignedHeaders=content-type;host, Signature='+signature,'X-TC-Action':'DescribeInstances','X-TC-Version':'2017-03-12','X-TC-Timestamp':String(time),'X-TC-Region':region,...(credential.session_token?{'X-TC-Token':credential.session_token}:{})},body:payload});
 need(response.ok,'CVM_http_failed');const reply=(await response.json()).Response;
 if(reply?.Error){const code=reply.Error.Code;need(false,'provider_'+(/^[A-Za-z][A-Za-z0-9.]{0,100}$/.test(code)?code:'rejected'))}
 need(reply?.RequestId,'CVM_response_invalid');return reply;
}
export class CVMReadonlyAdapter{
 constructor(invoke=cvmDescribe){this.invoke=invoke}
 validate(r,t){need(t.kind==='cvm'&&r.action==='cvm.instance.describe'&&r.operation==='read'&&Object.keys(r.parameters).length===0&&/^ins-[a-z0-9]+$/.test(t.instance_id)&&/^\d+$/.test(t.account_id)&&/^ap-[a-z]+$/.test(t.region),'registered_CVM_readonly_required')}
 async execute(r,t,c){
  this.validate(r,t);need(c.secret?.provider==='tencent-cvm'&&c.secret.account_id===t.account_id&&c.secret.region===t.region&&c.secret.instance_id===t.instance_id&&c.secret.current_scope_verified===true,'CVM_owned_credential_scope_required');
  await c.check('effect');c.markEffectStarted?.();const reply=await this.invoke(t.region,t.instance_id,c.secret);
  need(Array.isArray(reply.InstanceSet)&&reply.InstanceSet.length===1&&reply.InstanceSet[0].InstanceId===t.instance_id,'CVM_fixed_instance_response_required');
  const x=reply.InstanceSet[0];await c.check('final');return {state:'read',effect_id:reply.RequestId,result:{provider_request_id:reply.RequestId,instance_id:x.InstanceId,name:x.InstanceName,state:x.InstanceState,zone:x.Placement?.Zone,cpu:x.CPU,memory:x.Memory,public_ips:x.PublicIpAddresses??[],private_ips:x.PrivateIpAddresses??[],latest_operation:x.LatestOperation,latest_operation_state:x.LatestOperationState}};
 }
}
