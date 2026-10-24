// Runs in a temporary server process, never the production database or accounts.
import {createChatRepository} from '../server/business/chat-repository.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createGateway} from '../server/gateway.mjs';
import {createRuntimeHandler} from '../server/business/runtime.mjs';
import {loadRegisteredWebPush} from '../server/business/web-push-provider.mjs';
import {PROJECT} from '../server/business/native-authority.mjs';
export async function runServerPushAudit(subscription){
 const db=new DatabaseSync(':memory:'),origin='https://employeeclient-push-audit.invalid';
 const members=['local-push-sender','local-push-recipient'].map(actor_id=>({actor_id,project_id:PROJECT,can_read:true,can_write:true,display_name:actor_id}));
 const sessionFactory=async cookie=>{const actor=cookie==='qa-recipient'?members[1]:cookie==='qa-sender'?members[0]:null;if(!actor)throw Object.assign(Error('login_required'),{status:401,code:'login_required'});return {context:actor,directory:async()=>members};};
 const provider=await loadRegisteredWebPush({path:'/run/credentials/hub2-project-employeeclient.service/employeeclient-push.json',proxy:'http://127.0.0.1:17890'});
 const handler=createRuntimeHandler(db,{sessionFactory,pushProvider:provider,notificationDirectory:async()=>members});
 const server=createGateway({publicOrigin:origin,businessHandler:handler});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  const headers=cookie=>({cookie,origin,'content-type':'application/json','idempotency-key':crypto.randomUUID()});
  const binding=await fetch(base+'/business/v1/devices',{method:'POST',headers:headers('qa-recipient'),body:JSON.stringify({installation_id:'local-push-installation',platform:'ios_web_push',subscription})});const bound=await binding.json();
  if(binding.status!==200||!bound.push_bound)return {stage:'binding',http_status:binding.status,error:bound.error_code};
  const message=await fetch(base+'/business/v1/messages',{method:'POST',headers:headers('qa-sender'),body:JSON.stringify({body:'隔离后台推送链测试',mention_usernames:[],attachment_ids:[],project_id:null,work_item_id:null})});const sent=await message.json();
  if(message.status!==201)return {stage:'message',http_status:message.status,error:sent.error_code};
  let delivery;const end=Date.now()+20000;
  while(Date.now()<end){delivery=db.prepare('SELECT notification_id,state,error_code FROM push_deliveries').get();if(delivery?.state==='provider_accepted')break;await new Promise(r=>setTimeout(r,100));}
  const auditRepo=createChatRepository(db),snapshot=delivery?.notification_id?auditRepo.notification(members[1],delivery.notification_id):null;
  let retiredSnapshot=null;
  if(snapshot){auditRepo.notificationAction(members[1],delivery.notification_id,'read',{},'audit-state-read');retiredSnapshot=auditRepo.notification(members[1],delivery.notification_id);}
  return {stage:'delivery',bind_http:binding.status,push_bound:bound.push_bound,message_http:message.status,delivery_state:delivery?.state,provider_status:delivery?.error_code?Number(delivery.error_code):null,notification_id:delivery?.notification_id,notification_snapshot:snapshot,retired_snapshot:retiredSnapshot,device_id:bound.device.installation_id,outbox_state:db.prepare('SELECT state FROM delivery_outbox').get()?.state,database:'isolated in-memory SQLite; production database not used'};
 }finally{handler.close();server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
}

export async function runServerStatePushAudit(subscription,notification){
 const provider=await loadRegisteredWebPush({path:'/run/credentials/hub2-project-employeeclient.service/employeeclient-push.json',proxy:'http://127.0.0.1:17890'});return provider.deliver(subscription,notification);
}
