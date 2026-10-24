<script setup lang="ts">
// 应用壳（手机竖屏）：连接状态条 + 顶栏 + 内容(router-view) + 底部主导航。主控与员工同一壳，差异由服务端能力驱动。
import {isWorkNotice} from '@/domain/noticeChannel.mjs';
import {messageAttention} from '@/domain/messageBadge.mjs';
import { ref, watch, computed, provide, onMounted, onBeforeUnmount } from 'vue';
import { useChatViewport } from '@/platform/chatViewport';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '@/session/store';
import { useDataStore } from '@/store/data';
import { useUiStore } from '@/store/ui';
import MemberAvatar from '@/ui/components/MemberAvatar.vue';
import AppIcon from '@/ui/components/AppIcon.vue';
import FloatingNotices from '@/ui/components/FloatingNotices.vue';
import { recoverLiveSync } from '@/platform/liveLink';
import {Capacitor,type PluginListenerHandle} from '@capacitor/core';
import {App} from '@capacitor/app';
import {closeTopModal} from '@/ui/components/modalFocus';
import {pageNavigation} from '@/app/router';
import { hasAppUpdate } from '@/platform/updateAvailability';
import {createConnectionNotice} from '@/platform/connectionNotice.mjs';

const session = useSessionStore();
const data = useDataStore();
const ui = useUiStore();
const retrying = ref(false);
const connectionHint=ref('');
const pageVisible=ref(typeof document==='undefined'||document.visibilityState!=='hidden');
function noticeVisibility(){pageVisible.value=document.visibilityState!=='hidden';}
onMounted(()=>document.addEventListener('visibilitychange',noticeVisibility));
onBeforeUnmount(()=>document.removeEventListener('visibilitychange',noticeVisibility));
const connectionNotice=createConnectionNotice((text:string)=>connectionHint.value=text);
watch(()=>[session.isAuthenticated,session.status,session.link?.state,session.link?.networkUp,session.link?.connected,session.link?.foreground,pageVisible.value],()=>{
 if(session.businessReady&&session.link?.connected&&session.link?.networkUp!==false)ui.clearErrors(true);
 connectionNotice.update({active:!!session.isAuthenticated&&!!session.link,foreground:pageVisible.value&&session.link?.foreground!==false,healthy:(session.link?.connected===true||session.link?.state==='live')&&session.link?.networkUp!==false&&session.status!=='recovering',offline:session.status==='offline'&&session.link?.networkUp===false});
},{immediate:true});
onBeforeUnmount(()=>connectionNotice.dispose());
async function retryConnection() {
  if (retrying.value) return;
  retrying.value = true;
  try {
    if (session.businessReady && session.isAuthenticated) await recoverLiveSync();
    else await session.reconnect();
  } catch { /* The scoped connection notice owns a continuing outage. */ }
  finally { retrying.value = false; }
}
const route = useRoute();
const viewport = useChatViewport();
const collaborationLayout = computed(() => route.name === 'collaboration');
const collaborationStyle = computed(() => collaborationLayout.value ? { height: viewport.height.value + 'px', top: viewport.top.value + 'px' } : undefined);
const chatLayout = computed(() => route.name === 'chat');
const chatStyle = computed(() => chatLayout.value ? { height: viewport.height.value + 'px', top: viewport.top.value + 'px' } : undefined);
const router = useRouter();
const showPageBack=computed(()=>['member','inspiration','search','files','notifications','announcements'].includes(String(route.name)));
watch(()=>data.account,()=>{ui.clearErrors();pageNavigation.reset();});
onBeforeUnmount(()=>ui.clearErrors());
// An overlay belongs to the page that opened it; cached lists do not own it.
watch(()=>route.fullPath,(to,from)=>{ui.clearErrors();ui.closeOverlay();if(ui.confirmVisible)ui.resolveConfirm(false);const prior=router.resolve(from||'/');if(prior.query.returnSearch==='1'&&prior.query.returnTo===to)ui.openOverlay('search');},{flush:'sync'});
provide('exitCollaboration', () => pageNavigation.back());
let backListener:PluginListenerHandle|undefined,shellMounted=false,releaseSurface:(()=>void)|undefined;
function onPageEscape(event:KeyboardEvent){if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();void pageNavigation.back();}}
function closeBackSurface(){
 if(closeTopModal())return true;
 if(ui.confirmVisible){ui.resolveConfirm(false);return true;}
 if(ui.overlay){ui.closeOverlay();return true;}
 const focused=document.activeElement;if(focused instanceof HTMLInputElement||focused instanceof HTMLTextAreaElement){focused.blur();return true;}
 return false;
}
onMounted(()=>{shellMounted=true;document.addEventListener('keydown',onPageEscape);releaseSurface=pageNavigation.setSurfaceCloser(closeBackSurface);if(Capacitor.isNativePlatform())void App.addListener('backButton',async()=>{
 if(!await pageNavigation.back())await App.minimizeApp();
}).then(h=>{if(shellMounted)backListener=h;else void h.remove();});});
onBeforeUnmount(()=>{shellMounted=false;document.removeEventListener('keydown',onPageEscape);releaseSurface?.();void backListener?.remove();});


