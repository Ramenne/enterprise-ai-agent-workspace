import {isWorkNotice} from '@/domain/noticeChannel.mjs';
import {readNotificationBatch} from '@/domain/readNotifications.mjs';
// src/store/actions.ts —— 业务写动作的统一入口（职责1/2 边界）：幂等键、乐观更新、失败回滚与再同步只写一次。
// 客户端只消费服务端结果：不猜收件人、不改任务状态、不伪造审核结论；动作可行性以对象 allowed_actions 为准。
import { me } from '@/api/endpoints';
import { putMany } from '@/session/db';
import { newIdempotencyKey, ApiError, withRetry } from '@/api/client';
import { useDataStore } from '@/store/data';
import { useUiStore } from '@/store/ui';
import type { Notification } from '@/api/types';

const data = () => useDataStore();
const ui = () => useUiStore();

/** 通知账号级动作：read/ack/hide/pin/snooze——只改通知投影，绝不触碰 Task/Review/Issue。 */
export async function actOnNotification(
  n: Notification | Pick<Notification,'id'|'kind'>,
  action: 'read' | 'ack' | 'hide' | 'pin',
  body: { until?: number; off?: boolean } = {},
  options:{quiet?:boolean}={},
): Promise<boolean | 'gone'> {
  const store = data(), lease = store.captureLease(),feedback=ui().captureFeedback();
  if (!lease.valid()) return false;
  let before: Notification | undefined;
  let optimistic: Notification | undefined;
  let unreadDelta = 0;
  // 乐观更新：立即退悬浮/标记，随后后台增量校正
  const idx = data().notifications.findIndex(x => x.id === n.id);
  if (idx >= 0) {
    before = { ...store.notifications[idx] };
    const patch: Partial<Notification> = {};
    const ts = Date.now();
    if (action === 'read') { patch.read_at = ts; patch.persistent_float = false; }
    if (action === 'ack') { patch.acked_at = ts; patch.persistent_float = false; }
    if (action === 'hide') { patch.hidden_at = ts; patch.persistent_float = false; }
    if (action === 'pin') patch.pinned_at = body.off ? null : ts;
    data().notifications[idx] = { ...data().notifications[idx], ...patch };
    optimistic = data().notifications[idx];
    if ((action === 'read' || action === 'hide') && before.kind !== 'chat_message' && !before.read_at && !before.hidden_at) {
      unreadDelta = data().unreadCount > 0 ? 1 : 0;
      data().unreadCount -= unreadDelta;
    }
  }
  try {
    const key = newIdempotencyKey('notif');   // 一次动作一个键，重试复用（read/ack/hide 单调，pin/snooze 最后写入生效）
    const receipt=await withRetry(() => {
      if (!lease.valid()) throw new ApiError('unauthenticated', '会话已变更', 401);
      return me.notificationAction(n.id, action, body, key);
    });
    if(lease.valid()&&receipt?.message_badge)store.acceptMessageBadge(lease.account,receipt.message_badge);
    // Persist only a server-confirmed read owned by this action. Failed reads must
    // not survive restart, and newer stream versions take precedence.
    if (action === 'read' && optimistic && lease.valid() && store.notifications.find(x => x.id === n.id) === optimistic) {
      await putMany('notifications', lease.account, [optimistic as unknown as Record<string, unknown>]);
    }
    return lease.valid();
  } catch (e) {
    if (!lease.valid()) return false;
    // 服务端判定该通知已不存在（404 not_found：迁移／清理／换库等）：清除本地 ghost 而非回滚。
    //   否则它会永远卡在悬浮层，用户每次「已阅读」都 404 回滚、消不掉。清除即达成用户意图，不当失败。
    if (e instanceof ApiError && (e.code === 'not_found' || e.status === 404)) {
      await data().evictNotification(n.id);
      if(!options.quiet)feedback.toast('该提醒已失效，已从列表移除', false);
      return 'gone';
    }
    // 其余错误：回滚乐观更新
    const currentIndex = store.notifications.findIndex(x => x.id === n.id);
    // Only roll back the exact optimistic object we own. A newer server version
    // or another local action takes precedence, even if the index is unchanged.
    if (before && currentIndex >= 0 && store.notifications[currentIndex] === optimistic) {
      store.notifications[currentIndex] = before;
      store.unreadCount += unreadDelta;
    }
    if(!options.quiet)feedback.reportError(e);
    return false;
  }
}

/** 显式已读入口；可见已读复用同一read动作，ack仍表示单独知悉。 */
export const markRead = (n: Notification | Pick<Notification,'id'|'kind'>) => actOnNotification(n, 'read');
export const markAck = (n: Notification) => actOnNotification(n, 'ack');

// 便于后续链路复用（问题/策划/审核/公告等写动作在本文件继续集中扩展）
export const api = { me, newIdempotencyKey };

export async function readNormalNotifications(){
 const store=data(),lease=store.captureLease();
 const targets=store.inboxNotifications.filter(n=>isWorkNotice(n)&&!n.read_at&&n.priority!=='urgent');
 return readNotificationBatch(targets,(n:Notification)=>actOnNotification(n,'read',{}, {quiet:true}),lease.valid);
}
