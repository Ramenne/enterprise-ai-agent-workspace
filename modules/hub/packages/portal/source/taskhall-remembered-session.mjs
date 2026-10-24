import {createHash} from 'node:crypto';
export const TASKHALL_PROJECT='69197d56-41b0-4c8b-ac19-181f63e87c1f';
export const TASKHALL_TARGET='taskhall_hufu2';
const origin='http://127.0.0.1:4611';
const actions=['v8.work.read','v8.work.commit','v8.project.read'];
const need=(ok,code,status=401)=>{if(!ok)throw Object.assign(Error(code),{status});};

export function taskhallRememberedSession({call,handoffSession}){
 const valid=s=>s?.kind==='taskhall_remembered'&&s.host==='service.example.invalid'&&s.application==='taskhall'&&s.target===TASKHALL_TARGET&&s.until_revoked===true;
 const inspect=async s=>{
  need(valid(s),'remembered_application_invalid');
  const id=await call(origin+'/v2/me',{headers:{authorization:'Bearer '+s.token}});
  need(id.actor_id===s.actor_id&&id.credential_id===s.credential_id&&id.until_revoked===true&&id.credential_type==='member_api'&&id.principal_kind==='member','remembered_member_invalid');
  return{token:s.token,id,expires:Infinity};
 };
 return{
  inspect,
  async consumer(req){
   const token=req.headers['x-hub-consumer-key'];need(typeof token==='string'&&token.length<=4096,'consumer_not_authorized',403);
   const headers={authorization:'Bearer '+token,'content-type':'application/json'};
   const id=await call(origin+'/v2/me',{headers});
   need(id.principal_kind==='service'&&id.client_actions?.includes('hufu.taskhall.sso'),'consumer_not_authorized',403);
   const grants=await call(origin+'/v2/services/authorizations',{method:'POST',headers,body:JSON.stringify({service_id:id.actor_id,project_id:TASKHALL_PROJECT})});
   need(grants.items?.some(g=>g.project_id===TASKHALL_PROJECT&&g.effective_now===true&&g.capabilities?.includes('task_board')),'consumer_not_authorized',403);
   return id;
  },
  async issue(me,t,operation){
   need(t.application==='taskhall'&&t.host==='service.example.invalid','remembered_application_invalid',403);
   need(me.id.is_primary===true&&me.id.principal_kind==='member','current_primary_login_required_for_remembering',403);
   // No supervisor/finance or material actions are issued to this member client.
   const key='taskhall-remember-'+createHash('sha256').update(operation).digest('hex');
   const result=await call(origin+'/v2/credentials/create',{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json','idempotency-key':key},body:JSON.stringify({label:'任务大厅长期成员登录',actions,until_revoked:true,expires_at:null})});
   need(typeof result.credential==='string'&&typeof result.credential_id==='string','remembered_credential_not_delivered',503);
   const value={kind:'taskhall_remembered',until_revoked:true,application:t.application,host:t.host,target:TASKHALL_TARGET,actor_id:me.id.actor_id,credential_id:result.credential_id,token:result.credential};
   await inspect(value);
   return{session_cookie:handoffSession.seal(value),session_until_revoked:true,expires_at:new Date(Date.now()+31536000000).toISOString()};
  },
  async logout(s){
   if(!valid(s))return{state:'logged_out'};
   try{await inspect(s);}catch(e){if(e.status===401||e.status===403)return{state:'logged_out'};throw e;}
   await call(origin+'/v2/credentials/revoke',{method:'POST',headers:{authorization:'Bearer '+s.token,'content-type':'application/json','idempotency-key':'taskhall-logout-'+s.credential_id},body:JSON.stringify({credential_id:s.credential_id})});
   return{state:'logged_out'};
  }
 };
}
