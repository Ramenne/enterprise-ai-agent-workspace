// Temporary isolated server, actual HTTP handlers/provider, never production SQLite.
import {DatabaseSync} from 'node:sqlite';
import {createGateway} from '../server/gateway-factory.mjs';
import {createRuntimeHandler} from '../server/business/runtime.mjs';
import {createWebPushProvider,validateSubscription} from '../server/business/web-push-provider.mjs';
import {subscriptionFingerprint} from '../server/business/devices.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
import webpush from '../server/business/web-push.bundle.cjs';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
const db=new DatabaseSync(':memory:'),origin='https://employeeclient-push-audit.invalid';
const members=['local-push-sender','local-push-recipient'].map(actor_id=>({actor_id,project_id:PROJECT,can_read:true,can_write:true,display_name:actor_id}));
const sessionFactory=async cookie=>{const actor=cookie==='qa-recipient'?members[1]:cookie==='qa-sender'?members[0]:null;if(!actor)throw Object.assign(Error('login_required'),{status:401,code:'login_required'});return {context:actor,directory:async()=>members};};
const diagnostics=[];
const provider=createWebPushProvider(JSON.parse(await readFile('/run/credentials/hub2-project-employeeclient.service/employeeclient-push.json','utf8')),{proxy:'http://127.0.0.1:17890',send:async(...args)=>{
 try{return await webpush.sendNotification(...args);}catch(e){const body=String(e.body||'');diagnostics.push({status:e.statusCode,bodyLength:body.length,reason:['NotRegistered','UNREGISTERED','registration-token-not-registered','subscription has unsubscribed','subscription has expired','invalid token','InvalidRegistration','unsubscribed or expired'].find(v=>body.toLowerCase().includes(v.toLowerCase()))||'unclassified',googleServer:/^(ESF|GSE)$/i.test(e.headers?.server||'')});throw e;}
}});
const handler=createRuntimeHandler(db,{sessionFactory,pushProvider:provider,notificationDirectory:async()=>members});
const server=createGateway({publicOrigin:origin,businessHandler:handler});await new Promise(r=>server.listen(0,'127.0.0.1',r));
for await(const line of createInterface({input:process.stdin})){
 let request;try{request=JSON.parse(line);let result;
 if(request.path==='qa-reject-subscription'){
  const device=db.prepare('SELECT id FROM device_bindings WHERE actor_id=?').get('local-push-recipient');
  db.prepare('INSERT OR IGNORE INTO rejected_push_subscriptions VALUES(?,?,?)').run(device.id,subscriptionFingerprint(JSON.stringify(validateSubscription(request.body.subscription))),Date.now());
  result={fault_injection:'synthetic expiry marker in isolated memory SQLite',state:'recorded'};
 }
 else if(request.path==='qa-deliveries')result={deliveries:db.prepare('SELECT notification_id,state,error_code FROM push_deliveries').all(),diagnostics};
 else {const response=await fetch('http://127.0.0.1:'+server.address().port+request.path,{method:request.method||'GET',headers:{cookie:request.cookie||'qa-recipient',origin,'content-type':'application/json','idempotency-key':crypto.randomUUID()},...(request.body?{body:JSON.stringify(request.body)}:{})});result={status:response.status,body:await response.json()};}
 process.stdout.write(JSON.stringify({id:request.id,result})+'\n');
 }catch(e){process.stdout.write(JSON.stringify({id:request?.id,error:e.code||e.name})+'\n');}
}
handler.close();server.closeAllConnections();server.close();db.close();
