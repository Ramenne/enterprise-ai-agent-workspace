import {validMessageBadge,newerMessageBadge} from '@/domain/messageBadge.mjs';
import {conversationContentChanged} from '@/domain/conversationChange.mjs';
import {presentCatchUp,presentLive} from '@/platform/localNotify';
import { notifyChatWake, type ChatWake } from '@/platform/chatEvents';
// src/store/data.ts —— 【职责3 会话与同步缓存层】业务数据的响应式状态 + 增量同步引擎。
// 启动先用 IndexedDB 账号缓存渲染（带“最近同步时间”），再后台增量校验；断网只读缓存，不做离线业务写入。
// 通知同步口径（候选 v1.3 §二）：用单调 change_seq 做 after_version 增量；分页未完时持久化 next_cursor 续读，
//   整条链走完才推进 sync_version；按 notification.id 合并去重（含 hidden/read 等投影更新）；
//   服务端判定游标不可再用时丢弃进度重同步。同步结果区分“列表补齐”与“新到达”，后者才可能触发系统弹窗。
// 列表用全量刷新（规模 ≤10 人，足够）。
import { defineStore } from 'pinia';
import { ref, computed, watch, onScopeDispose } from 'vue';
import { me } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { isNewArrival, isCursorRestartHint, isFloatingEligible, ghostIdsToEvict } from '@/domain/notifyPolicy';
import * as db from '@/session/db';
import { personalDenied, denyPersonal, isPersonalRecord } from '@/session/scopeAccess';
import type { Task, Issue, Project, Notification, NotificationPage, MessageBadgeSnapshot, Announcement } from '@/api/types';
import {isRelevantNotice} from '@/domain/notificationAudience.mjs';

// 群消息有自己的聊天时间线；它们可以触发系统提醒，但不应混入“消息/公告”收件箱。
const isInboxNotification = (n: Notification, account='') => n.kind !== 'chat_message'&&isRelevantNotice(n,account);
// Retain group notifications for unread/read state; inbox projection still excludes them.
const visible = (n: Notification) => !n.hidden_at;

const SYNC_VERSION_KEY = 'notif_sync_version';
const CURSOR_KEY = 'notif_next_cursor';
/** 分页保护上限：200 条/页 × 60 页 = 1.2 万条，远超 ≤10 人公司量级；触发即视为服务端异常，断点续读而非死循环。 */
const PAGE_GUARD = 60;
type SyncHint = { kinds?: readonly string[]; announcementIds?: readonly string[] };


// 到达判定（isNewArrival）与游标失效判定（isCursorRestartHint）是纯决策逻辑，已抽到 @/domain/notifyPolicy
// （零运行时依赖，可被 dev/notifyPolicy.test.mjs 直接执行验证）；本文件只保留有副作用/环境依赖的部分：
// pinia 状态、IndexedDB 读写、ApiError 的 instanceof 收窄与分页调度。

