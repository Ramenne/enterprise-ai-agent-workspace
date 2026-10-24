<script setup lang="ts">
import {fromEvent} from '@/vendor/file-selector';
import {useDesktop} from '@/ui/useDesktop';
import {stageChatTransfer,chatTransfers} from '@/files/chatTransfers';
import {MAX_CHAT_FILE_BYTES} from '@/chat/files';
import {useReadFeedback} from '@/ui/useReadFeedback';
import {isUnreadMessageNotice} from '@/domain/messageBadge.mjs';
import {ref,computed,onActivated,onDeactivated,watch,onBeforeUnmount} from 'vue';
import {useRoute,useRouter} from 'vue-router';import {useSessionStore} from '@/session/store';import {useDataStore} from '@/store/data';
import {communication} from '@/api/endpoints';import {metaGet,metaSet} from '@/session/db';import {onChatWake} from '@/platform/chatEvents';import {userError} from '@/domain/userError.mjs';
import ModalSheet from '@/ui/components/ModalSheet.vue';import {newIdempotencyKey} from '@/api/client';import MemberAvatar from '@/ui/components/MemberAvatar.vue';import AppIcon from '@/ui/components/AppIcon.vue';import {conversationTime,messageSnippet} from '@/chat/presentation';import type {ChatMessage} from '@/api/types';import {useChatStore} from '@/store/chat';
import {useComposerDraftStore,draftPreview} from '@/chat/drafts';
defineOptions({name:'ConversationsView'});
const props=defineProps<{embedded?:boolean}>();const route=useRoute();
const session=useSessionStore(),data=useDataStore(),chat=useChatStore(),router=useRouter();
type Row={peer:string;peer_name?:string;pinned?:boolean;preview_after?:number;message:ChatMessage|null;unread_count:number};
const drafts=useComposerDraftStore();
function draft(row:Row){return drafts.account===session.user?.username?drafts.entries[row.peer]:undefined;}
function rowTime(row:Row){return Math.max(row.message?.created_at||0,draft(row)?.updatedAt||0);}
const search=ref(''),dropPeer=ref<string|null>(null),dropError=ref('');const desktop=useDesktop();let dropTurn=0;
function fileDrag(e:DragEvent){return !!e.dataTransfer&&[...e.dataTransfer.types].includes('Files');}
function rowDrag(r:Row,e:DragEvent){if(!desktop.value||!fileDrag(e))return;e.preventDefault();e.stopPropagation();cancelHold();dropPeer.value=r.peer;if(e.dataTransfer)e.dataTransfer.dropEffect='copy';}
async function rowDrop(r:Row,e:DragEvent){
 if(!desktop.value||!fileDrag(e))return;e.preventDefault();e.stopPropagation();cancelHold();dropPeer.value=null;dropError.value='';
 const owner=session.user?.username||'',n=epoch,turn=++dropTurn,origin=route.fullPath,peer=r.peer;const valid=()=>turn===dropTurn&&n===epoch&&owner===session.user?.username&&session.businessReady&&session.businessWritable;
 try{if(!valid())throw Error('请先恢复本人连接后添加文件');if([...e.dataTransfer!.items].some(i=>i.webkitGetAsEntry?.()?.isDirectory))throw Error('暂不支持文件夹，请选择其中的文件');
 const files=(await fromEvent(e)).filter(f=>f instanceof File)as File[];if(!valid()||route.fullPath!==origin)return;if(!files.length)return;
 if(files.some(f=>!f.size||f.size>MAX_CHAT_FILE_BYTES))throw Error('请选择非空且不超过100GB的文件');if(files.length+chatTransfers(owner,peer).filter(j=>j.needsConfirmation).length>6)throw Error('一次最多保留6个待发文件，请先发送或移除');
 await router.replace({name:'chat',query:peer?{peer}:{}});if(!valid()||route.name!=='chat'||(route.query.peer||'')!==peer)return;
 for(const file of files){if(!valid())return;const job=stageChatTransfer(file,newIdempotencyKey('chat-file'),peer,{body:'',attachment_ids:[],mention_usernames:[],...(peer?{recipient_username:peer}:{})});await job.promise;}
 }catch(error){if(n===epoch&&owner===session.user?.username)dropError.value=userError(error,'文件未能加入待发列表，请重试');}
}
const {error,feedback}=useReadFeedback();
const rows=ref<Row[]>([]),busy=ref(false),draftLoadError=ref(''),draftLoading=ref(false);let active=true,epoch=0,flight:Promise<void>|null=null,dirty=false,draftFlight:Promise<void>|null=null;
const displayRows=computed(()=>{
 const byPeer=new Map(rows.value.map(r=>[r.peer,r]));
 if(!byPeer.has(''))byPeer.set('',{peer:'',message:null,unread_count:0,pinned:true});
 const self=session.user?.username;if(self&&!byPeer.has(self))byPeer.set(self,{peer:self,peer_name:'文件传输助手',message:null,unread_count:0,pinned:false});
 for(const m of chat.members){if(m.username===session.user?.username)continue;if(!byPeer.has(m.username))byPeer.set(m.username,{peer:m.username,peer_name:m.nickname,message:null,unread_count:0,pinned:false});}
 return [...byPeer.values()].sort((a,b)=>Number(b.pinned??!b.peer)-Number(a.pinned??!a.peer)||rowTime(b)-rowTime(a)||Number(!!a.peer)-Number(!!b.peer)||title(a).localeCompare(title(b),'zh-CN'));
});
const filteredRows=computed(()=>{const q=search.value.trim().toLocaleLowerCase();return q?displayRows.value.filter(row=>[title(row),row.peer,rowPreview(row),draft(row)?draftPreview(draft(row)!):''].some(value=>value.toLocaleLowerCase().includes(q))):displayRows.value;});
function title(row:Row){if(row.peer&&row.peer===session.user?.username)return '文件传输助手';return row.peer?(chat.members.find(m=>m.username===row.peer)?.nickname|| row.peer_name||(row.message?.author_username===row.peer?row.message.author_name:'成员')):'公司工作群';}
function preview(m:ChatMessage|null){if(!m)return '';if(m.recalled)return '消息已撤回';return messageSnippet(m);}
const groupFaces=computed(()=>chat.members.slice(0,9));
const groupColumns=computed(()=>groupFaces.value.length>4?3:2);
function rowPreview(row:Row){const value=preview(row.message);return value&&!row.peer&&!row.message?.recalled?(row.message?.author_name||'成员')+'：'+value:value;}
function unread(row:Row){if(!row.message&&(row.preview_after||0)>0)return 0;if(data.account!==session.user?.username)return 0;return data.notifications.filter(n=>n.kind==='chat_message'&&isUnreadMessageNotice(n,session.user?.username||'')&&(n.snapshot?.conversation_peer||'')===row.peer).length;}
async function refresh(){if(!active||!session.businessReady)return;if(flight){dirty=true;return flight;}const n=epoch,owner=session.user?.username||'';busy.value=true;feedback.begin(rows.value.length>0);
 const work=Promise.resolve().then(async()=>{try{const result=await communication.conversations();if(epoch!==n||owner!==session.user?.username)return;rows.value=result.conversations;feedback.succeeded();await metaSet(owner,'conversation_list',JSON.parse(JSON.stringify(rows.value))).catch(()=>{});}catch(e){if(epoch===n&&owner===session.user?.username)feedback.failed(e,'会话暂未更新，请重试');}finally{if(flight===work){flight=null;busy.value=false;if(dirty){dirty=false;void refresh();}}}});flight=work;return work;}
