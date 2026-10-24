import {resolveNativeMember} from './native-member-login.mjs';
import {nativeRoute} from './native-routes.mjs';
import {boundedJSON} from './business/bounded-json.mjs';
const CENTRAL='https://hufu.example.invalid/';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
// Only an existing caller-owned Mem operation can obtain a transfer ticket.
// Browser supplies bytes and fixed operation IDs, never a URL or credential.
export async function relayNativeUpload(req,reply,fetcher,onSessionCookies=()=>{},{response,idleMs=120000,maxMs=1800000}={}){
 if(!Number.isSafeInteger(idleMs)||idleMs<1||!Number.isSafeInteger(maxMs)||maxMs<idleMs)throw new TypeError('invalid upload timeout policy');
 const controller=new AbortController(),check=()=>controller.signal.throwIfAborted();
 const abort=()=>controller.abort(Object.assign(Error('staging_put_cancelled'),{code:'staging_put_cancelled',status:499}));
 const closed=()=>{if(!response.writableEnded)abort();};
 const timeout=()=>controller.abort(Object.assign(Error('staging_put_timeout'),{code:'staging_put_timeout',status:504}));
 let idle;const touch=()=>{check();clearTimeout(idle);idle=setTimeout(timeout,idleMs);idle.unref?.();};
 const total=setTimeout(timeout,maxMs);total.unref?.();touch();
 req.once('aborted',abort);response?.once('close',closed);if(req.aborted||response?.destroyed)abort();
 // Do not depend on a provider honoring AbortSignal. Late responses only release resources.
 const wait=async(work,late)=>{check();let stopped;const interrupted=new Promise((_,reject)=>{stopped=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',stopped,{once:true});});const pending=Promise.resolve(work);pending.then(value=>{if(controller.signal.aborted)late?.(value);},()=>{});try{const value=await Promise.race([pending,interrupted]);check();return value;}finally{controller.signal.removeEventListener('abort',stopped);}};
 const release=r=>{try{void r?.body?.cancel().catch(()=>{});}catch{}};
 try{
  const q=new URL(req.url,'http://localhost').searchParams;
  if([...q.keys()].some(k=>!['project_id','operation_id','size','part_number'].includes(k)))fail('invalid_upload_reference');
  const project_id=q.get('project_id'),operation_id=q.get('operation_id'),size=Number(q.get('size'));
  if(!UUID.test(project_id||'')||!UUID.test(operation_id||'')||!q.has('size')||!Number.isSafeInteger(size)||size<0||size>64*1024*1024)fail('invalid_upload_reference');
  const part_number=q.has('part_number')?Number(q.get('part_number')):undefined;
  if(part_number!==undefined&&(!Number.isSafeInteger(part_number)||part_number<1||part_number>10000||size===0))fail('invalid_upload_reference');
  if(req.headers['content-length']!==undefined&&Number(req.headers['content-length'])!==size)fail('upload_size_mismatch');
  if(!req.headers.cookie)fail('login_required',401);
  check();const session=await wait(resolveNativeMember(req.headers.cookie,{fetcher,signal:controller.signal,onSessionCookies:r=>{check();onSessionCookies(r);}}));touch();
  const args={project_id,operation_id,...(part_number===undefined?{}:{part_number,size})};
  const route=nativeRoute(part_number===undefined?'mem.upload.ticket':'mem.upload.multipart.part_ticket',args);
  if(!route)fail('invalid_upload_reference');
  const grantResponse=await wait(fetcher(CENTRAL+route.path,{method:'POST',headers:{accept:'application/json','content-type':'application/json',origin:CENTRAL,authorization:'Bearer '+session.token},body:JSON.stringify(route.body),redirect:'error',signal:controller.signal}),release);
  const wrapper=await wait(boundedJSON(grantResponse,1024*1024)),grant=wrapper.body??wrapper;touch();
  if(!grantResponse.ok||wrapper.status>=400||grant.state==='failed'||grant.error_code)fail(typeof grant.error_code==='string'?grant.error_code:'upload_ticket_rejected',grantResponse.ok?(wrapper.status||403):grantResponse.status);
  if(grant.state==='ticket_wait')fail('upload_ticket_wait_resume_original',503);
  if(grant.state!=='uploading'||grant.ticket?.method!=='PUT'||!grant.ticket.url)fail('upload_ticket_not_ready',503);
  if(part_number===undefined&&grant.size!==size)fail('upload_size_mismatch');
  const target=new URL(grant.ticket.url);
  if(target.protocol!=='https:'||target.username||target.password)fail('invalid_upload_ticket',502);
  let sent=0;
  async function* content(){for await(const chunk of req){check();sent+=chunk.length;if(sent>size)fail('upload_size_mismatch');touch();yield chunk;check();}check();if(sent!==size)fail('upload_size_mismatch');touch();}
  const headers={...grant.ticket.required_headers,'content-length':String(size)};
  const put=await wait(fetcher(target.href,{method:'PUT',headers,body:content(),duplex:'half',redirect:'error',signal:controller.signal}),release);check();release(put);
  if(sent!==size)fail('upload_size_mismatch');
  if(!put.ok)fail('staging_put_failed',put.status);
  return reply(200,{state:'staged',operation_id,size});
 }catch(error){if(controller.signal.aborted)error=controller.signal.reason;if(response?.destroyed||response?.writableEnded)return;return reply(error.status||502,{error_code:typeof error.code==='string'&&/^[a-z0-9_]+$/.test(error.code)?error.code:'staging_put_connection_failed'});}
 finally{clearTimeout(idle);clearTimeout(total);req.off('aborted',abort);response?.off('close',closed);if(controller.signal.aborted&&!req.complete)req.destroy();}
}
