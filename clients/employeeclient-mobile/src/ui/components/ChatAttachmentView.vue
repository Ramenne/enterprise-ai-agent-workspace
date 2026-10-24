<script setup lang="ts">
import ChatRecordView from './ChatRecordView.vue';
import {isChatRecord} from '@/chat/chatRecord';
import {computed} from 'vue';
import {getChatDownload,renameChatFile,type ChatAttachment} from '@/chat/files';
import {useSessionStore} from '@/session/store';
import {isVoiceMessage} from '@/chat/mediaKind';
import CollaborationAttachment from './CollaborationAttachment.vue';
import {effectiveKind,effectiveMime} from '@/files/fileType';
import ChatVoiceMessage from './ChatVoiceMessage.vue';
const props=defineProps<{attachment:ChatAttachment;forwardable?:boolean;recordDepth?:number}>();
const emit=defineEmits<{forward:[];select:[]}>();
const session=useSessionStore();
const context=computed(()=>({account:session.user?.username||'',computer:'cloud',provider:'company',thread:'group'}));
const item=computed(()=>({...props.attachment,unavailable:props.attachment.source_unavailable?'原文件尚未取得，当前只保留历史附件索引':undefined,mime:effectiveMime(props.attachment.name,props.attachment.mime),version:`${props.attachment.ver}:${props.attachment.sha256}`,kind:effectiveKind(props.attachment.name,props.attachment.mime),rename:!props.attachment.id.startsWith('private:')&&props.attachment.owner_username===session.user?.username?async(name:string)=>{await renameChatFile(props.attachment.id,name);}:undefined,groupAttachment:props.attachment,resolveUrl:async(signal:AbortSignal)=>(await getChatDownload(props.attachment.id,signal,props.attachment)).download_url}));
</script>
<template><ChatRecordView v-if="isChatRecord(attachment)" :attachment="attachment" :depth="recordDepth"/><ChatVoiceMessage v-else-if="isVoiceMessage(attachment)" :attachment="attachment"/><CollaborationAttachment v-else :attachment="item" :context="context" :forwardable="forwardable" embedded-in-message @forward="emit('forward')" @select="emit('select')"/></template>