function loadDrafts():Promise<void>{
 const owner=session.user?.username||'',n=epoch;
 if(!active||!owner)return Promise.resolve();
 if(draftFlight)return draftFlight;
 draftLoading.value=true;
 const work=Promise.resolve().then(async()=>{
  try{await drafts.load(owner);if(n===epoch&&owner===session.user?.username)draftLoadError.value='';}
  catch{if(n===epoch&&owner===session.user?.username)draftLoadError.value='本机草稿暂未读到，请重试恢复会话草稿。';}
  finally{if(draftFlight===work){draftFlight=null;draftLoading.value=false;}}
 });
 draftFlight=work;return work;
}
const actions=ref<Row|null>(null),acting=ref(false),actionError=ref('');let actionGeneration=0;let hold:ReturnType<typeof setTimeout>|undefined,holdStart:{x:number;y:number}|undefined,suppressClick=false;
let pendingAction:{body:{peer:string;action:'pin'|'clear_preview';pinned?:boolean};key:string}|undefined;
watch(()=>session.user?.username,async owner=>{epoch++;dropTurn++;dropPeer.value=null;dropError.value='';feedback.succeeded();actionGeneration++;actionError.value='';search.value='';cancelHold();actions.value=null;pendingAction=undefined;acting.value=false;flight=null;draftFlight=null;draftLoadError.value='';draftLoading.value=false;rows.value=[];error.value='';busy.value=false;drafts.setAccount(owner||'');if(owner){void loadDrafts();const n=epoch;const saved=await metaGet<Row[]>(owner,'conversation_list').catch(()=>null);if(n!==epoch)return;if(saved)rows.value=saved;void refresh();}},{immediate:true});
watch(()=>session.businessReady,()=>void refresh());
const stop=onChatWake(e=>{if(e.account===session.user?.username&&(e.mode==='catchup'||e.kinds.includes('chat_message')||e.kinds.includes('conversation_list')))void refresh();});
function cancelHold(){clearTimeout(hold);hold=undefined;holdStart=undefined;}
function pressRow(r:Row,e:PointerEvent){if(e.button!==0)return;suppressClick=false;cancelHold();holdStart={x:e.clientX,y:e.clientY};hold=setTimeout(()=>{suppressClick=true;actions.value=r;cancelHold();},500);}
function moveRow(e:PointerEvent){if(holdStart&&Math.hypot(e.clientX-holdStart.x,e.clientY-holdStart.y)>10)cancelHold();}
function openRow(r:Row){cancelHold();if(suppressClick){suppressClick=false;return;}void (props.embedded?router.replace:router.push)({name:'chat',query:r.peer?{peer:r.peer}:{}});}
function closeActions(){if(!acting.value){actionGeneration++;actions.value=null;pendingAction=undefined;actionError.value='';}}
async function change(action:'pin'|'clear_preview'){
 const row=actions.value;if(!row||acting.value)return;const owner=session.user?.username,n=epoch,generation=actionGeneration;
 const valid=()=>n===epoch&&generation===actionGeneration&&owner===session.user?.username;
 const body={peer:row.peer,action,...(action==='pin'?{pinned:!(row.pinned??!row.peer)}:{})};
 if(!pendingAction)pendingAction={body,key:newIdempotencyKey('conversation')};
 if(JSON.stringify(pendingAction.body)!==JSON.stringify(body)){actionError.value='请先确认上次会话操作';return;}
 acting.value=true;actionError.value='';
 try{await communication.conversationAction(pendingAction.body,pendingAction.key);if(!valid())return;
  if(action==='pin')rows.value=displayRows.value.map(r=>r.peer===row.peer?{...r,pinned:body.pinned}:r);
  else rows.value=displayRows.value.map(r=>r.peer===row.peer?{...r,message:null,unread_count:0}:r);
  await metaSet(owner||'','conversation_list',JSON.parse(JSON.stringify(rows.value)),valid).catch(()=>{});if(!valid())return;pendingAction=undefined;actions.value=null;actionError.value='';await refresh();
  if(valid()&&action==='clear_preview')void data.syncNotifications(owner||'');
 }catch(e){if(valid())actionError.value=userError(e,'会话操作尚未确认，请重试确认');}finally{if(valid())acting.value=false;}
}
onActivated(()=>{active=true;void loadDrafts();void refresh();});onDeactivated(()=>{active=false;cancelHold();actionGeneration++;actions.value=null;pendingAction=undefined;actionError.value='';acting.value=false;});onBeforeUnmount(()=>{epoch++;cancelHold();stop();});
</script>
<template><section class="conversations" :class="{embedded}" aria-label="会话列表"><div class="conversation-search"><AppIcon name="search"/><input v-model="search" type="search" aria-label="搜索会话" placeholder="搜索会话、成员或消息摘要" maxlength="200"><button v-if="search" aria-label="清除会话搜索" @click="search=''">×</button></div><p v-if="search.trim()&&!filteredRows.length&&!draftLoadError&&!draftLoading" class="field-help">没有匹配的会话。可按成员名称或当前消息摘要查找。</p><p v-if="draftLoadError" class="field-help" role="alert">{{draftLoadError}}<button class="btn small" :disabled="draftLoading" @click="loadDrafts">重试读取草稿</button></p><p v-if="dropError" class="field-help" role="alert">{{dropError}}</p><p v-if="error" class="field-help" role="alert">{{error}}<button class="btn small" :disabled="busy" @click="refresh">重试</button></p><button v-for="r in filteredRows" :key="r.peer" class="conversation-row" @dragenter="rowDrag(r,$event)" @dragover="rowDrag(r,$event)" @dragleave="dropPeer===r.peer&&(dropPeer=null)" @drop="rowDrop(r,$event)" :class="{'file-drop-target':dropPeer===r.peer,selected:props.embedded&&route.name==='chat'&&(route.query.peer||'')===r.peer,pinned:r.pinned??!r.peer,'has-preview':!!r.message||!!draft(r)}" @click="openRow(r)" @contextmenu.prevent="cancelHold();actions=r" @pointerdown="pressRow(r,$event)" @pointermove="moveRow" @pointerup="cancelHold" @pointercancel="cancelHold" @pointerleave="cancelHold"><span class="conversation-avatar"><span v-if="r.peer===session.user?.username" class="assistant-avatar"><AppIcon name="folder"/></span><MemberAvatar v-else-if="r.peer" :actor="r.peer" :name="title(r)" size="var(--conversation-avatar-size)"/><span v-else-if="groupFaces.length" class="group-faces" :style="{gridTemplateColumns:'repeat('+groupColumns+',1fr)'}" aria-hidden="true"><MemberAvatar v-for="m in groupFaces" :key="m.username" :actor="m.username" :name="m.nickname" :size="'calc((var(--conversation-avatar-size) - 6px) / '+groupColumns+')'"/></span><AppIcon v-else name="users"/><i v-if="unread(r)" class="count-badge">{{unread(r)>99?'99+':unread(r)}}</i></span><span class="conversation-copy"><strong>{{title(r)}}</strong><small v-if="draft(r)"><span class="draft-label">[草稿]</span> {{draftPreview(draft(r)!)}}</small><small v-else-if="r.message">{{rowPreview(r)}}</small></span><time v-if="rowTime(r)">{{conversationTime(rowTime(r))}}</time></button><p v-if="busy&&!rows.length" class="field-help">正在读取会话…</p></section><Teleport to="body"><ModalSheet v-if="actions" :title="title(actions)" @close="closeActions"><div class="conversation-actions"><button :disabled="acting||!!pendingAction&&pendingAction.body.action!=='pin'" @click="change('pin')">{{pendingAction?.body.action==='pin'?'重试确认'+(pendingAction.body.pinned?'置顶':'取消置顶'):(actions.pinned??!actions.peer)?'取消置顶':'置顶'}}</button><button :disabled="acting||!!pendingAction&&pendingAction.body.action!=='clear_preview'" @click="change('clear_preview')">{{pendingAction?.body.action==='clear_preview'?'重试确认隐藏预览':'删除会话预览'}}</button></div><p class="field-help">聊天记录保留，新消息会正常显示。</p><p v-if="actionError" role="alert">{{actionError}}</p></ModalSheet></Teleport></template>
<style scoped>
.conversation-search{display:flex;align-items:center;gap:8px;margin:8px 12px;padding:0 10px;background:var(--paper);border-radius:8px;min-height:40px;color:var(--muted)}.conversation-search input{min-width:0;flex:1;border:0;background:transparent;padding:8px 0;font-size:14px;color:var(--ink)}.conversation-search button{border:0;background:transparent;color:var(--muted);min-width:36px;min-height:36px;font-size:20px}.conversation-search .icon{width:18px;height:18px;flex:none}

