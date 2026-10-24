<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {findAttachment,type Attachment,type LoadedMedia} from '@/collaboration/media';
import {startAcquisition} from '@/files/acquisition';
import { getChatDownload, getChatVoiceDuration, type ChatAttachment } from '@/chat/files';
import { claimVoice } from '@/chat/voicePlayback';
import { durationKey, knownVoiceDuration, loadVoiceDuration, rememberVoiceDuration } from '@/chat/voiceDuration';
import { voiceBubbleWidth } from '@/chat/mediaKind';
import { useSessionStore } from '@/session/store';

const props = defineProps<{ attachment: ChatAttachment }>();
const session = useSessionStore();
const attachmentOwner = session.user?.username;
const audio = ref<HTMLAudioElement>();
const surface = ref<HTMLElement>();
const url = ref(''), state = ref<'idle' | 'loading' | 'playing' | 'paused' | 'error'>('idle');
const duration = ref(0), elapsed = ref(0);
let generation = 0;
let media:LoadedMedia|undefined;
async function localSource(signal:AbortSignal){
 const a=props.attachment,context={account:attachmentOwner||'',computer:'cloud',provider:'company',thread:'group'};
 const file:Attachment={...a,unavailable:a.source_unavailable?'历史录音原文件尚未取得':undefined,kind:'audio',version:`${a.ver}:${a.sha256}`,resolveUrl:async s=>(await getChatDownload(a.id,s,a)).download_url};
 const job=startAcquisition(file,context,async()=>file);
 await job.promise;
 const result=await findAttachment(file,context);
 if(!result)throw Error('语音文件未保存在应用缓存');
 if(signal.aborted||session.user?.username!==attachmentOwner){result.dispose();throw new DOMException('已取消','AbortError');}media?.dispose();media=result;return result.url;
}
let request: AbortController | undefined;
let playback: ReturnType<typeof claimVoice> | undefined;
let observer: IntersectionObserver | undefined;
let durationRequest: AbortController | undefined;
const durationStatus = ref<'idle' | 'loading' | 'error'>('idle');
const cacheKey = computed(() => durationKey(attachmentOwner || '', props.attachment));
const label = computed(() => ({ idle: '播放语音', loading: '正在加载语音，点击取消', playing: '暂停语音', paused: '继续播放语音', error: '语音播放失败，点击重试' }[state.value]));
const seconds = computed(() => duration.value > 0 ? `${Math.ceil(duration.value)}″` : '…');
function metadata() {
  const value = audio.value?.duration;
  // MediaRecorder may report Infinity, but a finite value from the actual
  // browser decoder is valid even for MP4/WebM. Do not discard it in favor of
  // a second full-file decode that can fail on Android WebView.
  if (value && Number.isFinite(value) && value > 0) {
    durationRequest?.abort();durationStatus.value='idle';
    duration.value = value; rememberVoiceDuration(cacheKey.value, value);
  } else if (!duration.value) void resolveDuration();
}
async function resolveDuration() {
  if (duration.value || !url.value || durationStatus.value === 'loading' || session.user?.username !== attachmentOwner) return;
  const currentUrl = url.value, key = cacheKey.value;
  durationRequest?.abort(); const request = new AbortController(); durationRequest = request;
  durationStatus.value = 'loading';
  try {
    const source = currentUrl, resource = media;
    const seconds = await loadVoiceDuration(source, key, request.signal, resource ? {size: resource.uploadSource.size, mime:props.attachment.mime, readPart: (start,end) => resource.uploadSource.readPart ? resource.uploadSource.readPart(start,end) : Promise.resolve(resource.uploadSource.slice!(start,end)), duration: resource.audioDuration} : undefined);
    if (!request.signal.aborted && currentUrl === url.value && key === cacheKey.value) { duration.value = seconds; durationStatus.value = 'idle'; }
  } catch { if (!request.signal.aborted) durationStatus.value = 'error'; }
}
function stop(reset = true) {
  generation++; request?.abort(); request = undefined;
  audio.value?.pause();
  if (reset && audio.value) { audio.value.currentTime = 0; elapsed.value = 0; }
  state.value = reset ? 'idle' : 'paused';
  playback?.release(); playback = undefined;
}
let durationLookupAttempted = false;
function clear() { observer?.disconnect(); durationRequest?.abort(); durationStatus.value = 'idle'; durationLookupAttempted=false; stop(); media?.dispose();media=undefined;url.value = ''; duration.value = props.attachment.duration_ms ? props.attachment.duration_ms/1000 : knownVoiceDuration(cacheKey.value); }
async function readPublishedDuration() {
  if (duration.value || durationLookupAttempted || session.user?.username !== attachmentOwner) return;
  durationLookupAttempted=true;
  const key=cacheKey.value, pending=new AbortController();durationRequest=pending;
  try {
    const result=await getChatVoiceDuration(props.attachment.id,pending.signal);
    const ms=result.attachment.duration_ms;
    if(!pending.signal.aborted&&key===cacheKey.value&&ms&&ms>0){duration.value=ms/1000;rememberVoiceDuration(key,duration.value);}
  } catch { /* Duration is display metadata; playback has its own error path. */ }
  finally { if (durationRequest === pending) durationRequest = undefined; }
}
// Retry only when an external event makes a stale network result plausible.
// A missing duration must never start a timer or download audio merely to
// render the bubble; the server owns this metadata.
function retryPublishedDuration() {
  if (duration.value || durationRequest && !durationRequest.signal.aborted) return;
  durationLookupAttempted = false;
  void readPublishedDuration();
}
function onVisible() { if (document.visibilityState === 'visible') retryPublishedDuration(); }
function observe() {
  if (!surface.value || session.user?.username !== attachmentOwner) return;
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) void readPublishedDuration();
  });
  observer.observe(surface.value);
}
function failed() { durationRequest?.abort(); durationStatus.value = 'idle'; stop(); url.value = ''; state.value = 'error'; }
async function toggle() {
  if (session.user?.username !== attachmentOwner) return;
  if (state.value === 'playing') { stop(false); return; }
  if (state.value === 'loading') { stop(); return; }
  request?.abort();
  const current = ++generation;
  playback = claimVoice(() => stop());
  const ticket = playback;
  state.value = 'loading';
  try {
    if (!url.value) {
      request = new AbortController();
      const source = await localSource(request.signal);
      if (current !== generation || !ticket.current()) return;
      url.value = source;
    }
    await nextTick();
    if (current !== generation || !ticket.current() || !audio.value) return;
    if (!duration.value) void resolveDuration();
    await audio.value.play();
    if (current !== generation || !ticket.current()) return;
    state.value = 'playing';
  } catch {
    if (current === generation && ticket.current()) failed();
  }
}
function ended() {
  // Some MediaRecorder WebM files report Infinity until playback ends.
  if (!duration.value && audio.value?.currentTime) { duration.value = audio.value.currentTime; rememberVoiceDuration(cacheKey.value, duration.value); }
  stop();
}
watch(() => [session.user?.username, props.attachment.id, props.attachment.ver, props.attachment.sha256], async () => { clear(); await nextTick(); observe(); });
watch(() => props.attachment.duration_ms, ms => {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return;
  durationRequest?.abort(); durationRequest = undefined;
  duration.value = ms / 1000;
  rememberVoiceDuration(cacheKey.value, duration.value);
});
onMounted(() => { duration.value = props.attachment.duration_ms ? props.attachment.duration_ms/1000 : knownVoiceDuration(cacheKey.value); observe(); window.addEventListener('online', retryPublishedDuration); document.addEventListener('visibilitychange', onVisible); });
onBeforeUnmount(() => { window.removeEventListener('online', retryPublishedDuration); document.removeEventListener('visibilitychange', onVisible); clear(); });
</script>
<template>
  <div ref="surface" class="voice-message" :class="state">
    <button type="button" class="voice-bubble" :style="{ width: `${voiceBubbleWidth(duration)}px` }" data-message-action :aria-label="label" :aria-pressed="state === 'playing'" @click="toggle">
      <svg class="voice-signal" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="4.5" cy="12" r="1.5" fill="currentColor"/><path class="voice-near" d="M9 7c3.1 2.8 3.1 7.2 0 10"/><path class="voice-far" d="M13.5 3.5c5.3 4.7 5.3 12.3 0 17"/></svg>
      <span class="voice-duration">{{ duration ? seconds : state === 'loading' ? '加载' : state === 'error' ? '重试' : seconds }}</span>
    </button>
    <audio v-if="url" ref="audio" :src="url" preload="metadata" aria-label="语音消息音频" @loadedmetadata="metadata" @durationchange="metadata" @timeupdate="elapsed = audio?.currentTime || 0" @ended="ended" @error="failed" />
    <span v-if="state === 'error'" class="voice-error" role="alert">播放失败，点击气泡重试</span>
  </div>
