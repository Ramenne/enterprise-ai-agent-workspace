/** Native browser handoff extension of existing Portal2.0. No new identity/token issuance. */
export const applicationSsoTargets={baize_hufu2:{application:'baize',host:'service.example.invalid',callback:'/hufu2/callback'},tools_hufu2:{application:'tools',host:'service.example.invalid',callback:'/hufu2/callback'}};
export function createApplicationSso({handoffSession,identity,tickets,consumers,call}){
 const need=(ok,code,status=401)=>{if(!ok)throw Object.assign(Error(code),{status});};
 const target=b=>{const t=applicationSsoTargets[b.target];need(t,'native_application_target_required',400);return t;};
 const consumer=(req,b)=>{const supplied=req.headers['x-hub-consumer-key']||'',known=consumers[b.target]||'';need(known&&typeof supplied==='string'&&supplied.length===known.length,'consumer_not_authorized',403);return{known,supplied};};
 return{
  async exchange(req,b,timingSafeEqual){const t=target(b),k=consumer(req,b);need(timingSafeEqual(Buffer.from(k.known),Buffer.from(k.supplied)),'consumer_not_authorized',403);
   const ticket=tickets.get(b.ticket);need(ticket&&ticket.target===b.target&&ticket.host===t.host&&ticket.state===b.state&&ticket.expires>Date.now(),'invalid_handoff');tickets.delete(b.ticket);
   const me=await identity(ticket.cookie);need(me&&Number.isFinite(me.expires)&&me.expires>Date.now(),'session_expired');
   // Only Portal holds the encryption key. Cookie is exact application AND host bound.
   const expires=Math.min(me.expires,ticket.sessionExpires,Date.now()+28800000);const cookie=handoffSession.seal({cookie:ticket.cookie,host:t.host,application:t.application,target:b.target,expires});
   return{state:'authenticated_handoff',session_cookie:cookie,expires_at:new Date(expires).toISOString(),next:ticket.next.startsWith('/hufu2/')&&!ticket.next.startsWith('//')?ticket.next:'/hufu2/',actor_id:me.id.actor_id};
  },
  async check(req,b,timingSafeEqual){const t=target(b),k=consumer(req,b);need(timingSafeEqual(Buffer.from(k.known),Buffer.from(k.supplied)),'consumer_not_authorized',403);
   const s=handoffSession.open(b.cookie);need(s&&s.host===t.host&&s.application===t.application&&s.target===b.target,'application_session_invalid');
   const me=await identity(s.cookie);need(me&&me.expires>Date.now(),'session_expired');
   need(typeof b.route==='string'&&b.route.startsWith('/')&&b.route.length<2048&&['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE'].includes(b.method),'application_route_required',400);
   const collecting=t.application==='tools'&&b.method==='GET'&&b.route==='/'&&b.side_effect_query===true;
   const grants=t.application==='baize'&&(b.route==='/api/v1/dual-grants'||b.route.startsWith('/api/v1/dual-grants/'));
   const decision=await call('http://127.0.0.1:4611/v2/authorization/decision',{method:'POST',headers:{authorization:'Bearer '+me.token,'content-type':'application/json'},body:JSON.stringify({application_id:t.application,action:grants||(['GET','HEAD','OPTIONS'].includes(b.method)&&!collecting)?'read':'write',resource:{route:b.route,method:b.method}})});
   return{state:'current_caller',authorization:'Bearer '+me.token,decision,expires_at:new Date(Math.min(s.expires,me.expires)).toISOString()};
  }
 };
}
