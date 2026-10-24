<script setup lang="ts">
import {useReadFeedback} from '@/ui/useReadFeedback';
import {useLocalDraft} from '@/ui/useLocalDraft';
import {invalidateAnnouncementReplies} from '@/native/announcement-cache';
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useChatStore } from '@/store/chat';
import { markRead } from '@/store/actions';
import { useDataStore } from '@/store/data';
import { useUiStore } from '@/store/ui';
import { useSessionStore } from '@/session/store';
import { communication } from '@/api/endpoints';
import { usePendingWrite } from '@/ui/usePendingWrite';
import type { AnnouncementReply, Announcement } from '@/api/types';
import {userError} from '@/domain/userError.mjs';
import {memberDisplayName} from '@/domain/noticeChannel.mjs';
import {useVisibleAnnouncementReads} from '@/chat/readVisible';
import { ago, exact } from '@/ui/format';
import { onChatWake } from '@/platform/chatEvents';
import MemberAvatar from '@/ui/components/MemberAvatar.vue';
import MessageInput from '@/ui/components/MessageInput.vue';
import ModalSheet from '@/ui/components/ModalSheet.vue';
const data = useDataStore(), ui = useUiStore(), session = useSessionStore();
const props = ui.overlayProps as { announcementId: string };
const account = session.user?.username;
const chat = useChatStore();
const audienceTab = ref<'read' | 'unread' | null>(null);
const audienceRows = computed(() => (ann.value?.audience || []).filter(row => audienceTab.value === 'read' ? !!row.read_at : !row.read_at));
function memberName(username: string, fallback?: string) {
  return memberDisplayName(username,chat.account===account?chat.members:[],fallback);
}
const viewportHeight = ref(window.visualViewport?.height || window.innerHeight);
const viewportTop = ref(window.visualViewport?.offsetTop || 0);
function resizeViewport() { viewportHeight.value = window.visualViewport?.height || window.innerHeight; viewportTop.value = window.visualViewport?.offsetTop || 0; }
function resizeReply(event: Event) { const input = event.target as HTMLTextAreaElement; input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 104) + 'px'; }
const readBusy = ref(false);
async function confirmRead() {
  const notification = data.notifications.find(n => n.id === ann.value?.notification_id);
  if (!ann.value?.notification_id || readBusy.value || !valid()) return;
  readBusy.value = true;
  try { if (await markRead(notification||{id:ann.value!.notification_id,kind:'announcement'}) === true && valid()) await loadDetail(true); } catch { if (valid()) ui.toast('阅读状态刷新失败，请稍后重试', true); } finally { readBusy.value = false; }
}
const canConfirmRead = computed(() => !!ann.value && !ann.value.read_at && ann.value.publisher_username !== account && !!ann.value.notification_id);
const direct=ref<Announcement|null>(null),rejected=ref(false);
const {error:detailError,feedback:detailFeedback}=useReadFeedback({retry:()=>loadDetail(true),ready:()=>session.businessReady});
const {error:replyReadError,feedback:replyFeedback}=useReadFeedback({retry:()=>refresh(true),ready:()=>session.businessReady});
function reject(e:unknown){if([403,404].includes((e as any)?.status)){rejected.value=true;direct.value=null;replies.value=[];}}
const ann = computed(() => !rejected.value && data.account === session.user?.username && session.user?.username === account ? direct.value : null);
const publisherLabel=computed(()=>!ann.value?'':ann.value.publisher_username===account?'我':memberName(ann.value.publisher_username,ann.value.publisher_name));
const expired = computed(() => !!ann.value?.expires_at && ann.value.expires_at <= Date.now());
const hasAudienceStats = computed(() => ann.value?.recipient_count != null && ann.value?.read_count != null && ann.value?.unread_count != null);
const replies = ref<AnnouncementReply[]>([]), body = ref(''), error = ref(''), loading = ref(false), busy = ref(false);
let cursor = 0, alive = true,replyRefreshPending=false;
const repliesLoaded=ref(false);
const hasAudienceDetails=computed(()=>Array.isArray(ann.value?.audience));
const write = usePendingWrite<{ body: string }>('company', 'announcement-reply', props.announcementId);
const operation = write.pending;
const replyDraft=useLocalDraft<{body:string}>('announcement_reply_draft:'+props.announcementId,()=>body.value?{body:body.value}:null,value=>{if(!operation.value&&typeof value.body==='string')body.value=value.body;});
if (operation.value) body.value = operation.value.body.body;
const detailLoading = ref(false);let detailRefreshPending=false;
const readSurface=ref<HTMLElement|null>(null);
useVisibleAnnouncementReads(readSurface,computed(()=>session.user?.username||''),()=>loadDetail(true));
async function loadDetail(changed = false) {
  if(!alive||!write.valid())return;
  if(detailLoading.value){if(changed)detailRefreshPending=true;return;}
  detailLoading.value = true;detailFeedback.begin(!!ann.value);
  try { let force=changed;do{detailRefreshPending=false;const result=await communication.announcement(props.announcementId,force);force=true;if(alive&&write.valid()){direct.value=result.announcement;rejected.value=false;detailFeedback.succeeded();}}while(detailRefreshPending&&alive&&write.valid()); } catch(e) { if(alive&&write.valid()){reject(e);detailFeedback.failed(e,'公告暂未读取，请重试');} }
  finally { detailLoading.value = false; }
}
onMounted(() => { void chat.refreshMembers(); void loadDetail(); window.addEventListener('resize', resizeViewport); window.visualViewport?.addEventListener('resize', resizeViewport); window.visualViewport?.addEventListener('scroll', resizeViewport); });
const valid = () => alive && write.valid() && session.user?.username === account && !!ann.value;
async function refresh(changed = false) {
  if (!valid() || session.status !== 'online') return;
  if(loading.value){if(changed)replyRefreshPending=true;return;}
  loading.value = true;replyFeedback.begin(repliesLoaded.value);
  try {
    let force=changed;do{replyRefreshPending=false;let more = true;
    while (more && valid()) {
      const page = await communication.replies(props.announcementId, cursor,undefined,force);
      if (!valid()) return;
      if (page.has_more && page.next_cursor <= cursor) throw Error('回复游标未推进');
      const all = new Map(replies.value.map(r => [r.id, r]));
      for (const row of page.replies) all.set(row.id, row);
      replies.value = [...all.values()].sort((a, b) => a.seq - b.seq); cursor = page.next_cursor; more = page.has_more;
    }
    if(valid()){repliesLoaded.value=true;replyFeedback.succeeded();}force=true;
    }while(replyRefreshPending&&valid());
  } catch(e) { if(valid()){replyFeedback.failed(e,'回复暂未更新，请重试');reject(e);} }
  finally { if(alive) loading.value = false; }
}
async function send() {
  if (!valid() || !replyDraft.readyToEdit.value || busy.value || session.status !== 'online' || (!body.value.trim() && !operation.value)) return;

  busy.value = true; error.value = '';
  try { const intent = write.start({ body: body.value.trim() }); const result=await communication.reply(props.announcementId, intent.body.body, intent.key); if (!valid()) return; if(!result.reply?.id)throw Error('回复回执不完整，请重试确认');await invalidateAnnouncementReplies(props.announcementId);write.finish(); body.value = '';await replyDraft.flush();const all=new Map(replies.value.map(r=>[r.id,r]));all.set(result.reply.id,result.reply);replies.value=[...all.values()].sort((a,b)=>a.seq-b.seq);repliesLoaded.value=true; }
  catch(e) { if(valid()){error.value=userError(e);reject(e);} }
  finally { if(alive) busy.value = false; }
}
watch(() => ann.value?.id, () => { void refresh(); });
watch(() => session.status, status => { if(status==='online'){if(!direct.value||detailError.value)void loadDetail(true);void refresh();} });
const stopWake = onChatWake(event => {
  if (event.account !== account || event.mode !== 'catchup' && !event.announcementIds.includes(props.announcementId)) return;
  if(event.mode==='catchup'||event.kinds.includes('announcement_reply'))void refresh(true);
  if(event.mode==='catchup'||event.kinds.includes('announcement_read'))void loadDetail(true);
});
onUnmounted(() => { alive = false; stopWake(); window.removeEventListener('resize', resizeViewport); window.visualViewport?.removeEventListener('resize', resizeViewport); window.visualViewport?.removeEventListener('scroll', resizeViewport); });
</script>
<template>
  <ModalSheet v-if="ann" :style="{ height: viewportHeight + 'px', top: viewportTop + 'px', bottom: 'auto' }" modal-class="announcement-modal" :title="ann.title" :sub="`${publisherLabel?publisherLabel+'发布 ·':''} ${ago(ann.created_at)}${expired ? ' · 已过期' : ''}`" @close="ui.closeOverlay()">
    <p v-if="detailError" class="error-text" role="alert">{{detailError}}<button class="btn small" @click="loadDetail()">重试详情</button></p><div ref="readSurface"><span class="announcement-read-anchor" :data-announcement-id="ann.id" aria-hidden="true"></span><p class="body-text">{{ ann.body }}</p></div><details class="announcement-rules"><summary>公告范围与有效期</summary><p class="field-help">{{ ann.expires_at ? '有效至 ' + exact(ann.expires_at) + '。' : '未设置失效时间。' }}公告和回复仅发布者与原接收人可见。正文成功打开并可见后自动标记已读。</p></details>
    <button v-if="canConfirmRead" class="btn small" :disabled="readBusy || session.status !== 'online'" @click="confirmRead">{{ readBusy ? '正在确认…' : '我已阅读' }}</button>
    <div v-if="hasAudienceStats" class="announcement-audience" aria-label="公告阅读情况">
      <div class="announcement-audience-summary"><strong>阅读情况</strong><span><button v-if="hasAudienceDetails" :aria-expanded="audienceTab === 'read'" @click="audienceTab = audienceTab === 'read' ? null : 'read'">已读 {{ ann.read_count }} 人</button><span v-else>已读 {{ann.read_count}} 人</span> · <button v-if="hasAudienceDetails" :aria-expanded="audienceTab === 'unread'" @click="audienceTab = audienceTab === 'unread' ? null : 'unread'">未读 {{ ann.unread_count }} 人</button><span v-else>未读 {{ann.unread_count}} 人</span></span></div>
      <div v-if="hasAudienceDetails&&audienceTab" class="audience-names"><template v-if="ann.audience"><span v-for="person in audienceRows" :key="person.username"><MemberAvatar :actor="person.username" :name="memberName(person.username,person.name)" :size="24"/>{{ memberName(person.username, person.name) }}</span><p v-if="!audienceRows.length">{{ audienceTab === 'read' ? '暂无已读成员' : '没有未读成员' }}</p></template></div>
    </div>
    <p v-else-if="ann.publisher_username === account" class="field-help">阅读人数将在公告收件人状态同步后显示。</p>
    <div class="divider"></div><h3>公告回复</h3>
    <p v-if="replyReadError" class="field-help" role="status">{{replyReadError}}<button class="btn small" @click="refresh()">重试获取</button></p><p v-if="error" class="error-text" role="alert">{{error}}</p>
    <article v-for="r in replies" :key="r.id" class="announcement-reply"><small>{{ memberName(r.author_username, r.author_name) }} · {{ ago(r.created_at) }}</small><p>{{ r.body }}</p></article>
    <p v-if="!replies.length" class="field-help">{{ repliesLoaded ? '暂无回复' : loading ? '正在读取回复…' : error ? '回复尚未读取成功' : '回复尚未读取' }}</p>
    <template #footer><p v-if="replyDraft.error.value" role="alert" class="error-text">{{replyDraft.error.value}}<button class="btn small" @click="replyDraft.retry().catch(()=>{})">重试保留草稿</button></p><div class="announcement-compose"><MessageInput @input="resizeReply" v-model="body" placeholder="在公告下回复…" aria-label="公告回复" maxlength="4000" :disabled="!replyDraft.readyToEdit.value || busy || !!operation || session.status !== 'online'" />
    <button class="btn soft announcement-send" :disabled="!replyDraft.readyToEdit.value || busy || session.status !== 'online' || (!body.trim() && !operation)" @click="send">{{ busy ? '发送中…' : operation ? '重试回复' : '发送' }}</button></div></template>
  </ModalSheet>
  <ModalSheet v-else :title="detailLoading ? '正在读取公告' : '暂未取得公告详情'" @close="ui.closeOverlay()"><p class="body-text">{{detailError || '正在读取公告正文…'}}</p><button class="btn soft" :disabled="detailLoading" @click="loadDetail()">重试读取</button></ModalSheet>
