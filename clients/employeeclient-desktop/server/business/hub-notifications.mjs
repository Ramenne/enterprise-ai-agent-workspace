import {readFile,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PROJECT} from './native-authority.mjs';
const CONFIG='/srv/workspace';
const HUFU='https://hufu.example.invalid/hub2-preview/hufu';
const MEM='https://hufu.example.invalid/hub2-preview/mem';
const fail=(code,status=503)=>{throw Object.assign(Error(code),{code,status});};
// Fixed authority lease, not extended by message traffic. No stale fallback.
// One failed lookup also has a bounded cooldown so a burst cannot hammer Hufu.
export function shareMemberDirectory(read,{ttlMs=15000,now=Date.now}={}){
 let cached=null,until=0,pending=null,rejected=null,retryAt=0;
 return async()=>{
  const stamp=now();
  if(cached&&stamp<until)return cached;
  if(pending)return pending;
  if(rejected&&stamp<retryAt)throw rejected;
  cached=null;rejected=null;
  const work=Promise.resolve().then(read).then(rows=>{
   cached=Object.freeze(rows.map(row=>Object.freeze({...row})));until=stamp+ttlMs;return cached;
  }).catch(error=>{cached=null;rejected=error;retryAt=now()+ttlMs;throw error;});
  pending=work;
  try{return await work;}finally{if(pending===work)pending=null;}
 };
}
export async function loadNotificationFoundation({path=CONFIG,fetcher=globalThis.fetch.bind(globalThis),signal}={}){
 const info=await stat(path);if(!info.isFile()||info.size>8192||(info.mode&0o077))fail('foundation_configuration_not_private');
 const text=(await readFile(path,'utf8')).trim();let token;
 if(text.startsWith('hub2_'))token=text;else{let value;try{value=JSON.parse(text);}catch{fail('foundation_configuration_invalid');}token=value.token||value.access_token||(typeof value.credential==='string'?value.credential:value.credential?.token);}
 if(typeof token!=='string'||!/^hub2_[A-Za-z0-9_-]{20,}$/.test(token))fail('foundation_configuration_invalid');
 const call=async(path,body)=>{
  const r=await fetcher(HUFU+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
  let v;try{v=await r.json();}catch{fail('foundation_response_invalid');}if(!r.ok||v.error_code)fail('foundation_authorization_unavailable',r.status>=400?r.status:503);return v.body??v;
 };
 const identity=await call('/v2/me');
 if(!identity.actor_id||identity.principal_kind!=='service'||identity.authorization_mode!=='product_service')fail('registered_product_identity_required',403);
 const directory=shareMemberDirectory(async()=>{
  const members=[];let offset=0;
  for(;;){const page=await call('/v2/projects/members',{project_id:PROJECT,limit:100,offset});if(page.project_id!==PROJECT||!Array.isArray(page.members))fail('foundation_directory_scope_invalid');members.push(...page.members.filter(m=>m.can_read===true));if(page.next_offset==null)break;if(!Number.isSafeInteger(page.next_offset)||page.next_offset<=offset)fail('foundation_directory_cursor_invalid');offset=page.next_offset;}return members;
 });
 await directory(); // An actual call, not a configuration-presence readiness claim.
 return Object.freeze({actor_id:identity.actor_id,directory,
  stream:signal=>fetcher(MEM+'/v2/changes/events?project_id='+PROJECT,{headers:{authorization:'Bearer '+token,accept:'text/event-stream'},credentials:'omit',redirect:'error',signal})});
}
export function createHubNoticeStore(db,{now=Date.now}={}){
 db.exec('CREATE TABLE IF NOT EXISTS hub_project_projection(project_id TEXT PRIMARY KEY,digest TEXT NOT NULL,updated_at INTEGER NOT NULL);');
 return {
  apply(foundation,projection,members){
   if(projection.project_id!==PROJECT||projection.complete_projection!==true||!Array.isArray(projection.aggregates)||!foundation.actor_id)fail('hub_projection_invalid');
   const rows=projection.aggregates.map(x=>({domain:x.domain,aggregate_id:x.aggregate_id,aggregate_revision:x.aggregate_revision,state:x.state})).sort((a,b)=>(a.domain+':'+a.aggregate_id).localeCompare(b.domain+':'+b.aggregate_id));
   const digest=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
   const recipients=[...new Set(members.filter(x=>x.can_read===true&&x.actor_id!==foundation.actor_id).map(x=>x.actor_id))];
   db.exec('BEGIN IMMEDIATE');try{
    const old=db.prepare('SELECT digest FROM hub_project_projection WHERE project_id=?').get(PROJECT);
    if(old?.digest===digest){db.exec('COMMIT');return {state:'unchanged',created:0};}
    let count=0;
    // First connection establishes the historical baseline. Later differences,
    // including restart catch-up, create one durable synchronization hint.
    // This projection has no source actor: do not push anonymous changes to everyone.
    if(old&&recipients.length){const id=randomUUID(),stamp=now();
     db.prepare("INSERT INTO messages(id,actor_id,display_name,body,mentions,attachments_json,created_at,message_type,recipients_json,metadata_json) VALUES(?,?,?,?,?,?,?,'hub_notice',?,?)")
      .run(id,foundation.actor_id,'中枢','员工客户端项目资料或工作有更新，点击查看。','[]','[]',stamp,JSON.stringify(recipients),JSON.stringify({project_id:PROJECT,priority:'normal'}));
     for(const actor of recipients){const n=randomUUID();db.prepare('INSERT INTO notifications(id,recipient_actor,message_id,title,summary,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(n,actor,id,'员工客户端项目更新','资料或工作有更新，点击查看。',JSON.stringify({kind:'hub_update',silent:true,source:'authorized_project_commit_snapshot',project_id:PROJECT}),stamp,stamp);
      db.prepare('INSERT INTO notification_changes(notification_id,recipient_actor) VALUES(?,?)').run(n,actor);count++;}
    }
    db.prepare('INSERT INTO hub_project_projection VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET digest=excluded.digest,updated_at=excluded.updated_at').run(PROJECT,digest,now());db.exec('COMMIT');return {state:old?'updated':'baseline',created:count};
   }catch(e){db.exec('ROLLBACK');throw e;}
  }
 };
}
export function startHubSubscription(foundation,store,{changed=()=>{},status=()=>{},retryDelay=failures=>Math.min(60000,1000*2**Math.min(failures-1,6))}={}){
 let stopped=false,controller=null,timer=null,failures=0;
 const run=async()=>{
  if(stopped)return;const ctl=new AbortController();controller=ctl;let watchdog;
  const touch=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>ctl.abort(),45000);watchdog.unref?.();};touch();
  try{const r=await foundation.stream(ctl.signal);if(!r.ok||!r.body||!r.headers.get('content-type')?.includes('text/event-stream'))fail('hub_subscription_unavailable',r.status>=400?r.status:503);
   const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='',verified=false;
   try{for(;;){const {done,value}=await reader.read();if(done)throw Error('hub_subscription_closed');ctl.signal.throwIfAborted();buffer+=decoder.decode(value,{stream:true});if(buffer.length>2*1024*1024)throw Error('hub_subscription_frame_limit');let end;
    while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const type=/^event: (.+)$/m.exec(frame)?.[1],data=/^data: (.+)$/m.exec(frame)?.[1];if(!type||!data||!['ready','snapshot','ping','auth','error'].includes(type))continue;const p=JSON.parse(data);
     if(type==='ready'){if(p.project_id!==PROJECT)fail('hub_subscription_project_mismatch',403);verified=true;failures=0;status('connected');}
     if(!verified)throw Error('hub_subscription_identity_unconfirmed');touch();
     if(type==='snapshot'){const members=await foundation.directory();if(ctl.signal.aborted||stopped)return;const result=store.apply(foundation,p,members);status('live');if(result.created)changed();}
     if(type==='auth'||type==='error')fail('hub_subscription_authority_unavailable',type==='auth'?(p.status===403?403:401):503);
    }
   }}finally{ctl.abort();await reader.cancel().catch(()=>{});}
  }catch(e){if(!stopped){if(e.status===401||e.status===403){stopped=true;status('unauthorized');}else{status('reconnecting');failures++;timer=setTimeout(run,retryDelay(failures));timer.unref?.();}}}
  finally{clearTimeout(watchdog);}
 };
 void run();return {close(){stopped=true;clearTimeout(timer);controller?.abort();}};
}

