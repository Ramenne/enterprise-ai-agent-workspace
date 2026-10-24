import {resolveNativeMember} from '../native-member-login.mjs';
import {createHash} from 'node:crypto';
import {routeProjectASR} from '../hub-asr.mjs';
import {boundedJSON} from './bounded-json.mjs';
import {nativeRoute} from '../native-routes.mjs';
// Current Hufu member session and project authority; no shared supervisor credential.
// Native member identity + actual project qualification; legacy names are never guessed.
const CENTRAL='https://hufu.example.invalid/';
export const PROJECT='ad44cc0e-159e-4e0f-a5ca-73d3920240d9';
const denied=(code,status=403)=>Object.assign(new Error(code),{code,status});
function value(response){const v=response.body??response;if(response.status>=400||v?.state==='failed'||v?.error_code||v?.error)throw denied(v?.error_code||v?.error||'authority_unavailable',response.status||403);return v;}
export function qualificationContext(member,permissions,project,bindings,now=Date.now(),memberDirectory){
 const actor=member?.identity?.actor_id;
 if(!actor||permissions.actor_id!==actor||permissions.project_id!==PROJECT||project.id!==PROJECT)throw denied('identity_scope_mismatch');
 const current=(permissions.qualifications||[]).filter(q=>q.project_id===PROJECT&&q.principal_id===actor&&q.active&&q.effective_now===true&&(!q.expires_at||Date.parse(q.expires_at)>now));
 const actions=new Set(current.flatMap(q=>q.actions||[]));
 let readable=actions.has('v8.project.read')&&actions.has('mem.read');
 let writable=actions.has('mem.write')&&actions.has('v8.work.commit');
 let manager=project.manager_id===actor;
 // Qualifications are a grant inventory, not an exhaustive current access
 // decision. Use the official live project-member projection for the current
 // actor, including existing owner/manager access. Never infer from a role/name.
 if(memberDirectory!==undefined){
  if(memberDirectory.project_id!==PROJECT||!Array.isArray(memberDirectory.members))throw denied('member_directory_invalid',503);
  const own=memberDirectory.members.filter(m=>m.actor_id===actor);
  if(own.length!==1)throw denied('project_read_denied');
  readable=own[0].can_read===true;writable=readable&&own[0].can_write===true;
  manager=manager&&own[0].is_manager===true;
 }
 if(!readable)throw denied('project_read_denied');
 // Current runtime identity is canonical actor_id. Legacy mappings only annotate history.
 // Unknown old names never become the author, recipient or permission subject of new writes.
 if(bindings&&bindings.project_id!==PROJECT)throw denied('legacy_mapping_scope_mismatch',503);
 const rows=Array.isArray(bindings?.members)?bindings.members.filter(x=>x.actor_id===actor&&x.active===true):[];
 const legacyRefs=rows.length===1&&typeof rows[0].legacy_username==='string'?[rows[0].legacy_username]:[];
 return Object.freeze({actor_id:actor,project_id:PROJECT,username:actor,legacy_refs:Object.freeze(legacyRefs),display_name:member.user?.name||actor,can_read:true,can_write:writable,can_publish_announcement:writable,is_manager:manager});
}
export function assertBusinessWrite(context,body){
 if(!context?.can_write)throw denied('project_write_denied');
 assertActorNeutralBody(body);
}
export function assertActorNeutralBody(body){
 if(body&&['actor','actor_id','subject','subject_id','username','author_username','sender_username','role','is_main_control'].some(k=>Object.hasOwn(body,k)))throw denied('identity_claim_not_allowed',400);
}
export async function nativeBusinessSession(cookie,bindings,{fetcher=globalThis.fetch.bind(globalThis)}={}){
 if(!cookie)throw denied('login_required',401);
 async function call(path,{body,authorization,key}={}){
  const headers={accept:'application/json',...(authorization?{authorization}:{cookie})};
  if(body!==undefined){headers['content-type']='application/json';headers.origin=CENTRAL;}
  if(key)headers['idempotency-key']=key;
  const r=await fetcher(CENTRAL+path,{method:body===undefined?'GET':'POST',headers,redirect:'error',signal:AbortSignal.timeout(15000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  let json;try{json=await r.json();}catch{throw denied('authority_response_invalid',502);}
  if(!r.ok)throw denied('authority_request_rejected',r.status); // No private upstream body in client errors.
  return value(json);
 }
 const member=await resolveNativeMember(cookie,{fetcher});
 const authorization='Bearer '+member.token;
 const rpc=async(name,args={},key)=>{
  const route=nativeRoute(name,args);if(!route)throw denied('native_tool_not_exposed',400);
  return call(route.path,{authorization,body:route.body,key});
 };
 const directory=async()=>{
  let offset=0,items=[],seen=new Set();
  for(;;){const page=await call('/hub2-preview/hufu/v2/projects/members',{authorization,body:{project_id:PROJECT,limit:100,offset}});
   if(page.project_id!==PROJECT||!Array.isArray(page.members))throw denied('member_directory_invalid',503);
   items.push(...page.members.filter(m=>m.can_read===true));
   if(page.next_offset===null||page.next_offset===undefined)break;
   if(!Number.isSafeInteger(page.next_offset)||page.next_offset<=offset||seen.has(page.next_offset))throw denied('member_directory_cursor_invalid',503);
   seen.add(page.next_offset);offset=page.next_offset;
  }
   return items;
 };
 const [identity,members]=await Promise.all([member.identity??call('/hub2-preview/hufu/v2/me',{authorization}),directory()]);
 const matches=members.filter(m=>m.actor_id===identity.actor_id);
 if(!identity.actor_id||matches.length!==1||matches[0].can_read!==true)throw denied('project_read_denied',403);
 const current=matches[0];
 // Hufu's current project-member decision is the project authority. V8 work
 // metadata is read only when the user actually references a work or project.
 const context=Object.freeze({actor_id:identity.actor_id,project_id:PROJECT,username:identity.actor_id,
  display_name:identity.member_label||identity.actor_id,can_read:true,can_write:current.can_write===true,
  can_publish_announcement:current.can_write===true,is_manager:current.is_manager===true,member_roster:members,legacy_refs:Object.freeze([])});
 const asr=async(action,args)=>{
  if(!['prepare','start','status','poll'].includes(action)||args.project_id!==PROJECT)throw denied('asr_action_invalid',400);
  const response=await routeProjectASR('mem.asr.'+action,args,{fetcher,headers:{accept:'application/json','content-type':'application/json',origin:CENTRAL,authorization},signal:AbortSignal.timeout(60000),target:process.env.QN_ASR_TARGET_ID||'bailian-beijing-asr'});
  const body=await boundedJSON(response,1024*1024);
  if(!response.ok||body.error_code)throw denied(body.error_code||'asr_request_rejected',response.status>=400?response.status:502);
  return body;
 };
 const fileStream=async(fixed,signal)=>{
  if(fixed.project_id!==PROJECT)throw denied('file_project_mismatch');
  return fetcher(CENTRAL+'/hub2-preview/mem/v2/files/read',{method:'POST',headers:{accept:'application/octet-stream','content-type':'application/json',origin:CENTRAL,authorization},body:JSON.stringify({project_id:PROJECT,material_id:fixed.material_id,version_id:fixed.version_id}),redirect:'error',signal});
 };
 return {context,rpc,directory,asr,fileStream,authorityExpiresAt:member.expiresAt??null};
}

export async function nativeBusinessAuthority(cookie,bindings,options){return (await nativeBusinessSession(cookie,bindings,options)).context;}

// Reuse a verified device/project decision for a fixed, bounded interval.
// The lease is never extended by traffic. Different credential cookies remain isolated.
export function coalesceNativeSessions(resolveSession,{maxPending=128,ttlMs=0,rateLimitMs=60000,now=Date.now}={}){
 const pending=new Map(),verified=new Map(),limited=new Map(),versions=new Map();
 const keyOf=cookie=>createHash('sha256').update(cookie).digest('hex');
 function trim(map){while(map.size>maxPending)map.delete(map.keys().next().value);}
 const resolve=async cookie=>{
  if(!cookie)return resolveSession(cookie);
  const key=keyOf(cookie),stamp=now(),cached=verified.get(key),blocked=limited.get(key);
  if(cached&&cached.until>stamp)return cached.value;
  verified.delete(key);
  if(blocked&&blocked.until>stamp)throw blocked.error;
  limited.delete(key);
  if(pending.has(key))return pending.get(key);
  // Saturation must not bypass coalescing and multiply upstream identity reads.
  if(pending.size>=maxPending)throw denied('authority_busy',503);
  const version={valid:true};versions.set(key,version);
  const work=Promise.resolve().then(()=>resolveSession(cookie)).then(value=>{
   if(!version.valid)throw denied('session_changed',401);
   const expires=value.authorityExpiresAt;
   const until=Math.min(stamp+ttlMs,Number.isFinite(expires)?expires:Infinity);
   if(ttlMs>0&&until>now()){verified.set(key,{value,until});trim(verified);}
   return value;
  }).catch(error=>{
   verified.delete(key);
   if(error.status===429&&version.valid){limited.set(key,{error,until:now()+rateLimitMs});trim(limited);}
   throw error;
  });pending.set(key,work);
  try{return await work;}finally{if(pending.get(key)===work)pending.delete(key);if(versions.get(key)===version)versions.delete(key);}
 };
 resolve.invalidate=cookie=>{if(!cookie)return;const key=keyOf(cookie);verified.delete(key);limited.delete(key);const version=versions.get(key);if(version)version.valid=false;};
 return resolve;
}

// One current Hufu project decision for HTTP and notification stream reads.
// The full session carries RPC adapters, not another qualification authority.
export async function nativeEventAuthority(cookie,options={}){
 const {context}=await nativeBusinessSession(cookie,undefined,options);return context;
}