/* Measured from the user's 1280px-wide phone reference: 230px rows,
   154px avatars, 52px left inset and 36px between avatar and text. */
.conversations{margin:0;padding:0;background:#ededed;container-type:inline-size;--conversation-unit:min(1vw,4.3px);--conversation-height:calc(17.96875 * var(--conversation-unit));--conversation-avatar-size:calc(12.03125 * var(--conversation-unit));--conversation-inset:calc(4.0625 * var(--conversation-unit));--conversation-gap:calc(2.8125 * var(--conversation-unit));--conversation-title-line:calc(6.154 * var(--conversation-unit));--conversation-preview-line:calc(5.128 * var(--conversation-unit))}
@supports(width:1cqw){.conversations{--conversation-unit:min(1cqw,4.3px)}}
.conversation-row{position:relative;width:100%;display:grid;grid-template-columns:var(--conversation-avatar-size) minmax(0,1fr) auto;grid-template-rows:var(--conversation-title-line) var(--conversation-preview-line);column-gap:var(--conversation-gap);align-content:center;align-items:center;height:var(--conversation-height);min-height:64px;padding:0 var(--conversation-inset);border:0;background:transparent;text-align:left;color:#191919;touch-action:pan-y;user-select:none;-webkit-user-select:none}
.conversation-row.file-drop-target{background:#d8ebdf;box-shadow:inset 0 0 0 1px #07a956}.conversation-row::after{content:'';position:absolute;bottom:0;left:calc(var(--conversation-inset) + var(--conversation-avatar-size) + var(--conversation-gap));right:0;height:1px;background:#dedede}
.conversation-row.pinned{background:#e7e7e8}.conversation-row:active{background:#d9d9d9}.conversation-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.conversation-avatar{grid-area:1/1/3/2;position:relative;width:var(--conversation-avatar-size);height:var(--conversation-avatar-size);display:grid;place-items:center;background:#dedfe0;border-radius:4px}
.assistant-avatar{width:100%;height:100%;display:grid;place-items:center;background:#20ad69;color:white;border-radius:4px}.assistant-avatar .icon{width:60%;height:60%}
.conversation-avatar :deep(.member-avatar){border-radius:4px}.conversation-avatar :deep(.member-avatar>span){font-size:calc(5.64 * var(--conversation-unit))}
.group-faces{display:grid;gap:1px;justify-items:center;align-content:center;padding:2px;width:var(--conversation-avatar-size);height:var(--conversation-avatar-size);box-sizing:border-box;overflow:hidden;border-radius:4px}
.group-faces :deep(.member-avatar){border-radius:1px}.group-faces :deep(.member-avatar>span){font-size:calc(2.052 * var(--conversation-unit))}
.conversation-avatar>.count-badge{position:absolute;right:-4px;top:-4px;min-width:16px;height:16px;line-height:16px;padding:0 4px;border-radius:9px;background:#fa5151;font-size:10px;font-weight:500}
.conversation-copy{display:contents}.conversation-copy strong{grid-area:1/2/2/3;min-width:0;font-size:clamp(16px,calc(4.359 * var(--conversation-unit)),20px);font-weight:400;line-height:var(--conversation-title-line);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conversation-copy small{grid-area:2/2/3/4;min-width:0;display:block;font-size:clamp(13px,calc(3.59 * var(--conversation-unit)),17px);line-height:var(--conversation-preview-line);color:#999;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0}
.draft-label{color:#ba3b35}
.conversation-row:not(.has-preview) .conversation-copy strong{grid-row:1/3;align-self:center}
.conversation-row time{grid-area:1/3/2/4;min-width:0;align-self:center;font-size:clamp(11px,calc(3.077 * var(--conversation-unit)),14px);line-height:var(--conversation-title-line);color:#999;max-width:calc(29 * var(--conversation-unit));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.conversation-actions{display:grid;gap:4px}.conversation-actions button{border:0;background:var(--paper);color:var(--ink);font-size:15px;min-height:42px;text-align:left;padding:8px 0}.conversation-actions button:active{background:var(--green-soft)}
@media(min-width:769px){.conversations{margin:0}}
</style>

<style scoped>
.conversations.embedded{--conversation-unit:3.3px;--conversation-avatar-size:40px;--conversation-inset:12px;--conversation-gap:10px;--conversation-title-line:22px;--conversation-preview-line:20px;--conversation-height:72px;min-height:100%}
.embedded .conversation-row.selected{background:#d9d9da}.embedded .conversation-copy strong{font-size:15px}.embedded .conversation-copy small{font-size:12px}.embedded .conversation-row time{font-size:10px}
.embedded .conversation-search{margin:14px 10px;min-height:34px}.embedded .conversation-search input{font-size:12px}
</style>
