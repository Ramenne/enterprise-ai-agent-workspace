<script setup lang="ts">
import {useReadFeedback} from '@/ui/useReadFeedback';
import PageHeading from '@/ui/components/PageHeading.vue';
import WorklogNumber from '@/ui/components/WorklogNumber.vue';
// 消息中心（链路2）：可靠收件箱的账号级视图。已读/知悉/置顶/稍后提醒只改本人通知投影，不改 Task/Issue/Review。
// 前台实际看到卡片即已读；“我知道了”仍是独立确认，不代表审核或工作已完成。
import { ref, computed, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useDataStore } from '@/store/data';
import { useUiStore } from '@/store/ui';
import { actOnNotification, readNormalNotifications } from '@/store/actions';
import { routeFromNotification, deepTargetQuery } from '@/platform/deeplink';
import { ago, NOTIFICATION_KIND_LABEL } from '@/ui/format';
import type { Notification } from '@/api/types';
import {isWorkNotice} from '@/domain/noticeChannel.mjs';
import PullToRefresh from '@/ui/components/PullToRefresh.vue';
import AppIcon from '@/ui/components/AppIcon.vue';
import { useSessionStore } from '@/session/store';
import { useVisibleNotificationReads } from '@/chat/readVisible';

const data = useDataStore();
const session = useSessionStore();
const noticeList = ref<HTMLElement | null>(null);
useVisibleNotificationReads(noticeList, computed(() => session.user?.username || ''));
const ui = useUiStore();
const router = useRouter();
const {error,feedback}=useReadFeedback();
async function refreshNotifications(){feedback.begin(data.inboxNotifications.length>0);try{await data.syncNotifications(data.account,false,'catchup');feedback.succeeded();}catch(e){feedback.failed(e,'通知暂未更新，请重试');}}
watch(()=>data.syncError,value=>{if(!value)feedback.succeeded();});
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let press: { id: number; x: number; y: number } | undefined;
let suppressClick = false;
let copiedOnHold = false;
function cancelCopyPress() { clearTimeout(copyTimer); copyTimer = undefined; }
async function copyWorklog(n: Notification) {
  cancelCopyPress();
  if (!n.worklog_id || !Number.isSafeInteger(n.worklog_id) || n.worklog_id <= 0) { ui.toast('这条消息没有可复制的动态编号', true); return; }
  const label = `#${n.worklog_id}`;
  try { await navigator.clipboard.writeText(label); ui.toast(`已复制 ${label}`); }
  catch { ui.openOverlay('copyFallback', { text: label }); }
}
function startCopyPress(event: PointerEvent, n: Notification) {
  if (event.button !== 0) return;
  cancelCopyPress();
  press = { id: event.pointerId, x: event.clientX, y: event.clientY };
  suppressClick = false; copiedOnHold = false;
  copyTimer = setTimeout(() => { suppressClick = true; copiedOnHold = true; void copyWorklog(n); }, 520);
}
function moveCopyPress(event: PointerEvent) {
  if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
    suppressClick = true; cancelCopyPress();
  }
}
function endCopyPress() { cancelCopyPress(); press = undefined; }
function abandonCopyPress() { suppressClick = true; endCopyPress(); }
function contextCopy(event: MouseEvent, n: Notification) {
  event.preventDefault(); suppressClick = true;
  if (!copiedOnHold) { copiedOnHold = true; void copyWorklog(n); }
}
function activate(event: MouseEvent, n: Notification) {
  if (suppressClick && event.detail !== 0) { event.preventDefault(); suppressClick = false; return; }
  void open(n);
}
onUnmounted(endCopyPress);

const list = computed(() => {
  const rows = data.inboxNotifications.filter(isWorkNotice);
  return [...rows].sort((a, b) => (Number(!!b.pinned_at)-Number(!!a.pinned_at)) || (Number(b.priority === 'urgent' && !b.acked_at) - Number(a.priority === 'urgent' && !a.acked_at)) || b.created_at - a.created_at);
});

function iconOf(n: Notification): string {
  if (n.priority === 'urgent' && !n.acked_at) return 'bolt';
  if (n.kind === 'issue_collab') return 'flag';
  if (n.kind === 'announcement') return 'bell';
  return 'bell';
}
function toneOf(n: Notification): string {
  if (n.priority === 'urgent' && !n.acked_at) return 'red';
  if (['review_pending', 'review_result', 'revision_required'].includes(n.kind)) return 'amber';
  return 'teal';
}
const unread = (n: Notification) => !n.read_at && !n.acked_at;