</template>
<style scoped>.body-text{font-size:17px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.announcement-reply{padding:12px 0;border-bottom:1px solid var(--line)}.announcement-reply small{font-size:13px;color:var(--muted)}.announcement-reply p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:17px;line-height:1.5;margin-top:6px}.input{margin:12px 0}.announcement-compose{display:flex;flex-direction:column;gap:8px}.announcement-send{align-self:flex-end}.announcement-audience{margin:14px 0;padding:12px;border:1px solid #e6eee9;border-radius:10px;background:#f8fbf9}.announcement-audience-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.announcement-audience-summary span{color:var(--muted);font-size:11px}:global(.announcement-modal .modal-body){min-height:0}:global(.announcement-modal .modal-footer){flex:none}@media (max-width:600px){:global(.announcement-modal){max-height:calc(100dvh - env(safe-area-inset-top));}:global(.announcement-modal .modal-body){padding-bottom:12px;}:global(.announcement-modal .modal-footer){position:sticky;bottom:0;background:#fcfdfc;}}</style>

<style scoped>
.announcement-rules{font-size:13px;color:var(--muted);margin:12px 0}.announcement-rules summary{cursor:pointer;min-height:28px}
.announcement-audience-summary button{border:0;background:transparent;color:var(--text);padding:8px 2px;text-decoration:underline;text-underline-offset:4px;font:inherit}
.audience-names{display:flex;flex-wrap:wrap;gap:8px;padding-top:10px}.audience-names span{background:white;border:1px solid var(--line);border-radius:6px;padding:4px 8px}
.announcement-compose{width:100%;flex:1;min-width:0;flex-direction:row;align-items:flex-end}.announcement-compose textarea{min-height:48px!important;max-height:104px;resize:none;margin:0;flex:1;min-width:0}.announcement-send{flex-shrink:0;min-height:48px;align-self:flex-end}.announcement-reply small{font-size:13px}.announcement-reply p{font-size:17px;line-height:1.5}
:global(.announcement-modal){max-height:100%!important}:global(.announcement-modal .modal-footer){background:#fff!important;padding:12px!important}
</style>

<style scoped>
.announcement-read-anchor{display:block;height:1px;width:100%}
</style>
