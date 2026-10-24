<script setup lang="ts">
import {pageNavigation} from '@/app/router';
import {orderGroupFiles} from '@/chat/groupFiles.mjs';
import {fullDate} from '@/ui/date.mjs';
import {ref,onMounted,onBeforeUnmount,onActivated,onDeactivated,nextTick} from 'vue';
import {onChatWake} from '@/platform/chatEvents';
import {communication} from '@/api/endpoints';
import {isGroupFile} from '@/chat/mediaKind';
import {captureApiLease} from '@/api/client';
import {metaGet,metaSet,metaRemove} from '@/session/db';
import {useReadFeedback} from '@/ui/useReadFeedback';
import ChatAttachmentView from '@/ui/components/ChatAttachmentView.vue';
import type {ChatAttachment} from '@/api/types';
const lease=captureApiLease(),key='group-files-view';
const {error,feedback}=useReadFeedback({retry:()=>load(),ready:()=>lease.networkReady()});
const root=ref<HTMLElement|null>(null),files=ref<ChatAttachment[]>([]),query=ref(''),submitted=ref(''),cursor=ref<string|null>(null),busy=ref(false);
let active=true,hydrated=false,refreshPending=false,loadedRevision=-1,contentRevision=0;
let alive=true,generation=0,abort:AbortController|undefined;
function host(){let node=root.value?.parentElement;while(node){if(/auto|scroll/.test(getComputedStyle(node).overflowY))return node;node=node.parentElement;}return document.scrollingElement;}
function save(){if(lease.valid())void metaSet(lease.account,key,JSON.parse(JSON.stringify({files:files.value,query:query.value,submitted:submitted.value,cursor:cursor.value,scroll:host()?.scrollTop||0})),lease.valid).catch(()=>{});}
async function load(more=false,changed=false){
 if(busy.value&&!more&&query.value.trim()===submitted.value){if(changed)refreshPending=true;return;}
 refreshPending=false;const revision=contentRevision;
 const n=++generation;abort?.abort();abort=new AbortController();const signal=abort.signal,valid=()=>alive&&n===generation&&lease.valid()&&!signal.aborted;
 const text=more?submitted.value:query.value.trim(),same=text===submitted.value,preserve=!more&&same?files.value.length:0;
 if(!same){feedback.succeeded();files.value=[];cursor.value=null;}submitted.value=text;busy.value=true;feedback.begin(files.value.length>0);
 try{const rows:ChatAttachment[]=more?[...files.value]:[];let next=more?cursor.value:undefined;const seen=new Set();
 do{const page=await communication.files(next||undefined,signal,{q:text||undefined});if(!valid())return;rows.push(...page.files.filter(isGroupFile));next=page.next_cursor;if(next&&seen.has(next))throw Error('群文件分页未推进');if(next)seen.add(next);}while(next&&orderGroupFiles(rows).length<(more?files.value.length+1:preserve));
 if(!valid())return;files.value=orderGroupFiles(rows);cursor.value=next||null;loadedRevision=revision;feedback.succeeded();save();
 }catch(e){if(valid()){feedback.failed(e,'群文件暂未更新，请重试');if([401,403].includes((e as any)?.status)){files.value=[];cursor.value=null;await metaRemove(lease.account,key,valid).catch(()=>{});}}}finally{if(valid()){busy.value=false;if(refreshPending){refreshPending=false;void load(false,true);}}}
}
onMounted(async()=>{const cached=await metaGet<any>(lease.account,key).catch(()=>null);if(!alive||!lease.valid())return;if(cached){files.value=orderGroupFiles((cached.files||[]).filter(isGroupFile));query.value=cached.query||'';submitted.value=cached.submitted||'';cursor.value=cached.cursor||null;await nextTick();const target=host();if(target)target.scrollTop=cached.scroll||0;}await load();hydrated=true;});
onActivated(()=>{active=true;if(hydrated&&loadedRevision!==contentRevision)void load();});
onDeactivated(()=>{active=false;save();});
const stopWake=onChatWake(event=>{if(event.account===lease.account&&(event.mode==='catchup'||event.groupFilesChanged)){contentRevision++;if(active)void load(false,true);}});
onBeforeUnmount(()=>{save();stopWake();alive=false;generation++;abort?.abort();});
</script>
<template><section ref="root" class="group-files"><button class="btn ghost" data-page-back @click="save();pageNavigation.back()">‹ 返回工作群</button><h1>群文件</h1><form @submit.prevent="load()"><input class="input" v-model="query" aria-label="搜索群文件" placeholder="搜索文件名或消息关键词" maxlength="200"><button class="btn soft">搜索</button></form><p v-if="error" role="alert" class="error-text">{{error}}<button class="btn" @click="load()">重试</button></p><article v-for="file in files" :key="file.id"><time v-if="(file as any).created_at" class="file-date">{{fullDate((file as any).created_at)}}</time><ChatAttachmentView :attachment="file" /></article><p v-if="busy" role="status">正在读取群文件…</p><p v-else-if="!files.length&&!error">没有匹配的群文件</p><button v-if="cursor" class="btn" :disabled="busy" @click="load(true)">更多群文件</button></section></template>
<style scoped>.group-files{max-width:560px;margin:auto}.group-files h1{font-size:20px;margin:16px 0 6px}.group-files>p{font-size:13px;line-height:1.5;color:var(--muted);margin:8px 0 16px}.group-files form{display:flex;align-items:center;gap:8px;min-height:48px}.group-files form .btn{font-size:14px;min-height:max(var(--search-height),calc(1.55em + 10px));height:max(var(--search-height),calc(1.55em + 10px));padding:4px 12px}.group-files input{min-width:0;flex:1;font-size:16px;min-height:max(var(--search-height),calc(1.55em + 10px));height:max(var(--search-height),calc(1.55em + 10px));padding:4px 10px;margin:0}.group-files .file-date{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}.group-files article{padding:10px 0;border-bottom:1px solid var(--line-soft)}</style>