const chatUnread = computed(() => messageAttention(data.account===session.user?.username?data.notifications:[],session.user?.username||''));
const workUnread = computed(() => data.account===session.user?.username?data.inboxNotifications.filter(n=>isWorkNotice(n)&&!n.read_at&&!n.acked_at).length:0);
const navItems = [
  { name: 'chat', label: '消息', icon: 'message' },
  { name: 'work', label: '工作', icon: 'inbox' },
] as const;
const sectionLabel = computed(() => navItems.find(it => isActive(it.name))?.label || (route.name === 'profile' ? '设置' : '详情'));
function isActive(n: string): boolean {
  const name = String(route.name);
  if (name === n) return true;
  return (n === 'personal' && ['project', 'projects', 'archives', 'drafts'].includes(name)) || (n === 'chat' && ['conversations','member','announcements','group-files'].includes(name)) || (n === 'work' && ['notifications','inbox', 'company', 'reviews','work-detail','material-detail','files'].includes(name));
}
function badgeCount(n:number){return n>99?'99+':String(n);}
function go(n: string) { const target=n==='chat'?'conversations':n;void pageNavigation.primary({name:target}); }
</script>

<template>
  <div class="shell" :class="{ 'shell-collaboration': collaborationLayout, 'shell-chat': chatLayout, 'shell-conversations': route.name==='conversations', 'chat-keyboard': chatLayout && viewport.keyboard.value }" :style="collaborationStyle || chatStyle">
    <a class="skip-link" href="#main">跳到内容</a>
    <aside v-if="!collaborationLayout" class="sidebar" aria-label="工作空间">
      <div class="sidebar-brand"><img src="/employeeclient.svg" alt="">员工客户端</div>
      <div class="sidebar-label">工作空间</div>
      <nav class="sidebar-nav" aria-label="桌面主要导航">
        <button v-for="it in navItems" :key="it.name" :class="{ active: isActive(it.name) }" :aria-current="isActive(it.name) ? 'page' : undefined" @click="go(it.name)">
          <AppIcon :name="it.icon" /><span>{{ it.label }}</span>
          <small v-if="it.name === 'chat' && chatUnread.count">{{ chatUnread.count }}</small>
        </button>
      </nav>
      <button class="sidebar-account" @click="go('profile')"><MemberAvatar :name="session.displayName" :size="28"/><span><strong>{{ session.displayName || '我的账号' }}</strong><small>账号与客户端设置</small></span><AppIcon name="chevron" /></button>
    </aside>
    <div class="workspace">
      <div v-if="connectionHint" class="offline-hint" role="status"><span class="offline-mark" aria-hidden="true">!</span><span>{{connectionHint}}</span></div>
      <div v-if="!collaborationLayout" class="topbar">
        <div class="mobile-brand"><img src="/employeeclient.svg" alt="">员工客户端</div>
        <div class="breadcrumb"><span>员工客户端</span><span>/</span><b>{{ sectionLabel }}</b></div>
        <div class="top-actions">
          <!-- 搜索（原型 UI v1.1 的 search 弹层）：手机窄屏下原型也只留图标（label 与 kbd 在 ≤600px 隐藏），故这里用 icon-btn -->
          <button class="icon-btn" aria-label="查找中枢资料与工作" @click="router.push({name:'search'})"><AppIcon name="search" /></button>
          <button class="icon-btn notification-entry" :class="{ active: route.name === 'notifications' }" :aria-current="route.name === 'notifications' ? 'page' : undefined" aria-label="消息通知" @click="router.push({ name: 'notifications' })">
            <AppIcon name="bell" /><i v-if="workUnread" class="count-badge" :aria-label="`${workUnread} 条未读工作通知`">{{badgeCount(workUnread)}}</i>
          </button>
          <button class="account-shortcut" :aria-label="hasAppUpdate?'账号与设置，有新版本':'账号与设置'" @click="go('profile')"><MemberAvatar :name="session.displayName" :size="36"/><i v-if="hasAppUpdate" class="update-dot" aria-hidden="true"/></button>
        </div>
      </div>
      <FloatingNotices v-if="!collaborationLayout"/>
      <main id="main" class="content" tabindex="-1">
        <div v-if="!session.businessReady && session.status === 'unbound'" class="callout" role="alert">
          {{ session.lastError || '聊天与通知尚未连接，资料和工作仍可访问。' }}
          <button class="btn small" :disabled="retrying" @click="retryConnection">{{retrying?'正在重试…':'重试'}}</button>
        </div>
        <div v-if="data.personalCleanupError" class="callout" role="alert">{{ data.personalCleanupError }}</div>
        <button v-if="showPageBack" class="btn ghost page-back" aria-label="返回上一层" data-page-back @click="pageNavigation.back()"><AppIcon name="back"/>返回</button>
        <router-view v-slot="{ Component }">
          <KeepAlive :key="data.account + ':' + data.scopeRevision" :include="['ChatView','ConversationsView','WorkHomeView','ProfileView','ProjectsView','SearchView','FilesView','GroupFilesView']" :max="8">
            <component :is="Component" :key="String(route.name)" />
          </KeepAlive>
        </router-view>
      </main>
    </div>
    <nav v-if="!collaborationLayout" class="bottom-nav" aria-label="主要导航">
      <button v-for="it in navItems" :key="it.name" :class="{ active: isActive(it.name) }" :aria-current="isActive(it.name) ? 'page' : undefined" @click="go(it.name)">
        <AppIcon :name="it.icon" /><span>{{ it.label }}<strong v-if="it.name === 'chat' && chatUnread.relevant" class="chat-relevant-label"> · 与我有关</strong></span><i v-if="it.name === 'chat' && chatUnread.count" class="count-badge" :aria-label="`${chatUnread.count} 条未读消息，其中 ${chatUnread.relevant} 条与你有关`">{{badgeCount(chatUnread.count)}}</i>
      </button>
    </nav>

  </div>
