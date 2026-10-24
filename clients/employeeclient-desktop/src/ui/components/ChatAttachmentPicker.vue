<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {userError} from '@/domain/userError.mjs';
import TransferSector from './TransferSector.vue';
import {startChatTransfer,stageChatTransfer} from '@/files/chatTransfers';
import type {ChatSendBody} from '@/api/types';
import type {TransferProgress} from '@/files/transferProgress';
import VoicePlayer from './VoicePlayer.vue';
import AppIcon from './AppIcon.vue';
import { captureApiLease, newIdempotencyKey } from '@/api/client';
import { MAX_CHAT_FILE_BYTES, uploadChatFile, type ChatAttachment,type UploadFile } from '@/chat/files';
import { stopVoicePlayback } from '@/chat/voicePlayback';
import { durationKey, rememberVoiceDuration, decodeVoiceDuration } from '@/chat/voiceDuration';
import { useSessionStore } from '@/session/store';

import { pendingSharedFiles, readSharedFile, clearSharedFiles, acknowledgeSharedFile } from '@/chat/share';
const owner = useSessionStore().user?.username || '';
const valid = () => {const current=captureApiLease();return alive&&current.account===owner&&current.valid();};
let shareRead: AbortController | null = null;
let failedShareId = '';
let voiceUpload = false;
const props = defineProps<{ deliveryBody?:()=>ChatSendBody;peer?:string;disabled?: boolean; remaining?: number; multiple?:boolean; hideVoice?: boolean; voiceOnly?: boolean; deliver?:(attachment:ChatAttachment,voice:boolean)=>Promise<boolean> }>();
const emit = defineEmits<{ filesSelected:[files:File[]];captureError:[message:string];voiceSource: []; fileSource: []; added: [attachment: ChatAttachment, voice?: boolean]; busy: [value: boolean,scope:{account:string;peer:string}]; active: [value: boolean,scope:{account:string;peer:string}]; capture: [state: { recording: boolean; seconds: number;account:string;peer:string }] }>();
const pickerScope={account:owner,peer:props.peer||''};
const input = ref<HTMLInputElement>();
const albumInput=ref<HTMLInputElement>();
const transferProgress=ref<TransferProgress>();
const busy = ref(false), stage = ref(''), error = ref(''), recording = ref(false), seconds = ref(0);
const failed = ref<UploadFile | null>(null);
const uploaded = ref<ChatAttachment|null>(null);
const draft = ref<File | null>(null), draftUrl = ref('');
const draftSeconds = ref(0);
let captureStarted = 0, captureEnded = 0,autoSendCapture=false;
function clearDraft() { if (draftUrl.value) URL.revokeObjectURL(draftUrl.value); draftUrl.value = ''; draft.value = null; }
function abandon() { clearDraft(); uploaded.value=null;failed.value = null; error.value = ''; }
function delivered(id:string){if(uploaded.value?.id===id){uploaded.value=null;failed.value=null;error.value='';if(voiceUpload)clearDraft();}}
const finishing = ref(false), requestingPermission = ref(false);
const shared = ref<Awaited<ReturnType<typeof pendingSharedFiles>>>([]);
const importing = ref(false);
watch([recording, seconds], () => emit('capture', { recording: recording.value, seconds: seconds.value,...pickerScope }), { flush: 'sync' });
watch([busy, recording, importing, finishing], values => emit('busy', values.some(Boolean),pickerScope));
watch([busy, recording, importing, finishing, draft, failed, error], values => emit('active', !autoSendCapture&&(props.deliveryBody?!!draft.value:values.some(Boolean)),pickerScope));
async function checkShare() {
  if (!valid() || document.visibilityState === 'hidden') return;
  try { const files = await pendingSharedFiles(); if (valid()) shared.value = files; } catch (e) { if (alive) error.value = e instanceof Error ? e.message : '无法读取分享文件'; }
}
async function importShared() {
  if (!valid() || busy.value || importing.value || props.disabled) return;
  if (shared.value.length > (props.remaining ?? 6)) { error.value = '每条消息最多6个附件，请先处理已有附件'; return; }
  importing.value = true; error.value = ''; shareRead = new AbortController();
  try {
    for (const source of shared.value) {
      if (!valid() || shareRead.signal.aborted) return;
      const file = await readSharedFile(source, shareRead.signal);
      if (!valid() || shareRead.signal.aborted) return;
      failedShareId = source.id;
      await send(file, false, source.id);
      if (!valid() || failed.value) return;
    }
    if (valid()) { await clearSharedFiles(); shared.value = []; }
  } catch (e) { error.value = e instanceof Error ? e.message : '分享导入失败'; }
  finally { importing.value = false; shareRead = null; }
}
async function discardShare() { await clearSharedFiles(); shared.value = []; }
onMounted(() => { void checkShare(); document.addEventListener('visibilitychange', checkShare); });
let key = '', controller: AbortController | null = null, recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null, timer: ReturnType<typeof setInterval> | null = null;
let alive = true, discard = false, chunks: Blob[] = [], recordedSize = 0;
let captureGeneration = 0;
watch(error,message=>{if(message&&autoSendCapture&&!failed.value)emit('captureError',message);});
const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
async function send(file: UploadFile, retry = false, sourceId = '', voice = false) {
  if (!valid() || busy.value || props.disabled && !(voice && props.deliveryBody)) return;
  if (!retry) { uploaded.value=null;failedShareId = sourceId; voiceUpload = voice; if (!voice) emit('fileSource'); }
  if (!retry) key = newIdempotencyKey('chat-file');
  failed.value = file; error.value = ''; busy.value = true; controller = new AbortController();
  try {
    if(props.deliveryBody){stage.value='文件正在传输，进度见上方消息';
      const job=startChatTransfer(file,key,props.peer||'',props.deliveryBody(),voiceUpload?'voice':'file',voiceUpload?Math.max(1,Math.round(draftSeconds.value*1000)):undefined);
      const sent=await (retry&&job.state!=='running'?job.retry():job.promise);if(!valid())return;if(!sent){if(!failedShareId){failed.value=null;uploaded.value=null;error.value='';if(voiceUpload)clearDraft();return;}throw Error(job.error||'发送未完成，请重试');}
      if(failedShareId){await acknowledgeSharedFile(failedShareId);shared.value=shared.value.filter(f=>f.id!==failedShareId);failedShareId='';}
      failed.value=null;uploaded.value=null;if(voiceUpload){if(job.attachment)rememberVoiceDuration(durationKey(owner,job.attachment),draftSeconds.value);clearDraft();}
      return;
    }
    const a = uploaded.value || await uploadChatFile(file, key, (s,p) => { stage.value = s;transferProgress.value=p; }, controller.signal, voiceUpload ? 'voice' : 'file', voiceUpload ? Math.max(1,Math.round(draftSeconds.value*1000)) : undefined,props.peer);
    if (valid()) {
      uploaded.value=a;
      if(props.deliver){stage.value='文件已上传，正在发送…';if(!await props.deliver(a,voiceUpload))throw Error('文件已上传，消息尚未确认；请重试发送');if(!valid())return;}
      else emit('added',a,voiceUpload);
      if (failedShareId) {
        const sharedId = failedShareId; await acknowledgeSharedFile(sharedId);
        if (!valid()) return;
        shared.value = shared.value.filter(f => f.id !== sharedId); failedShareId = '';
      }
      failed.value = null;uploaded.value=null;
      if (voiceUpload) { rememberVoiceDuration(durationKey(owner, a), draftSeconds.value); clearDraft(); }
    }
  } catch (e) { if (alive && !controller.signal.aborted) error.value = userError(e,'发送未完成，请重试'); }
  finally { busy.value = false; stage.value = '';transferProgress.value=undefined; }
}
async function choose(event: Event) {
 const el=event.target as HTMLInputElement,files=Array.from(el.files||[]),file=files[0];el.value='';
 if(props.multiple&&!props.voiceOnly){if(files.length&&valid()&&!busy.value&&!props.disabled)emit('filesSelected',files);return;}
 if(!file||!valid()||busy.value||props.disabled)return;
 if(!props.voiceOnly){
  if(!file.size||file.size>MAX_CHAT_FILE_BYTES){error.value='请选择100GB以内的文件';return;}
  if(!props.deliveryBody){void send(file);return;}
  emit('fileSource');busy.value=true;error.value='';stage.value='正在保留待发选择…';
  try{const job=stageChatTransfer(file,newIdempotencyKey('chat-file'),props.peer||'',props.deliveryBody());await job.promise;}
  catch(e){if(valid())error.value=userError(e,'文件选择未能保留，请重试');}
  finally{if(valid()){busy.value=false;stage.value='';}}
  return;
 }
 if(!/^audio\//i.test(file.type)&&!/\.(wav|mp3|m4a|mp4|ogg|webm|flac)$/i.test(file.name)){error.value='请选择音频文件';return;}
 if(!file.size||file.size>32*1024*1024){error.value='请选择32MB以内的语音文件';return;}
 emit('voiceSource');busy.value=true;error.value='';
 try{const duration=await decodeVoiceDuration(await file.arrayBuffer());if(!valid())return;clearDraft();draftSeconds.value=duration;draft.value=file;draftUrl.value=URL.createObjectURL(file);}
 catch{if(valid())error.value='无法读取音频，请选择有效的语音文件';}
 finally{busy.value=false;}
}
function release() {
  stream?.getTracks().forEach(t => {t.removeEventListener?.('ended', interrupted);t.stop();}); stream = null;
  if (timer) clearInterval(timer); timer = null; recording.value = false;
}
function interrupted(){if(!recording.value)return;error.value='录音中断，请重新录制';stop(true);}
function stop(cancel = false) {
  requestingPermission.value=false;
  captureGeneration++;if(!recording.value&&!finishing.value)busy.value=false;
  if (recording.value) captureEnded = performance.now();
  recording.value=false;
  discard = discard || cancel;
  finishing.value = !!recorder && recorder.state !== 'inactive';
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  release();
}
async function record(options?:{autoSend?:boolean}) {
  autoSendCapture=options?.autoSend===true;
  if (!valid() || busy.value || recording.value || finishing.value || draft.value || props.disabled) return;
  if (!canRecord) { error.value='当前系统不支持直接录音，请选择音频文件发送'; return; }
  if (failed.value) { error.value = '还有未上传的录音或附件，请先重试或放弃'; return; }
  stopVoicePlayback();
  error.value = ''; busy.value = true; requestingPermission.value=true;
  const captureId = ++captureGeneration,operationLease=captureApiLease();
  try {
    const capture = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!valid() || !operationLease.valid() || captureId !== captureGeneration) { capture.getTracks().forEach(t => t.stop()); return; }
    requestingPermission.value=false;stream = capture;
    stream.getTracks().forEach(t=>t.addEventListener?.('ended',interrupted));
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks = []; recordedSize = 0; discard = false; seconds.value = 0; recording.value = true;
    recorder.ondataavailable = e => {
      recordedSize += e.data.size;
      if (recordedSize > MAX_CHAT_FILE_BYTES) { error.value = '录音过大，请分段录制'; stop(true); return; }
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      // A browser/system stop is not the user's release-to-send action.
      if(recording.value){discard=true;error.value='录音中断，请重新录制';}
      const type = recorder?.mimeType || 'audio/webm'; release(); finishing.value = false;
      if (!alive || discard) { chunks = []; return; }
      const blob = new Blob(chunks, { type }); chunks = [];
      if (!blob.size) { error.value = '没有录到声音，请重新录制'; return; }
      clearDraft();
      draftSeconds.value = Math.max(0, (captureEnded - captureStarted) / 1000);
      draft.value = new File([blob], `语音-${new Date().toISOString().replace(/[:.]/g, '-')}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type });
      draftUrl.value = URL.createObjectURL(blob);
      if(autoSendCapture&&props.deliveryBody){const file=draft.value;void send(file,false,'',true).finally(()=>{clearDraft();failed.value=null;error.value='';});}
    };
    recorder.onerror = () => { error.value = '录音中断，请重试'; stop(true); };
    recorder.start(1000);
    captureStarted = performance.now(); captureEnded = captureStarted;
    timer = setInterval(() => { seconds.value = Math.floor((performance.now() - captureStarted) / 1000); if (seconds.value >= 120) stop(); }, 200);
  } catch (cause) { if(captureId!==captureGeneration||!valid())return;release(); const name = cause instanceof DOMException ? cause.name : ''; error.value = name === 'NotAllowedError' ? '麦克风权限未开启。请在系统设置中允许员工客户端使用麦克风，再点语音重试。' : name === 'NotFoundError' ? '未找到可用麦克风，可选择音频文件。' : '麦克风暂时不可用，请关闭其他录音应用后重试。'; }
  finally { if(captureId===captureGeneration){busy.value = false;requestingPermission.value=false;} }
}
// Keep stop public so the composer and automated/browser flows can end a
// recording through the same path as the visible Send/Cancel controls.
function sendFile(file:File){if(!valid()||props.disabled||props.voiceOnly||busy.value||finishing.value||recording.value||failed.value||draft.value)return false;void send(file);return true;}
defineExpose({ record, stop, delivered,sendFile });
onBeforeUnmount(() => { document.removeEventListener('visibilitychange', checkShare); alive = false; shareRead?.abort(); controller?.abort(); stop(true); clearDraft(); });
</script>

<template>
  <div class="attachment-picker">
    <div v-if="shared.length && !voiceOnly" class="incoming-share"><span>收到 {{ shared.length }} 个分享文件</span><button type="button" class="btn small" :disabled="busy || importing || disabled" @click="importShared">导入附件</button><button type="button" class="btn small" :disabled="busy || importing" @click="discardShare">不导入</button></div>
    <input ref="albumInput" type="file" :multiple="multiple&&!voiceOnly" class="file-input" aria-label="选择手机相册图片或视频" accept="image/*,video/*" @change="choose">
    <input ref="input" type="file" :multiple="multiple&&!voiceOnly" class="file-input" :aria-label="voiceOnly?'选择语音文件':'选择聊天文件'" :accept="voiceOnly?'audio/*':undefined" @change="choose">
    <div v-if="requestingPermission" class="voice-recording" aria-label="麦克风授权等待"><span role="status">正在打开麦克风…</span><button type="button" class="btn small" @click="stop(true)">取消</button></div>
    <div v-else-if="recording" class="voice-recording" aria-label="录音控制">
      <span role="status"><i class="record-dot"></i>正在录音 {{ seconds }} 秒<small>最长 2 分钟</small></span>
      <button type="button" class="btn primary small" @click="stop()">完成录音</button>
      <button type="button" class="btn small" @click="stop(true)">取消</button>
    </div>
    <div v-else-if="draft" class="voice-draft">
      <VoicePlayer :src="draftUrl" :duration-hint="draftSeconds" label="发送前试听" @error="error = '试听加载失败，可重新录制'" />
      <div class="voice-draft-actions"><button type="button" class="btn small" :disabled="busy" @click="abandon">取消</button><button type="button" class="btn small" :disabled="busy || disabled" @click="abandon(); record()">重录</button><button type="button" class="btn primary small" :disabled="busy || disabled" @click="send(draft, !!failed, '', true)">{{ busy ? '正在上传…' : failed ? '重试发送' : '发送语音' }}</button></div>
    </div>
    <template v-else>
      <button v-if="!voiceOnly" type="button" class="composer-tool" :disabled="busy || finishing || disabled || !!failed" @click="albumInput?.click()"><span aria-hidden="true"><AppIcon name="image" /></span>相册</button>
      <button v-if="!voiceOnly" type="button" class="composer-tool" :disabled="busy || finishing || disabled || !!failed" @click="input?.click()"><span aria-hidden="true"><AppIcon name="folder" /></span>文件</button>
      <button v-if="voiceOnly" type="button" class="composer-tool" :disabled="busy || finishing || disabled || !!failed" @click="input?.click()"><span aria-hidden="true"><AppIcon name="upload" /></span>选择语音文件</button>
      <button v-if="canRecord && !hideVoice" type="button" class="composer-tool" :disabled="busy || finishing || disabled || !!failed" @click="record()"><span aria-hidden="true"><AppIcon name="mic" /></span>语音</button>
      <slot v-if="!voiceOnly" /><span v-if="busy" class="upload-status" role="status"><TransferSector v-if="stage" :value="transferProgress?.phase==='upload'?transferProgress.loaded/transferProgress.total*100:undefined" :label="stage"/>{{ stage || '正在打开麦克风' }}</span>
    </template>
    <p v-if="error" class="upload-error" role="alert">{{ error }} <button v-if="failed && !busy && !draft" class="btn small" @click="send(failed, true)">{{uploaded?'重试发送':'重试上传'}}</button><button v-if="!busy && !draft" type="button" class="btn small" @click="abandon">{{ failed ? '放弃' : '关闭' }}</button></p>
  </div>
</template>
<style scoped>
.voice-draft{grid-column:1/-1;padding:14px;background:var(--paper-soft);border:1px solid var(--line);border-radius:14px;display:grid;gap:12px}.voice-draft-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.voice-draft-actions .btn{min-height:44px}.voice-draft{min-width:0}.voice-recording{flex-wrap:wrap}.voice-recording .btn{min-height:44px}.voice-recording>span{min-width:115px}
.attachment-picker{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:start;gap:20px 12px;font-size:12px;color:var(--muted,#6c7c79)}
.incoming-share{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex-basis:100%;padding:8px;background:#edf7f3;border-radius:8px}.file-input{display:none}.upload-error{grid-column:1/-1;margin:4px 0;color:#a44838}
.voice-recording{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:8px 0}.voice-recording>span{flex:1;color:var(--ink);font-size:14px}.voice-recording small{display:block;font-size:11px;color:var(--muted);margin:4px 0 0 14px}.record-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#c63c40;margin-right:7px}.upload-status{grid-column:1/-1}.attachment-picker :deep(.composer-tool){display:flex;flex-direction:column;align-items:center;gap:8px;border:0;background:transparent;color:var(--ink);font-size:13px;padding:6px 0;min-width:0}.attachment-picker :deep(.composer-tool span){display:grid;place-items:center;width:56px;height:56px;background:white;border:0;border-radius:12px;color:var(--ink);font-size:24px}.attachment-picker :deep(.composer-tool:disabled){opacity:.45}
.attachment-picker :deep(.composer-tool .icon){width:28px;height:28px}.attachment-picker{padding:12px 4px}@media(max-width:340px){.attachment-picker{gap:16px 4px}.attachment-picker :deep(.composer-tool span){width:52px;height:52px}.attachment-picker :deep(.composer-tool){font-size:12px}}
</style>
