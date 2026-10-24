<script setup lang="ts">
// 通知与连接（原型 UI v1.1 的 notification-settings 弹层）。
// 布局严格按原型：callout → 系统通知行 → 权限关闭时的 amber 提示 → 提示声音行 → divider → 当前连接 → 自检按钮 → 页脚「完成」。
//
// 与原型的唯一差别是「真假」：原型是自述「仅模拟界面，不申请系统权限、不发送真实系统推送」的演示弹层，
// 这里读的是真机真实权限、真实设备绑定与真实连接状态，不新增行、不改行序、不发明控件。
//
// 平台差异如实呈现（策划 v0.24 §零-1／§零-8／§零-10）：
//  - Android：已彻底取消第三方／厂商推送，消息由存活连接接收后弹本地系统通知，「系统通知」＝本地通知权限；
//    提示声音是渠道属性，本开关只切换有声／静默渠道，不绕过系统静音、勿扰与渠道设置。
//  - iPhone PWA：Web Push，「系统通知」＝浏览器 Notification 权限；声音由 iOS 系统通知设置决定，应用内不可单独关闭，
//    因此这一行在非 Android 下如实显示为系统控制，不做成假开关。
//  - 缺权限不丢消息：消息仍完整进入权威收件箱（§6.2）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import {App} from '@capacitor/app';
import {backgroundAccess,BackgroundSettings,type BackgroundAccess} from '@/platform/backgroundAccess';
import { useSessionStore } from '@/session/store';
import { useUiStore } from '@/store/ui';
import { me } from '@/api/endpoints';
import type { DeviceInfo } from '@/api/types';
import { isAndroidNative } from '@/session/installation';
import { ensureNotificationPermission } from '@/platform/push';
import {
  checkLocalNotifyPermission, requestLocalNotifyPermission, selfTestNotify,
  soundEnabled, setSoundEnabled,
} from '@/platform/localNotify';
import { exact, ago } from '@/ui/format';
import {useDataStore} from '@/store/data';
import ModalSheet from '@/ui/components/ModalSheet.vue';
import AppIcon from '@/ui/components/AppIcon.vue';

const session = useSessionStore(),data=useDataStore();
const ui = useUiStore();

const android = isAndroidNative();
const permission = ref<'granted' | 'denied' | 'prompt' | 'unknown'>('unknown');
const sound = ref(soundEnabled());
const devices = ref<DeviceInfo[]>([]);
const devicesNote = ref('');
const testing = ref(false);
const binding = ref(false);
const permissionError = ref('');
const background=ref<BackgroundAccess|null>(null),backgroundError=ref('');
let resumeListener:{remove:()=>Promise<void>}|undefined,disposed=false;
async function checkBackground(){if(!android)return;try{background.value=await backgroundAccess();backgroundError.value='';}catch{backgroundError.value='暂时无法读取后台设置';}}
async function openBackground(target:'battery'|'autostart'|'notifications'){try{await BackgroundSettings.open({target});}catch{backgroundError.value='系统设置暂未打开，请重试';}}
async function returned(){await Promise.all([loadPermission(),checkBackground()]);}

const permissionText = computed(() => (
  { granted: '已允许', denied: '已关闭', prompt: '尚未询问', unknown: '读取中' } as Record<string, string>
)[permission.value] || permission.value);

/** 连接状态如实展示，不用通知权限或后台权限设置代替判断（§零-3）。 */
const linkStateText=computed(()=>session.link.connected===true?'已连接':({live:'已连接',idle:'连接中…',backoff:'正在重连…',paused:'网络不可用',stopped:'连接未运行'}[session.link.state]||session.link.state));
const linkText = computed(() => {
  const l = session.link;
  const head = l.connected===true?'已连接':({
    live: '连接存活', idle: '正在建立连接', backoff: '正在恢复连接',
    paused: '网络不可用，已暂停', stopped: '连接未运行',
  } as Record<string, string>)[l.state] || l.state;
  const last = data.lastSyncedAt ? `最近通知同步 ${exact(data.lastSyncedAt)}` : '尚未完成通知同步';
  return `${head} · ${last}`;
});

