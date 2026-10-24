<script setup lang="ts">
import {computed,ref,onBeforeUnmount} from 'vue';
import {captureApiLease} from '@/api/client';
import type {ChatMessage,AssigneeOption} from '@/api/types';
import type {PendingWrite} from '@/session/pendingWrites';
import {readBatchDelete,prepareBatchDelete,startBatchDelete,getBatchDelete,discardBatchDelete,type BatchDelete,type BatchDeleteJob} from '@/chat/batchDelete';
import {userError} from '@/domain/userError.mjs';import {useUiStore} from '@/store/ui';import ModalSheet from './ModalSheet.vue';
const props=defineProps<{messages:ChatMessage[];peer:string;online:boolean;members:AssigneeOption[]}>();
const emit=defineEmits<{close:[];pending:[];done:[number]}>(),account=captureApiLease().account;
const intent=ref<PendingWrite<BatchDelete>|null>(null),job=ref<BatchDeleteJob>(),error=ref(''),readFailed=ref(false);
try{intent.value=readBatchDelete(account);if(intent.value)job.value=getBatchDelete(account,intent.value.key);}catch(e){readFailed.value=true;error.value=userError(e);}
const busy=computed(()=>job.value?.state==='running'),peer=computed(()=>intent.value?.body.peer??props.peer),total=computed(()=>intent.value?.body.ids.length??props.messages.length),confirmed=computed(()=>job.value?.confirmed??intent.value?.body.confirmed??0);
const target=computed(()=>!peer.value?'公司工作群':peer.value===account?'文件传输助手':props.members.find(m=>m.username===peer.value)?.nickname||'原私聊会话');
function close(){if(busy.value)job.value?.cancel();emit('pending');emit('close');}
onBeforeUnmount(()=>{if(busy.value)job.value?.cancel();});
async function submit(){
 if(busy.value||!props.online||readFailed.value)return;
 try{const lease=captureApiLease();if(lease.account!==account||!lease.valid())throw Error('账号状态已变化，请重新打开');intent.value ||=prepareBatchDelete(account,peer.value,props.messages);emit('pending');job.value=startBatchDelete(intent.value);const result=await job.value.promise;if(captureApiLease().account!==account)return;if(result!==false){emit('done',result);emit('pending');emit('close');}else{intent.value=readBatchDelete(account);error.value=job.value.error||'';}}catch(e){error.value=userError(e);}
}
async function discard(){if(!intent.value||busy.value)return;const key=intent.value.key,ok=await useUiStore().confirm({title:'结束剩余删除？',text:'已删除的消息不会恢复，未确认的操作也可能已生效。其余消息将保留。',label:'结束操作'});if(ok&&captureApiLease().account===account){try{discardBatchDelete(account,key);emit('pending');emit('close');}catch(e){error.value=userError(e);}}}
</script>
<template><ModalSheet title="删除所选消息" :sub="target" @close="close"><p class="batch-delete-description">从你的聊天记录中隐藏 {{total}} 条消息，其他成员的记录保留。</p><p v-if="intent" role="status">已确认 {{confirmed}} / {{total}} 条{{busy?' · 正在删除…':''}}</p><p v-if="error" role="alert">{{error}}</p><template #footer><button class="btn" @click="close">{{busy?'暂停并返回':'取消'}}</button><button v-if="intent&&!busy" class="btn" @click="discard">结束操作</button><button class="btn primary" :disabled="busy||!online||readFailed||!total" @click="submit">{{busy?'正在删除…':intent?'继续删除':'确认删除'}}</button></template></ModalSheet></template>
<style scoped>.batch-delete-description{font-size:14px;line-height:1.6;margin:8px 0 16px}</style>