export const useDataStore = defineStore('data', () => {
  const account = ref('');
  const chatRevision=ref(0),announcementRevision=ref(0);
  let accountEpoch = 0;
  const scopeRevision = ref(0);
  const personalBlocked = ref(false);
  const personalCleanupError = ref('');
  let personalPurge: Promise<void> = Promise.resolve();
  function captureAccountLease() {
    const a = account.value, epoch = accountEpoch;
    return { account: a, valid: () => !!a && a === account.value && epoch === accountEpoch };
  }
  function captureLease() {
    const a = account.value, epoch = accountEpoch, scope = scopeRevision.value;
    return { account: a, valid: () => !!a && a === account.value && epoch === accountEpoch && scope === scopeRevision.value };
  }
  const mainControl = ref(false);   // 由会话层在 bootstrap 时写入；所有同步路径共用，避免调用方漏传导致主控待审被空 /me/tasks 覆盖
  const tasks = ref<Task[]>([]);
  const companyIssues = ref<Issue[]>([]);
  const personalProjects = ref<Project[]>([]);
  const companyProjects = ref<{ id: string; name: string }[]>([]);
  const notifications = ref<Notification[]>([]);
  const announcements = ref<Announcement[]>([]);
  const unreadCount = ref(0);
  const messageBadge=ref<MessageBadgeSnapshot|null>(null);
  function acceptMessageBadge(a:string,value:unknown){
   if(a!==account.value||!validMessageBadge(value)||!newerMessageBadge(value,messageBadge.value))return;
   const incoming=value as MessageBadgeSnapshot,snapshot={count:incoming.count,version:incoming.version,computed_at:incoming.computed_at};
   messageBadge.value=snapshot;
   void db.withLease(()=>a===account.value).metaSet(a,'message_badge_v1',snapshot).catch(()=>{});
  }
  const lastSyncedAt = ref<number | null>(null);
  const syncing = ref(false);
  const syncError = ref('');

  // 详情：network-first，内存轻缓存（离线时回退列表缓存已在页面处理）

  // 到期退出悬浮层（不变量#24「到期只退出悬浮层，不删除列表」）：expires_at 是时间触发、服务端不改行、change_seq 不 bump，
  //   增量同步不会重发这条通知，缓存里的 persistent_float:true 快照会滞留到下次全量同步。故客户端按本地时间判定到期，
  //   与 notify.mjs publicNotification 的 persistent_float 到期子句（expires_at==null || expires_at>now）保持一致，不必等全量。
  //   只影响悬浮层；收件箱（inboxNotifications）仍保留到期公告作为历史。
  const floatClock = ref(Date.now());
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleExpiry() {
    clearTimeout(expiryTimer); floatClock.value = Date.now();
    const next = notifications.value.map(n => n.expires_at).filter((t): t is number => t != null && t > floatClock.value);
    if (next.length) expiryTimer = setTimeout(scheduleExpiry, Math.min(2147483647, Math.min(...next) - floatClock.value + 1));
  }
  watch(notifications, scheduleExpiry, { deep: true });
  onScopeDispose(() => clearTimeout(expiryTimer));
  const floatingNotices = computed(() => notifications.value.filter(n => isFloatingEligible(n, floatClock.value)));
  const inboxNotifications = computed(() => notifications.value.filter(n => !n.hidden_at && isInboxNotification(n,account.value)&&isRelevantNotice(n,account.value)));

  function setAccount(a: string) {
    accountEpoch++;
    if (account.value !== a) {
      personalCleanupError.value = '';
      tasks.value = []; companyIssues.value = []; personalProjects.value = []; companyProjects.value = [];
      notifications.value = []; announcements.value = []; unreadCount.value = 0; messageBadge.value=null; lastSyncedAt.value = null;
      }
    account.value = a;
    personalBlocked.value = !!a && personalDenied(a);
    notifInFlight = null; notifFollowup=null;listFlight=null;listPending=false;
    syncing.value = false; syncError.value = '';
  }
  function setMainControl(v: boolean) { mainControl.value = !!v; }
  function withoutDenied<T>(rows: T[]): T[] { return personalBlocked.value ? rows.filter(r => !isPersonalRecord(r as Record<string, unknown>)) : rows; }
  async function revokePersonal(): Promise<void> {
    const a = account.value; if (!a) return;
    if (!personalBlocked.value) { personalBlocked.value = true; scopeRevision.value++; }
    // Immediately invalidate all response/cache leases, but retain company state and account authentication.
    personalProjects.value = []; tasks.value = withoutDenied(tasks.value); notifications.value = withoutDenied(notifications.value);
    unreadCount.value = notifications.value.filter(n => !n.read_at && !n.hidden_at && isInboxNotification(n,account.value)).length;
    const errors: unknown[] = [];
    try { denyPersonal(a); } catch (e) { errors.push(e); }
    // Personal API denial blocks visibility and purges re-fetchable business snapshots.
    // Unsubmitted local drafts are user originals: keep them hidden until scope is confirmed
    // again, instead of deleting them on one potentially transient 403 during an app update.
    // A localStorage/quota failure must never skip the independent IndexedDB purge.
    personalPurge = personalPurge.catch(() => {}).then(() => db.clearPersonalScope(a));
    try { await personalPurge; } catch (e) { errors.push(e); }
    if (a === account.value) personalCleanupError.value = errors.length ? '私人缓存未完全清理；已隐藏，联网核验权限前不会恢复。请检查本机存储后重试。' : '';
  }

  /** 项目名解析（个人项目 + 公司项目选择目录）；解析不到回退短 ID，不猜。 */
  function projectName(id: string): string {
    const p = personalProjects.value.find(x => x.id === id) || companyProjects.value.find(x => x.id === id);
    return p ? p.name : (id ? id.slice(0, 10) : '');
  }

  /** 启动：从账号缓存水合（不触网），让界面先有内容。 */
  async function hydrateFromCache(a: string): Promise<void> {
    setAccount(a);const lease=captureLease();
    const [n,an,ls,badge]=await Promise.all([db.getAllByAccount<Notification>('notifications',a),cachedList<Announcement>('announcements',a),db.metaGet<number>(a,'notification_synced_at'),db.metaGet<MessageBadgeSnapshot>(a,'message_badge_v1')]);
    if(!lease.valid())return;
    tasks.value=[];companyIssues.value=[];personalProjects.value=[];
    if(badge)acceptMessageBadge(a,badge);
    notifications.value=n.filter(visible);announcements.value=an;lastSyncedAt.value=ls??null;
    unreadCount.value=notifications.value.filter(n=>!n.read_at&&isInboxNotification(n,account.value)).length;
  }

  // 单飞：同一时刻只允许一条通知分页链在跑。前台恢复、网络恢复、到达事件可能同时触发，
  // 并发跑两条链会各自推进 next_cursor / sync_version 而互相覆盖，造成重取或漏取。
  let notifInFlight: Promise<Notification[]> | null = null;
  let notifFollowup:Promise<Notification[]>|null=null;

  /** 通知增量同步：首次/强制=全量分页；否则用 change_seq 增量（含 hidden/read 撤销投影）。
   *  返回本次“新到达”的通知（按到达顺序）；空数组 = 只补齐了列表、无需弹窗。 */
  function syncNotifications(a: string, forceFull = false, wakeMode: ChatWake['mode'] = 'live',hints:SyncHint={}): Promise<Notification[]> {
    if (a !== account.value || !a) return Promise.resolve([]);
    const lease=captureLease();
    if(wakeMode!=='catchup'&&hints.kinds?.length&&hints.kinds.every(k=>['conversation_list','announcement_read','member_presence','member_avatar'].includes(k))) {
      if(hints.kinds.some(k=>k==='announcement_read'||k==='conversation_list'))notifyChatWake(a,'live',[],hints);return Promise.resolve([]);
    }
    const finish=(flight:Promise<Notification[]>)=>hints.kinds?.some(k=>k==='announcement_read'||k==='conversation_list')?flight.then(rows=>{if(lease.valid())notifyChatWake(a,'live',[],hints);return rows;}):flight;
    if (notifInFlight) {
      if(!notifFollowup){
        const current=notifInFlight;
        const queued=current.catch(()=>[]).then(()=>{if(notifFollowup===queued)notifFollowup=null;return lease.valid()?syncNotifications(a,forceFull,wakeMode,hints):[];});
        notifFollowup=queued;
      }
      return finish(notifFollowup);
    }
    syncing.value=true;
    const work = runNotificationSync(a, forceFull, wakeMode).then(rows=>{if(lease.valid())syncError.value='';return rows;}).catch(e=>{if(lease.valid())syncError.value=e instanceof ApiError?e.code:'network';throw e;}).finally(() => { if (notifInFlight === work) {notifInFlight = null;if(lease.valid())syncing.value=false;} });
    notifInFlight = work;
    return finish(notifInFlight);
  }

  async function runNotificationSync(a: string, forceFull: boolean, wakeMode: ChatWake['mode']): Promise<Notification[]> {
    const lease = captureLease(), cache = db.withLease(lease.valid);
    const before = new Map<string, Notification>();
    for (const n of await db.getAllByAccount<Notification>('notifications', a)) before.set(n.id, n);
    // 本机还没有任何通知缓存 = 首次建立（登录或显式清空后重同步）：用户正在看着屏幕，
    // 不把历史消息当作“新到达”，否则逐条重演历史弹窗（策划 §7：补取只补齐列表、不逐条重演离线期间声音）。
    const coldStart = (await db.metaGet<number>(a, SYNC_VERSION_KEY)) == null;

    const contentBefore=new Map(before);
    let afterVersion = forceFull ? null : await db.metaGet<number>(a, SYNC_VERSION_KEY);
    // 续读游标：上次分页被切后台/断网/进程结束打断时留下的位置。服务端 sync_version 只在最后一页返回，
    // 所以中途必须持久化 next_cursor，否则每次都从 after_version 重翻全部分页（v1.3 §二“不能仅保存首屏游标”）。
    let cursor = forceFull ? '' : ((await db.metaGet<string>(a, CURSOR_KEY)) || '');
    let delta = afterVersion != null;
    if (!delta) cursor = '';

    const arrived: Notification[] = [];
    const wakeRows: Notification[] = [];
    const seenIds = new Set<string>();   // 仅全量分页时填充：服务端当前返回的完整通知集合，用于走完后的 ghost 收敛
    let syncVersion: number | null = null;
    let guard = 0;

    for (;;) {
      if (!lease.valid()) return [];
      if (++guard > PAGE_GUARD) throw new ApiError('upstream_unavailable', 'sync_page_guard_exceeded', 503);
      let page: NotificationPage;
      try {
        page = await me.notifications(delta
          ? { after_version: afterVersion, cursor: cursor || undefined, limit: 200 }
          : { cursor: cursor || undefined, limit: 100 });
      } catch (e) {
        if (!lease.valid()) return [];
        if (delta && e instanceof ApiError && isCursorRestartHint(e.code, e.hint)) {
          // 快照变化(409) / after_version 越界 / 游标作用域不符 → 丢弃进度重新全量一次。
          // 已写入的记录按 id 幂等合并，不产生重复。
          delta = false; afterVersion = null; cursor = ''; seenIds.clear();
          await cache.metaRemove(a, SYNC_VERSION_KEY);
          await cache.metaRemove(a, CURSOR_KEY);
          continue;
        }
        throw e;   // 断网/超时/401 等：保留已写入记录与游标，下次从此处续读
      }

      // 先落记录、再推进游标：顺序颠倒会在中断时丢消息（与弹窗层“先调度成功再记去重”同一原则）。
      if(page.message_badge)acceptMessageBadge(a,page.message_badge);
      page.notifications = withoutDenied(page.notifications);
      if (!lease.valid()) return [];
      if (page.notifications.length) {
        await cache.putMany('notifications', a, page.notifications as unknown as Array<Record<string, unknown>>);
        if (!lease.valid()) return [];
        for (const n of page.notifications) {
          const previous = before.get(n.id);
          if (!previous || previous.update_version !== n.update_version || previous.version !== n.version) wakeRows.push(n);
        }
        if (!coldStart) for (const n of page.notifications) if (isNewArrival(before, n)) arrived.push(n);
        for (const n of page.notifications) before.set(n.id, n);
        if (!delta) for (const n of page.notifications) seenIds.add(n.id);   // 全量页：纳入服务端当前完整集合
      }
      syncVersion = page.sync_version;
      cursor = page.next_cursor || '';
      if (cursor) await cache.metaSet(a, CURSOR_KEY, cursor);
      if(page.has_more&&!cursor)throw new ApiError('upstream_unavailable','同步分页未完整返回',503);
      if (!page.has_more) break;
    }

    // 只有整条分页链走完（服务端给出非 null sync_version 且无待续游标）才推进持久版本号。
    if (syncVersion != null && !cursor) {
      await cache.metaSet(a, SYNC_VERSION_KEY, syncVersion);
      await cache.metaRemove(a, CURSOR_KEY);
      // 全量收敛（断联补取）：一次完整全量分页返回的就是服务端当前全部「未隐藏」通知（notify.mjs listFor 非 delta 只加 hidden_at IS NULL）。
      //   把本地「可见但本次全量未返回」的通知判为服务端已不存在（迁移/清理/换库产生的 ghost）并清除，使悬浮层与收件箱收敛到真相。
      //   只清可见项、保留隐藏墓碑：隐藏行由增量作撤销投影重发，若误删墓碑，日后该行再变更会被 isNewArrival 当成新到达误弹窗。
      //   仅在 !delta（确为完整全量、非增量）时执行；增量只返回变更行，seenIds 不完整，绝不可据此淘汰。
      if (!delta) {
        const cachedAll = await db.getAllByAccount<Notification>('notifications', a);
        for (const id of ghostIdsToEvict(cachedAll, seenIds)) await cache.removeById('notifications', a, id);
      }
    }
    const cached = await db.getAllByAccount<Notification>('notifications', a);
    if (!lease.valid()) return [];
    const candidates=wakeMode==='catchup'?wakeRows:arrived;
    if(candidates.length) {
      if(wakeMode==='catchup')await presentCatchUp(a,candidates).catch(()=>undefined);
      else for(const n of candidates)await presentLive(a,n).catch(()=>undefined);
    }
    notifications.value = withoutDenied(cached).filter(visible); unreadCount.value = notifications.value.filter(n => !n.read_at && isInboxNotification(n,account.value)).length;
    const contentRows=wakeRows.filter(n=>conversationContentChanged(contentBefore.get(n.id),n));
    if(contentRows.some(n=>n.kind==='chat_message'))chatRevision.value++;
    if(wakeRows.some(n=>n.kind==='announcement'))announcementRevision.value++;
    if(contentRows.length||wakeMode==='catchup')notifyChatWake(a,wakeMode,contentRows);
    const stamp=Date.now();await cache.metaSet(a,'notification_synced_at',stamp);if(lease.valid())lastSyncedAt.value=stamp;
    return arrived;
  }

  /** Current product lists; work/history live in native V8, never in old Task projections. */
  let listFlight: Promise<void> | null = null;
  let listPending = false;let listLoadedAccount='';
  function syncLists(a: string, changed = false): Promise<void> {
    if(!a||a!==account.value)return Promise.resolve();
    if(!changed&&listLoadedAccount===a)return Promise.resolve();
    if(listFlight){if(changed)listPending=true;return listFlight;}
    const lease=captureLease();
    const run=(async()=>{
      do {
        listPending=false;
        const result=await me.announcements();
        if(!lease.valid())return;
        announcements.value=result.announcements;listLoadedAccount=a;
        tasks.value=[];companyIssues.value=[];
        await db.withLease(lease.valid).metaSet(a,'list:announcements',result.announcements);
      }while(listPending&&lease.valid());
    })();
    const work=run.finally(()=>{if(listFlight===work)listFlight=null;});
    listFlight=work;return work;
  }

  // ---- 详情（network-first；仅临时网络故障允许当前会话回退）----
  async function cachedList<T>(store: db.StoreName, a: string): Promise<T[]> {
    const snapshot = await db.metaGet<T[]>(a, 'list:' + store);
    return snapshot ?? db.getAllByAccount<T>(store, a); // 旧缓存一次性兼容；成功同步后只认快照（包括空列表）
  }
  /** 服务端判定某通知已不存在（迁移／清理／换库等）时清除本地 ghost：从状态与缓存移除并校正未读计数。
   *  否则陈旧卡片会永远卡在悬浮层、每次「已阅读」都 404 回滚，用户消不掉（断联补取自愈的一环）。 */
  async function evictNotification(id: string): Promise<void> {
    const i = notifications.value.findIndex(x => x.id === id);
    if (i >= 0) {
      const wasUnread = isInboxNotification(notifications.value[i],account.value) && !notifications.value[i].read_at && !notifications.value[i].hidden_at;
      notifications.value.splice(i, 1);
      if (wasUnread) unreadCount.value = Math.max(0, unreadCount.value - 1);
    }
    if (account.value) await db.removeById('notifications', account.value, id).catch(() => undefined);
  }

  async function clearAccount(a: string): Promise<void> {
    if (account.value === a) setAccount('');
    await db.clearAccount(a);
  }

  return {
    account, mainControl, tasks, companyIssues, personalProjects, companyProjects, notifications, announcements, unreadCount, messageBadge, acceptMessageBadge,
    scopeRevision, personalBlocked, personalCleanupError, revokePersonal,
    lastSyncedAt, syncing, syncError, floatingNotices, inboxNotifications,
    setAccount, chatRevision, announcementRevision, captureLease, captureAccountLease, setMainControl, projectName, hydrateFromCache, syncNotifications, syncLists,
    clearAccount, evictNotification,
  };
});
