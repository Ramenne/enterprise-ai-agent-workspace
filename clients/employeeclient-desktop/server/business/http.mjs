import {assertBusinessWrite,assertActorNeutralBody} from './native-authority.mjs';
import {isGroupFile} from '../../shared/chat-media-purpose.mjs';
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
export function createBusinessHandler({repository,authorize,directory,resolveReference,resolveAttachments,onChange=()=>{},credential=req=>req.headers.cookie||'',now=()=>performance.now()}) {
 if(!repository||!authorize||!directory||!resolveReference||!resolveAttachments)throw Error('business_adapters_required');
 return async function handle(req,res){
  const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  try{
   const url=new URL(req.url,'http://localhost'),parts=url.pathname.replace(/^\/business\/v1\//,'').split('/');
   let context;let initialActor;
   const refreshAuthority=async()=>{const next=await authorize(credential(req));if(next.actor_id!==initialActor)fail('identity_changed',401);return next;};
   const query=Object.fromEntries(url.searchParams);
   let body={};
   if(req.method==='POST'){
    let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>(parts[0]==='inspirations'?24*1024*1024:1024*1024))fail('request_too_large',413);chunks.push(c);}
    try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_json');}
    if(!body||typeof body!=='object'||Array.isArray(body))fail('invalid_json');
    
   }
   // Verify after receiving the bounded body, immediately before local work.
   context=await authorize(credential(req));initialActor=context.actor_id;const authorizedAt=now();
   if(req.method==='POST'){if(parts[0]==='notifications')assertActorNeutralBody(body);else assertBusinessWrite(context,body);}
   const key=req.headers['idempotency-key'];
   const [domain,id,action]=parts;
   if(domain==='members'&&parts.length===1&&req.method==='GET'){
    const roster=context.member_roster||await directory(context,credential(req));if(!context.member_roster)context=await refreshAuthority();
    return reply(200,{members:roster.map(m=>repository.profiles?repository.profiles.member(m):{username:m.actor_id,nickname:m.display_name||m.actor_id,online:m.online,last_seen_at:m.last_seen_at??m.last_auth_sync_at??null})});
   }
   if(domain==='profile'&&id==='avatar'&&parts.length===2&&req.method==='POST'){
    context=await refreshAuthority();const result=repository.profiles.save(context,body);onChange({member_ids:[context.actor_id],member_kind:'member_avatar'});return reply(200,result);
   }
   if(domain==='members'&&id&&action==='avatar'&&parts.length===3&&req.method==='GET'){
    const roster=context.member_roster||await directory(context,credential(req));if(!context.member_roster)context=await refreshAuthority();if(!roster.some(m=>m.actor_id===id&&m.can_read===true))fail('member_not_found',404);
    return reply(200,repository.profiles.avatar(id));
   }
   if(domain==='inspirations'){
    if(parts.length===1&&req.method==='POST'){context=await refreshAuthority();return reply(201,repository.inspirations.submit(context,body,key));}
    if(parts.length===1&&req.method==='GET')return reply(200,repository.inspirations.list(context,query));
    if(id&&action==='media'&&parts.length===3&&req.method==='GET'){const item=repository.inspirations.media(context,id);res.writeHead(200,{'content-type':item.mime,'content-length':item.bytes.length,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':'inline'});res.end(Buffer.from(item.bytes));return;}
   }
   if(domain==='feedback'){
    if(parts.length===1&&req.method==='POST'){context=await refreshAuthority();return reply(201,repository.feedback.submit(context,body,key));}
    if(parts.length===1&&req.method==='GET')return reply(200,repository.feedback.list(context,query));
    if(id&&parts.length===2&&req.method==='GET')return reply(200,{feedback:repository.feedback.detail(context,id)});
   }
   if(domain==='conversations'&&parts.length===1){
    const members=context.member_roster||await directory(context,credential(req));
    if(!context.member_roster)context=await refreshAuthority();
    if(req.method==='GET')return reply(200,repository.conversations(context,members));
    if(req.method==='POST'){context=await refreshAuthority();const result=repository.conversationAction(context,body,key,context.member_roster||members);onChange({actors:[context.actor_id],conversation_list_changed:true});return reply(200,result);}
   }
   if(domain==='files'&&parts.length===1&&req.method==='GET')return reply(200,repository.files(context,query));
   if(domain==='messages'){
    if(parts.length===1&&req.method==='GET')return reply(200,repository.messages(context,query));
    if(parts.length===1&&req.method==='POST'){
     const [members,reference,attachments]=await Promise.all([context.member_roster||directory(context,credential(req)),resolveReference(context,body,credential(req)),resolveAttachments(context,body,credential(req))]);
     // Reuse this request's verified authority; recheck long remote resolution.
     if(now()-authorizedAt>5000||!context.member_roster)context=await refreshAuthority();
     const result=repository.send(context,body,key,{members:context.member_roster||members,reference,attachments});onChange({message_kind:'chat_message',group_files_changed:!result.message.conversation_peer&&result.message.attachments.some(isGroupFile),...(result.message.conversation_peer?{actors:[context.actor_id,result.message.conversation_peer],message_participants:[context.actor_id,result.message.conversation_peer]}:{})});return reply(201,result);
    }
    if(id==='changes'&&parts.length===2&&req.method==='GET')return reply(200,repository.changes(context,query.after_change,query.limit,query.peer));
    if(id&&parts.length===2&&req.method==='GET')return reply(200,{message:repository.get(context,id)});
    if(id&&parts.length===3&&req.method==='POST'){
     const result=repository.change(context,id,action,key);onChange({message_kind:'chat_message',group_files_changed:!result.message.conversation_peer,...(result.message.conversation_peer?{message_participants:[context.actor_id,result.message.conversation_peer]}:{}),...(action==='hide'?{actors:[context.actor_id]}:result.message.conversation_peer?{actors:[context.actor_id,result.message.conversation_peer]}:{})});return reply(200,result);
    }
   }
   if(domain==='announcements'){
    if(id&&parts.length===2&&req.method==='GET')return reply(200,{announcement:repository.announcement(context,id)});
    if(parts.length===1&&req.method==='GET')return reply(200,repository.announcements(context));
    if(parts.length===1&&req.method==='POST'){
     const members=await directory(context,credential(req));context=await refreshAuthority();
     const result=repository.publishAnnouncement(context,body,key,members);onChange();return reply(201,result);
    }
    if(id&&action==='replies'&&parts.length===3&&req.method==='GET')return reply(200,repository.announcementReplies(context,id,query.after));
    if(id&&action==='replies'&&parts.length===3&&req.method==='POST'){const result=repository.replyAnnouncement(context,id,body.body,key);onChange();return reply(201,result);}
   }
   if(domain==='notifications'){
    if(parts.length===1&&req.method==='GET')return reply(200,repository.notifications(context,query.cursor||query.after_version,query.limit));
    if(id&&parts.length===2&&req.method==='GET')return reply(200,repository.notification(context,id));
    if(id&&parts.length===3&&req.method==='POST'){
     const result=repository.notificationAction(context,id,action,body,key);onChange(repository.notificationWake(context,id,action));return reply(200,result);
    }
   }
   return reply(404,{error_code:'business_route_not_connected'});
  }catch(e){return reply(Number.isInteger(e.status)?e.status:503,{error_code:e.code||'business_dependency_unavailable',...(e.hint?{hint:e.hint}:{})});}
 };
}
