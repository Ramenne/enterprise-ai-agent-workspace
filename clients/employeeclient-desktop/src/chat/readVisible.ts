import {captureApiLease} from '@/api/client';
import {useRoute} from 'vue-router';
import { App } from '@capacitor/app';
import { isAndroidNative } from '@/session/installation';
import { watch, onBeforeUnmount, onActivated, onDeactivated, type Ref } from 'vue';
import { useDataStore } from '@/store/data';
import { actOnNotification } from '@/store/actions';
import {isWorkNotice,isAnnouncementNotice} from '@/domain/noticeChannel.mjs';
import type { Notification } from '@/api/types';

type ReadSurface = {
  selector: string;
  elementId: (element: HTMLElement) => string | undefined;
  notificationId: (note: Notification) => string | undefined;
  root: (element: HTMLElement) => Element | null;
  afterRead?: () => Promise<unknown>;
  partialRead?: boolean;
  eligible?: (note: Notification) => boolean;
};
/** Shared visible-read queue. Visibility is not acknowledgment or business completion. */
function useVisibleReads(stream: Ref<HTMLElement | null>, owner: Ref<string>, surface: ReadSurface) {
  const data = useDataStore();
  const visible = new Set<string>(), observed = new Set<Element>();
  const attempts = new Map<string, number>(), retryAt = new Map<string,number>(), inFlight = new Set<string>();
  let observer: IntersectionObserver | undefined, mutations: MutationObserver | undefined;
  let disposed = false, active = true, generation = 0;
  let retryTimer:ReturnType<typeof setTimeout>|undefined,surfaceRetryAt=0;
  function scheduleRetry(){
    clearTimeout(retryTimer);retryTimer=undefined;
    if(disposed||!active||!retryAt.size&&!surfaceRetryAt)return;
    const soonest=Math.min(...retryAt.values(),surfaceRetryAt||Infinity);
    retryTimer=setTimeout(()=>{retryTimer=undefined;void flush();},Math.max(50,soonest-Date.now()));
  }
  // Android Activity state is authoritative; WebView document visibility alone
  // must not mark background arrivals read and cancel their system notification.
  let nativeForeground = !isAndroidNative(), lifecycleVersion = 0;
  const nativeListeners:Array<{remove:()=>Promise<void>}> = [];
  if(isAndroidNative()){
    const bind = async (name:'pause'|'resume', foreground:boolean)=>{
      try{const changed=()=>{lifecycleVersion++;nativeForeground=foreground;if(foreground)void flush();};
        const listener=name==='pause'?await App.addListener('pause',changed):await App.addListener('resume',changed);
        if(disposed)await listener.remove();else nativeListeners.push(listener);
      }catch{/* No confirmed foreground means no automatic read. */}
    };
    void (async()=>{await Promise.all([bind('pause',false),bind('resume',true)]);
      const version=lifecycleVersion;try{const state=await App.getState();if(!disposed&&version===lifecycleVersion){nativeForeground=state.isActive;void flush();}}catch{}
    })();
  }
  function chatVisibleNow(id: string) {
    const host = stream.value;
    if (!host?.isConnected) return false;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const right = left + (viewport?.width || window.innerWidth), bottom = top + (viewport?.height || window.innerHeight);
    const root = host.getBoundingClientRect();
    for (const element of observed) {
      if (surface.elementId(element as HTMLElement) !== id || !element.isConnected || !host.contains(element)) continue;
      const rect = element.getBoundingClientRect();
      const x1 = Math.max(left, root.left, rect.left), x2 = Math.min(right, root.right, rect.right);
      const y1 = Math.max(top, root.top, rect.top), y2 = Math.min(bottom, root.bottom, rect.bottom);
      if (x2 <= x1 || y2 <= y1 || !element.getClientRects().length) continue;
      // Re-check the current painted surface: IO delivery can lag scrolling,
      // keyboard resize, a conversation switch or a dialog covering the stream.
      for (const [x,y] of [[(x1+x2)/2,(y1+y2)/2],[x1+.5,y1+.5],[x2-.5,y2-.5]]) {
        const hit = document.elementFromPoint(x,y);
        if (hit && element.contains(hit)) return true;
      }
    }
    return false;
  }
  async function flush() {
    if (captureApiLease().networkReady?.() === false) return;
    if (disposed || !active || !nativeForeground || document.visibilityState !== 'visible' || !owner.value || data.account !== owner.value) return;
    surfaceRetryAt=0;
    const currentGeneration = generation;
    for(const key of retryAt.keys())if(!data.notifications.some(n=>n.id===key&&!n.read_at&&!n.acked_at&&!n.hidden_at))retryAt.delete(key);
    for(const [key,time] of retryAt)if(time<=Date.now())retryAt.delete(key);
    for (const n of data.notifications) {
      if (inFlight.size >= 2) break;
      const id = surface.notificationId(n);
      if (!id || surface.eligible && !surface.eligible(n) || n.read_at || n.acked_at || n.hidden_at || !visible.has(id) || inFlight.has(n.id) || (retryAt.get(n.id)||0)>Date.now()) continue;
      if(surface.partialRead&&!chatVisibleNow(id)){surfaceRetryAt=Date.now()+500;continue;}
      const key = n.id;retryAt.delete(key);attempts.set(key, (attempts.get(key) || 0) + 1); inFlight.add(key);
      void actOnNotification(n, 'read', {}, { quiet: true }).then(async result => {
        if(currentGeneration!==generation||disposed||owner.value!==data.account)return;
        if(result===false)retryAt.set(key,Date.now()+Math.min(60000,2000*2**Math.min((attempts.get(key)||1)-1,5)));
        else {retryAt.delete(key);attempts.delete(key);if(result===true)await surface.afterRead?.();}
      }).finally(() => {
        if (currentGeneration !== generation || disposed) return;
        inFlight.delete(key);
        // Drain other visible notes; failed writes wait for bounded backoff, not permanent exhaustion.
        void flush();scheduleRetry();
      });
    }
    scheduleRetry();
  }
  function scan() {
    const current = new Set(stream.value?.querySelectorAll(surface.selector) || []);
    for (const element of observed) if (!current.has(element)) { observer?.unobserve(element); observed.delete(element); visible.delete(surface.elementId(element as HTMLElement) || ''); }
    for (const element of current) if (!observed.has(element)) { observed.add(element); observer?.observe(element); }
  }
  function observe(element: HTMLElement | null) {
    generation++;clearTimeout(retryTimer);retryTimer=undefined;retryAt.clear();surfaceRetryAt=0;observer?.disconnect(); mutations?.disconnect(); observed.clear(); visible.clear(); attempts.clear(); inFlight.clear();
    if (!element || !active) return;
    const observedGeneration = generation;
    observer = new IntersectionObserver(entries => {
      if (observedGeneration !== generation || disposed || !active) return;
      for (const entry of entries) {
        const id = surface.elementId(entry.target as HTMLElement);
        if (!id) continue;
        if (entry.isIntersecting && (surface.partialRead ? entry.intersectionRatio > 0 : entry.intersectionRatio >= .5)) visible.add(id); else visible.delete(id);
      }
      void flush();
    }, { root: surface.root(element), threshold: surface.partialRead ? [0, Number.EPSILON] : [.5] });
    mutations = new MutationObserver(scan); mutations.observe(element, { childList: true, subtree: true }); scan();
  }
  const stop = watch([stream, owner], ([element]) => observe(element), { immediate: true, flush: 'post' });
  onDeactivated(() => { active = false; observe(null); });
  onActivated(() => { active = true; observe(stream.value); });
  const stopNotes = watch(() => String(captureApiLease().networkReady?.() !== false) + ':' + data.account + ':' + data.notifications.map(n => `${n.id}:${n.read_at}:${n.acked_at}:${n.hidden_at}`).join('|'), () => void flush());
  const wake = () => {for(const [id,time] of retryAt)if(time<=Date.now())retryAt.delete(id);void flush();}; document.addEventListener('visibilitychange', wake);
  onBeforeUnmount(() => { disposed = true;clearTimeout(retryTimer); for(const listener of nativeListeners)void listener.remove(); generation++; stop(); stopNotes(); observer?.disconnect(); mutations?.disconnect(); document.removeEventListener('visibilitychange', wake); });
}

