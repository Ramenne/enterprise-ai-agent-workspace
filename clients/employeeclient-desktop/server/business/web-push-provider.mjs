import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {sendBoundedWebPush} from './web-push-transport.mjs';
const CREDENTIAL='/run/credentials/hub2-project-employeeclient.service/employeeclient-push.json';
const fail=code=>{throw Object.assign(Error(code),{code,status:503});};
export function validateSubscription(value){
 if(!value||typeof value.endpoint!=='string'||value.endpoint.length>2048)fail('invalid_push_subscription');
 const u=new URL(value.endpoint),hosts=new Set(['web.push.apple.com','fcm.googleapis.com','jmt17.google.com','updates.push.services.mozilla.com']);
 if(u.protocol!=='https:'||!hosts.has(u.hostname)||u.port||u.username||u.password||u.hash)fail('push_endpoint_not_supported');
 const keys=value.keys;
 if(typeof keys?.p256dh!=='string'||!(/^[A-Za-z0-9_-]{87}$/).test(keys.p256dh)||typeof keys?.auth!=='string'||!(/^[A-Za-z0-9_-]{22}$/).test(keys.auth))fail('invalid_push_subscription_keys');
 return {endpoint:u.href,keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
export function createWebPushProvider(config,{send=sendBoundedWebPush,proxy=null}={}){
 if(proxy!==null&&proxy!=='http://127.0.0.1:17890')fail('registered_push_proxy_invalid');
 if(config?.version!==1||config.android_third_party_push!==false||!config.public_key||!config.private_key||!config.subject)fail('registered_push_configuration_invalid');
 const details={subject:config.subject,publicKey:config.public_key,privateKey:config.private_key};
 return Object.freeze({publicConfig(){return {web_push:{supported:true,application_server_key:config.public_key},android_third_party_push:false};},
  async deliver(subscription,notification){
   const destination=validateSubscription(subscription);
   const payload=JSON.stringify({id:notification.id,recipient_username:notification.recipient_actor,installation_id:notification.device_id,update_version:notification.version,state_only:notification.state_only===true,silent:notification.state_only===true,created_at:notification.created_at, title:'员工客户端',summary:'有新的通知，请打开员工客户端查看',kind:notification.kind,priority:notification.state_only?'normal':notification.priority,snapshot:notification.snapshot,deep_link:notification.deep_link,...(notification.message_badge?{message_badge:notification.message_badge}:{})});
   try{const result=await send(destination,payload,{vapidDetails:details,TTL:2419200,topic:createHash('sha256').update(notification.device_id+'\0'+notification.id).digest('base64url').slice(0,32),timeout:15000,urgency:notification.priority==='urgent'?'high':'normal',...(proxy&&['fcm.googleapis.com','jmt17.google.com'].includes(new URL(destination.endpoint).hostname)?{proxy}:{})});
    return {state:'provider_accepted',provider_status:result.statusCode,device_display:'not_asserted'};
   }catch(e){const status=Number(e.statusCode)||null;return {state:status===404||status===410?'subscription_expired':'delivery_failed',provider_status:status,retryable:status===null||status===429||status>=500,...(status===null?{transport_error:['ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN','ENOTFOUND'].includes(e.code)?e.code:'push_transport_failed'}:{}),device_display:'not_asserted'};}
  }});
}
export async function loadRegisteredWebPush({path=process.env.QN_PUSH_CONFIG,proxy=process.env.QN_WEB_PUSH_PROXY||null}={}){
 if(path!==CREDENTIAL)fail('registered_push_configuration_required');
 // Only the running process reads the systemd credential. Neither raw config,
 // private key nor provider response bodies enter the client, source or log.
 return createWebPushProvider(JSON.parse(await readFile(path,'utf8')),{proxy});
}