async function loadPermission(): Promise<void> {
  permissionError.value = '';
  try {
  if (android) { permission.value = await checkLocalNotifyPermission(); return; }
  if (typeof Notification === 'undefined') { permission.value = 'denied'; return; }
  permission.value = Notification.permission === 'granted' ? 'granted'
    : Notification.permission === 'denied' ? 'denied' : 'prompt';
  } catch { permission.value = 'unknown'; permissionError.value = '暂时无法读取通知权限，请重试。'; }
}

/** 点「系统通知」行：未允许时真实发起系统授权；已允许或已被系统驳回时不重复弹框，只说明去哪里改。 */
async function togglePermission(): Promise<void> {
  if (binding.value) return;
  if (permission.value === 'denied') { await loadPermission(); if (permission.value === 'denied') { if(android)await openBackground('notifications');else ui.toast('请在浏览器或手机系统设置中允许员工客户端通知', 'action'); return; } }
  binding.value = true;
  try {
  // 用返回值而不是重读 permission：前者是本次授权的真实结果，后者会被 TS 窄化成调用前的类型。
  const granted = android ? await requestLocalNotifyPermission() : (await ensureNotificationPermission()) === 'granted';
  await loadPermission();
  if (granted && !android) {
    const bound = await session.syncPushBinding();
    ui.toast(bound ? '通知已允许' : '正在开启后台通知');
  } else ui.toast(granted ? '通知已允许' : '仍未取得通知权限；消息会保留在收件箱', granted ? false : 'action');
  } catch { ui.toast('通知授权暂未完成，请重试或检查系统设置', true); }
  finally { binding.value = false; }
}

function toggleSound(): void {
  if (!android) { ui.toast('iPhone 的推送声音由 iOS 系统通知设置决定，应用内不单独开关'); return; }
  const next = !sound.value;
  if (!setSoundEnabled(next)) { ui.toast('本机声音设置未能保存，请检查存储空间后重试', true); return; }
  sound.value = next;
}

/** 本机自检：只验证本机权限与渠道，不写云端、不计入业务消息（§零-11 实机验收用）。 */
async function selfTest(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  try {
    const r = await selfTestNotify();
    ui.toast(r.presented ? '已弹出本机自检通知 · ' + r.reason : r.reason);
  } catch { ui.toast('本机通知自检未完成，请检查权限后重试', true); }
  finally { testing.value = false; }
}

onMounted(async () => {
  await loadPermission();
  if(android){await checkBackground();const listener=await App.addListener('resume',returned);if(disposed)await listener.remove();else resumeListener=listener;}
  try { devices.value = (await me.devices()).devices || []; }
  catch { devicesNote.value = '设备列表暂时读不到，不影响收件箱与消息补取'; }
});
onBeforeUnmount(()=>{disposed=true;void resumeListener?.remove();});
</script>

