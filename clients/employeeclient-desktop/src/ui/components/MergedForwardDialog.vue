<script setup lang="ts">
import {computed,ref} from 'vue';
import type {AssigneeOption,ChatMessage} from '@/api/types';
import {captureApiLease} from '@/api/client';
import {readMergedForward,prepareMergedForward,startMergedForward,getMergedJob,discardMergedForward,type MergedJob} from '@/chat/mergedForward';
import {userError} from '@/domain/userError.mjs';
import {useUiStore} from '@/store/ui';
import ModalSheet from './ModalSheet.vue';import ForwardRecipientPicker from './ForwardRecipientPicker.vue';import ForwardProgress from './ForwardProgress.vue';
const props=defineProps<{messages:ChatMessage[];members:AssigneeOption[];online:boolean}>(),emit=defineEmits<{close:[];done:[count:number];pending:[]}>();
const account=captureApiLease().account,intent=ref<ReturnType<typeof readMergedForward>>(null),error=ref(''),readFailed=ref(false);
try{intent.value=readMergedForward(account);}catch{readFailed.value=true;error.value='上次聊天记录转发暂不可读取，请重试';}
const peer=ref<string|null>(intent.value?.body.peer??null),job=ref<MergedJob|undefined>(intent.value?getMergedJob(account,intent.value.key):undefined),busy=computed(()=>job.value?.state==='running');
const targetName=computed(()=>peer.value===''?'公司工作群':peer.value===account?'文件传输助手':props.members.find(m=>m.username===peer.value)?.nickname||'所选联系人');
const rows=computed(()=>intent.value?.body.messages||props.messages.map(m=>({author:m.author_name,body:m.body,attachments:m.attachments,created_at:m.created_at})));
function close(){if(busy.value)job.value?.cancel();emit('pending');emit('close');}
async function discard(){if(!intent.value||busy.value)return;if(await useUiStore().confirm({title:'结束这次转发？',text:'若消息已经送达，结束不会撤回它。',label:'结束转发'})){try{discardMergedForward(account,intent.value.key);emit('pending');emit('close');}catch(e){error.value=userError(e);}}}
async function submit(){if(busy.value||peer.value===null||!props.online||readFailed.value)return;error.value='';try{if(captureApiLease().account!==account)throw Error('账号已变化');intent.value ||=prepareMergedForward(account,peer.value,props.messages);emit('pending');job.value=startMergedForward(intent.value);const result=await job.value.promise;if(captureApiLease().account!==account)return;if(result!==false){emit('done',result);emit('pending');emit('close');}else{intent.value=readMergedForward(account);error.value=job.value.error;}}catch(e){error.value=userError(e,'转发未完成，请重试');}}
</script>
<template><ModalSheet modal-class="forward-dialog" title="转发给" sub="合并为一条聊天记录" @close="close"><ForwardRecipientPicker v-if="!intent" v-model="peer" :account="account" :members="members"/><p v-else-if="!busy" class="field-help">继续发给{{targetName}}</p><div class="record-preview" aria-label="待合并消息"><p v-for="(m,i) in rows" :key="i"><strong>{{m.author}}：</strong>{{m.body||m.attachments.map(a=>a.mime.startsWith('image/')?'[图片]':a.mime.startsWith('audio/')?'[语音]':'[文件] '+a.name).join(' ')}}</p></div><p v-if="error" role="alert">{{error}}</p><template #footer><button class="btn" @click="close">{{busy?'暂停':'取消'}}</button><button v-if="intent&&!busy" class="btn" @click="discard">结束转发</button><button class="btn primary" :disabled="busy||peer===null||!online||readFailed" @click="submit">{{busy?'':intent?'继续转发':'发送'}}<ForwardProgress :busy="busy"/></button></template></ModalSheet></template>
<style scoped>.record-preview{margin:12px 0;padding:12px;background:var(--paper-soft);max-height:24vh;overflow:auto}.record-preview p{margin:4px 0;font-size:14px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.record-preview strong{font-weight:400;color:var(--muted)}</style>
