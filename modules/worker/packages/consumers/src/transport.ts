/** Generic consumer HTTP transport. Credentials identify member + client only. */
export interface ConsumerCredential { token:string; }
export interface CredentialProvider { getCredential():Promise<ConsumerCredential>; }
export interface CallOptions { signal?:AbortSignal; logicalKey?:string; expectedBinding?:string; }
export interface PublicApiTransport { postJson<T=unknown>(path:string,body:unknown,options?:CallOptions):Promise<T>; }
export class ConsumerError extends Error {
 constructor(readonly code:string,readonly status=0,readonly retryable=false){super(code);this.name='ConsumerError';}
}
export function protectedEndpoint(value:string):URL {
 let url:URL;try{url=new URL(value);}catch{throw new ConsumerError('invalid_endpoint');}
 if(url.username||url.password||url.search||url.hash||
   (url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))
   throw new ConsumerError('tls_or_loopback_endpoint_required');
 return url;
}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
async function limitedText(response:Response,limit:number):Promise<string>{
 if(!response.body)return '';
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0;
 try{for(;;){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;
   if(length>limit){await reader.cancel();throw new ConsumerError('response_too_large',0,true);}parts.push(item.value);}}
 finally{reader.releaseLock();}
 const all=new Uint8Array(length);let offset=0;for(const part of parts){all.set(part,offset);offset+=part.byteLength;}
 return new TextDecoder('utf-8',{fatal:true}).decode(all);
}
export class HubApiClient implements PublicApiTransport {
 readonly endpoint:URL;
 constructor(endpoint:string,readonly credentials:CredentialProvider,readonly timeoutMs=15000,
   readonly fetcher:typeof fetch=fetch,readonly maxJsonBytes=16*1024*1024){
  this.endpoint=protectedEndpoint(endpoint);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(maxJsonBytes)||maxJsonBytes<1)
   throw new ConsumerError('invalid_transport_budget');
 }
 async bindingId():Promise<string>{
  const credential=await this.credentials.getCredential();this.checkToken(credential.token);
  return this.credentialBinding(credential.token);
 }
 private async credentialBinding(token:string):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([this.endpoint.href,token])));
  // Partition local checkpoints on credential changes; this is NOT identity proof.
  return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
 }
 private checkToken(token:string){if(typeof token!=='string'||token.length<1||token.length>4096||/[\r\n]/.test(token))throw new ConsumerError('invalid_controlled_credential');}
 async postStream(path:string,body:unknown,options:CallOptions={}):Promise<Response>{
  if(!/^\/[a-zA-Z0-9._/-]+$/.test(path)||path.startsWith('//')||path.split('/').includes('..'))
   throw new ConsumerError('invalid_api_path');
  if(object(body)&&['actor','actor_id','subject','subject_id'].some(key=>Object.hasOwn(body,key)))
   throw new ConsumerError('body_cannot_select_actor');
  if(options.logicalKey!==undefined&&(options.logicalKey.length<1||options.logicalKey.length>200))throw new ConsumerError('invalid_logical_key');
  const credential=await this.credentials.getCredential();this.checkToken(credential.token);
  if(options.expectedBinding!==undefined&&await this.credentialBinding(credential.token)!==options.expectedBinding)
   throw new ConsumerError('credential_changed_during_request',401);
  const headers:Record<string,string>={authorization:'Bearer '+credential.token,'content-type':'application/json'};
  if(options.logicalKey!==undefined)headers['idempotency-key']=/^[\x20-\x7e]+$/.test(options.logicalKey)?options.logicalKey:'hub2-key-'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(options.logicalKey))),n=>n.toString(16).padStart(2,'0')).join('');
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs);
  let response:Response;
  const base=new URL(this.endpoint);if(!base.pathname.endsWith('/'))base.pathname+='/';
  try{response=await this.fetcher(new URL(path.slice(1),base),{method:'POST',headers,body:JSON.stringify(body),
    redirect:'error',credentials:'omit',cache:'no-store',signal});}
  catch{throw new ConsumerError('transport_unavailable_or_redirect_rejected',0,true);}
  if(!response.ok){
   let code='http_'+response.status;
   try{const data:unknown=JSON.parse(await limitedText(response,64*1024));
    if(object(data)&&typeof data['error_code']==='string'&&/^[a-z0-9_]{1,100}$/.test(data['error_code'])&&!data['error_code'].includes(credential.token))code=data['error_code'];}
   catch{/* Never echo body, endpoint, credentials or raw network exception. */}
   throw new ConsumerError(code,response.status,response.status>=500||response.status===429);
  }
  return response;
 }
 async postJson<T=unknown>(path:string,body:unknown,options:CallOptions={}):Promise<T>{
  const response=await this.postStream(path,body,options);
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')){await response.body?.cancel();throw new ConsumerError('json_response_required',0,true);}
  let result:unknown;try{result=JSON.parse(await limitedText(response,this.maxJsonBytes));}
  catch(error){if(error instanceof ConsumerError)throw error;throw new ConsumerError('invalid_json_response',0,true);}
  return result as T;
 }
}