</template>
<style scoped>
.voice-message{max-width:100%;min-width:0}
.voice-bubble{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:var(--message-control-size);min-width:104px;max-width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:4px 12px 12px;background:var(--paper);color:var(--ink);text-align:left;touch-action:pan-y}
.voice-duration{font-family:inherit;font-size:var(--message-font-size,15px);font-weight:400;font-style:normal;font-variant-numeric:tabular-nums;line-height:20px;white-space:nowrap}.voice-caption{font-size:12px;color:var(--muted);margin-left:auto;white-space:nowrap}
.voice-signal{display:block;width:19px;height:22px;flex:none;color:currentColor;overflow:visible}.voice-signal path{stroke:currentColor;stroke-width:1.8;stroke-linecap:round;fill:none}
.playing .voice-near{animation:voice-wave-near 1.2s steps(1,end) infinite}.playing .voice-far{animation:voice-wave-far 1.2s steps(1,end) infinite}.loading .voice-signal{opacity:.55}
.voice-error{display:block;color:var(--red);font-size:12px;margin-top:6px}.error .voice-bubble{border-color:var(--red)}audio{display:none}
.own .voice-bubble{background:var(--message-own);border-color:var(--message-own-line);border-radius:12px 4px 12px 12px}
.own .voice-bubble{flex-direction:row-reverse}.own .voice-signal{transform:scaleX(-1)}
@keyframes voice-wave-near{0%,100%{opacity:0}33%,99%{opacity:1}}@keyframes voice-wave-far{0%,65%,100%{opacity:0}66%,99%{opacity:1}}
@media(prefers-reduced-motion:reduce){.playing .voice-near,.playing .voice-far{animation:none}}
</style>
