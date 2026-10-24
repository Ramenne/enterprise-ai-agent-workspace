<script setup lang="ts">
import ForwardProgress from './ForwardProgress.vue';
import {computed,ref} from 'vue';
import type {AssigneeOption,ChatMessage} from '@/api/types';
import type {PendingWrite} from '@/session/pendingWrites';
import {captureApiLease} from '@/api/client';
import {prepareBatchForward,readBatchForward,startBatchForward,getBatchForward,discardBatchForward,type BatchForward,type BatchForwardJob,type BatchItem} from '@/chat/batchForward';
import {useUiStore} from '@/store/ui';
import {userError} from '@/domain/userError.mjs';
import ModalSheet from './ModalSheet.vue';
import ForwardRecipientPicker from './ForwardRecipientPicker.vue';
import {messageSnippet} from '@/chat/presentation';
const props=defineProps<{messages:ChatMessage[];members:AssigneeOption[];online:boolean}>();
const emit=defineEmits<{close:[];done:[count:number];pending:[]}>();
const account=captureApiLease().account,intent=ref<PendingWrite<BatchForward>|null>(null),error=ref(''),readFailed=ref(false);
try{intent.value=readBatchForward(account);}catch{readFailed.value=true;error.value='无法读取上次逐条转发，请检查本机存储后重试';}
const recovering=!!intent.value;
const peer=ref<string|null>(intent.value?.body.peer??null),job=ref<BatchForwardJob|undefined>(intent.value?getBatchForward(account,intent.value.key):undefined);
const busy=computed(()=>job.value?.state==='running'),confirmed=computed(()=>job.value?.confirmed??intent.value?.body.confirmed??0);
const rows=computed(()=>intent.value?.body.items||[...props.messages].sort((a,b)=>a.seq-b.seq).map(m=>({sourceId:m.id,text:m.body,...(m.attachments.length?{attachment:m.attachments[0],...(m.attachments.length>1?{attachments:m.attachments}:{})}:{})})));
const targetName=computed(()=>peer.value===''?'公司工作群':peer.value===account?'文件传输助手':props.members.find(m=>m.username===peer.value)?.nickname||'所选联系人');
function rowPreview(row:BatchItem){return messageSnippet({body:row.text})||(row.attachment?row.attachment.mime.startsWith('image/')?'[图片]':row.attachment.mime.startsWith('video/')?'[视频]':'[文件]':'');}
function close(){if(busy.value)job.value?.cancel();emit('pending');emit('close');}
async function discard(){if(busy.value||!intent.value)return;const key=intent.value.key;const ok=await useUiStore().confirm({title:'结束这次逐条转发？',text:'已经发送的消息会保留。未确认的消息也可能已送达；再次转发会作为新操作。',label:'结束转发'});if(ok&&captureApiLease().account===account){try{discardBatchForward(account,key);emit('pending');emit('close');}catch(e){error.value=userError(e);}}}
async function submit(){
 if(busy.value||!props.online||peer.value===null||readFailed.value)return;error.value='';
 try{
  const lease=captureApiLease();if(lease.account!==account||!lease.valid())throw Error('账号状态已变化，请重新打开转发');
  intent.value ||=prepareBatchForward(account,peer.value,props.messages);emit('pending');job.value=startBatchForward(intent.value);
  const result=await job.value.promise;
  if(result!==false){if(captureApiLease().account===account){emit('done',result);emit('pending');emit('close');}}
  else{intent.value=readBatchForward(account);if(job.value.state==='error')error.value=job.value.error||'转发未完成，请重试';}
 }catch(e){error.value=userError(e,'逐条转发未完成，请继续原操作');}
}
</script>
<template><ModalSheet modal-class="forward-dialog" title="转发给" :sub="`${rows.length}条消息 · 逐条转发`" @close="close">
 <p v-if="recovering&&!busy" class="forward-recovery">继续发给{{targetName}}，已确认的消息会跳过，未确认的消息继续原操作。</p><ForwardRecipientPicker v-else v-model="peer" :account="account" :members="members"/>
 <div class="batch-forward-preview" aria-label="待转发内容"><div v-for="(row,index) in rows" :key="row.sourceId" :class="{confirmed:index<confirmed}"><span>{{index<confirmed?'已确认':index+1}}</span><p>{{rowPreview(row)}}</p><small v-if="row.attachment">{{(row.attachments||[row.attachment]).map(a=>a.name).join('、')}}</small></div></div>
 <p v-if="peer===''&&rows.some(r=>r.attachment?.id.startsWith('private:'))" class="field-help">转发后，工作群所有成员可以查看这些文件。</p>
 <ForwardProgress :busy="busy" :completed="confirmed" :total="rows.length"/>
 <p v-if="error||job?.state==='error'" role="alert">{{error||job?.error}}</p>
 <template #footer><button class="btn" @click="close">{{busy?'暂停':'取消'}}</button><button v-if="intent&&!busy" class="btn" @click="discard">结束转发</button><button class="btn primary" :disabled="busy||!online||peer===null||readFailed" @click="submit">{{intent&&!busy?'继续转发':'发送'}}</button></template>
</ModalSheet></template>
<style scoped>
.batch-forward-preview{display:grid;gap:10px;max-height:26vh;overflow:auto;margin-top:14px;padding:12px;background:var(--paper-soft);border-radius:6px}.batch-forward-preview>div{display:grid;grid-template-columns:42px minmax(0,1fr);gap:3px 8px;align-items:baseline}.batch-forward-preview p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.5}.batch-forward-preview small{grid-column:2;color:var(--muted);overflow-wrap:anywhere}.batch-forward-preview>div>span{color:var(--muted);font-size:11px}.batch-forward-preview .confirmed{opacity:.6}.forward-recovery{font-size:13px;line-height:1.6;color:var(--muted)}.batch-forward-status{display:flex;gap:10px;align-items:center;margin-top:12px;font-size:14px}
</style>
