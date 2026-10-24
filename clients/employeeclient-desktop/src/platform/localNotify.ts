// src/platform/localNotify.ts —— 【职责4 平台适配层】Android 本地系统通知 + 弹窗去重。
// 依据：策划 v0.24 §零 Android 通知传输与补取方案（尤其 2/3/7/13 项）、§5.1 通知四级分类、§6.1/§6.2、
//        §7.3.1 Android 通知恢复与持久游标、§提供方接线要求（“Android 本地通知使用既定工作通知渠道”）。
//
// Android 使用唯一原生前台服务的事件连接接收通知；共享端不接受 Android 推送订阅，且只给 iPhone 排 Web Push。
// 本模块委托原生通知与持久去重，不另建并行供应商传输链。
//
// 行为：存活连接接收到消息 → 本地系统通知；补取批量到达 → 补全列表但不逐条重演离线期间历史声音（§零-7、§7.3.1）。
// 硬约束：
//  - 使用既定工作通知渠道 employeeclient_work（渠道 id 与服务端既有工作通知渠道名一致，避免同名渠道语义分裂）；
//  - 通知权限、渠道及声音设置允许时才发声，任何情况都不绕过系统权限/静音/勿扰（§6.2）；
//  - 弹窗去重独立持久化「已提示的 notification id + update_version」，补取/重试/重复连接不重复响铃，
//    但不抹掉合法的再次催促版本（§零-7、§零-13、§7.3.1）；
//  - 弹出通知不是已读：本模块不调用 read/ack/hide 等任何账号动作（§零-7、§十一-21、§十二-52）；
//  - 「普通记录」（本人内容自动生效、版本登记）只进收件箱、默认静默（§5.1 四级分类、§6.2）；
//  - 不用权限设置代替连接状态判断（§零-3）：权限只决定能否发声，不决定是否补取，缺权限也不丢消息。
import {presentPwaMessages} from './pwaMessageAlerts';
import { LocalNotifications } from '@capacitor/local-notifications';
import { NativeLive } from './liveTransport';
import type { LocalNotificationSchema } from '@capacitor/local-notifications';
import { isAndroidNative } from '@/session/installation';
import type { Notification } from '@/api/types';
import { isSilentRecord, numericId } from '@/domain/notifyPolicy';

/** 既定工作通知渠道（策划 v0.24 §提供方接线要求）。 */
export const CHANNEL_WORK = 'employeeclient_work';
/** 紧急催促渠道：Android 声音与悬浮级别是渠道属性、无法按条覆盖，故为「明显提示音」单列同族渠道（§5.1 四级分类：紧急催促额外标红置顶）。 */
export const CHANNEL_URGENT = 'employeeclient_work_urgent';
/** 补取静默渠道：补齐列表但不逐条重演离线期间声音（§零-7、§7.3.1）。 */
export const CHANNEL_CATCHUP = 'employeeclient_work_silent';

// 接收与恢复补取共用 NativeLive 的持久弹窗去重，不维护第二套网页提示日志。

// ==================== 权限与渠道 ====================
export type LocalNotifyPermission = 'granted' | 'denied' | 'prompt' | 'unknown';
let permissionCache: LocalNotifyPermission = 'unknown';

/** 只读检测，不弹系统授权框。非 Android 原生返回 denied（iPhone 由 sw.ts 的 Web Push 负责）。 */
export async function checkLocalNotifyPermission(): Promise<LocalNotifyPermission> {
  if (!isAndroidNative()) { permissionCache = 'denied'; return permissionCache; }
  try {
    const p = await LocalNotifications.checkPermissions();
    permissionCache = p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'prompt';
  } catch { permissionCache = 'unknown'; }
  return permissionCache;
}

/** 请求通知权限：只在用户主动入口调用，不做启动即弹。已被系统拒绝时不重复骚扰。 */
export async function requestLocalNotifyPermission(): Promise<boolean> {
  if (!isAndroidNative()) return false;
  try {
    let p = await LocalNotifications.checkPermissions();
    if (p.display !== 'granted' && p.display !== 'denied') p = await LocalNotifications.requestPermissions();
    permissionCache = p.display === 'granted' ? 'granted' : 'denied';
    return p.display === 'granted';
  } catch { permissionCache = 'unknown'; return false; }
}

