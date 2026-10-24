import {taskhallRememberedSession} from './taskhall-remembered-session.mjs';
import {rememberedSession} from './baize-remembered-session.mjs';
/** Native application entry with actual member-issued persistent Baize authorization. */
export const applicationSsoTargets={baize_hufu2:{application:'baize',host:'service.example.invalid',callback:'/hufu2/callback'},tools_hufu2:{application:'tools',host:'service.example.invalid',callback:'/hufu2/callback'},taskhall_hufu2:{application:'taskhall',host:'service.example.invalid',callback:'/auth/callback'}};
export function createApplicationSso({handoffSession,identity,tickets,consumers,call}){
 const remembered=rememberedSession({call,handoffSession});
 const taskhall=taskhallRememberedSession({call,handoffSession});
 const need=(ok,code,status=401)=>{if(!ok)throw Object.assign(Error(code),{status});};
 const target=b=>{const t=applicationSsoTargets[b.target];need(t,'native_application_target_required',400);return t;};
 const legacyConsumer=(req,b)=>{const supplied=req.headers['x-hub-consumer-key']||'',known=consumers[b.target]||'';need(known&&typeof supplied==='string'&&supplied.length===known.length,'consumer_not_authorized',403);return{known,supplied};};
 const authorizeConsumer=async(req,b,timingSafeEqual)=>{if(b.target==='taskhall_hufu2'){await taskhall.consumer(req);return;}const k=legacyConsumer(req,b);need(timingSafeEqual(Buffer.from(k.known),Buffer.from(k.supplied)),'consumer_not_authorized',403);};
 return{
  async exchange(req,b,timingSafeEqual){const t=target(b);await authorizeConsumer(req,b,timingSafeEqual);
   const ticket=tickets.get(b.ticket);need(ticket&&ticket.target===b.target&&ticket.host===t.host&&ticket.state===b.state&&ticket.expires>Date.now(),'invalid_handoff');
   const me=await identity(ticket.cookie);need(me&&Number.isFinite(me.expires)&&me.expires>Date.now(),'session_expired');
   if(t.application==='taskhall'){const session=await taskhall.issue(me,t,'exchange:'+b.ticket);tickets.delete(b.ticket);return{state:'authenticated_handoff',...session,next:'/',actor_id:me.id.actor_id};}
   if(t.application==='baize'){
    const session=await remembered.issue(me,t,'exchange:'+b.ticket);tickets.delete(b.ticket);
    return{state:'authenticated_handoff',...session,next:ticket.next.startsWith('/hufu2/')&&!ticket.next.startsWith('//')?ticket.next:'/hufu2/',actor_id:me.id.actor_id};
   }
   tickets.delete(b.ticket);
   // Only Portal holds the encryption key. Cookie is exact application AND host bound.
   const expires=Math.min(me.expires,ticket.sessionExpires,Date.now()+28800000);const cookie=handoffSession.seal({cookie:ticket.cookie,host:t.host,application:t.application,target:b.target,actor_id:me.id.actor_id,expires});
   return{state:'authenticated_handoff',session_cookie:cookie,expires_at:new Date(expires).toISOString(),next:ticket.next.startsWith('/hufu2/')&&!ticket.next.startsWith('//')?ticket.next:'/hufu2/',actor_id:me.id.actor_id};
  },
  async check(req,b,timingSafeEqual){const t=target(b);await authorizeConsumer(req,b,timingSafeEqual);
   const s=handoffSession.open(b.cookie);need(s&&s.host===t.host&&s.application===t.application&&s.target===b.target,'application_session_invalid');
   const persistent=s.kind==='baize_remembered'||s.kind==='taskhall_remembered';
   const me=s.kind==='taskhall_remembered'?await taskhall.inspect(s):persistent?await remembered.inspect(s):await identity(s.cookie);need(me&&me.expires>Date.now(),'session_expired');
   need(!s.actor_id||s.actor_id===me.id.actor_id,'application_session_actor_changed');
   need(typeof b.route==='string'&&b.route.startsWith('/')&&b.route.length<2048&&['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE'].includes(b.method),'application_route_required',400);
   const collecting=t.application==='tools'&&b.method==='GET'&&b.route==='/'&&b.side_effect_query===true;
   const grants=t.application==='baize'&&(b.route==='/api/v1/dual-grants'||b.route.startsWith('/api/v1/dual-grants/'));
   if(t.application==='taskhall')return{state:'current_caller',authorization:'Bearer '+me.token,identity:me.id,session_cookie:b.cookie,session_until_revoked:true,expires_at:new Date(Date.now()+31536000000).toISOString()};
   const decision=await call('http://127.0.0.1:4611/v2/authorization/decision',{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json'},body:JSON.stringify({application_id:t.application,action:grants||(['GET','HEAD','OPTIONS'].includes(b.method)&&!collecting)?'read':'write',resource:{route:b.route,method:b.method}})});
   need(decision.actor_id===me.id.actor_id,'application_decision_actor_changed',403);
   if(persistent)return{state:'current_caller',authorization:'Bearer '+me.token,decision,session_cookie:b.cookie,session_until_revoked:true,expires_at:new Date(Date.now()+31536000000).toISOString()};
   // Upgrade an existing valid login once; expired or revoked sessions cannot bootstrap.
   if(t.application==='baize')return{state:'current_caller',authorization:'Bearer '+me.token,decision,...await remembered.issue(me,t,'upgrade:'+b.cookie)};
   // Refresh only an unexpired product cookie backed by this same live central session.
   // The central expiry is authoritative; revocation and expiry still fail closed above.
   const expires=Math.min(me.expires,Date.now()+28800000);
   const renew=expires>s.expires+60000;
   return{state:'current_caller',authorization:'Bearer '+me.token,decision,
    expires_at:new Date(renew?expires:Math.min(s.expires,me.expires)).toISOString(),
    ...(renew?{session_cookie:handoffSession.seal({...s,actor_id:me.id.actor_id,expires})}:{})};
  },
  async logout(req,b,timingSafeEqual){
   const t=target(b);await authorizeConsumer(req,b,timingSafeEqual);
   const s=handoffSession.open(b.cookie);if(!s)return{state:'logged_out'};
   need(s.host===t.host&&s.application===t.application&&s.target===b.target,'application_session_invalid');
   return s.kind==='taskhall_remembered'?taskhall.logout(s):remembered.logout(s);
  }
 };
}
