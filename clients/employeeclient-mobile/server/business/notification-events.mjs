import {EventEmitter} from 'node:events';

// A wake signal is never the inbox. Each subscriber reads its own durable
// notification change log, under freshly checked authority, before receiving data.
export function createNotificationEvents(authorize, repository, {heartbeatMs=30000}={}) {
 const bus=new EventEmitter();bus.setMaxListeners(0);
 const clients=new Set();
 return {
  changed(hint){bus.emit('change',hint);},
  close(){for(const close of clients)close();},
  async handle(req,res){
   let context=await authorize(req.headers.cookie||'');
   const requested=new URL(req.url,'http://localhost').searchParams.get('after_version');
   let cursor=requested===null?0:Number(requested);
   if(!Number.isSafeInteger(cursor)||cursor<0)throw Object.assign(Error('invalid_cursor'),{status:400,code:'invalid_cursor'});
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no'});
   let closed=false,busy=false,pending=false,timer,presence,messageHint=false,messageFiles=false,conversationListHint=false;const messagePeers=new Set(),announcementHints=new Set();
   const write=async(type,data)=>{
    if(closed||res.destroyed)return;
    if(!res.write('event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n'))await new Promise(resolve=>{
     const done=()=>{res.off('drain',done);res.off('close',done);resolve();};res.once('drain',done);res.once('close',done);
    });
   };
   const close=()=>{if(closed)return;closed=true;clearInterval(timer);bus.off('change',changed);clients.delete(close);if(presence&&repository.profiles.close(context.actor_id,presence.token))bus.emit('change',{member_ids:[context.actor_id],member_kind:'member_presence'});if(!res.writableEnded)res.end();};
   const refresh=async()=>{const next=await authorize(req.headers.cookie||'');if(next.actor_id!==context.actor_id)throw Object.assign(Error('identity_changed'),{status:401,code:'identity_changed'});context=next;};
   const diagnose=(error,operation)=>console.warn(JSON.stringify({event:'notification_stream_authority_failed',operation,status:error.status||503,error_code:error.code||'notification_authority_unavailable',transport_code:error.cause?.code||null,error_name:error.name||'Error'}));
   const sync=async(catchup)=>{
    if(closed)return;if(busy){pending=true;return;}busy=true;
    try{
     do{
      pending=false;
      for(;;){
       await refresh();if(closed)return;
       let page;
       try{page=repository.notifications(context,cursor,100);}catch(e){
        if(e.hint==='invalid_after_version'){cursor=0;await write('reset',{catchup:true});catchup=true;page=repository.notifications(context,0,100);}else throw e;
       }
       const next=page.has_more?Number(page.next_cursor):page.sync_version;
       if(!Number.isSafeInteger(next)||next<cursor||page.has_more&&next<=cursor)throw Error('notification_cursor_stalled');
       if(catchup||page.notifications.length||messageHint||conversationListHint){const chatRows=page.notifications.filter(n=>n.kind==='chat_message'),kinds=[...new Set([...page.notifications.map(n=>n.kind),...(messageHint?['chat_message']:[]),...(conversationListHint?['conversation_list']:[])])],conversation_peers=[...new Set([...messagePeers,...chatRows.map(n=>n.snapshot?.conversation_peer||'')])],group_files_changed=messageFiles||chatRows.some(n=>n.snapshot?.has_group_files!==false);messageHint=false;messageFiles=false;conversationListHint=false;messagePeers.clear();await write('change',{notifications:page.notifications,...(page.message_badge?{message_badge:page.message_badge}:{}),sync_version:next,catchup,kinds,...(conversation_peers.length?{conversation_peers,group_files_changed}:{})});}
       cursor=next;if(closed||!page.has_more)break;
      }
      if(announcementHints.size){
       const ids=[...announcementHints];announcementHints.clear();const visible=[];
       for(const id of ids){try{repository.announcement(context,id);visible.push(id);}catch(e){if(e.status!==403&&e.status!==404)throw e;}}
       if(visible.length)await write('change',{notifications:[],sync_version:cursor,catchup:false,kinds:['announcement_read'],announcement_ids:visible});
      }
     }while(pending&&!closed);
    }catch(e){diagnose(e,'sync');await write(e.status===401||e.status===403?'auth':'error',{status:e.status||503,error_code:e.code||'notification_sync_failed'});close();}
    finally{busy=false;}
   };
   const changed=(hint)=>{if(hint?.member_ids){void refresh().then(()=>write('change',{notifications:[],kinds:[hint.member_kind||'member_presence'],member_ids:hint.member_ids})).catch(e=>{void write('error',{status:e.status||503}).finally(close);});return;}if(hint?.actors&&!hint.actors.includes(context.actor_id))return;if(hint?.push_subscription_expired){void refresh().then(()=>write('change',{notifications:[],sync_version:cursor,catchup:false,kinds:['push_subscription_expired']})).catch(e=>{void write('error',{status:e.status||503}).finally(close);});return;}if(hint?.conversation_list_changed)conversationListHint=true;if(hint?.message_kind==='chat_message'){messageHint=true;messagePeers.add(hint.message_participants?.find(a=>a!==context.actor_id)||(hint.message_participants?.includes(context.actor_id)?context.actor_id:''));messageFiles||=hint.group_files_changed===true;}if(hint?.announcement_id&&hint.reader_actor!==context.actor_id&&hint.actors?.includes(context.actor_id))announcementHints.add(hint.announcement_id);void sync(false);};
   clients.add(close);bus.on('change',changed);res.once('close',close);
   if(repository.profiles){presence=repository.profiles.open(context.actor_id);if(presence.changed)bus.emit('change',{member_ids:[context.actor_id],member_kind:'member_presence'});}
   await write('ready',{actor_id:context.actor_id,catchup:true,...(repository.messageBadge?{message_badge:repository.messageBadge(context)}:{})});
   await sync(true);
   if(closed)return;
   // A heartbeat proves transport liveness; it never queries identity or data.
   // Data reads above still refresh authority before releasing any records.
   // Upstream trouble during an idle period must not tear down a healthy stream.
   timer=setInterval(()=>{if(closed)return;repository.profiles?.seen(context.actor_id);void write('ping',{}).catch(close);},heartbeatMs);timer.unref?.();
  }
 };
}
