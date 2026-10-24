import {createHash} from 'node:crypto';
export const BAIZE_PROJECT='3527ac31-0643-4f89-a6bd-b1e9768b2e42';
const origin='http://127.0.0.1:4611';
const actions=['mem.upload','mem.read','mem.write','v8.project.create','v8.project.read'];
const failed=code=>Object.assign(Error(code),{status:503});
// The underlying member credential stays encrypted inside the host-bound cookie.
// Every use checks current member identity and current application authority.
export function rememberedSession({call,handoffSession}){
 const inspect=async s=>{
  const id=await call(origin+'/v2/me',{headers:{authorization:'Bearer '+s.token}});
  if(id.actor_id!==s.actor_id||id.credential_id!==s.credential_id||id.until_revoked!==true||id.credential_type!=='member_api')throw Object.assign(Error('remembered_member_invalid'),{status:401});
  return{token:s.token,id,expires:Infinity};
 };
 return{
  inspect,
  async issue(me,t,operation){
   if(t.application!=='baize'||t.host!=='service.example.invalid')throw failed('remembered_application_invalid');
   if(me.id.is_primary!==true)throw failed('current_primary_login_required_for_remembering');
   const key='baize-remember-'+createHash('sha256').update(operation).digest('hex');
   const grant=await call(origin+'/v2/credentials/create',{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json','idempotency-key':key},body:JSON.stringify({label:'白泽默认长期登录',actions,until_revoked:true,expires_at:null,resource_selector:{version:1,kind:'projects',project_ids:[BAIZE_PROJECT]}})});
   if(typeof grant.credential!=='string'||typeof grant.credential_id!=='string')throw failed('remembered_credential_not_delivered');
   const value={kind:'baize_remembered',until_revoked:true,host:t.host,application:t.application,target:'baize_hufu2',actor_id:me.id.actor_id,credential_id:grant.credential_id,token:grant.credential};
   await inspect(value);
   return{session_cookie:handoffSession.seal(value),session_until_revoked:true,expires_at:new Date(Date.now()+31536000000).toISOString()};
  },
  async logout(s){
   if(s.kind!=='baize_remembered')return{state:'logged_out'};
   try{await inspect(s);}catch(e){if(e.status===401||e.status===403)return{state:'logged_out'};throw e;}
   await call(origin+'/v2/credentials/revoke',{method:'POST',headers:{authorization:'Bearer '+s.token,'content-type':'application/json','idempotency-key':'baize-remember-logout-'+s.credential_id},body:JSON.stringify({credential_id:s.credential_id})});
   return{state:'logged_out'};
  }
 };
}
