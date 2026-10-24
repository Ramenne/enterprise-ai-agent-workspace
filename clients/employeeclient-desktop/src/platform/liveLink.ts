import {createRecoveryGate} from './recoveryGate.mjs';
// Persistent event connection + serialized catch-up. No timer queries business messages.
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { ApiError, isOnline } from '@/api/client';
import { isAndroidNative } from '@/session/installation';
import { connectStream, NativeLive } from './liveTransport';
export type LiveLinkState = 'idle' | 'live' | 'backoff' | 'paused' | 'stopped';
export interface LiveLinkSnapshot {
  connected?: boolean;
  state: LiveLinkState; foreground: boolean; networkUp: boolean;
  lastTickAt: number | null; lastDetail: string; failures: number; rebuiltCount: number;
}
export interface LiveSyncHint {
  /** Notification kinds affected by the server change signal, when supplied. */
  kinds?: string[];
  /** Announcement ids included in an announcement-reply notification. */
  announcementIds?: string[];
  catchup?: boolean;
  conversationPeers?:string[];
  groupFilesChanged?:boolean;
}
export interface LiveLinkHooks {
  account: string; shouldRun: () => boolean;
  onTick: (mode: 'live' | 'catchup', hint?: LiveSyncHint) => Promise<void>;
  onWake?: () => void;
  onBadge?: (value:unknown)=>void;
  onAuthLost?: (e: unknown) => void;
  onNetworkChange?: (up: boolean) => void;
  onStateChange?: (s: LiveLinkSnapshot) => void;
}
let snapshot: LiveLinkSnapshot = { state: 'stopped', foreground: true, networkUp: true,
  lastTickAt: null, lastDetail: '', failures: 0, rebuiltCount: 0 };
