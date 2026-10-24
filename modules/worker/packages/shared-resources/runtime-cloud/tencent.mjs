import {createHmac} from 'node:crypto';
import {requireThat,Rejected,sha} from './core.mjs';

const services={cam:{version:'2019-01-16',actions:['AddUser','GetUser','CreatePolicy','AttachUserPolicy','ListAttachedUserPolicies']},dnspod:{version:'2021-03-23',actions:['DescribeDomain','DescribeRecordList','DescribeRecord','ModifyRecord']},sts:{version:'2018-08-13',actions:['GetFederationToken']},lighthouse:{version:'2020-03-24',actions:['DescribeInstances','StartInstances','StopInstances','RebootInstances','DescribeInstanceFirewallRules','ModifyFirewallRules']}};
/** Fixed official endpoints, no caller URL, no automatic effect retry. */
export async function tencentRequest(service,action,region,body,credential){
 const profile=services[service];requireThat(profile?.actions.includes(action),'cloud_action_denied');
 const host=service+'.tencentcloudapi.com',time=Math.floor(Date.now()/1000),date=new Date(time*1000).toISOString().slice(0,10),payload=JSON.stringify(body);
 const headers='content-type:application/json; charset=utf-8\nhost:'+host+'\n',scope=date+'/'+service+'/tc3_request';
 const canonical='POST\n/\n\n'+headers+'\ncontent-type;host\n'+sha(payload),h=(k,v)=>createHmac('sha256',k).update(v).digest();
 const key=h(h(h('TC3'+credential.secret_key,date),service),'tc3_request'),signature=createHmac('sha256',key).update('TC3-HMAC-SHA256\n'+time+'\n'+scope+'\n'+sha(canonical)).digest('hex');
 const response=await fetch('https://'+host+'/',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json; charset=utf-8',host,authorization:'TC3-HMAC-SHA256 Credential='+credential.secret_id+'/'+scope+', SignedHeaders=content-type;host, Signature='+signature,'X-TC-Action':action,'X-TC-Version':profile.version,'X-TC-Timestamp':String(time),...(region?{'X-TC-Region':region}:{}),...(credential.session_token?{'X-TC-Token':credential.session_token}:{})},body:payload});
 requireThat(response.ok,'cloud_http_request_failed');const reply=(await response.json()).Response;
 if(reply?.Error){const code=reply.Error.Code;throw new Rejected('provider_'+(/^[A-Za-z][A-Za-z0-9.]{0,100}$/.test(code)?code:'rejected'),502)}
 requireThat(reply?.RequestId,'cloud_response_invalid');return reply;
}