// ==================== 本机提示声音开关 ====================
// 只影响 Android 本地系统通知走哪个渠道（有声 vs 静默），不修改云端记录、不代替系统权限；
// 系统静音／勿扰／渠道被关闭仍服从系统最高权限（策划 v0.24 §6.2）。iPhone 的 Web Push 声音由 iOS 系统通知设置决定，本开关不参与。
const SOUND_PREF_KEY = 'qn.pref.sound';

/** 本机提示声音是否开启（默认开）。读取失败时当作开启，宁可多提示一次也不静默掉真实待办。 */
export function soundEnabled(): boolean {
  try { return localStorage.getItem(SOUND_PREF_KEY) !== '0'; } catch { return true; }
}

export function setSoundEnabled(on: boolean): boolean {
  try { localStorage.setItem(SOUND_PREF_KEY, on ? '1' : '0'); } catch { return false; }
  if (isAndroidNative()) void NativeLive.setSound({ sound: on });
  return true;
}

let channelsReady = false;
/** 建渠道（Android 上同名渠道重复创建不会覆盖用户已调整的设置）。失败不阻断收件箱，下次调用重试。 */
export async function ensureChannels(): Promise<void> {
  if (!isAndroidNative() || channelsReady) return;
  try {
    // importance: 3=DEFAULT（无声，仅入通知栏）4=HIGH（悬浮+声音）5=MAX；visibility: 1=PUBLIC（锁屏可见内容）
    await LocalNotifications.createChannel({
      id: CHANNEL_WORK, name: '工作通知', description: '待处理事项与处理结果',
      sound: 'default', importance: 4, visibility: 1, vibration: true, lights: true,
    });
    await LocalNotifications.createChannel({
      id: CHANNEL_URGENT, name: '紧急催促', description: '员工明确催促主控审核的待审提醒',
      sound: 'default', importance: 5, visibility: 1, vibration: true, lights: true,
    });
    await LocalNotifications.createChannel({
      id: CHANNEL_CATCHUP, name: '补取消息（静默）', description: '断联或进程结束期间遗漏的消息：补齐列表，不重演历史声音',
      importance: 3, visibility: 1,
    });
    channelsReady = true;
  } catch { /* 渠道创建失败不阻断列表补齐；不置 channelsReady，下次重试 */ }
}

// ==================== 弹窗 ====================
export interface PresentResult {
  presented: number;          // 实际调度成功的条数
  skippedDeduped: number;     // 已提示过同一版本而跳过（不重复响铃）
  skippedSilent: number;      // 普通记录，按策划只进收件箱
  permission: LocalNotifyPermission;
}

const EMPTY: PresentResult = { presented: 0, skippedDeduped: 0, skippedSilent: 0, permission: 'unknown' };

/** 存活连接实时接收到的一条消息 → 本地系统通知（§零-2：进程与连接存活时实时触发）。 */
export async function presentLive(account: string, n: Notification): Promise<PresentResult> {
  return present(account, [n], false);
}

/** 四类补取时机批量到达 → 补全列表，但不逐条重演离线期间历史声音（§零-7、§7.3.1）。 */
export async function presentCatchUp(account: string, items: Notification[]): Promise<PresentResult> {
  return present(account, items, true);
}

async function present(account: string, items: Notification[], catchUp: boolean): Promise<PresentResult> {
  if(!items.length)return {...EMPTY};
  if(!isAndroidNative()){await presentPwaMessages(account,items,catchUp);return {...EMPTY};}
  const permission = await checkLocalNotifyPermission();
  if (permission !== 'granted') return { ...EMPTY, permission };
  await ensureChannels();
  // Native receiver and Vue catch-up share one persistent presentation journal.
  const candidates = items.filter(n => !isSilentRecord(n));
  const r = await NativeLive.present({ account, notifications: candidates, catchup: catchUp, sound: soundEnabled() });
  return { ...EMPTY, presented: r.presented, permission, skippedSilent: items.length - candidates.length };
}

