<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { claimVoice } from '@/chat/voicePlayback';
const props = defineProps<{ src: string; autoplay?: boolean; label?: string; durationHint?: number }>();
const emit = defineEmits<{ error: [] }>();
const audio = ref<HTMLAudioElement>();
const playing = ref(false), current = ref(0), duration = ref(props.durationHint || 0), rate = ref(1), notice = ref('');
let playback: ReturnType<typeof claimVoice> | undefined;
function stop() { audio.value?.pause(); playback?.release(); playback = undefined; }
function time(value: number) { const s = Math.max(0, Math.floor(value || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function update() { const el = audio.value; if (!el) return; current.value = el.currentTime; duration.value = props.durationHint || (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0); }
async function toggle() {
  const el = audio.value; if (!el) return;
  notice.value = '';
  if (!el.paused) { stop(); return; }
  playback = claimVoice(stop);
  const ticket = playback;
  try { await el.play(); if (!ticket.current()) el.pause(); } catch { if (ticket.current()) { stop(); notice.value = '点击播放，或重新打开这条语音'; } }
}
function seek(event: Event) { if (audio.value && duration.value) audio.value.currentTime = Number((event.target as HTMLInputElement).value); }
function speed() { rate.value = rate.value === 1 ? 1.5 : rate.value === 1.5 ? 2 : 1; if (audio.value) audio.value.playbackRate = rate.value; }
function reset() { stop(); playing.value = false; current.value = 0; duration.value = props.durationHint || 0; notice.value = ''; rate.value = 1; }
watch(() => props.src, reset);
watch(() => props.durationHint, () => { if (props.durationHint) duration.value = props.durationHint; });
function ready() { update(); if (props.autoplay && current.value === 0) void toggle(); }
onMounted(() => { if (audio.value?.readyState) ready(); });
onBeforeUnmount(stop);
</script>
<template>
  <div class="voice-player" :aria-label="label || '语音消息'">
    <audio ref="audio" :src="src" preload="metadata" aria-label="语音播放" @loadedmetadata="ready" @durationchange="update" @timeupdate="update" @play="playing = true" @pause="playing = false" @ended="playing = false" @error="emit('error')" />
    <button class="voice-play" :aria-label="playing ? '暂停语音' : '播放语音'" @click="toggle"><AppIcon :name="playing ? 'pause' : 'play'" /></button>
    <div class="voice-track"><span>{{ label || '语音消息' }}</span><input type="range" min="0" :max="duration || 1" step="0.1" :value="current" :disabled="!duration" aria-label="语音播放进度" :aria-valuetext="`${time(current)} / ${time(duration)}`" @input="seek"><small>{{ time(current) }}<template v-if="duration"> / {{ time(duration) }}</template></small></div>
    <button class="voice-speed" :aria-label="`播放速度 ${rate} 倍，点击切换`" @click="speed">{{ rate }}×</button>
    <small v-if="notice" class="voice-notice" role="status">{{ notice }}</small>
  </div>
</template>
<style scoped>
.voice-player{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;width:100%;color:var(--ink)}audio{display:none}.voice-play{display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:50%;background:var(--accent);color:white;flex:none}.voice-play .icon{width:19px;height:19px}.voice-track{flex:1;min-width:70px;display:grid;gap:2px}.voice-track>span{font-size:13px;font-weight:600}.voice-track input{width:100%;min-width:0;height:24px;margin:0;accent-color:var(--accent)}.voice-track small{font-variant-numeric:tabular-nums;font-size:11px;color:var(--muted)}.voice-speed{padding:0;width:44px;height:44px;border:0;background:transparent;color:var(--accent-dark);font-size:13px;font-weight:600}.voice-notice{width:100%;color:var(--red)}
</style>