async function open(n: Notification) {
  if (n.kind === 'legacy_notice') {ui.openOverlay('copyFallback',{text:n.summary||n.title});void actOnNotification(n,'read',{}, {quiet:true});return;}
  if (n.kind === 'announcement') {
    if (n.object_id) ui.openOverlay('announcement', { announcementId: n.object_id });
    else ui.toast('公告关联信息缺失，暂时无法查看正文', true);
    return;
  }
  const target = routeFromNotification(n);
  // 可见已读由统一观察队列处理；点击普通消息也补记已读，确认操作仍独立。
  if (n.kind !== 'review_pending' && n.priority !== 'urgent' && !n.read_at) void actOnNotification(n, 'read',{}, {quiet:true});
  if (target) void router.push({ name: target.name, params: target.params, query: deepTargetQuery(target) });
  else ui.toast('这条通知未绑定可直接打开的对象');
}
const pending=ref(new Set<string>());
async function notificationAction(n:Notification,action:'ack'|'pin',body:{off?:boolean;until?:number}={}){
 if(pending.value.has(n.id))return false;pending.value.add(n.id);try{return await actOnNotification(n,action,body);}finally{pending.value.delete(n.id);}
}
async function ack(n:Notification){if(await notificationAction(n,'ack')===true)ui.toast('已确认');}
async function togglePin(n:Notification){await notificationAction(n,'pin',{off:!!n.pinned_at});}
const readBusy=ref(false);
async function readAllNormal() {
  if(readBusy.value)return;const lease=data.captureLease();readBusy.value=true;
  try{const result=await readNormalNotifications();if(!lease.valid()||result.cancelled)return;
    ui.toast(result.failed ? `已读 ${result.read} 条，剩余操作未完成，请稍后重试` : result.read ? `已读 ${result.read} 条${result.gone ? '，失效通知已清理' : ''}` : '没有待标记的普通消息',!!result.failed);
  }finally{readBusy.value=false;}
}
</script>

<template>
  <PullToRefresh :refresh="refreshNotifications" :error="error" label="刷新工作通知">
    <p v-if="error" class="field-help" role="status">{{error}} <button class="btn small" @click="refreshNotifications">重试</button></p>
    <PageHeading title="工作通知">
      <button v-if="list.some(n=>n.priority!=='urgent'&&n.kind!=='review_pending'&&!n.read_at)" class="btn small" aria-label="将普通通知标记为已读" @click="readAllNormal" :disabled="readBusy"><AppIcon name="check" />{{readBusy?'处理中…':'标为已读'}}</button>
    </PageHeading>

    <section ref="noticeList" class="list-panel">
      <div v-for="n in list" :key="n.id" :data-notification-id="n.id" class="notification-item" :class="{ unread: unread(n) }">
        <span class="row-icon" :class="toneOf(n)"><AppIcon :name="iconOf(n)" /></span>
        <div class="grow">
          <button class="notif-open" @pointerdown="startCopyPress($event, n)" @pointermove="moveCopyPress" @pointerup="endCopyPress" @pointercancel="abandonCopyPress" @pointerleave="abandonCopyPress" @contextmenu="contextCopy($event, n)" @click="activate($event, n)"><p><WorklogNumber :id="n.worklog_id" />{{ n.title }}</p></button>
          <small>{{ n.summary }}</small>
          <small class="muted">{{ NOTIFICATION_KIND_LABEL[n.kind] || '工作动态' }} · {{ ago(n.created_at) }}<template v-if="n.pinned_at"> · 已置顶</template></small>
          <button v-if="n.priority === 'urgent' && !n.acked_at" class="btn small" @click="ack(n)" :disabled="pending.has(n.id)">我知道了</button>
          <div class="notification-actions">
            <button class="btn small ghost" @click="togglePin(n)" :disabled="pending.has(n.id)"><AppIcon name="pin" />{{ n.pinned_at ? '取消置顶' : '置顶' }}</button>
          </div>
        </div>
        <i v-if="unread(n)" class="read-dot" aria-label="未读"></i>
      </div>
      <div v-if="!list.length" class="empty"><span class="empty-symbol"><AppIcon name="bell" /></span><h3>暂无通知</h3></div>
    </section>
  </PullToRefresh>
</template>

<style scoped>
.notif-open { touch-action: pan-y; user-select: none; -webkit-touch-callout: none; border: 0; background: transparent; padding: 0; text-align: left; width: 100%; }
.notif-open p { font-size: 16px; line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.notification-item .grow > small { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.notification-item { align-items: flex-start; }
.notification-actions .btn{min-height:44px}.notification-actions{display:flex;gap:8px;margin-top:8px}.notification-item .grow > small{font-size:13px;line-height:1.5}
.notification-actions{gap:14px;margin-top:2px;justify-content:flex-start}.notification-actions .btn{position:relative;min-height:28px;padding:3px 0;font-size:12px;gap:5px}.notification-actions .btn::after{content:'';position:absolute;inset:-8px 0}.notification-actions .icon{width:14px;height:14px}.notif-open p{font-size:15px;line-height:1.45}.notification-item .grow>small{font-size:12px;line-height:1.45}.notification-item{padding-top:14px;padding-bottom:12px}
</style>
