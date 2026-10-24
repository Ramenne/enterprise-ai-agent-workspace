<script setup lang="ts">
import { ref, onBeforeUnmount, watch } from 'vue';
import jsQR from 'jsqr';
import { parsePairingQr } from '@/collaboration/pairingQr';
const props = defineProps<{ disabled: boolean }>();
const emit = defineEmits<{ scanned: [code: string] }>();
const video = ref<HTMLVideoElement | null>(null);
const active = ref(false), error = ref(''), starting = ref(false);
let stream: MediaStream | undefined, timer: ReturnType<typeof setTimeout> | undefined, generation = 0;
const canvas = document.createElement('canvas');
function stop() {
  generation++;
  clearTimeout(timer);
  stream?.getTracks().forEach(t => t.stop());
  stream = undefined;
  if (video.value) video.value.srcObject = null;
  active.value = false;
  starting.value = false;
}
function scan(id: number) {
  if (id !== generation || !active.value) return;
  const v = video.value;
  if (v && v.readyState >= 2 && v.videoWidth) {
    canvas.width = Math.min(720, v.videoWidth);
    canvas.height = Math.round(v.videoHeight * canvas.width / v.videoWidth);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const qr = jsQR(frame.data, frame.width, frame.height);
      if (qr) {
        try { const code = parsePairingQr(qr.data); stop(); emit('scanned', code); return; }
        catch (e) { error.value = (e as Error).message; }
      }
    }
  }
  timer = setTimeout(() => scan(id), 180);
}
async function start() {
  if (props.disabled || starting.value) return;
  stop(); const id = generation;
  starting.value = true; error.value = '';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境无法打开相机，请使用新版员工客户端或 HTTPS 页面。');
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    if (id !== generation) { acquired.getTracks().forEach(t => t.stop()); return; }
    stream = acquired;
    const v = video.value;
    if (!v) { stop(); return; }
    v.srcObject = acquired;
    await v.play();
    if (id !== generation) return;
    starting.value = false; active.value = true; scan(id);
  } catch (e) {
    if (id !== generation) return;
    stop();
    const name = (e as Error).name;
    error.value = name === 'NotAllowedError' ? '相机权限未开启，请在系统设置允许员工客户端使用相机后重试。' : name === 'NotFoundError' ? '未找到相机，请在手机上扫码。' : '相机未能启动，请关闭其他占用相机的应用后重试。';
  }
}
function visibility() { if (document.hidden) stop(); }
document.addEventListener('visibilitychange', visibility);
watch(() => props.disabled, value => { if (value) stop(); });
onBeforeUnmount(() => { stop(); document.removeEventListener('visibilitychange', visibility); });
</script>
<template>
  <div class="pair-scanner">
    <video ref="video" v-show="active || starting" autoplay muted playsinline aria-label="扫码取景框" />
    <p v-if="active">将 Mac 上的二维码放入取景框，识别后自动绑定。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="!active && !starting" type="button" class="btn primary" :disabled="disabled" @click="start">扫码连接 Mac</button>
    <button v-else type="button" class="btn" @click="stop">取消扫码</button>
  </div>
</template>
<style scoped>
.pair-scanner { display: grid; gap: 12px; margin: 20px 0; }
video { width: 100%; max-height: 42vh; object-fit: cover; border-radius: 12px; background: #111; }
[role="alert"] { color: #a32525; }
</style>
