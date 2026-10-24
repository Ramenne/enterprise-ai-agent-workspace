<script setup lang="ts">
import ForwardProgress from './ForwardProgress.vue';
import {computed,ref,onBeforeUnmount} from 'vue';
import type {AssigneeOption,ChatMessage} from '@/api/types';
import type {PendingWrite} from '@/session/pendingWrites';
import {captureApiLease} from '@/api/client';
import {readTextForward,prepareTextForward,sendTextForward,discardTextForward,type TextForward} from '@/chat/forward';
import {useUiStore} from '@/store/ui';
import {userError} from '@/domain/userError.mjs';
import ModalSheet from './ModalSheet.vue';
import ForwardRecipientPicker from './ForwardRecipientPicker.vue';
const props=defineProps<{messages:ChatMessage[];members:AssigneeOption[];online:boolean}>();
const emit=defineEmits<{close:[];done:[count:number];pending:[]}>();
const lease=captureApiLease(),intent=ref<PendingWrite<TextForward>|null>(null),error=ref(''),readFailed=ref(false);
try{intent.value=readTextForward(lease.account);}catch{readFailed.value=true;error.value='无法读取上次转发，请检查本机存储后重试';}
const recovering=!!intent.value;
const peer=ref<string|null>(intent.value?.body.peer??null),busy=ref(false),confirmed=ref(0);

const rows=computed(()=>intent.value?.body.items||props.messages.map(message=>({sourceId:message.id,text:message.body})));
const targetName=computed(()=>peer.value===''?'公司工作群':peer.value===lease.account?'文件传输助手':props.members.find(member=>member.username===peer.value)?.nickname||'所选联系人');
let controller:AbortController|undefined;
function close(){controller?.abort();emit('pending');emit('close');}
async function discard(){
  if(busy.value||!intent.value)return;
  const key=intent.value.key;
  const ok=await useUiStore().confirm({title:'结束这次转发？',text:'已经发送的消息会保留。结果未确认的消息也可能已经送达；结束后再次转发会作为新操作。',label:'结束转发'});
  if(ok&&captureApiLease().account===lease.account&&intent.value?.key===key){try{discardTextForward(lease.account,key);emit('pending');emit('close');}catch(cause){error.value=userError(cause);}}
}
async function submit(){
  if(busy.value||!props.online||peer.value===null||readFailed.value)return;
  busy.value=true;error.value='';confirmed.value=0;controller=new AbortController();
  try{
    const actionLease=captureApiLease();if(actionLease.account!==lease.account||!actionLease.valid())throw Error('账号状态已变化，请重新打开转发');
    intent.value ||= prepareTextForward(lease.account,peer.value,props.messages);emit('pending');
    const count=await sendTextForward(intent.value,controller.signal,value=>confirmed.value=value);
    if(!controller.signal.aborted&&actionLease.valid()){emit('done',count);emit('pending');emit('close');}
  }catch(cause){if(!controller.signal.aborted)error.value=userError(cause,'转发未完成，请继续原操作');}
  finally{busy.value=false;}
}
onBeforeUnmount(()=>controller?.abort());
</script>
<template><ModalSheet modal-class="forward-dialog" title="转发给" :sub="`${rows.length}条消息 · 逐条转发`" @close="close">
  <p v-if="recovering&&!busy" class="forward-recovery">上次转发尚未全部确认，将继续发给{{targetName}}。已成功的消息不会重复发送。</p>
  <ForwardRecipientPicker v-else v-model="peer" :account="lease.account" :members="members"/>
  <div class="forward-preview" aria-label="待转发内容"><p v-for="row in rows" :key="row.sourceId">{{row.text}}</p></div>
  <ForwardProgress :busy="busy" :completed="confirmed" :total="rows.length"/><p v-if="error" role="alert">{{error}}</p>
  <template #footer><button class="btn" @click="close">{{busy?'暂停':'取消'}}</button><button v-if="intent&&!busy" class="btn" @click="discard">结束转发</button><button class="btn primary" :disabled="busy||!online||peer===null||readFailed" @click="submit">{{intent&&!busy?'继续转发':'发送'}}</button></template>
</ModalSheet></template>
<style scoped>
.forward-preview{display:grid;gap:8px;max-height:22vh;overflow:auto;margin-top:14px;padding:12px;background:var(--paper-soft);border-radius:6px}.forward-preview p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.5}.forward-recovery{font-size:14px;line-height:1.6;color:var(--muted)}
</style>