// A remote foundation outage must not terminate chat or the member event service.
// The directory stays unavailable until a real service identity is verified.
export function createFoundationNotifications(load,store,{changed=()=>{},status=()=>{},retryMs=30000,subscriptionOptions={}}={}){
 let stopped=false,provider=null,stream=null,timer=null,controller=null;
 let view={state:'starting',error_code:null};
 const report=(state,error_code=null)=>{view={state,error_code};status({...view});};
 const attempt=async()=>{
  if(stopped)return;const ctl=new AbortController();controller=ctl;report('verifying');
  try{const actual=await load({signal:ctl.signal});if(stopped||ctl.signal.aborted)return;
   provider=actual;
   stream=startHubSubscription(actual,store,{...subscriptionOptions,changed,status:state=>{report(state);if(state==='unauthorized')provider=null;}});
  }catch(e){if(stopped||ctl.signal.aborted)return;provider=null;
   const denied=e.status===401||e.status===403;
   report(denied?'unauthorized':'unavailable',typeof e.code==='string'&&/^[a-z0-9_]{1,100}$/.test(e.code)?e.code:'foundation_temporarily_unavailable');
   if(!denied){timer=setTimeout(attempt,retryMs);timer.unref?.();}
  }
 };
 void attempt();return {
  async directory(){if(stopped||!provider)fail('foundation_directory_not_ready');return provider.directory();},
  snapshot(){return {...view};},
  close(){stopped=true;clearTimeout(timer);controller?.abort();stream?.close();provider=null;report('stopped');}
 };
}
