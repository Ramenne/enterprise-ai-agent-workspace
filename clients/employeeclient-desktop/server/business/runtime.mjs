import {resolveRecordAttachments} from '../../shared/chat-record.mjs';
import {createIntegrationHandler} from './integration-http.mjs';
import {createSmallMediaHandler} from './small-media.mjs';
import {createMemberTasksHandler} from './member-tasks.mjs';
import {createPersonalTasksHandler} from './personal-tasks.mjs';
import {loadNotificationFoundation,createHubNoticeStore,startHubSubscription,createFoundationNotifications} from './hub-notifications.mjs';
import {DatabaseSync,backup} from 'node:sqlite';
import {readFile,realpath,mkdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createNotificationEvents} from './notification-events.mjs';
import {createDeviceRepository,createDeliveryDispatcher} from './devices.mjs';
import {createChatRepository} from './chat-repository.mjs';
import {createBusinessHandler} from './http.mjs';
import {nativeBusinessSession,nativeIntegrationSession,coalesceNativeSessions,PROJECT,assertBusinessWrite} from './native-authority.mjs';
import {loadRegisteredWebPush} from './web-push-provider.mjs';
import {importSharedCommunication,importOwnerProjection} from './legacy-import.mjs';
import {createASRHandler} from './asr-http.mjs';
import {createASRJobs} from './asr-jobs.mjs';
import {createVoiceASRJobs} from './voice-asr-jobs.mjs';
import {VOICE_LIMIT} from './voice-asr-provider.mjs';
import {createPrivateAttachments} from './private-attachments.mjs';
const DATABASE='/srv/workspace';
const PRIVATE='/srv/workspace';
const OWNER='acca6883-4cc2-4805-aefe-29d413ce0abd';
export const SHARED_SOURCE=Object.freeze({project_id:PROJECT,material_id:'12a1a0c8-1e72-4633-a9f9-ecf150739244',version_id:'7e755100-8acc-4e69-a427-f52f1921009f',sha256:'58bd4973e4be985e38bbf0ffba93d47c410da2bc226da575bae354e09adcb387',size:11874});
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function readFixed(session,fixed){
 if(!Number.isSafeInteger(fixed.size)||fixed.size<0||fixed.size>1024*1024)fail('migration_source_size_invalid');
 const chunks=[];let offset=0;
 do{const page=await session.rpc('mem.version.read',{project_id:fixed.project_id,material_id:fixed.material_id,version_id:fixed.version_id,offset,limit:131072,encoding:'base64'});
  if(['material_id','version_id','sha256','size'].some(k=>page.fixed_ref?.[k]!==fixed[k]))fail('migration_fixed_source_changed',409);
  const bytes=Buffer.from(page.bytes_base64||'','base64');
  if(page.range?.start!==offset||page.range?.end_exclusive!==offset+bytes.length||sha(bytes)!==page.chunk_sha256)fail('migration_chunk_invalid',502);
  chunks.push(bytes);offset+=bytes.length;
  if(offset>fixed.size||(!bytes.length&&offset<fixed.size))fail('migration_source_incomplete',502);
  if(offset<fixed.size&&page.next_offset!==offset)fail('migration_source_cursor_invalid',502);
 }while(offset<fixed.size);
 const bytes=Buffer.concat(chunks);if(sha(bytes)!==fixed.sha256)fail('migration_source_hash_mismatch',502);return bytes;
}
export function createRuntimeHandler(db,{sessionFactory=nativeBusinessSession,integrationSessionFactory=nativeIntegrationSession,readPrivate=()=>readFile(PRIVATE),eventsOptions={},pushProvider=null,asrJobs=null,voiceProviderLoader,notificationDirectory=null,foundation=null,foundationLoader=null}={}){
 sessionFactory=coalesceNativeSessions(sessionFactory,{ttlMs:60000});
 const memberTasks=createMemberTasksHandler(sessionFactory);
 const sessions=new WeakMap(),repository=createChatRepository(db),authorize=async cookie=>{const session=await sessionFactory(cookie);sessions.set(session.context,{cookie,session});return session.context;};
 const requestSession=(ctx,cookie)=>{const saved=sessions.get(ctx);return saved?.cookie===cookie?Promise.resolve(saved.session):sessionFactory(cookie);};
 const eventAuthority=authorize;
 const events=createNotificationEvents(eventAuthority,repository,eventsOptions);
 const privateAttachments=createPrivateAttachments(db);
 let managedFoundation=null;
 const directory=foundationLoader?()=>managedFoundation.directory():notificationDirectory;
 const devices=createDeviceRepository(db),drain=createDeliveryDispatcher(db,pushProvider,{directory,messageBadge:repository.messageBadge,onSubscriptionExpired:actor=>events.changed({actors:[actor],push_subscription_expired:true})});
 const changed=(hint)=>{events.changed(hint);drain.wake();};
 const hubSubscription=foundationLoader?(managedFoundation=createFoundationNotifications(foundationLoader,createHubNoticeStore(db),{changed})):foundation?startHubSubscription(foundation,createHubNoticeStore(db),{changed}):null;
 const deliveryWake=cookie=>{drain.wake(async()=>{const session=await sessionFactory(cookie);return session.directory();});};
 const reference=async(ctx,body,cookie,knownSession)=>{
  if(body.task_id!==undefined||body.plan_id!==undefined||body.code_id!==undefined)fail('retired_task_reference');
  if(!body.work_item_id&&!body.project_id)return null;
  if(body.project_id!==PROJECT)fail('reference_audience_mismatch',403);
  const session=knownSession?.context===ctx?knownSession:await requestSession(ctx,cookie);
  const [projectPage,workPage]=await Promise.all([session.rpc('v8.project.read',{project_id:PROJECT}),body.work_item_id?session.rpc('v8.work.read',{project_id:PROJECT,work_item_id:body.work_item_id}):Promise.resolve(null)]);
  const project=projectPage.project;
  if(project.id!==PROJECT||project.visibility!=='team')fail('reference_audience_mismatch',403);
  if(!body.work_item_id)return {project_id:PROJECT,project_title:project.title,work_item_id:null,work_title:null,visibility:'team'};
  const w=workPage.work_item;
  if(w.id!==body.work_item_id||w.project_id!==PROJECT)fail('work_reference_invalid',403);
  return {project_id:PROJECT,project_title:project.title,work_item_id:w.id,work_title:w.goal,short_no:w.short_no,visibility:'team'};
 };
 const attachments=async(ctx,body,cookie,knownSession)=>{
  if(!Array.isArray(body.attachment_ids)||body.attachment_ids.length>6)fail('attachment_reference_invalid');
  if(!body.attachment_ids.length)return [];
  const session=knownSession?.context===ctx?knownSession:await requestSession(ctx,cookie),result=[];
  for(const id of body.attachment_ids){
   if(String(id).startsWith('private:')){result.push(privateAttachments.resolve(ctx,id,body.recipient_username));continue;}
   if(body.recipient_username)fail('private_attachment_requires_encrypted_source',403);
   // Current attachment identity is a pair of immutable Mem UUIDs. Old opaque
   // attachment IDs without a registered fixed mapping remain unavailable.
   const parts=String(id).split(':');if(parts.length!==2||parts.some(x=>!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(x)))fail('attachment_fixed_reference_required');
   const [page,head]=await Promise.all([session.rpc('mem.version.read',{project_id:PROJECT,material_id:parts[0],version_id:parts[1],offset:0,limit:1,encoding:'base64'}),session.rpc('mem.material.head',{project_id:PROJECT,material_id:parts[0]})]);
   const fixed=page.fixed_ref;if(fixed?.material_id!==parts[0]||fixed?.version_id!==parts[1]||(fixed?.project_id&&fixed.project_id!==PROJECT))fail('attachment_reference_invalid',403);
   const meta=head.properties?.employeeclient||{};
   if(meta.internal_encrypted)fail('private_cipher_cannot_be_group_attachment',403);
   result.push({id,file_id:'m2_'+fixed.material_id,ver:Number(fixed.local_version_no)||1,name:meta.name||head.placements?.[0]?.logical_path?.split('/').pop()||'文件 '+(fixed.file_no||fixed.material_id),mime:meta.mime||'application/octet-stream',purpose:meta.purpose||'file',duration_ms:meta.duration_ms,size:fixed.size,sha256:fixed.sha256,fixed_ref:{...fixed,project_id:PROJECT},address:''});
  }return result;
 };
 const standard=createBusinessHandler({repository,authorize,directory:async(ctx,cookie)=>{if(!cookie)fail('directory_session_required',503);return ctx.member_roster||(await requestSession(ctx,cookie)).directory();},resolveReference:reference,resolveAttachments:(ctx,body,cookie)=>resolveRecordAttachments(body,value=>attachments(ctx,value,cookie)),onChange:changed});
 const reply=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
 const effectiveASR=asrJobs||createASRJobs(db,{
  verifySource:async(session,input)=>{const page=await session.rpc('mem.version.read',{project_id:PROJECT,material_id:input.material_id,version_id:input.version_id,offset:0,limit:1,encoding:'base64'});if(['material_id','version_id','sha256'].some(k=>page.fixed_ref?.[k]!==input[k]))fail('asr_fixed_source_changed',409);},
  readOutput:async(session,fixed)=>{const page=await session.rpc('mem.version.read',{project_id:PROJECT,material_id:fixed.material_id,version_id:fixed.version_id,offset:0,limit:1,encoding:'base64'});if(['material_id','version_id','sha256'].some(k=>page.fixed_ref?.[k]!==fixed[k]))fail('asr_fixed_result_changed',409);return (await readFixed(session,{...fixed,size:page.fixed_ref.size})).toString('utf8');}
 });
 const voiceASR=createVoiceASRJobs(db,{privateAttachments,legacyJobs:effectiveASR,providerLoader:voiceProviderLoader,
  verifyGroupSource:async(session,input)=>{
   const page=await session.rpc('mem.version.read',{project_id:PROJECT,material_id:input.material_id,version_id:input.version_id,offset:0,limit:1,encoding:'base64'});
   if(['material_id','version_id','sha256'].some(k=>page.fixed_ref?.[k]!==input[k]))fail('voice_asr_source_changed',409);
   if(!Number.isSafeInteger(page.fixed_ref.size)||page.fixed_ref.size<1||page.fixed_ref.size>VOICE_LIMIT)fail('voice_asr_audio_too_large',413);
   const head=await session.rpc('mem.material.head',{project_id:PROJECT,material_id:input.material_id}),meta=head.properties?.employeeclient||{};
   if(meta.internal_encrypted||(!String(meta.mime||'').startsWith('audio/')&&meta.purpose!=='voice'))fail('voice_asr_source_invalid',422);
   if(meta.duration_ms>180000)fail('voice_asr_audio_too_large',413);return {...meta,size:page.fixed_ref.size};
  },
  readGroupSource:async(session,input,signal)=>{
   const page=await session.rpc('mem.version.read',{project_id:PROJECT,material_id:input.material_id,version_id:input.version_id,offset:0,limit:1,encoding:'base64'});
   const head=await session.rpc('mem.material.head',{project_id:PROJECT,material_id:input.material_id});
   const fixed={...input,size:page.fixed_ref?.size};if(!Number.isSafeInteger(fixed.size)||fixed.size<1||fixed.size>VOICE_LIMIT)fail('voice_asr_audio_too_large',413);
   const response=await session.fileStream(fixed,signal);if(!response.ok||!response.body)fail('voice_asr_source_unavailable',502);
   const parts=[];let size=0;for await(const part of response.body){signal.throwIfAborted();size+=part.length;if(size>fixed.size||size>VOICE_LIMIT)fail('voice_asr_audio_too_large',413);parts.push(part);}
   if(size!==fixed.size)fail('voice_asr_source_changed',409);return {bytes:Buffer.concat(parts),mime:head.properties?.employeeclient?.mime};
  }
 });
 const asrHandler=createASRHandler(effectiveASR,sessionFactory),voiceHandler=createASRHandler(voiceASR,sessionFactory,{prefix:'voice-asr'});
 const personalTasks=createPersonalTasksHandler(sessionFactory);
 const smallMedia=createSmallMediaHandler({db,sessionFactory,repository,privateAttachments,reference,changed});
 const integration=createIntegrationHandler({db,sessionFactory:integrationSessionFactory,repository,privateAttachments,reference,attachments,changed});
 const handler=async(req,res)=>{
  try{const path=new URL(req.url,'http://localhost').pathname;
   if(await integration(req,res))return;
   if(await smallMedia(req,res))return;
   if(await personalTasks(req,res))return;
   if(await voiceHandler(req,res))return;
   if(asrHandler&&await asrHandler(req,res))return;
   if(path.startsWith('/business/v1/private-attachments')){
    const parts=path.split('/').slice(4),cookie=req.headers.cookie||'';
    const session=await sessionFactory(cookie),ctx=session.context,authorizedAt=performance.now();
    if(path==='/business/v1/private-attachments'&&req.method==='POST'||parts.length===2&&['bind','commit'].includes(parts[1])&&req.method==='POST'){
     if(!req.headers['idempotency-key'])fail('idempotency_required');let bytes=0,chunks=[];for await(const part of req){bytes+=part.length;if(bytes>(parts[1]==='commit'?1024*1024:8192))fail('request_too_large',413);chunks.push(part);}let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json');}if(!body||typeof body!=='object'||Array.isArray(body))fail('invalid_json');assertBusinessWrite(ctx,body);
     if(parts[1]==='commit'&&(!body.message||typeof body.message!=='object'||Array.isArray(body.message)))fail('invalid_json');
     if(parts[1]==='commit')assertBusinessWrite(ctx,body.message);
     const value=parts.length?await privateAttachments.bind(ctx,parts[0],body,session):privateAttachments.prepare(ctx,body,req.headers['idempotency-key'],ctx.member_roster||await session.directory());
     if(parts[1]==='commit'){
      const messageBody={...body.message,attachment_ids:[value.attachment.id]};
      if(!messageBody.recipient_username||messageBody.recipient_username!==value.attachment.private_peer)fail('private_attachment_audience_mismatch',403);
      const resolved=privateAttachments.resolve(ctx,value.attachment.id,messageBody.recipient_username);
      const ref=await reference(ctx,messageBody,cookie);
      const next=performance.now()-authorizedAt>5000||!ctx.member_roster?await sessionFactory(cookie):session;if(next.context.actor_id!==ctx.actor_id)fail('identity_changed',401);assertBusinessWrite(next.context,messageBody);
      const result=repository.send(next.context,messageBody,req.headers['idempotency-key'],{members:next.context.member_roster||await next.directory(),reference:ref,attachments:[resolved]});
      changed({message_kind:'chat_message',group_files_changed:false,actors:[ctx.actor_id,messageBody.recipient_username],message_participants:[ctx.actor_id,messageBody.recipient_username]});return reply(res,201,{...result,attachment:value.attachment});
     }
     if(parts.length){const next=await sessionFactory(cookie);if(next.context.actor_id!==ctx.actor_id||!next.context.can_write)fail('project_write_denied',403);}return reply(res,200,value);
    }
    if(parts.length===1&&req.method==='GET')return reply(res,200,privateAttachments.head(ctx,parts[0]));
    if(parts.length===2&&parts[1]==='file'&&req.method==='GET'){
     const ctl=new AbortController(),cancel=()=>ctl.abort();res.once('close',cancel);try{return await privateAttachments.stream(ctx,parts[0],session,res,ctl.signal);}finally{res.off('close',cancel);}
    }fail('private_attachment_route_not_found',404);
   }
   deliveryWake(req.headers.cookie||'');
   if(path==='/business/v1/devices'&&req.method==='GET'){const {context}=await sessionFactory(req.headers.cookie||'');return reply(res,200,devices.list(context));}
   if(path==='/business/v1/devices'&&req.method==='POST'){
    if(!req.headers['idempotency-key'])fail('idempotency_required');
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192)fail('request_too_large',413);chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json');}
    if(!body||typeof body!=='object'||Array.isArray(body))fail('invalid_json');
    const {context}=await sessionFactory(req.headers.cookie||'');const result=devices.bind(context,body);deliveryWake(req.headers.cookie||'');return reply(res,200,result);
   }
   if(/^\/business\/v1\/devices\/qn-[a-f0-9]{64}\/subscription$/.test(path)&&req.method==='POST'){
    if(!req.headers['idempotency-key'])fail('idempotency_required');
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192)fail('request_too_large',413);chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json');}
    if(!body||typeof body!=='object'||Array.isArray(body))fail('invalid_json');
    const {context}=await sessionFactory(req.headers.cookie||'');const result=devices.renew(context,path.split('/')[4],body);deliveryWake(req.headers.cookie||'');return reply(res,200,result);
   }
   if(path==='/business/v1/events'&&req.method==='GET')return await events.handle(req,res);
   if(await memberTasks(req,res))return;
   if(path==='/business/v1/bootstrap'&&req.method==='GET'){
    const {context}=await sessionFactory(req.headers.cookie||'');
    return reply(res,200,{state:'ready',actor_id:context.actor_id,project_id:PROJECT,can_read:context.can_read,can_write:context.can_write,can_publish_announcement:context.can_publish_announcement,is_manager:context.is_manager===true,capabilities:{fast_media:true,chat:true,announcements:true,notifications:true,events:true,devices:true,push:!!pushProvider},foundation_subscription:managedFoundation?.snapshot()??{state:foundation?'configured':'not_configured'},acceptance:'runtime_adapters_only;not_device_delivery'});
   }
   if(path==='/business/v1/push-config'&&req.method==='GET'){
    await sessionFactory(req.headers.cookie||'');if(!pushProvider)fail('registered_push_configuration_unavailable',503);return reply(res,200,pushProvider.publicConfig());
   }
   if(path==='/business/v1/migration'&&req.method==='POST'){
    if(!req.headers['idempotency-key'])fail('idempotency_required');
    let length=0;for await(const bytes of req){length+=bytes.length;if(length>1024)fail('request_too_large',413);}
    let session=await sessionFactory(req.headers.cookie||'');assertBusinessWrite(session.context,{});
    const sharedBytes=await readFixed(session,SHARED_SOURCE),packet=JSON.parse(sharedBytes.toString('utf8'));
    session=await sessionFactory(req.headers.cookie||'');assertBusinessWrite(session.context,{});
    const shared=importSharedCommunication(db,session.context,packet,SHARED_SOURCE);
    let owner={state:'not_applicable'};
    if(session.context.actor_id===OWNER){
     const bytes=await readPrivate(),privatePacket=JSON.parse(bytes.toString('utf8'));
     session=await sessionFactory(req.headers.cookie||'');if(session.context.actor_id!==OWNER)fail('legacy_projection_owner_mismatch',403);
     owner=importOwnerProjection(db,session.context,privatePacket,new Map(packet.member_mapping.map(m=>[m.legacy_username,m.actor_id])),bytes);
    }
    changed();return reply(res,200,{shared,owner});
   }
   await standard(req,res);if(req.method==='POST')deliveryWake(req.headers.cookie||'');return;
  }catch(e){if(res.headersSent){res.destroy();return;}
   const failedPath=new URL(req.url,'http://localhost').pathname;
   if(e.code==='native_session_unavailable')console.warn(JSON.stringify({event:'chat_member_transport_failed',path:failedPath,status:e.status||503,device_cookie_present:/(?:^|;\s*)qn_member_device=/.test(req.headers.cookie||'')}));
   if(['/business/v1/me/points','/business/v1/me/tasks'].includes(failedPath))console.warn(JSON.stringify({event:'personal_board_read_failed',path:failedPath,status:e.status||503,error_code:e.code||'business_dependency_unavailable',transport_code:e.cause?.code||null,error_name:e.name||'Error'}));
   return reply(res,e.status||503,{error_code:e.code||'business_dependency_unavailable'});}
 };
 handler.invalidateSession=cookie=>sessionFactory.invalidate(cookie);
 handler.pushStatus=()=>({...devices.health(),provider:pushProvider?'configured':'not_configured'});
 handler.notificationStatus=()=>managedFoundation?.snapshot()??{state:foundation?'configured':'not_configured'};
 handler.close=()=>{hubSubscription?.close();events.close();drain.close();};
 return handler;
}
export async function openRegisteredBusiness({path=process.env.QN_BUSINESS_DB,notificationDirectory=null}={}){
 // Startup uses only the manager-registered resource, never an empty fallback
 // database under a release directory. Back up consistent SQLite bytes before DDL.
 if(path!==DATABASE||await realpath(path)!==DATABASE)fail('registered_business_database_required',503);
 const db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=5000');
 try{const destination=join(DATABASE.slice(0,DATABASE.lastIndexOf('/')),'backups');await mkdir(destination,{recursive:true,mode:0o700});
  const saved=join(destination,'pre-runtime-'+Date.now()+'-'+randomUUID()+'.db');await backup(db,saved);await chmod(saved,0o600);
  const pushProvider=await loadRegisteredWebPush();
  return {db,handler:createRuntimeHandler(db,{pushProvider,notificationDirectory,foundationLoader:loadNotificationFoundation}),backupPath:saved};
 }catch(e){db.close();throw e;}
}
