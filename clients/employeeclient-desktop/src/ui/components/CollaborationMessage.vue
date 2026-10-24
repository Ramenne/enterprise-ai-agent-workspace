<script setup lang="ts">
import {fullDateTime} from '@/ui/date.mjs';
import {computed} from 'vue';
import {renderMessage,type VisibleMessage} from '@/collaboration/presentation';
import CollaborationAttachment from './CollaborationAttachment.vue';
import type {MediaContext} from '@/collaboration/media';
import {effectiveKind,effectiveMime} from '@/files/fileType';
const props=defineProps<{message:VisibleMessage; providerName:string;mediaContext?:MediaContext}>();
const timestamp=computed(()=>props.message.created_at||(props.message.role==='user'?props.message.started_at:props.message.completed_at));
const timeLabel=computed(()=>timestamp.value?fullDateTime(timestamp.value):'');
const duration=computed(()=>props.message.completed_at&&props.message.started_at?Math.max(0,Math.round((props.message.completed_at-props.message.started_at)/1000)):null);
const html=computed(()=>renderMessage(props.message.text,!!props.message.attachments?.length));
const attachments=computed(()=>(props.message.attachments||[]).map(a=>({...a,mime:effectiveMime(a.name,a.mime),kind:effectiveKind(a.name,a.mime)})));
</script>
<template>
  <article class="collaboration-message" :class="[message.role,{progress:message.phase==='commentary','final-answer':message.phase==='final_answer'||message.phase==='final'}]">
    <div class="message-meta"><span class="author">{{message.role==='user'?'我':message.phase==='commentary'?'工作进展':providerName}}</span><time v-if="timestamp" :datetime="new Date(timestamp).toISOString()">{{timeLabel}}</time><small v-if="duration!==null && message.phase==='final_answer'">用时 {{duration}} 秒</small></div>
    <small v-if="message.missingPrefix">上方“查看更早记录”可继续加载这条消息的前文</small>
    <div class="message-content" v-html="html"></div>
    <template v-if="mediaContext"><CollaborationAttachment v-for="a in attachments" :key="a.id" :attachment="a" :context="mediaContext" /></template>
  </article>
</template>
<style scoped>
.collaboration-message{margin:0 0 20px;max-width:100%;overflow-wrap:anywhere;font-size:15px;line-height:1.65}
.message-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.message-meta time{font-size:11px;color:var(--muted);margin-bottom:6px}.author,small{display:block;color:#667085;font-size:12px;margin-bottom:6px}
.user{margin-left:auto;background:#eaf0fb;padding:12px 16px;border-radius:14px;max-width:94%}
.progress{border-left:2px solid #d5dae1;padding-left:12px;color:#667085;font-size:13px;line-height:1.6}.progress .author{font-size:11px;color:#77818e}.final-answer{color:#202a37;font-size:16px;line-height:1.75;margin-top:24px}.final-answer .author{font-weight:600;color:#4b586b}.final-answer :deep(strong){font-weight:650}
.message-content :deep(p){margin:0 0 .75em;white-space:normal}
.message-content :deep(p:last-child){margin-bottom:0}
.message-content :deep(pre){overflow:auto;max-width:100%;padding:12px;background:#f3f4f6;border:1px solid #e4e7ec;border-radius:8px;white-space:pre;font-size:13px}
.message-content :deep(code){font-family:ui-monospace,monospace;background:#edf0f4;border-radius:4px;padding:1px 3px}
.message-content :deep(pre code){padding:0;background:none}
.message-content :deep(ul),.message-content :deep(ol){padding-left:1.5em;margin:.65em 0}
.message-content :deep(h1),.message-content :deep(h2),.message-content :deep(h3){font-size:1.1em;margin:.8em 0 .4em}
.message-content :deep(blockquote){border-left:3px solid #b9c2d0;padding-left:12px;margin:10px 0;color:#556070}
.message-content :deep(table){display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:12px 0}
.message-content :deep(td),.message-content :deep(th){border:1px solid #dce1e8;padding:6px 10px}
.message-content :deep(a){color:#215db0;text-decoration:underline}
</style>
