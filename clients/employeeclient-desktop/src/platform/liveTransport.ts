// Same native HttpOnly session on both platforms; no qn1 token or cookie sent through JavaScript.
import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { captureApiLease, ApiError } from '@/api/client';
import { servicePath } from '@/api/runtime';
import {metaGet} from '@/session/db';
import { isAndroidNative } from '@/session/installation';
let renewalAccount='',renewalAt=0;
const RENEW_INTERVAL_MS=30*60*1000;
export function noteVerifiedTransportIdentity(account:string){renewalAccount=account;renewalAt=Date.now();}
export type StreamEvent = { type: string; data?: Record<string, unknown>; status?: number; generation?: string };
export const NativeLive = registerPlugin<{
  start(o: { url: string; account: string; generation: string; sound: boolean }): Promise<void>;
  stop(): Promise<void>; resume(): Promise<void>;
  present(o: { account: string; notifications: unknown[]; catchup: boolean; sound: boolean }): Promise<{ presented: number }>;
  setSound(o: { sound: boolean }): Promise<void>;
  addListener(name: string, fn: (e: StreamEvent & Record<string, unknown>) => void): Promise<PluginListenerHandle>;
}>('EmployeeClientLive');
export async function connectStream(account: string, generation: string, signal: AbortSignal,
  receive: (e: StreamEvent) => void): Promise<void> {
  let url = new URL(servicePath('/business/v1/events'), window.location.href).href;
  const lease = captureApiLease();
  if (!lease.valid() || lease.account!==account) throw new ApiError('unauthenticated', '登录已失效', 401);
  if (signal.aborted) return;
  if (isAndroidNative()) {
    let handle: PluginListenerHandle | undefined;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { void handle?.remove(); resolve(); };
      signal.addEventListener('abort', abort, { once: true });
      void (async () => {
        try {
          handle = await NativeLive.addListener('stream', e => {
            if (!signal.aborted && e.generation === generation) receive(e);
          });
          if (signal.aborted) { await handle.remove(); resolve(); return; }
          await NativeLive.start({ url, account, generation, sound: localStorage.getItem('qn.pref.sound') !== '0' });
          if (signal.aborted) { await handle.remove(); resolve(); }
        } catch (e) { signal.removeEventListener('abort', abort); void handle?.remove(); reject(e); }
      })();
    });
    return;
  }
  const cursor=await metaGet<number>(account,'notif_sync_version');
  if(!lease.valid()||signal.aborted)return;
  if(Number.isSafeInteger(cursor)&&cursor!>=0)url+='?after_version='+cursor;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => { clearTimeout(timer); timer = setTimeout(cancel, 45000); };
  touch();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const renewSession=async()=>{
    if(renewalAccount===account&&Date.now()-renewalAt<RENEW_INTERVAL_MS)return;
    const sessionSignal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
    const renewed=await fetch(servicePath('/native/session'),{credentials:'include',cache:'no-store',signal:sessionSignal});
    sessionSignal.throwIfAborted();
    if(!renewed.ok)throw new ApiError(renewed.status===401?'unauthenticated':'upstream_unavailable','连接会话续期失败',renewed.status);
    const identity=await renewed.json();
    sessionSignal.throwIfAborted();
    if(!lease.valid()||identity.identity?.actor_id!==account)throw new ApiError('unauthenticated','连接会话身份已改变',401);
    renewalAccount=account;renewalAt=Date.now();
  };
  let renewalFlight:Promise<void>|null=null,renewalRetryAt=0;
  const maintainSession=()=>{
    if(renewalFlight||controller.signal.aborted||Date.now()<renewalRetryAt)return;
    renewalFlight=renewSession().catch(error=>{
      if(controller.signal.aborted||!lease.valid())return;
      if(error instanceof ApiError&&(error.needsAuth||error.status===403)){
        receive({type:'auth',data:{status:error.status},status:error.status});controller.abort();
      }else renewalRetryAt=Date.now()+60000;
    }).finally(()=>{renewalFlight=null;});
  };
  try {
    await renewSession();
    controller.signal.throwIfAborted();
    const res = await fetch(url, {credentials:'include',cache:'no-store',headers:{Accept:'text/event-stream'},signal:controller.signal});
    controller.signal.throwIfAborted();
    if (!res.ok) throw new ApiError(res.status === 401 ? 'unauthenticated' : 'upstream_unavailable', '持续连接建立失败', res.status);
    if (!res.headers.get('content-type')?.includes('text/event-stream') || !res.body) throw new Error('持续连接响应格式不正确');
    reader = res.body.getReader();
    const decoder = new TextDecoder(); let buffer = '',identityVerified=false;
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      controller.signal.throwIfAborted();
      if(!lease.valid())throw new ApiError('unauthenticated','登录状态已改变',401);
      if (done) throw new Error('持续连接已断开');
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 1024 * 1024) throw new Error('持续连接帧过大');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        controller.signal.throwIfAborted();
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const type = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
        if(type&&data&&['ready','ping','change','reset','auth','error'].includes(type)){const value=JSON.parse(data);if(type==='ready'){if(value.actor_id!==account)throw new ApiError('unauthenticated','通知连接身份不一致',401);identityVerified=true;}if(!identityVerified)throw Error('通知连接尚未确认身份');touch();if(type==='ready'||type==='ping')maintainSession();receive({type,data:value});}
      }
    }
  } finally {
    clearTimeout(timer!); signal.removeEventListener('abort', cancel);
    controller.abort(); await reader?.cancel().catch(() => undefined);
  }
}