// ==================== 本机自检 ====================
/**
 * 弹一条不写云端的本机自检通知（策划 v0.24 §零-11 实机验收需要区分“权限／声音不允许”与“根本没收到”）。
 * 只证明本机权限、渠道与声音链路可用，不代表服务端已投递任何业务消息，也不写入弹窗去重日志。
 * 返回真实结果；非 Android 原生不弹（iPhone 由 Web Push 自行验证），并如实告知原因。
 */
export async function selfTestNotify(): Promise<{ presented: boolean; reason: string }> {
  if (!isAndroidNative()) return { presented: false, reason: '本机自检只对 Android 本地系统通知有效；iPhone 请使用系统推送实际验收' };
  const permission = await checkLocalNotifyPermission();
  if (permission !== 'granted') return { presented: false, reason: '系统通知权限未开启（当前：' + permission + '）' };
  await ensureChannels();
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id: numericId('qn-selftest'), title: '员工客户端 · 本机通知自检',
        body: '看到这条说明本机权限与通知渠道可用。它不来自云端，也不计入任何业务消息。',
        channelId: soundEnabled() ? CHANNEL_WORK : CHANNEL_CATCHUP, group: 'qn-work',
      }],
    });
    return { presented: true, reason: soundEnabled() ? '已按有声渠道弹出' : '已按静默渠道弹出（本机提示声音已关）' };
  } catch (e) {
    return { presented: false, reason: '系统调度失败：' + (e instanceof Error ? e.message : String(e)) };
  }
}

// ==================== 点击深链 ====================
/** 点击本地通知后路由所需的最小服务端事实（全部来自调度时写入的 extra）。 */
export interface LocalNotifyTarget {
  id: string; kind: string; object_type: string; object_id: string; deep_link: string;
  project_id?:string;snapshot?:Record<string,unknown>;
}

/**
 * 本地通知点击 → 深链。返回清理函数；非 Android 原生为 no-op（iPhone 走 sw.ts 的 notificationclick）。
 * 点开详情不自动标记已读（§零-7、§十一-21、§十二-52），本模块不做任何账号动作。
 */
export function onLocalNotificationOpened(cb: (t: LocalNotifyTarget) => void): () => void {
  if (!isAndroidNative()) return () => { /* 非 Android 原生：无本地通知点击 */ };
  let disposed = false;
  let handle: { remove: () => void } | null = null;
  let nativeHandle: { remove: () => void } | null = null;
  void NativeLive.addListener('opened', n => cb({ id: String(n.id || ''), kind: String(n.kind || ''),
    object_type: String(n.object_type || ''), object_id: String(n.object_id || ''), deep_link: String(n.deep_link || ''),project_id:typeof n.project_id==='string'?n.project_id:undefined,snapshot:n.snapshot&&typeof n.snapshot==='object'&&!Array.isArray(n.snapshot)?n.snapshot as Record<string,unknown>:undefined }))
    .then(h => { nativeHandle = h; if (disposed) void h.remove(); });
  const fire = (a: { notification?: LocalNotificationSchema }): void => {
    const x = (a?.notification?.extra || {}) as Record<string, unknown>;
    const t: LocalNotifyTarget = {
      id: String(x.qn_id || ''), kind: String(x.qn_kind || ''),
      object_type: String(x.qn_object_type || ''), object_id: String(x.qn_object_id || ''),
      deep_link: String(x.qn_deep_link || ''),
      project_id:typeof x.qn_project_id==='string'?x.qn_project_id:undefined,snapshot:x.qn_snapshot&&typeof x.qn_snapshot==='object'&&!Array.isArray(x.qn_snapshot)?x.qn_snapshot as Record<string,unknown>:undefined,
    };
    if (t.id || t.object_id || t.deep_link) cb(t);
  };
  LocalNotifications.addListener('localNotificationActionPerformed', fire)
    .then(h => { handle = h; if (disposed) { try { void h.remove(); } catch { /* 忽略 */ } } })
    .catch(() => { /* 非原生或插件缺失 */ });
  return () => { disposed = true; if (handle) void handle.remove(); if (nativeHandle) void nativeHandle.remove(); };
}
