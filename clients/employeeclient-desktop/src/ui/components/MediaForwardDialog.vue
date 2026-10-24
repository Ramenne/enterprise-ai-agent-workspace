<script setup lang="ts">
import ForwardProgress from './ForwardProgress.vue';
import {computed,ref} from 'vue';
import type {AssigneeOption,ChatMessage} from '@/api/types';
import type {PendingWrite} from '@/session/pendingWrites';
import {captureApiLease} from '@/api/client';
import {readMediaForward,prepareMediaForward,startMediaForward,getMediaForward,discardMediaForward,type MediaForward,type MediaForwardJob} from '@/chat/mediaForward';
import {useUiStore} from '@/store/ui';
import {userError} from '@/domain/userError.mjs';
import ModalSheet from './ModalSheet.vue';
import ForwardRecipientPicker from './ForwardRecipientPicker.vue';
const props=defineProps<{message:ChatMessage|null;members:AssigneeOption[];online:boolean}>();
const emit=defineEmits<{close:[];done:[];pending:[]}>();
const account=captureApiLease().account,intent=ref<PendingWrite<MediaForward>|null>(null),error=ref(''),readFailed=ref(false);
try{intent.value=readMediaForward(account);}catch{readFailed.value=true;error.value='无法读取上次文件转发，请检查本机存储后重试';}
const recovering=!!intent.value;
const peer=ref<string|null>(intent.value?.body.peer??null),job=ref<MediaForwardJob|undefined>(intent.value?getMediaForward(account,intent.value.key):undefined);
const busy=computed(()=>job.value?.state==='running'),attachment=computed(()=>intent.value?.body.attachment||props.message?.attachments[0]),files=computed(()=>intent.value?.body.attachments||props.message?.attachments||[attachment.value!]),caption=computed(()=>intent.value?.body.caption??props.message?.body??'');
const targetName=computed(()=>peer.value===''?'公司工作群':peer.value===account?'文件传输助手':props.members.find(m=>m.username===peer.value)?.nickname||'所选联系人');
const fileSize=(n:number)=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.ceil(n/1024)+' KB';
function close(){if(busy.value)job.value?.cancel();emit('pending');emit('close');}
async function discard(){if(busy.value||!intent.value)return;const key=intent.value.key;const ok=await useUiStore().confirm({title:'结束这次文件转发？',text:'文件可能已经送达。结束后再次转发会作为新操作，不会撤回已发送的消息。',label:'结束转发'});if(ok&&captureApiLease().account===account){try{discardMediaForward(account,key);emit('pending');emit('close');}catch(e){error.value=userError(e);}}}
async function submit(){
 if(busy.value||!props.online||peer.value===null||readFailed.value)return;
 error.value='';
 try{
  const lease=captureApiLease();if(lease.account!==account||!lease.valid())throw Error('账号状态已变化，请重新打开转发');
  if(!intent.value){if(!props.message)throw Error('原消息暂不可见');intent.value=prepareMediaForward(account,peer.value,props.message);}
  emit('pending');job.value=startMediaForward(intent.value);
  if(await job.value.promise){if(captureApiLease().account===account){emit('done');emit('pending');emit('close');}}
  else {intent.value=readMediaForward(account);if(job.value.state==='error')error.value=job.value.error||'转发未完成，请重试';}
 }catch(e){error.value=userError(e,'文件转发未完成，请继续原操作');}
}
// A route teardown leaves the file job running. Only explicit pause/account
// change stops it, so navigating away cannot silently discard progress.
</script>
<template><ModalSheet modal-class="forward-dialog" title="转发给" sub="确认接收方和内容" @close="close">
 <p v-if="recovering&&!busy" class="forward-recovery">继续发给{{targetName}}，保持原文件和原操作。</p><ForwardRecipientPicker v-else v-model="peer" :account="account" :members="members"/>
 <div class="media-forward-preview" aria-label="待转发文件"><div v-for="file in files" :key="file.id"><strong>{{file.name}}</strong><small>{{fileSize(file.size)}}</small></div><p v-if="caption">{{caption}}</p></div>
 <p v-if="peer===''&&attachment?.id.startsWith('private:')" class="field-help">转发后，工作群所有成员可以查看这份文件。</p>
 <ForwardProgress :busy="busy"/>
 <p v-if="error||job?.state==='error'" role="alert">{{error||job?.error}}</p>
 <template #footer><button class="btn" @click="close">{{busy?'暂停':'取消'}}</button><button v-if="intent&&!busy" class="btn" @click="discard">结束转发</button><button class="btn primary" :disabled="busy||!online||peer===null||readFailed" @click="submit">{{intent&&!busy?'继续转发':'发送'}}</button></template>
</ModalSheet></template>
<style scoped>
.media-forward-preview{display:grid;gap:6px;margin-top:14px;padding:12px;background:var(--paper-soft);border-radius:6px;overflow-wrap:anywhere}.media-forward-preview strong{font-size:15px;font-weight:500}.media-forward-preview small,.forward-recovery{color:var(--muted);font-size:13px;line-height:1.6}.media-forward-preview p{font-size:14px;white-space:pre-wrap;max-height:18vh;overflow:auto}.media-forward-status{display:flex;gap:10px;align-items:center;margin-top:12px;font-size:14px}
</style>