let hooks: LiveLinkHooks | null = null;
let epoch = 0;
let controller: AbortController | null = null;
const transportRecovery=createRecoveryGate({wake:()=>connect(epoch)});
const syncRecovery=createRecoveryGate({wake:()=>requestSync(pending||'catchup',epoch,pendingHint)});
let listeners: Array<{ remove: () => Promise<void> }> = [];
let pending: 'live' | 'catchup' | null = null;
let pendingHint: LiveSyncHint | undefined;
let syncFlight: Promise<void> | null = null;
let socketUp = false, authorityPending = false;
export const liveLinkSnapshot = (): LiveLinkSnapshot => ({ ...snapshot,connected:socketUp });
export const liveLinkState = () => snapshot.state;
function show(state: LiveLinkState, text: string) {
  snapshot.state = state; snapshot.lastDetail = text;
  hooks?.onStateChange?.(liveLinkSnapshot());
}
function authLost(e: unknown, n: number) {
  if (n !== epoch || authorityPending) return;
  authorityPending=true;pending=null;pendingHint=undefined;
  const h = hooks;controller?.abort();controller=null;transportRecovery.cancel();syncRecovery.cancel();socketUp=false;
  show('backoff','正在核对连接身份');h?.onAuthLost?.(e);
}
function mergeHint(a: LiveSyncHint | undefined, b: LiveSyncHint | undefined): LiveSyncHint | undefined {
  if (!a && !b) return undefined;
  const kinds = [...new Set([...(a?.kinds || []), ...(b?.kinds || [])].filter(Boolean))];
  const announcementIds = [...new Set([...(a?.announcementIds || []), ...(b?.announcementIds || [])].filter(Boolean))];
  return { ...(a || {}), ...(b || {}), ...(kinds.length ? { kinds } : {}), ...(announcementIds.length ? { announcementIds } : {}), conversationPeers:[...new Set([...(a?.conversationPeers||[]),...(b?.conversationPeers||[])])],groupFilesChanged:a?.groupFilesChanged===true||b?.groupFilesChanged===true };
}
function requestSync(mode: 'live' | 'catchup', n = epoch, hint?: LiveSyncHint) {
  if (n !== epoch || !hooks || authorityPending) return;
  // A reconnect/catch-up must win over a queued live tick; otherwise a brief
  // foreground transition can leave the cursor repair behind a live refresh.
  pending = mode === 'catchup' || pending === 'catchup' ? 'catchup' : 'live';
  pendingHint = mergeHint(pendingHint, { ...hint, ...(mode === 'catchup' ? { catchup: true } : {}) });
  // New events merge above but cannot shorten a failed sync backoff.
  if (syncFlight || !syncRecovery.ready()) return;
  const h = hooks;
  const work = (async () => {
    while (pending && n === epoch && h.shouldRun()) {
      const next = pending; const nextHint = pendingHint; pending = null; pendingHint = undefined;
      try {
        await h.onTick(next, nextHint);
        if (n !== epoch) return;
        snapshot.lastTickAt = Date.now(); snapshot.failures = 0;syncRecovery.completed();
        if (socketUp) show('live', '持续连接正常，数据已同步');
      } catch (e) {
        if (n !== epoch) return;
        if (e instanceof ApiError && (e.needsAuth || e.status === 403 || e.code === 'device_invalid')) { authLost(e, n); return; }
        pending = next === 'catchup' || pending === 'catchup' ? 'catchup' : 'live'; pendingHint = mergeHint(pendingHint, nextHint); snapshot.failures++;
        show('backoff', '同步暂时失败，自动恢复中');
        syncRecovery.failed();
        return;
      }
    }
  })();
  syncFlight = work;
  void work.finally(() => {
    if (syncFlight === work) syncFlight = null;
    if (n !== epoch && hooks && pending) requestSync(pending, epoch, pendingHint);
  });
}
function connect(n = epoch) {
  if (n !== epoch || authorityPending || !hooks?.shouldRun()) return;
  if(!snapshot.networkUp||controller&&!controller.signal.aborted||!transportRecovery.ready())return;
  controller?.abort();socketUp=false;
  const h = hooks, ctl = new AbortController(); controller = ctl;let readySeen=false;
  show('idle', '正在建立持续连接');
  void connectStream(h.account, String(n), ctl.signal, e => {
    if (n !== epoch || ctl.signal.aborted) return;
    if(e.data?.message_badge)h.onBadge?.(e.data.message_badge);
    if (e.type === 'ready') {
      socketUp=true;transportRecovery.completed();const firstReady=!readySeen;readySeen=true;
      if(e.data?.resumed===true){show('live','持续连接正常');
        // The native cursor covers notification delivery, not this new UI's stores.
        if(firstReady){h.onWake?.();requestSync('catchup',n,{catchup:true});}return;}
      snapshot.rebuiltCount++; show('live', '持续连接已建立，正在补齐');
      h.onWake?.();
      // This service follows ready with its cursor-backed catch-up frame.
      // Avoid a second recovery fetch before that frame arrives.
      if(e.data?.catchup!==true)requestSync('catchup', n, { catchup: true });
    } else if (e.type === 'change') {
      const data = e.data || {};
      const kinds = Array.isArray(data.kinds) ? data.kinds.filter((x): x is string => typeof x === 'string')
        : typeof data.kind === 'string' ? [data.kind] : [];
      const announcementIds = Array.isArray(data.announcement_ids) ? data.announcement_ids.filter((x): x is string => typeof x === 'string')
        : typeof data.announcement_id === 'string' ? [data.announcement_id] : [];
      requestSync(data.catchup === true ? 'catchup' : 'live', n, { kinds, announcementIds, catchup: data.catchup === true,conversationPeers:Array.isArray(data.conversation_peers)?data.conversation_peers.filter((x):x is string=>typeof x==='string'):undefined,groupFilesChanged:typeof data.group_files_changed==='boolean'?data.group_files_changed:undefined });
    }
    else if (e.type === 'reset') { h.onWake?.();
      // This service follows ready with its cursor-backed catch-up frame.
      // Avoid a second recovery fetch before that frame arrives.
      if(e.data?.catchup!==true)requestSync('catchup', n, { catchup: true }); }
    else if (e.type === 'auth') authLost(new ApiError((e.data?.status||e.status)===403?'forbidden_scope':'unauthenticated', '连接资格失效', Number(e.data?.status||e.status)||401), n);
    else if (e.type === 'error') { socketUp = false; show('backoff', '服务暂时不可用，自动恢复中'); }
    else if (e.type === 'backoff') { socketUp = false; snapshot.failures++; show('backoff', '连接已断开，原生模块正在自动重连'); }
  }).catch(e => {
    if (n !== epoch || ctl.signal.aborted) return;
    if (e instanceof ApiError && (e.needsAuth || e.status === 403 || e.code === 'device_invalid')) { authLost(e, n); return; }
    if(controller===ctl)controller=null;socketUp=false;snapshot.failures++;show('backoff','连接已断开，自动重连中');
    transportRecovery.failed();
  });
}
async function bind(n: number) {
  const add = async (p: Promise<{ remove: () => Promise<void> }>) => {
    try { const l = await p; if (n !== epoch) await l.remove(); else listeners.push(l); } catch { /* Web fallback supplied by plugins */ }
  };
  await add(App.addListener('resume', () => {
    if (n !== epoch) return;
    snapshot.foreground = true; pokeLiveLink();
  }));
  await add(App.addListener('pause', () => { if (n === epoch) snapshot.foreground = false; }));
  await add(Network.addListener('networkStatusChange', s => {
    if (n !== epoch) return;
    snapshot.networkUp = s.connected; hooks?.onNetworkChange?.(s.connected);
    if (s.connected) pokeLiveLink();
    else {controller?.abort();controller=null;socketUp=false;show('paused','网络不可用，恢复后自动连接');}
  }));
}
export function startLiveLink(h: LiveLinkHooks, _opts: { alreadySynced?: boolean } = {}) {
  stopLiveLink('重建通知连接', false); authorityPending=false;hooks = h;
  snapshot = { state: 'idle', foreground: true, networkUp: isOnline(), lastTickAt: null,
    lastDetail: '', failures: 0, rebuiltCount: 0 };
  const n = epoch; void bind(n); connect(n);
}
export function stopLiveLink(detail = '已停止', stopNative = true) {
  epoch++; controller?.abort(); controller = null; transportRecovery.cancel();syncRecovery.cancel();
  if (stopNative && isAndroidNative()) void NativeLive.stop().catch(() => undefined);
  for (const l of listeners) void l.remove(); listeners = [];
  pending = null; pendingHint = undefined; socketUp = false;authorityPending=false;
  // Keep the old sync flight occupied until it finishes, so new sessions cannot race it.
  show('stopped', detail); hooks = null;
}
export function pokeLiveLink() {
  if (!hooks || authorityPending || snapshot.state === 'stopped') return;
  hooks.onWake?.();
  requestSync('catchup');
  if (isAndroidNative()) void NativeLive.resume().catch(() => connect());
  else if (!socketUp) connect();
}

/** Manual recovery joins the same cursor-backed event flight; never resets caches/cursors. */
export async function recoverLiveSync(){
 if(!hooks||!hooks.shouldRun())throw Error('连接尚未建立，请重试连接');
 if(!isOnline())throw Error('网络不可用，恢复后会自动同步');
 const n=epoch;pokeLiveLink();const work=syncFlight;if(work)await work;
 if(n!==epoch)throw Error('连接身份已变化');
 if(snapshot.failures)throw Error('同步暂未完成，正在自动恢复');
}

/** Called only after confirming the same member identity; reopen a rejected transport, not its stores. */
export function restartVerifiedTransport(){if(hooks?.shouldRun()){authorityPending=false;connect();}}