<template>
  <ModalSheet title="通知与连接" @close="ui.closeOverlay()">
    <button class="settings-row" :disabled="binding" @click="togglePermission">
      <AppIcon name="bell" />
      <span class="text"><strong>系统通知</strong></span>
      <i class="toggle" :class="{ on: permission === 'granted' }"></i>
    </button>

    <div v-if="permissionError" class="error-text" role="alert">{{ permissionError }}<button class="btn small" @click="loadPermission">重试读取</button></div>
    <p v-else-if="permission === 'unknown'" role="status" class="field-help">正在读取系统通知权限…</p>
    <div v-else-if="permission !== 'granted'" class="callout amber">
      系统通知{{ permissionText }}，可前往系统设置开启。
    </div>

    <button class="settings-row" @click="toggleSound">
      <AppIcon name="sound" />
      <span class="text">
        <strong>提示声音</strong>
        <small>{{ android ? '关闭后仍弹通知，只是不发声；系统静音与勿扰优先' : '遵循系统静音、勿扰和专注模式' }}</small>
      </span>
      <i v-if="android" class="toggle" :class="{ on: sound }"></i>
      <span v-else class="right-text">系统控制</span>
    </button>

    <template v-if="android">
      <div class="divider"></div>
      <h3>后台接收</h3>
      <button class="settings-row" @click="openBackground('battery')"><AppIcon name="phone"/><span class="text"><strong>电池与后台运行</strong><small>允许不受省电限制，减少后台消息延迟</small></span><span class="right-text">{{background?background.batteryUnrestricted?'已允许':'去允许':'检查设置'}}</span></button>
      <button class="settings-row" @click="openBackground('autostart')"><AppIcon name="phone"/><span class="text"><strong>自启动</strong><small>允许员工客户端自启动和后台活动</small></span><span class="right-text">去设置</span></button>
      <button class="settings-row" @click="openBackground('notifications')"><AppIcon name="bell"/><span class="text"><strong>通知与横幅</strong><small>允许通知、悬浮通知与锁屏提醒</small></span><span class="right-text">{{background&&(!background.notifications||background.chatChannelImportance>=0&&background.chatChannelImportance<4)?'需开启':'去设置'}}</span></button>
      <p class="field-help">自启动与“无限制”由手机系统确认，打开设置不代表已开启。</p>
      <p v-if="backgroundError" class="error-text">{{backgroundError}}<button class="btn small" @click="checkBackground">重试</button></p>
    </template>
    <p class="field-help">未免打扰的新聊天消息会提醒；已读、自己发送和已隐藏的消息不重复弹出。历史补取不逐条重放声音，横幅遵循系统设置。</p>
    <div class="divider"></div>
    <h3>当前连接</h3>
    <dl class="connection-facts">
      <div><dt>身份权限服务账号</dt><dd>{{ session.displayName || '未登录' }}</dd></div>
      <div><dt>当前设备</dt><dd>{{ android ? 'Android 安装包' : 'PWA / 浏览器' }}</dd></div>
      <div><dt>连接状态</dt><dd>{{ linkStateText }}</dd></div>
      <div v-if="!android"><dt>系统推送</dt><dd>{{ session.pushBound && permission === 'granted' ? '已就绪' : '未就绪' }}</dd></div>
    </dl>
    <details><summary class="device-detail-toggle">连接与设备详情</summary><p class="field-help">{{linkText}}</p><p v-if="!android && session.pushReason" class="field-help">推送：{{session.pushReason}}</p><p class="field-help">安装实例 {{ session.installationId }} · {{ session.mode === 'device' ? '设备会话' : '令牌会话' }}。需要解除绑定时，由主控在电脑端处理。</p></details>

    <template v-if="devices.length">
      <h3 class="space-top">同账号设备</h3>
      <div v-for="d in devices" :key="d.installation_id" class="device-row">
        <AppIcon :name="d.platform === 'android_native' ? 'phone' : 'desktop'" />
        <div class="grow">
          {{ d.installation_id.slice(0, 18) }}…
          <small>{{ d.platform === 'android_native' ? 'Android 安装包' : 'iPhone PWA / 浏览器' }} · 最近同步 {{ ago(d.last_auth_sync_at) }}</small>
        </div>
        <span class="status" :class="d.status === 'active' ? 'green' : 'amber'">{{ d.status === 'active' ? '已绑定' : d.status }}</span>
      </div>
    </template>
    <p v-else-if="devicesNote" class="field-help space-top">{{ devicesNote }}</p>

    <div class="space-top">
      <button class="btn soft" :disabled="testing" @click="selfTest">
        <AppIcon name="bell" />{{ testing ? '正在弹出…' : '本机通知自检' }}
      </button>
    </div>
    <p class="field-help">仅测试本机通知显示。</p>

    <template #footer>
      <button class="btn primary" @click="ui.closeOverlay()">完成</button>
    </template>
  </ModalSheet>
</template>
<style scoped>
.connection-facts{margin:16px 0;display:grid;gap:16px}.connection-facts>div{display:grid;grid-template-columns:80px minmax(0,1fr);gap:12px;font-size:14px;line-height:1.7}.connection-facts dt{color:var(--muted)}.connection-facts dd{margin:0;color:var(--ink);overflow-wrap:anywhere}.device-detail-toggle{min-height:44px;cursor:pointer;font-size:13px;color:var(--accent);padding:10px 0}
</style>