/** Only visible group messages, without marking unrelated work notifications. */
export function useVisibleChatReads(stream: Ref<HTMLElement | null>, owner: Ref<string>) {
  const route = useRoute();
  useVisibleReads(stream, owner, {
    selector: '[data-message-id]', elementId: el => el.dataset.messageId,
    notificationId: note => note.kind === 'chat_message' ? note.object_id : undefined,
    root: el => el, partialRead: true,
    eligible: note => route.name === 'chat' && (note.snapshot?.conversation_peer || '') === (typeof route.query.peer === 'string' ? route.query.peer : ''),
  });
}
/** Work cards share the queue; the browser viewport clips the actual scrolling ancestors. */
export function useVisibleNotificationReads(list: Ref<HTMLElement | null>, owner: Ref<string>) {
  useVisibleReads(list, owner, {
    selector: '[data-notification-id]', elementId: el => el.dataset.notificationId,
    notificationId: note => isWorkNotice(note) ? note.id : undefined,
    root: () => null,
  });
}

/** A successful, visible announcement body is the read surface, not a stale list card. */
export function useVisibleAnnouncementReads(body: Ref<HTMLElement | null>, owner: Ref<string>, afterRead: () => Promise<unknown>) {
  useVisibleReads(body, owner, {
    selector: '[data-announcement-id]', elementId: el => el.dataset.announcementId,
    notificationId: note => isAnnouncementNotice(note) ? (note.kind==='announcement' ? note.object_id : note.snapshot?.announcement_id) as string : undefined,
    root: () => null, afterRead,
  });
}
