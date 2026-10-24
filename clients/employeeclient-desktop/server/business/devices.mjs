import {notificationTarget} from './notification-target.mjs';
import {createHash} from 'node:crypto';
import {PROJECT,assertActorNeutralBody} from './native-authority.mjs';
import {validateSubscription} from './web-push-provider.mjs';
export const subscriptionFingerprint=value=>value?createHash('sha256').update(value).digest('hex'):null;
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
export const DEVICE_SCHEMA=`CREATE TABLE IF NOT EXISTS device_bindings(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,platform TEXT NOT NULL,subscription_json TEXT,created_at INTEGER NOT NULL,revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS device_push_diagnostics(device_id TEXT PRIMARY KEY,client_version INTEGER,permission TEXT,phase TEXT,error_code TEXT,observed_at INTEGER NOT NULL,last_bound_at INTEGER);
CREATE TABLE IF NOT EXISTS rejected_push_subscriptions(device_id TEXT NOT NULL,fingerprint TEXT NOT NULL,rejected_at INTEGER NOT NULL,PRIMARY KEY(device_id,fingerprint));
CREATE TABLE IF NOT EXISTS push_deliveries(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL,device_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error_code TEXT);
CREATE INDEX IF NOT EXISTS push_deliveries_target ON push_deliveries(notification_id,device_id);`;
export function createDeviceRepository(db,{now=Date.now}={}){
 db.exec(DEVICE_SCHEMA);
 const check=ctx=>{if(!ctx?.can_read||!ctx.actor_id||ctx.project_id!==PROJECT)fail('project_read_denied',403);};
 const retryExpired=id=>{
  db.exec('SAVEPOINT device_delivery_retry');
  try{
   const changed=db.prepare("UPDATE push_deliveries SET state='queued',updated_at=?,error_code=NULL WHERE device_id=? AND state='subscription_expired'").run(now(),id);
   if(changed.changes)db.prepare("UPDATE delivery_outbox SET state='queued' WHERE state='processed' AND notification_id IN (SELECT notification_id FROM push_deliveries WHERE device_id=? AND state='queued')").run(id);
   db.exec('RELEASE device_delivery_retry');
  }catch(error){db.exec('ROLLBACK TO device_delivery_retry; RELEASE device_delivery_retry');throw error;}
 };
 const assertFresh=(id,saved)=>{if(saved&&db.prepare('SELECT 1 FROM rejected_push_subscriptions WHERE device_id=? AND fingerprint=?').get(id,subscriptionFingerprint(saved)))fail('push_subscription_expired',409);};
 const recordDiagnostic=(id,raw,bound=false)=>{
  const old=db.prepare('SELECT * FROM device_push_diagnostics WHERE device_id=?').get(id),d=raw&&typeof raw==='object'?raw:{};
  const permission=['granted','denied','default','unsupported','unknown','native'].includes(d.permission)?d.permission:old?.permission||'unknown';
  const phase=bound?'ready':['permission','worker','config','subscription','registration','ready'].includes(d.phase)?d.phase:'registration';
  const code=!bound&&typeof d.code==='string'&&d.code!=='ready'&&/^[a-zA-Z0-9_]{1,64}$/.test(d.code)?d.code:null;
  const version=Number.isSafeInteger(d.client_version)&&d.client_version>0&&d.client_version<10000000?d.client_version:old?.client_version??null;
  db.prepare('INSERT INTO device_push_diagnostics VALUES(?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET client_version=excluded.client_version,permission=excluded.permission,phase=excluded.phase,error_code=excluded.error_code,observed_at=excluded.observed_at,last_bound_at=excluded.last_bound_at').run(id,version,permission,phase,code,now(),bound?now():old?.last_bound_at??null);
 };
 const publicView=d=>{const diagnosis=db.prepare('SELECT client_version,permission,phase,error_code,observed_at,last_bound_at FROM device_push_diagnostics WHERE device_id=?').get(d.id)||null;return {installation_id:d.id,platform:d.platform,status:d.revoked_at===null?'active':'revoked',created_at:d.created_at,updated_at:d.revoked_at||diagnosis?.observed_at||d.created_at,last_auth_sync_at:diagnosis?.observed_at||d.created_at,push_subscription:!!d.subscription_json,subscription_fingerprint:subscriptionFingerprint(d.subscription_json),push_diagnostic:diagnosis};};
 return {health(){
  const registered=db.prepare("SELECT COUNT(*) registered,SUM(subscription_json IS NOT NULL) subscribed FROM device_bindings WHERE platform='ios_web_push' AND revoked_at IS NULL").get();
  const pending=db.prepare("SELECT COUNT(*) n FROM delivery_outbox WHERE state IN ('queued','sending','failed')").get().n;
  return {state:registered.registered&&!registered.subscribed?'awaiting_subscription':registered.subscribed?'configured':'awaiting_client',registered_pwa:registered.registered,subscribed_pwa:registered.subscribed||0,pending_outbox:pending,device_display:'not_asserted'};
 },list(ctx){check(ctx);return {devices:db.prepare('SELECT * FROM device_bindings WHERE actor_id=?').all(ctx.actor_id).map(publicView)};},
  bind(ctx,body){check(ctx);assertActorNeutralBody(body);
   if(typeof body.installation_id!=='string'||!(/^[A-Za-z0-9_.:-]{2,128}$/).test(body.installation_id)||!['android_native','ios_web_push'].includes(body.platform))fail('invalid_device');
   if(body.platform==='android_native'&&body.subscription!=null)fail('android_subscription_retired');
   const sub=body.subscription==null?null:validateSubscription(body.subscription);
   const id='qn-'+createHash('sha256').update(ctx.actor_id+'\0'+body.installation_id).digest('hex');
   const old=db.prepare('SELECT * FROM device_bindings WHERE id=?').get(id);
   if(old&&old.actor_id!==ctx.actor_id)fail('device_identity_conflict',409);
   if(!old&&db.prepare('SELECT COUNT(*) n FROM device_bindings WHERE actor_id=? AND revoked_at IS NULL').get(ctx.actor_id).n>=20)fail('device_limit_exceeded',409);
   // Failure to read a browser subscription is not a request to revoke it.
   // Only a fresh subscription replaces it; explicit revoke still clears it.
   const saved=sub?JSON.stringify(sub):old&&old.revoked_at===null&&old.platform===body.platform?old.subscription_json:null;
   assertFresh(id,saved);
   if(sub&&old?.revoked_at===null&&old.subscription_json&&old.subscription_json!==saved&&subscriptionFingerprint(old.subscription_json)!==body.expected_fingerprint)fail('subscription_revision_changed',409);
   db.prepare('INSERT INTO device_bindings(id,actor_id,platform,subscription_json,created_at,revoked_at) VALUES(?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,subscription_json=excluded.subscription_json,revoked_at=NULL').run(id,ctx.actor_id,body.platform,saved,now());
   recordDiagnostic(id,body.diagnostic,!!sub);
   const current=db.prepare('SELECT * FROM device_bindings WHERE id=?').get(id);
   if(saved)retryExpired(id);
   return {state:'bound',device:publicView(current),push_bound:!!current.subscription_json,device_display:'not_asserted'};
  },renew(ctx,id,body){check(ctx);assertActorNeutralBody(body);
   const old=db.prepare('SELECT * FROM device_bindings WHERE id=? AND actor_id=?').get(id,ctx.actor_id);
   // Renewal cannot create/reactivate devices, or bind a second account.
   if(!old||old.revoked_at!==null||old.platform!=='ios_web_push')fail('device_not_active',404);
   // null means first registration, not permission to replace an existing one.
   if(body.expected_fingerprint!==null&&(typeof body.expected_fingerprint!=='string'||!(/^[a-f0-9]{64}$/).test(body.expected_fingerprint)))fail('invalid_subscription_revision');
   const saved=JSON.stringify(validateSubscription(body.subscription));
   assertFresh(id,saved);
   if(old.subscription_json!==saved&&old.subscription_json!==null&&subscriptionFingerprint(old.subscription_json)!==body.expected_fingerprint)fail('subscription_revision_changed',409);
   db.prepare('UPDATE device_bindings SET subscription_json=? WHERE id=? AND actor_id=? AND revoked_at IS NULL').run(saved,id,ctx.actor_id);
   // Expired subscriptions can be replaced. Explicit revoke remains terminal.
   retryExpired(id);recordDiagnostic(id,body.diagnostic,true);
   return {state:'bound',device:publicView(db.prepare('SELECT * FROM device_bindings WHERE id=?').get(id)),push_bound:true};
  },revoke(ctx,id){check(ctx);const changed=db.prepare('UPDATE device_bindings SET revoked_at=?,subscription_json=NULL WHERE id=? AND actor_id=?').run(now(),id,ctx.actor_id);if(!changed.changes)fail('device_not_found',404);return {state:'revoked'};}
 };
}
// A current native session supplies a freshly rechecked directory. No cookie or
// service key is persisted. Restart catch-up begins on the next authorized request.
export function createDeliveryDispatcher(db,provider,{now=Date.now,directory:authority=null,onSubscriptionExpired=null,messageBadge=null}={}){
 let running=false,timer=null,latest=authority,again=false,closed=false;
 db.function('employeeclient_delivery_id',{deterministic:true},(job,device)=>createHash('sha256').update(job+'\0'+device).digest('hex'));
 // Select executable deliveries, not just the oldest failed batch. A retry's
 // persisted updated_at/state remains its deadline across process restarts.
 const delaySql="CASE WHEN p.state='sending' THEN 60000 WHEN p.state LIKE 'retry:%' THEN MIN(300000,1000*(1 << CAST(SUBSTR(p.state,7) AS INTEGER))) ELSE 0 END";
 const bindings="d.actor_id=o.recipient_actor AND d.platform='ios_web_push' AND d.revoked_at IS NULL AND d.subscription_json IS NOT NULL";
 const unfinished="(p.id IS NULL OR p.state NOT IN ('provider_accepted','subscription_expired','delivery_failed'))";
 const eligible=`EXISTS(SELECT 1 FROM device_bindings d LEFT JOIN push_deliveries p ON p.id=employeeclient_delivery_id(o.id,d.id) WHERE ${bindings} AND ${unfinished} AND (p.id IS NULL OR p.state='queued' OR p.updated_at+(${delaySql})<=?))`;
 const nextDeadline=()=>db.prepare(`SELECT MIN(CASE WHEN p.id IS NULL OR p.state='queued' THEN ? ELSE p.updated_at+(${delaySql}) END) due FROM delivery_outbox o JOIN device_bindings d ON ${bindings} LEFT JOIN push_deliveries p ON p.id=employeeclient_delivery_id(o.id,d.id) WHERE o.state IN ('queued','sending','failed') AND ${unfinished}`).get(now()).due;

 const drain=async function(directory){if(running||!provider)return null;running=true;let retryAfter=null,completed=0;const defer=ms=>{retryAfter=Math.min(retryAfter??Infinity,Math.max(1,ms));};try{
  // A delivery is retired by authoritative read/recall state even when no
  // endpoint exists; message history and device registration are untouched.
  db.prepare("UPDATE delivery_outbox SET state='expired' WHERE state IN ('queued','sending','failed') AND id NOT LIKE 'state:%' AND notification_id IN (SELECT n.id FROM notifications n JOIN messages m ON m.id=n.message_id WHERE n.read_at IS NOT NULL OR n.acked_at IS NOT NULL OR n.hidden_at IS NOT NULL OR m.recalled_at IS NOT NULL)").run();
  db.prepare(`UPDATE delivery_outbox AS o SET state='processed' WHERE o.state IN ('queued','sending','failed') AND EXISTS(SELECT 1 FROM device_bindings d WHERE ${bindings}) AND NOT EXISTS(SELECT 1 FROM device_bindings d LEFT JOIN push_deliveries p ON p.id=employeeclient_delivery_id(o.id,d.id) WHERE ${bindings} AND ${unfinished})`).run();
  const rows=db.prepare(`SELECT o.*,(SELECT MAX(seq) FROM notification_changes c WHERE c.notification_id=n.id) AS delivery_version,n.message_id,n.version,n.hidden_at,n.read_at,n.acked_at,n.title,n.summary,n.snapshot_json,m.recalled_at,m.metadata_json,m.message_type,m.reply_id AS parent_message_id FROM delivery_outbox o JOIN notifications n ON n.id=o.notification_id JOIN messages m ON m.id=n.message_id WHERE o.state IN ('queued','sending','failed') AND ${eligible} ORDER BY CASE o.state WHEN 'queued' THEN 0 ELSE 1 END,o.created_at LIMIT 100`).all(now());
  jobs:for(const job of rows){
   if(closed)return null;
   const members=await directory();if(closed)return null;if(!members.some(m=>m.actor_id===job.recipient_actor&&m.can_read===true)){db.prepare("UPDATE delivery_outbox SET state='expired' WHERE id=?").run(job.id);continue;}
   const stateOnly=job.id.startsWith('state:');
   const meta=JSON.parse(job.metadata_json||'{}'),snapshot=JSON.parse(job.snapshot_json);
   if(!stateOnly&&(job.hidden_at||job.read_at||job.acked_at||job.recalled_at||meta.expires_at&&meta.expires_at<=now())){db.prepare("UPDATE delivery_outbox SET state='expired' WHERE id=?").run(job.id);continue;}
   if(!stateOnly&&snapshot.silent===true&&meta.priority!=='urgent'){db.prepare("UPDATE delivery_outbox SET state='inbox_only' WHERE id=?").run(job.id);continue;}
   const devices=db.prepare('SELECT * FROM device_bindings WHERE actor_id=? AND revoked_at IS NULL').all(job.recipient_actor);
   if(!devices.length)continue;
   let pending=false;
   for(const device of devices){
    if(device.platform!=='ios_web_push'||!device.subscription_json)continue;
    const id=createHash('sha256').update(job.id+'\0'+device.id).digest('hex');
    db.prepare("INSERT OR IGNORE INTO push_deliveries VALUES(?,?,?,'queued',?,?,NULL)").run(id,job.notification_id,device.id,now(),now());
    const d=db.prepare('SELECT * FROM push_deliveries WHERE id=?').get(id);
    if(['provider_accepted','subscription_expired','delivery_failed'].includes(d.state))continue;
    const attempt=d.state.startsWith('retry:')?Number(d.state.split(':')[1]):0;
    if(d.state==='sending'&&now()-d.updated_at<60000||attempt&&now()-d.updated_at<Math.min(300000,1000*2**attempt)){pending=true;defer(d.state==='sending'?60000-(now()-d.updated_at):Math.min(300000,1000*2**attempt)-(now()-d.updated_at));continue;}
    // Recheck recipient eligibility and binding immediately before external send.
    const current=await directory();if(closed)return null;const live=db.prepare('SELECT * FROM device_bindings WHERE id=? AND revoked_at IS NULL').get(device.id);
    if(!current.some(m=>m.actor_id===job.recipient_actor&&m.can_read===true)||!live||live.subscription_json!==device.subscription_json){pending=true;defer(30000);continue;}
    const notice=db.prepare('SELECT version,read_at,acked_at,hidden_at,snooze_until FROM notifications WHERE id=?').get(job.notification_id);
    if(!notice||!stateOnly&&(notice.read_at||notice.acked_at||notice.hidden_at||notice.snooze_until>now())){
     db.prepare("UPDATE delivery_outbox SET state=? WHERE id=?").run(notice?.snooze_until>now()?'snoozed':'expired',job.id);continue jobs;
    }
    if(notice.version!==job.version){pending=true;defer(1);break;}
    db.prepare("UPDATE push_deliveries SET state='sending',updated_at=? WHERE id=?").run(now(),id);
    let result;try{result=await provider.deliver(JSON.parse(live.subscription_json),{id:job.notification_id,recipient_actor:job.recipient_actor,device_id:device.id,version:job.delivery_version||job.version,state_only:stateOnly,created_at:job.created_at,title:job.title,summary:job.summary,...notificationTarget(job.message_type,job.message_id,job.parent_message_id,PROJECT),priority:meta.priority||'normal',snapshot,...(messageBadge?{message_badge:messageBadge({actor_id:job.recipient_actor,project_id:PROJECT,can_read:true})}:{})});}catch{result={state:'delivery_failed',retryable:true};}
    if(closed)return null;
    const afterSend=db.prepare('SELECT subscription_json,revoked_at FROM device_bindings WHERE id=?').get(device.id);
    if(afterSend?.revoked_at===null&&afterSend.subscription_json&&afterSend.subscription_json!==live.subscription_json){
     // A late response for an old endpoint must not retire the replacement or
     // mark its unread delivery complete. Re-run against the new subscription.
     db.prepare("UPDATE push_deliveries SET state='queued',updated_at=?,error_code=NULL WHERE id=?").run(now(),id);
     pending=true;defer(1);continue;
    }
    // Transient provider/network outages must not permanently discard delivery.
    // Retry at a capped interval until read, expiry, revocation or a permanent refusal.
    const retry=result.retryable===true,state=retry?'retry:'+Math.min(attempt+1,9):result.state;
    db.prepare('UPDATE push_deliveries SET state=?,updated_at=?,error_code=? WHERE id=?').run(state,now(),result.provider_status?String(result.provider_status):result.transport_error||null,id);
    if(result.state==='subscription_expired'){
     db.exec('SAVEPOINT rejected_push_subscription');
     try{
      db.prepare('INSERT OR IGNORE INTO rejected_push_subscriptions VALUES(?,?,?)').run(live.id,subscriptionFingerprint(live.subscription_json),now());
      db.prepare('UPDATE device_bindings SET subscription_json=NULL WHERE id=? AND subscription_json=?').run(live.id,live.subscription_json);
      db.exec('RELEASE rejected_push_subscription');
      try{onSubscriptionExpired?.(live.actor_id);}catch{/* durable rejection still repairs on page resume */}
     }catch(error){db.exec('ROLLBACK TO rejected_push_subscription; RELEASE rejected_push_subscription');throw error;}
    }
    if(retry){pending=true;defer(Math.min(300000,1000*2**(attempt+1)));}
   }
   if(!pending){db.prepare("UPDATE delivery_outbox SET state='processed' WHERE id=?").run(job.id);completed++;}
   else db.prepare("UPDATE delivery_outbox SET state='failed' WHERE id=?").run(job.id);
  }
 if(rows.length===100)defer(1);
 const due=nextDeadline();if(due!==null)defer(due-now());
 return retryAfter;}finally{running=false;}};
 // Wake after a committed event. Timers are only durable retry/batch recovery,
 // never a business-message polling loop. A runtime identity can recheck current
 // membership independently of the last user request and survive a restart.
 const schedule=delay=>{if(closed)return;clearTimeout(timer);timer=setTimeout(()=>{timer=null;drain.wake();},delay);timer.unref?.();};
 drain.wake=directory=>{
  if(closed)return;
  if(authority)latest=authority;else if(directory)latest=directory;
  if(!latest||!provider)return;
  if(running){again=true;return;}clearTimeout(timer);timer=null;
  void drain(latest).then(delay=>{
   if(closed)return;
   if(again){again=false;schedule(1);return;}
   if(delay!=null)schedule(delay);
  }).catch(()=>{again=false;if(!closed)schedule(30000);});
 };
 drain.close=()=>{closed=true;clearTimeout(timer);timer=null;latest=null;again=false;};
 if(authority)queueMicrotask(()=>drain.wake());
 return drain;
}
