<script setup lang="ts">
import {useReadFeedback} from '@/ui/useReadFeedback';
import PullToRefresh from '@/ui/components/PullToRefresh.vue';
import {useChatStore} from '@/store/chat';
import {memberDisplayName} from '@/domain/noticeChannel.mjs';
import PageHeading from '@/ui/components/PageHeading.vue';
// 公司公告（链路5）：收件人查看/已读/从我的列表隐藏；主控发布（勾选具体账号，不按部门，不回显自己发出的公告）。
// 已读或到期只退出顶部悬浮，仍保留在此列表与中枢审计；收件人“删除”只隐藏本人投影。
import { computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionStore } from '@/session/store';
import { useDataStore } from '@/store/data';
import { useUiStore } from '@/store/ui';
import { ago } from '@/ui/format';
import AppIcon from '@/ui/components/AppIcon.vue';

const route = useRoute();
const session = useSessionStore();
const data = useDataStore();
const ui = useUiStore();
const chat=useChatStore();
const {error,feedback}=useReadFeedback();
async function refreshAnnouncements(force=true){feedback.begin(data.announcements.length>0);try{await data.syncLists(data.account,force);feedback.succeeded();}catch(e){feedback.failed(e,'公告暂未更新，请重试');}}
watch(()=>data.announcements,()=>feedback.succeeded());
watch(()=>session.businessReady,ready=>{if(ready)void refreshAnnouncements(false);});
const publisher=(a:any)=>a.publisher_username===session.user?.username?'我发布的':memberDisplayName(a.publisher_username,chat.members,a.publisher_name);

const list = computed(() => [...(data.account === session.user?.username ? data.announcements : [])].sort((a, b) => Number(!!a.read_at) - Number(!!b.read_at) || b.created_at - a.created_at));
function expiredAt(a: { expires_at: number | null }): boolean { return !!a.expires_at && a.expires_at <= Date.now(); }
function open(a: { id: string }) { ui.openOverlay('announcement', { announcementId: a.id }); }
function publish() { if(session.canPublishAnnouncement)ui.openOverlay('announcementForm', {}); else ui.toast('当前账号没有公告发布权限',true); }
watch(() => [route.name,route.params.id], ([name,id]) => { if (name === 'announcements' && typeof id === 'string' && id) ui.openOverlay('announcement', { announcementId: id }); }, { immediate: true });
onMounted(() => { void chat.refreshMembers(); if (data.account && session.status === 'online') void refreshAnnouncements(false); });
</script>

<template>
  <PullToRefresh class="page-stack" :refresh="refreshAnnouncements" :error="error" label="刷新公司公告">
    <p v-if="error" class="field-help" role="status">{{error}} <button class="btn small" @click="refreshAnnouncements()">重试</button></p>
    <PageHeading title="公司公告">
<button class="btn primary" :aria-disabled="!session.canPublishAnnouncement" @click="publish"><AppIcon name="megaphone" />发布公告</button>
      </PageHeading>

    <div class="list-panel">
      <button v-for="a in list" :key="a.id" class="task-row pressable" @click="open(a)">
        <span class="row-icon" :class="a.priority === 'urgent' ? 'red' : 'teal'"><AppIcon name="megaphone" /></span>
        <span class="row-body">
          <span class="row-title">{{ a.title }}</span>
          <span class="row-description">{{ a.body }}</span>
          <span class="row-info"><template v-if="publisher(a)">{{publisher(a)}} · </template> {{ ago(a.created_at) }}<template v-if="expiredAt(a)"> · 已过期</template><template v-if="a.publisher_username === session.user?.username && a.read_count != null"> · 已读 {{ a.read_count }} · 未读 {{ a.unread_count ?? 0 }}</template></span>
        </span>
        <span class="status" :class="a.read_at ? 'gray' : 'green'">{{ a.publisher_username === session.user?.username ? '已发布' : a.read_at ? '已读' : '未读' }}</span>
      </button>
      <div v-if="!list.length && !data.syncing && !data.syncError" class="empty">
        <span class="empty-symbol"><AppIcon name="megaphone" /></span>
        <h3>{{ session.canPublishAnnouncement ? '发布一条清楚的公告' : '暂无公司公告' }}</h3>
        <p>{{session.canPublishAnnouncement?'选择接收人发布公告，参与者可以在公告下回复。':'收到的公告会显示在这里。'}}</p>
        <button v-if="session.canPublishAnnouncement" class="btn soft" @click="publish"><AppIcon name="send" />发布公告</button>
      </div>
    </div>
  </PullToRefresh>
</template>
