<script setup lang="ts">
import {ref,onBeforeUnmount,onMounted,watch} from 'vue';
import type {ChatAttachment} from '@/chat/files';
import {readChatRecord,type ChatRecord} from '@/chat/chatRecord';
import {userError} from '@/domain/userError.mjs';
import {useSessionStore} from '@/session/store';
import ModalSheet from './ModalSheet.vue';import ChatAttachmentView from './ChatAttachmentView.vue';import ForwardProgress from './ForwardProgress.vue';
const props=withDefaults(defineProps<{attachment:ChatAttachment;depth?:number}>(),{depth:0});
const card=ref<HTMLElement>();let observer:IntersectionObserver|undefined;
const session=useSessionStore(),expanded=ref(false),busy=ref(false),error=ref(''),record=ref<ChatRecord>();let controller:AbortController|undefined;
function open(){expanded.value=true;void load();}
async function load(){if(busy.value||record.value)return;if(props.depth>3){error.value='聊天记录层级过多';return;}busy.value=true;error.value='';const c=new AbortController();controller=c;try{const result=await readChatRecord(props.attachment,c.signal);if(!c.signal.aborted)record.value=result;}catch(e){if(!c.signal.aborted)error.value=userError(e,'聊天记录暂未读到，请重试');}finally{if(controller===c)busy.value=false;}}
function close(){controller?.abort();expanded.value=false;busy.value=false;}
watch([()=>session.user?.username,()=>props.attachment.id],()=>{close();record.value=undefined;error.value='';});onMounted(()=>{observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer?.disconnect();void load();}},{rootMargin:'80px'});if(card.value)observer.observe(card.value);});onBeforeUnmount(()=>{observer?.disconnect();close();});
const time=(value:number)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
</script>
<template><button ref="card" class="chat-record-card" data-message-action aria-label="查看聊天记录" @click.stop="open"><strong>{{record?.title||'聊天记录'}}</strong><span v-if="record">{{record.messages.slice(0,3).map(m=>m.author+'：'+(m.body||'[附件]')).join('\n')}}</span><span v-else>点击查看聊天内容</span><small>聊天记录</small></button><Teleport to="body"><ModalSheet modal-class="chat-record-dialog" v-if="expanded" :title="record?.title||'聊天记录'" @close="close"><ForwardProgress :busy="busy" label="正在读取聊天记录"/><div v-if="record" class="chat-record-messages"><article v-for="(m,i) in record.messages" :key="i"><header><strong>{{m.author}}</strong><time>{{time(m.created_at)}}</time></header><p v-if="m.body">{{m.body}}</p><ChatAttachmentView v-for="a in m.attachments" :key="a.id" :attachment="a" :record-depth="depth+1"/></article></div><p v-if="error" role="alert">{{error}}<button class="btn small" @click="open">重试</button></p></ModalSheet></Teleport></template>
<style scoped>
.chat-record-card{width:250px;max-width:100%;text-align:left;border:0;border-radius:4px;background:var(--paper);color:var(--ink);padding:12px;display:grid;gap:7px;cursor:pointer}.chat-record-card strong{font-size:15px;font-weight:400}.chat-record-card>span{color:#888;font-size:13px;line-height:1.5;white-space:pre-line;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.chat-record-card small{font-size:11px;color:#999;border-top:1px solid var(--line-soft);padding-top:6px}.chat-record-messages{max-height:65vh;overflow:auto}.chat-record-messages article{padding:14px 0;border-bottom:1px solid var(--line-soft)}.chat-record-messages header{display:flex;gap:12px;align-items:center;color:var(--muted);margin-bottom:8px}.chat-record-messages header strong{font-size:13px;font-weight:400}.chat-record-messages time{font-size:11px;margin-left:auto}.chat-record-messages p{font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;margin:6px 0}
</style>
