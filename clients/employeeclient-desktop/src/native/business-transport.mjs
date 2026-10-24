import {NativeError,unwrap} from './client.mjs';
export async function businessRequest(base,method,path,{lease,body,query={},key,signal,timeout=15000,onUnauthorized=()=>{},fetcher=globalThis.fetch.bind(globalThis)}={}) {
 const active=()=>{if(!lease?.valid())throw new NativeError('session_changed',401);};
 active();if(method==='POST'&&body===undefined)body={};
 const personalRead=method==='GET'&&['/business/v1/me/points','/business/v1/me/tasks'].includes(path);
 const profileAvatar=method==='POST'&&path==='/business/v1/profile/avatar';
 if(!['GET','POST'].includes(method)||!profileAvatar&&!personalRead&&!/^\/business\/v1\/(?:voice-asr|private-attachments|inspirations|conversations|feedback|messages|members|notifications|announcements|files|uploads|devices|bootstrap|migration|push-config|asr)(?:\/|$)/.test(path)||path.includes('..'))throw new NativeError('retired_or_unknown_business_route',410);
 if(method==='POST'&&!key)throw new NativeError('idempotency_required',400);
 const url=new URL(base.replace(/\/$/,'')+path,globalThis.location?.href||'http://localhost');
 for(const [k,v] of Object.entries(query))if(v!==undefined&&v!==null&&v!=='')url.searchParams.set(k,String(v));
 const controller=new AbortController(),abort=()=>controller.abort();
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
 try{
  active();const response=await fetcher(url.href,{method,credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal,
   headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  active();controller.signal.throwIfAborted();let value;try{value=await response.json();}catch{throw new NativeError('business_response_not_json',502);}
  active();controller.signal.throwIfAborted();if(!response.ok){if(response.status===401)onUnauthorized();throw new NativeError(value.error_code||value.error||'business_request_rejected',response.status,value.hint||'');}
  // ASR failure/blocked are persisted domain states consumed by its one state
  // machine, not malformed transport responses. HTTP errors still reject above.
  if(/^\/business\/v1\/(?:asr|voice-asr)\/(prepare|start|status|poll)$/.test(path)&&value?.job_id&&['prepared','queued','running','completed','blocked','failed','submission_unknown'].includes(value.state)&&!value.error_code)return value;
  return unwrap(value);
 }catch(error){
  if(!lease?.valid())throw new NativeError('session_changed',401);
  if(signal?.aborted)throw signal.reason||new DOMException('操作已暂停','AbortError');
  if(timedOut)throw new NativeError('business_transport_timeout',0,'连接超时，请重试');
  if(error instanceof TypeError)throw new NativeError('business_transport_failed',0);
  throw error;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
