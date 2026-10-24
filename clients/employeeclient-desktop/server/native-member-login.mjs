import {boundedJSON} from './business/bounded-json.mjs';
const CENTRAL='https://hufu.example.invalid/hub2-preview/hufu';
export const MEMBER_COOKIE='qn_member_device';
const fail=(code,status=401)=>{throw Object.assign(Error(code),{code,status});};
const value=v=>v?.body??v;
export function memberDeviceCookie(token,{crossSite=false,clear=false}={}){
 return MEMBER_COOKIE+'='+(clear?'':Buffer.from(token).toString('base64url'))+'; Path=/; HttpOnly; Secure; SameSite='+(crossSite?'None':'Lax')+'; Max-Age='+(clear?0:34560000);
}
function deviceToken(cookie){
 const entries=String(cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(MEMBER_COOKIE+'='));
 if(!entries.length)return null;
 // Android CookieHandler may append the same credential already supplied by its transport.
 // Only identical repetitions can collapse; conflicting credentials stay rejected.
 if(new Set(entries).size!==1)fail('member_device_cookie_invalid');
 const encoded=entries[0].slice(MEMBER_COOKIE.length+1);
 if(!/^[A-Za-z0-9_-]{20,4096}$/.test(encoded))fail('member_device_cookie_invalid');
 const token=Buffer.from(encoded,'base64url').toString('utf8');
 if(Buffer.from(token).toString('base64url')!==encoded||!token||/[\s\x00-\x1f\x7f]/.test(token))fail('member_device_cookie_invalid');
 return token;
}
async function memberRead(url,options,fetcher){
 for(let attempt=0;attempt<2;attempt++){
  options.signal?.throwIfAborted();
  try{const response=await fetcher(url,options);if(attempt===0&&[502,503,504].includes(response.status)){await response.body?.cancel().catch(()=>{});continue;}return response;}
  catch(e){if(attempt!==0||options.signal?.aborted||!(e instanceof TypeError))throw e;}
 }
}
async function call(path,{fetcher,authorization,body,key,signal,cookie}){
 const r=await (body===undefined?memberRead:((url,opts,f)=>f(url,opts)))(CENTRAL+path,{method:body===undefined?'GET':'POST',headers:{accept:'application/json',...(authorization?{authorization}:{}),...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json',origin:'https://hufu.example.invalid/'}),...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal},fetcher);
 const v=value(await boundedJSON(r,1024*1024));
 if(!r.ok||v.error_code||v.error||v.state==='failed')fail(typeof v.error_code==='string'?v.error_code:'member_authority_unavailable',r.ok?502:r.status);
 return {response:r,value:v};
}
function assertMember(identity){
 if(!identity?.actor_id||identity.principal_kind!=='member'||identity.authorization_mode==='product_service')fail('member_device_identity_required',403);
}
export async function resolveNativeMember(cookie,{fetcher=fetch,signal=AbortSignal.timeout(15000),onSessionCookies=()=>{}}={}){
 const token=deviceToken(cookie);
 if(token){
  const {value:identity}=await call('/v2/me',{fetcher,authorization:'Bearer '+token,signal});
  assertMember(identity);
  if(identity.until_revoked!==true||identity.expires_at!==null)fail('member_device_lifetime_invalid',403);
  return {token,identity,persistent:true};
 }
 if(!cookie)fail('login_required');
 const r=await memberRead(CENTRAL+'/v2/auth/get-session',{headers:{accept:'application/json',...(cookie?{cookie}:{})},redirect:'error',signal},fetcher);
 onSessionCookies(r);
 const session=value(await boundedJSON(r,1024*1024));
 if(!r.ok){console.warn(JSON.stringify({event:'native_member_session_read_failed',mode:'browser',upstream_status:r.status}));fail('native_session_unavailable',r.status);}
 if(!session?.session?.token||!Number.isFinite(Date.parse(session.session.expiresAt))||Date.parse(session.session.expiresAt)<=Date.now())fail('login_required');
 return {token:session.session.token,user:session.user,persistent:false,expiresAt:Date.parse(session.session.expiresAt)};
}
export async function persistNativeMember(cookie,key,{fetcher=fetch,signal=AbortSignal.timeout(45000),onSessionCookies=()=>{}}={}){
 if(typeof key!=='string'||!/^qn-device-[a-f0-9-]{36}$/.test(key))fail('member_device_intent_required',400);
 const current=await resolveNativeMember(cookie,{fetcher,signal,onSessionCookies});
 if(current.persistent)return current;
 const {value:identity}=await call('/v2/me',{fetcher,authorization:'Bearer '+current.token,signal});assertMember(identity);
 const actions=['mem.read','v8.project.read','v8.work.read','v8.context.read','v8.experience.read','mem.upload','mem.write','mem.delete','mem.share','mem.process','mem.correct','v8.work.open','v8.work.commit','v8.context.prepare','v8.context.materialize','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback'];
 const {value:issued}=await call('/v2/credentials/create',{fetcher,authorization:'Bearer '+current.token,signal,key:identity.actor_id+':'+key,body:{label:'员工客户端设备 · '+key.slice(-8),actions,until_revoked:true,expires_at:null,resource_selector:{version:1,kind:'projects',project_ids:['ad44cc0e-159e-4e0f-a5ca-73d3920240d9']}}});
 if(typeof issued.credential!=='string'||!issued.credential_id)fail('member_device_credential_missing',502);
 const {value:verified}=await call('/v2/me',{fetcher,authorization:'Bearer '+issued.credential,signal});assertMember(verified);
 if(verified.actor_id!==identity.actor_id||verified.credential_id!==issued.credential_id||verified.until_revoked!==true||verified.expires_at!==null)fail('member_device_identity_mismatch',502);
 return {token:issued.credential,identity:verified,user:current.user,persistent:true};
}
export async function revokeNativeMember(cookie,{fetcher=fetch,signal=AbortSignal.timeout(15000)}={}){
 const member=await resolveNativeMember(cookie,{fetcher,signal});
 if(member.persistent){if(!member.identity.credential_id)fail('member_device_credential_missing',502);await call('/v2/credentials/revoke',{fetcher,authorization:'Bearer '+member.token,signal,key:'qn-device-signout-'+member.identity.credential_id,body:{credential_id:member.identity.credential_id}});}
 return {state:'signed_out'};
}