</template>

<style scoped>
.offline-hint{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px 12px;color:var(--muted);font-size:12px;background:var(--paper)}
.offline-mark{display:inline-grid;place-items:center;width:16px;height:16px;border:1px solid currentColor;border-radius:50%;font-weight:600;line-height:1}
.page-back{align-self:flex-start;margin-bottom:8px;gap:4px}
.shell-conversations .content{padding:0 0 calc(88px + env(safe-area-inset-bottom));max-width:none;background:#f7f7f7}

.account-shortcut{position:relative}.account-shortcut>.update-dot{position:absolute;top:2px;right:2px}
.notification-entry.active{color:#368e67;background:var(--green-soft)}
.notification-entry.active .icon{stroke-width:2.2}
.chat-relevant-label{font-size:11px;color:#245fc2;font-weight:600}
.shell.shell-collaboration{position:fixed;left:0;right:0;display:flex;flex-direction:column;min-height:0;overflow:hidden;background:var(--paper)}
.shell-collaboration .workspace{display:flex;flex:1;flex-direction:column;min-height:0;overflow:hidden}
.shell-collaboration .content{display:flex;flex-direction:column;flex:1;min-height:0;padding:0;max-width:none;overflow:hidden;width:100%}
.collaboration-nav{display:flex;justify-content:space-between;flex:none;border-top:1px solid var(--line);padding:8px 20px calc(8px + env(safe-area-inset-bottom));background:var(--paper)}
.collaboration-nav button{display:flex;align-items:center;gap:8px;border:0;padding:10px 14px;background:transparent;color:var(--ink);font:inherit}
</style>
