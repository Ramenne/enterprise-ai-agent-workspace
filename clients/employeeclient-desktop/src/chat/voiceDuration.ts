import {isNativeFileUrl} from '@/files/native-url';
// Older MediaRecorder WebM/fragmented MP4 can omit the container duration.
// Decode the complete recording OFFLINE: no play(), speakers, or microphone.
import {fragmentedMp4Duration} from './mp4Duration';
const MAX_BYTES = 32 * 1024 * 1024;
const values = new Map<string, number>();
let running = 0;
const waiters: Array<() => void> = [];
export function durationKey(account: string, file: { id: string; ver: number; sha256: string }) {
  return JSON.stringify([account, file.id, file.ver, file.sha256]);
}
export function knownVoiceDuration(key: string) {
 const memory=values.get(key);if(memory)return memory;
 try{const n=Number(localStorage.getItem('employeeclient:voice-duration:'+key));if(Number.isFinite(n)&&n>0){values.set(key,n);return n;}}catch{}
 return 0;
}
export function rememberVoiceDuration(key: string, seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  values.delete(key); values.set(key, seconds);
  try{localStorage.setItem('employeeclient:voice-duration:'+key,String(seconds));}catch{}
  if (values.size > 400) values.delete(values.keys().next().value!);
}
const aborted = () => new DOMException('已取消', 'AbortError');
async function acquire(signal: AbortSignal) {
  if (signal.aborted) throw aborted();
  if (running < 2) { running++; return; }
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { const i = waiters.indexOf(wake); if (i >= 0) waiters.splice(i, 1); reject(aborted()); };
    const wake = () => { signal.removeEventListener('abort', cancel); resolve(); };
    waiters.push(wake); signal.addEventListener('abort', cancel, { once: true });
  });
}
function release() { const next = waiters.shift(); if (next) next(); else running--; }
export async function decodeVoiceDuration(bytes: ArrayBuffer): Promise<number> {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw new Error('录音大小无效');
  const context = new OfflineAudioContext(1, 1, 8000);
  const decoded = await context.decodeAudioData(bytes);
  if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('录音时长不可用');
  return decoded.duration;
}
export type VoiceDurationSource = {
  size: number;
  mime?: string;
  readPart: (start: number, end: number) => Promise<Blob>;
  duration?: () => Promise<number>;
};
export async function loadVoiceDuration(url: string, key: string, signal: AbortSignal, source?: VoiceDurationSource): Promise<number> {
  if (signal.aborted) throw aborted();
  const cached = knownVoiceDuration(key);
  if (cached) return cached;
  await acquire(signal);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 30000);
  try {
    if (signal.aborted) throw aborted();
    // Native cached files are not network URLs. Read through the attachment
    // port instead of fetching Capacitor's virtual URL a second time.
    if (source) {
      if (!source.size || source.size > MAX_BYTES) throw new Error('录音大小无效');
      let seconds = 0;
      // Android's extractor scans sample timestamps, including fragmented MP4.
      // It is cheaper and more reliable than decoding the entire cached file
      // in a WebView, regardless of the MIME spelling used by the recorder.
      if (source.duration) {
        try { seconds = await source.duration(); } catch { /* Decoder fallback below. */ }
      }
      if (!Number.isFinite(seconds) || seconds <= 0) {
        const parts: Blob[] = [];
        for (let start = 0; start < source.size; start += 524288) {
          if (controller.signal.aborted) throw aborted();
          parts.push(await source.readPart(start, Math.min(source.size, start + 524288)));
        }
        const bytes=new Uint8Array(await new Blob(parts).arrayBuffer());
        seconds=/\b(?:mp4|m4a)\b/i.test(source.mime||'')?fragmentedMp4Duration(bytes):0;
        if(!seconds&&source.duration)try{seconds=await source.duration();}catch{}
        if(!seconds)seconds=await decodeVoiceDuration(bytes.buffer);
      }
      if (controller.signal.aborted) throw aborted();
      rememberVoiceDuration(key, seconds);
      return seconds;
    }
    const response = await fetch(url, { signal: controller.signal, credentials: isNativeFileUrl(url)?'include':'omit', redirect: 'error' });
    if (!response.ok || Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new Error('录音读取失败');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('录音读取失败');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error('录音超过大小限制'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (controller.signal.aborted) throw aborted();
    const seconds = fragmentedMp4Duration(bytes)||await decodeVoiceDuration(bytes.buffer);
    if (controller.signal.aborted) throw aborted();
    rememberVoiceDuration(key, seconds);
    return seconds;
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', cancel); release();
  }
}

export function clearVoiceDurations(account:string){
 for(const key of [...values.keys()])try{if(JSON.parse(key)[0]===account)values.delete(key);}catch{}
 for(const key of Object.keys(localStorage))if(key.startsWith('employeeclient:voice-duration:'))try{if(JSON.parse(key.slice('employeeclient:voice-duration:'.length))[0]===account)localStorage.removeItem(key);}catch{}
}
