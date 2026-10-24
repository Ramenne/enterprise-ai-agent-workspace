import {createHash,createHmac} from 'node:crypto';
import {request} from 'node:https';
import type {LeasePolicy} from './policy.js';
import {TARGET,type Consumer} from './policy.js';
export type BrokerErrorCode='sts_unavailable'|'sts_authentication_failed'|'sts_policy_rejected'|'sts_throttled'|'sts_protocol_invalid'|'management_config_invalid'|'management_unavailable'|'bao_access_denied'|'bao_write_failed'|'bao_write_receipt_invalid'|'broker_stopped'|'state_unavailable'|'secret_writer_unavailable'|'multipart_scope_configuration_required';
/** No original response/message/cause or signed request is retained in errors. */
export class BrokerError extends Error {
 constructor(readonly code:BrokerErrorCode,readonly retryable=false){super(code);this.name='BrokerError';}
}
export interface ManagementKey {secret_id:string;secret_key:string;}
export interface LeaseConfig extends Record<string,unknown> {
 endpoint:string;region:string;bucket:string;access_key_id:string;secret_access_key:string;session_token:string;
 expires_at:number;credential_expires_at:number;credential_type:'sts';force_path_style:false;
}
export interface Lease {config:LeaseConfig;issued_at:number;policy_hash:string;}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const hmac=(key:string|Buffer,value:string)=>createHmac('sha256',key).update(value).digest();
const encoded=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
export function managementKey(data:Record<string,unknown>):ManagementKey {
 const id=data['secret_id'],key=data['secret_key'];
 if(typeof id!=='string'||!/^[A-Za-z0-9_-]{5,256}$/.test(id)||typeof key!=='string'||key.length<5||key.length>512
 ||data['region']!==TARGET.region||data['bucket']!==TARGET.bucket||(typeof data['session_token']==='string'&&data['session_token']))throw new BrokerError('management_config_invalid');
 return {secret_id:id,secret_key:key};
}
export function signSts(key:ManagementKey,domain:Consumer,policy:LeasePolicy,timestamp=Math.floor(Date.now()/1000)) {
 if(!Number.isSafeInteger(timestamp)||timestamp<=0)throw new BrokerError('sts_protocol_invalid');
 const host='sts.tencentcloudapi.com',service='sts',date=new Date(timestamp*1000).toISOString().slice(0,10),type='application/json; charset=utf-8';
 const body=JSON.stringify({Name:'hub2-'+domain,DurationSeconds:3600,Policy:encoded(JSON.stringify(policy))});
 const canonical='POST\n/\n\ncontent-type:'+type+'\nhost:'+host+'\n\ncontent-type;host\n'+sha(body);
 const scope=date+'/'+service+'/tc3_request';const signing='TC3-HMAC-SHA256\n'+timestamp+'\n'+scope+'\n'+sha(canonical);
 const signature=createHmac('sha256',hmac(hmac(hmac('TC3'+key.secret_key,date),service),'tc3_request')).update(signing).digest('hex');
 return {host,body,headers:{'Content-Type':type,Host:host,'X-TC-Action':'GetFederationToken','X-TC-Version':'2018-08-13','X-TC-Timestamp':String(timestamp),'X-TC-Region':TARGET.region,Authorization:'TC3-HMAC-SHA256 Credential='+key.secret_id+'/'+scope+', SignedHeaders=content-type;host, Signature='+signature}};
}
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
export function parseLease(status:number,body:unknown,key:ManagementKey,started:number,hash:string,now=Math.floor(Date.now()/1000)):Lease {
 if(!object(body)||!object(body['Response']))throw new BrokerError('sts_protocol_invalid');
 const response=body['Response'];const error=response['Error'];
 if(object(error)){
  const code=typeof error['Code']==='string'?error['Code']:'';
  if(code.startsWith('AuthFailure')||code.startsWith('UnauthorizedOperation'))throw new BrokerError('sts_authentication_failed');
  if(code.startsWith('InvalidParameter'))throw new BrokerError('sts_policy_rejected');
  if(code.startsWith('RequestLimitExceeded'))throw new BrokerError('sts_throttled',true);
  throw new BrokerError('sts_unavailable',true);
 }
 if(status<200||status>=300)throw new BrokerError(status===401||status===403?'sts_authentication_failed':'sts_unavailable',status>=500||status===429);
 const credentials=response['Credentials'],expiry=response['ExpiredTime'];
 if(!object(credentials)||typeof expiry!=='number'||!Number.isSafeInteger(expiry)||expiry<=now+90||expiry>started+3900)throw new BrokerError('sts_protocol_invalid');
 const id=credentials['TmpSecretId'],secret=credentials['TmpSecretKey'],token=credentials['Token'];
 if(typeof id!=='string'||!id||typeof secret!=='string'||!secret||typeof token!=='string'||!token||id===key.secret_id||secret===key.secret_key)throw new BrokerError('sts_protocol_invalid');
 return {issued_at:started,policy_hash:hash,config:{endpoint:`https://cos.${TARGET.region}.myqcloud.com`,region:TARGET.region,bucket:TARGET.bucket,access_key_id:id,secret_access_key:secret,session_token:token,expires_at:expiry,credential_expires_at:expiry,credential_type:'sts',force_path_style:false}};
}
export type StsIssuer=(key:ManagementKey,domain:Consumer,policy:LeasePolicy,policyHash:string,signal:AbortSignal)=>Promise<Lease>;
/** Fixed external endpoint; no arbitrary URL, redirects, provider messages or secret logs. */
export const issueSts:StsIssuer=async(key,domain,policy,hash,signal)=>{
 if(signal.aborted)throw new BrokerError('broker_stopped');
 const started=Math.floor(Date.now()/1000);const signed=signSts(key,domain,policy,started);
 const reply=await new Promise<{status:number;body:unknown}>((resolve,reject)=>{
  let settled=false;const fail=(code:BrokerErrorCode,retryable=false)=>{if(!settled){settled=true;reject(new BrokerError(code,retryable));}};
  const req=request({hostname:signed.host,path:'/',method:'POST',headers:{...signed.headers,'Content-Length':Buffer.byteLength(signed.body)},rejectUnauthorized:true,minVersion:'TLSv1.2',signal},response=>{
   const chunks:Buffer[]=[];let size=0;
   response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536){req.destroy();fail('sts_protocol_invalid');}else chunks.push(chunk);});
   response.on('error',()=>fail(signal.aborted?'broker_stopped':'sts_unavailable',!signal.aborted));
   response.on('end',()=>{if(settled)return;try{const body:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));settled=true;resolve({status:response.statusCode??0,body});}catch{const status=response.statusCode??0;fail(status===401||status===403?'sts_authentication_failed':status>=500||status===429?'sts_unavailable':'sts_protocol_invalid',status>=500||status===429);}});
  });
  const timeout=setTimeout(()=>{req.destroy();fail('sts_unavailable',true);},10000);
  req.on('error',()=>fail(signal.aborted?'broker_stopped':'sts_unavailable',!signal.aborted));req.on('close',()=>clearTimeout(timeout));req.end(signed.body);
 });
 return parseLease(reply.status,reply.body,key,started,hash);
};
