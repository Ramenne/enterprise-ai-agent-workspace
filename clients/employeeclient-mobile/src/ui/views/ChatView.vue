<script setup lang="ts">
import MergedForwardDialog from '@/ui/components/MergedForwardDialog.vue';
import {readMergedForward,pauseMergedForward} from '@/chat/mergedForward';
import {isChatRecord} from '@/chat/chatRecord';
import {useReadFeedback} from '@/ui/useReadFeedback';
import {pendingForwards,removeForwards,updateForward,replaceForward,isCloudForward,type ForwardAttachment} from '@/files/forward';
import {shareCloudFile,cloudFileAttachment,cloudFileContext} from '@/files/cloud';
import {findAttachment} from '@/collaboration/media';
import {renameChatFile} from '@/chat/files';
import { useVisibleChatReads } from '@/chat/readVisible';
import { useChatQuery } from '@/chat/query';
import { useRoute,useRouter,onBeforeRouteLeave,onBeforeRouteUpdate } from 'vue-router';
import type { CSSProperties } from 'vue';
import { computed, nextTick, onMounted, onUnmounted, onActivated, onDeactivated, ref, watch } from 'vue';
import { loadChatContext, mergeContextMessages, assertContextScope } from '@/chat/context';
import {applyChatChanges} from '@/chat/projection';
import {metaSet} from '@/session/db';
import {captureApiLease} from '@/api/client';
import {viewResumeKey,viewRange,restoreViewWindow,type ChatViewResume,type ViewPoint} from '@/chat/viewResume';
import { communication } from '@/api/endpoints';
import { onChatWake } from '@/platform/chatEvents';
import {createRecoveryGate} from '@/platform/recoveryGate.mjs';
import {isRetryableFailure} from '@/domain/userError.mjs';
import { useSessionStore } from '@/session/store';
import {useDataStore} from '@/store/data';
import {isAnnouncementNotice} from '@/domain/noticeChannel.mjs';
import {useComposerDraftStore,sameDraftContent,type ComposerDraft} from '@/chat/drafts';
import { useChatStore } from '@/store/chat';
import { useUiStore } from '@/store/ui';
import { chatTime, chatTimeMarkers } from '@/chat/time';
import {messageSnippet} from '@/chat/presentation';
import ReferenceNumber from '@/ui/components/ReferenceNumber.vue';
import MemberAvatar from '@/ui/components/MemberAvatar.vue';
import { presenceStatus, comparePresence } from '@/chat/presence';
import type { ChatMessage, ChatAttachment, ChatFilter, ChatContext } from '@/api/types';
import ChatAttachmentPicker from '@/ui/components/ChatAttachmentPicker.vue';
import ChatAttachmentView from '@/ui/components/ChatAttachmentView.vue';
import { isVoiceMessage } from '@/chat/mediaKind';
import { useOutsideDismiss } from '@/ui/useOutsideDismiss';
import { transcribeVoice, readExistingVoiceTranscript } from '@/chat/transcription';
import {userError} from '@/domain/userError.mjs';
import {NativeClient} from '@/native/client.mjs';
import {saveDiscussionRecord} from '@/native/work-record.mjs';
import {serviceOrigin} from '@/api/runtime';
import { usePendingWrite } from '@/ui/usePendingWrite';
import ChatContextPicker from '@/ui/components/ChatContextPicker.vue';
import ModalSheet from '@/ui/components/ModalSheet.vue';
import ChatDatePicker from '@/ui/components/ChatDatePicker.vue';
import ChatSearchPanel from '@/ui/components/ChatSearchPanel.vue';
import {sameComposerScope} from '@/chat/composerScope.mjs';
import TransferSector from '@/ui/components/TransferSector.vue';
import {chatTransfers,pruneChatTransfers,restoreChatTransfers,type ChatTransfer} from '@/files/chatTransfers';
import AppIcon from '@/ui/components/AppIcon.vue';
import MessageInput from '@/ui/components/MessageInput.vue';
import ChatForwardDialog from '@/ui/components/ChatForwardDialog.vue';
import MediaForwardDialog from '@/ui/components/MediaForwardDialog.vue';
import BatchForwardDialog from '@/ui/components/BatchForwardDialog.vue';
import {canForwardMessage,forwardUnavailableReason,readBatchForward,pauseBatchForward} from '@/chat/batchForward';
import {canForwardMedia,readMediaForward,pauseMediaForward} from '@/chat/mediaForward';
import {canForwardText,readTextForward,MAX_FORWARD_MESSAGES} from '@/chat/forward';
import {pageNavigation} from '@/app/router';
import {useModeBack} from '@/ui/components/modalFocus';
import EmojiPicker from '@/ui/components/EmojiPicker.vue';
import BatchDeleteDialog from '@/ui/components/BatchDeleteDialog.vue';
import {canSelectMessage,canDeleteMessage,selectionText,readBatchDelete,pauseBatchDelete} from '@/chat/batchDelete';
import ChatMessageText from '@/ui/components/ChatMessageText.vue';
import {useConversationViewport} from '@/ui/useConversationViewport';
defineOptions({name:'ChatView'});
const viewActive=ref(true),quoteView=ref(false);
const route = useRoute();
const router=useRouter();
const session = useSessionStore(), chat = useChatStore(), ui = useUiStore();
const data=useDataStore();
const peer=computed(()=>typeof route.query.peer==='string'?route.query.peer:'');
watch(()=>chat.messages.map(m=>m.id),ids=>pruneChatTransfers(session.user?.username||'',ids));
const transfers=computed(()=>chatTransfers(session.user?.username||'',peer.value).filter(j=>!j.messageId||!chat.messages.some(m=>m.id===j.messageId)));
async function pickTransferSource(job:ChatTransfer,event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(file)await job.resumeWith(file);}
const transferSize=(size:number)=>size>=1048576?(size/1048576).toFixed(1)+' MB':Math.ceil(size/1024)+' KB';
const isAssistant=computed(()=>!!peer.value&&peer.value===session.user?.username);
const isDirect=computed(()=>!!peer.value);
const conversationName=computed(()=>isAssistant.value?'文件传输助手':isDirect.value?name(peer.value):'工作群');
const announcementUnread=computed(()=>data.account===session.user?.username?data.notifications.filter(n=>isAnnouncementNotice(n)&&!n.read_at&&!n.acked_at&&!n.hidden_at).length:0);
const filter = ref<ChatFilter>({}), searchText = ref(''), searchOpen = ref(false);
const query = useChatQuery(computed(() => session.user?.username || ''), filter);
const filterActive = query.active, queryLoading = query.loading, queryError = query.error;
const showQuery=computed(()=>filterActive.value&&!quoteView.value);
const contextMessages=ref<ChatMessage[]>([]), contextHasOlder=ref(false), contextHasNewer=ref(false), contextBusy=ref(false);
type ContextRequest='older'|'newer'|'refresh';
const contextFailures=ref<Record<ContextRequest,string>>({older:'',newer:'',refresh:''});
const contextRetry=computed<ContextRequest>(()=>contextFailures.value.refresh?'refresh':contextFailures.value.older?'older':'newer');
const contextError=computed(()=>contextFailures.value[contextRetry.value]);
let contextRefreshPending=false;
let contextCursor=0,contextTarget='',contextController:AbortController|null=null,contextPositionLock='';
const canLoadOlder = computed(() => quoteView.value ? contextHasOlder.value : showQuery.value ? query.hasOlder.value : chat.canLoadOlder);
const listLoading = computed(() => quoteView.value ? locatingDate.value||contextBusy.value : showQuery.value ? query.loading.value : chat.loading);
function contextNumber(c:ChatContext){return c.short_no?'#'+c.short_no:c.work_title?.match(/^#\d+/)?.[0]||(c.work_item_id?'查看工作':'项目');}
function contextTitle(c:ChatContext){return (c.work_title||c.project_title||'').replace(/^#\d+\s*[·：:]?\s*/,'').slice(0,36);}
function openContext(c:ChatContext){void router.push(c.work_item_id?{name:'work-detail',params:{id:c.work_item_id},query:{project:c.project_id,returnTo:route.fullPath}}:{name:'work',query:{project:c.project_id,returnTo:route.fullPath}});}
function searchMessages() { dismissQuoteInspection();filter.value = { ...filter.value, q: searchText.value.trim() || undefined }; }
function closeMessageSearch() { clearFilter();searchOpen.value=false; }
function clearFilter() { dismissQuoteInspection();filter.value = peer.value?{peer:peer.value}:{}; searchText.value = ''; historyDate.value=''; historyNote.value=''; }
const body = ref(''), mentions = ref<string[]>([]), reply = ref<ChatMessage | null>(null), showMembers = ref(false);
const composerLoaded=ref(false);
const viewResumeBusy=ref(false),viewResumeError=ref('');
let viewResumeReady=false,viewResumeScope:{account:string;peer:string}|null=null,pendingViewResume:ChatViewResume|null=null,viewResumeController:AbortController|null=null;
type AttachmentDraft = { mentions: string[]; replyId?: string; projectId?: string | null; workItemId?: string | null };
const mentionSelection=ref<string[]>([]);
let mentionRange:{start:number;end:number}|null=null;
function openMentionPicker(range:{start:number;end:number}|null=null){
 mentionRange=range;mentionSelection.value=[];showMembers.value=true;toolsOpen.value=false;input.value?.blur();
 void chat.refreshMembers();
}
function composerInput(event:Event){
 resizeInput();const el=event.target as HTMLTextAreaElement,pos=el.selectionStart;
 if((event as InputEvent).isComposing)return;
 if((event as InputEvent).inputType==='insertText'&&body.value.slice(pos-1,pos)==='@')openMentionPicker({start:pos-1,end:pos});
}
function confirmMentions(){
 const chosen=chat.members.filter(m=>mentionSelection.value.includes(m.username));
 if(!chosen.length)return;
 const el=input.value,start=mentionRange?.start??el?.selectionStart??body.value.length,end=mentionRange?.end??start;
 const insert=chosen.map(m=>'@'+(m.nickname||m.username)).join(' ')+' ';
 body.value=body.value.slice(0,start)+insert+body.value.slice(end);
 mentions.value=[...new Set([...mentions.value,...chosen.map(m=>m.username)])];
 showMembers.value=false;mentionRange=null;
 void nextTick(()=>{el?.focus();el?.setSelectionRange(start+insert.length,start+insert.length);});
}
function cancelMentions(){showMembers.value=false;mentionRange=null;}
watch(body,text=>{mentions.value=mentions.value.filter(id=>text.includes('@'+name(id)));});
const attachmentDraft = ref<AttachmentDraft | null>(null);
// Uploading an audio file and creating its chat message are separate
// operations. Keep both the attachment and its frozen context until receipt.
type PendingAttachment = { attachment: ChatAttachment; draft: AttachmentDraft };
const pendingAttachment = ref<PendingAttachment | null>(null);
const statusOpen = ref(false);
useModeBack(statusOpen,()=>{statusOpen.value=false;});
// Local time labels only; this clock never reads members or business messages.
const presenceClock=setInterval(()=>{if(statusOpen.value)clockNow.value=Date.now();},60000);onUnmounted(()=>clearInterval(presenceClock));
const selectedContext = ref<ChatContext | null>(null), contextExplicit = ref(false), contextPicker = ref(false);
const recordPicker = ref(false), recordOpen = ref(false), recordContext = ref<ChatContext|null>(null), recordMessage = ref<ChatMessage|null>(null), recordSummary = ref(''), recordBusy = ref(false), recordError = ref('');
const recordClient=new NativeClient({base:serviceOrigin(),onUnauthorized:()=>session.onUnauthorized()});
const recordWrite = usePendingWrite<{project_id:string;work_item_id:string;message:ChatMessage;summary:string}>('company','chat-work-record','group');
function chooseContext(value: ChatContext|null) { selectedContext.value=value; contextExplicit.value=true; contextPicker.value=false; toolsOpen.value=false; }
function openRecord() {
  if (!actionMessage.value) return;
  recordMessage.value=actionMessage.value; recordContext.value=null; recordSummary.value=actionMessage.value?.body || ''; recordError.value=''; recordOpen.value=true; closeMessageActions(false);
  if(recordWrite.pending.value)recordSummary.value=recordWrite.pending.value.body.summary;
}
async function saveRecord() {
  if(recordBusy.value||!recordWrite.valid()||!recordWrite.pending.value&&(!recordContext.value?.work_item_id||!recordMessage.value||!recordSummary.value.trim()))return;
  recordBusy.value=true;recordError.value='';
  try { const op=recordWrite.start({project_id:recordContext.value?.project_id||'',work_item_id:recordContext.value?.work_item_id||'',message:recordMessage.value!,summary:recordSummary.value.trim()});
    await recordClient.session();
    const checkpoint='qn.native.discussion.'+recordWrite.account+'.'+op.key;
    await saveDiscussionRecord(recordClient,op.body,op.key,{valid:recordWrite.valid,load:()=>JSON.parse(localStorage.getItem(checkpoint)||'null'),save:(value:unknown)=>localStorage.setItem(checkpoint,JSON.stringify(value))});
    if(recordWrite.valid())localStorage.removeItem(checkpoint); if(!recordWrite.valid())return;recordWrite.finish();recordOpen.value=false;ui.toast('已保存到工作记录');
  } catch(e){if(recordWrite.valid())recordError.value=e instanceof Error?e.message:'记录未确认，请重试';}
  finally{recordBusy.value=false;}
}

const uploading = ref(false);
const attachmentActive = ref(false);
const textReader=ref<ChatMessage|null>(null);
function readText(message:ChatMessage){if(selecting.value||!message.body||message.hidden||message.recalled)return;closeMessageActions(false);textReader.value=JSON.parse(JSON.stringify(message));}
async function copyReaderText(){const message=textReader.value,owner=session.user?.username;if(!message)return;try{await navigator.clipboard.writeText(message.body);if(owner===session.user?.username)ui.toast('已复制');}catch{if(owner===session.user?.username)ui.toast('暂时无法复制，请检查剪贴板权限',true);}}
watch(()=>session.user?.username,()=>{textReader.value=null;});
const highlighted = ref('');
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
const actionMessage = ref<ChatMessage | null>(null), actionPanel = ref<HTMLElement | null>(null);
type Transcript = { phase: string; text: string; error: string; loading: boolean; visible: boolean; messageId: string };
const transcripts = ref<Record<string, Transcript>>({});
const transcriptRequests = new Map<string, AbortController>();
const transcriptKey = (a: ChatAttachment) => `${a.id}:${a.ver}:${a.sha256}`;
const actionVoices = computed(() => actionMessage.value && !actionMessage.value.hidden && !actionMessage.value.recalled ? actionMessage.value.attachments.filter(isVoiceMessage) : []);
function clearTranscripts() { transcriptRequests.forEach(r => r.abort()); transcriptRequests.clear(); transcripts.value = {}; }
function transcriptViewKey(){return 'qn.transcript-views:'+session.user?.username;}
function savedTranscriptViews():Record<string,string>{try{return JSON.parse(localStorage.getItem(transcriptViewKey())||'{}');}catch{return {};}}
function rememberTranscriptView(key:string,messageId?:string){
 if(!session.user?.username)return;const choices=savedTranscriptViews();if(messageId)choices[key]=messageId;else delete choices[key];
 try{localStorage.setItem(transcriptViewKey(),JSON.stringify(choices));}catch{}
}
function restoreTranscriptViews(){
 const account=session.user?.username;if(!account||!session.businessReady)return;
 for(const [key,messageId] of Object.entries(savedTranscriptViews())){
  if(transcripts.value[key])continue;
  const m=messageMap.value.get(messageId),a=m?.attachments.find(a=>transcriptKey(a)===key&&isVoiceMessage(a));if(!m||m.hidden||m.recalled||!a)continue;
  const request=new AbortController();transcriptRequests.set(key,request);
  transcripts.value[key]={phase:'正在恢复转写结果…',text:'',error:'',loading:true,visible:true,messageId};
  void readExistingVoiceTranscript(a.id,request.signal).then(result=>{if(!request.signal.aborted&&session.user?.username===account&&transcriptRequests.get(key)===request)transcripts.value[key].text=result.text;})
  .catch(e=>{if(!request.signal.aborted&&session.user?.username===account&&transcriptRequests.get(key)===request)transcripts.value[key].error=e instanceof Error?e.message:'原结果读取失败，请重试';})
  .finally(()=>{if(transcriptRequests.get(key)===request){transcriptRequests.delete(key);if(transcripts.value[key])transcripts.value[key].loading=false;}});
 }
}

function hideTranscript(a: ChatAttachment) {
  const key = transcriptKey(a); rememberTranscriptView(key); transcriptRequests.get(key)?.abort(); transcriptRequests.delete(key);
  if (transcripts.value[key]) { transcripts.value[key].visible = false; transcripts.value[key].loading = false; }
}
async function convertVoice(message: ChatMessage, a: ChatAttachment) {
  closeMessageActions(false);
  if (!online.value || message.hidden || message.recalled || !isVoiceMessage(a)) return;
  rememberTranscriptView(transcriptKey(a),message.id);
  const key = transcriptKey(a), account = session.user?.username;
  const old = transcripts.value[key];
  if (old) { old.visible = true; if (old.text || old.loading) return; }
  const request = new AbortController(); transcriptRequests.set(key, request);
  transcripts.value[key] = { phase: '正在识别…', text: '', error: '', loading: true, visible: true, messageId: message.id };
  try {
    const result = await transcribeVoice(a.id, request.signal,()=>{if(!request.signal.aborted&&transcriptRequests.get(key)===request&&session.user?.username===account)transcripts.value[key].phase='正在识别…';},a);
    if (request.signal.aborted || session.user?.username !== account || transcriptRequests.get(key) !== request) return;
    transcripts.value[key].text = result.text;
  } catch (e) {
    if (!request.signal.aborted && session.user?.username === account && transcriptRequests.get(key) === request)
      transcripts.value[key].error = userError(e,'转文字失败，请重试');
  } finally {
    if (transcriptRequests.get(key) === request) { transcriptRequests.delete(key); if (transcripts.value[key]) transcripts.value[key].loading = false; }
  }
}
watch(() => session.user?.username, clearTranscripts);
function reconcileTranscriptViews(){
  for (const [key, state] of Object.entries(transcripts.value)) {
    const message = messageMap.value.get(state.messageId);
    if (!message || message.hidden || message.recalled || !message.attachments.some(a => transcriptKey(a) === key)) {
      transcriptRequests.get(key)?.abort(); transcriptRequests.delete(key); delete transcripts.value[key];
    }
  }
  restoreTranscriptViews();
}
watch(() => session.businessReady,restoreTranscriptViews);
onMounted(restoreTranscriptViews);
onUnmounted(clearTranscripts);
const menuStyle = ref<CSSProperties>({ visibility: 'hidden' });
const menuSide = ref<'above' | 'below'>('above');
const menuKeyboard = ref(false),actionKind=ref<'message'|'quote'>('message');
let menuFrame = 0;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressX = 0, pressY = 0, actionOrigin: HTMLElement | null = null;
let suppressMessageClick = false;
function cancelPress() { clearTimeout(pressTimer); pressTimer = undefined; }
function openMessageActions(message: ChatMessage, origin: EventTarget | null, keyboard = false,kind:'message'|'quote'='message') {
  if(selecting.value)return;
  actionKind.value=kind;menuKeyboard.value = keyboard;
  cancelPress(); actionOrigin = origin instanceof HTMLElement ? origin : null;
  // Clear an existing native range before showing app actions; inputs remain selectable.
  const selection = window.getSelection();
  if (selection?.anchorNode && (stream.value?.contains(selection.anchorNode) || actionPanel.value?.contains(selection.anchorNode))) selection.removeAllRanges();
  menuStyle.value = { visibility: 'hidden' }; actionMessage.value = message;
  void nextTick(async () => {
    positionMessageActions();
    await nextTick();
    if (actionMessage.value?.id !== message.id) return;
    (actionPanel.value?.querySelector<HTMLButtonElement>('button:not(:disabled)') || actionPanel.value)?.focus({ preventScroll: true });
  });
}
function positionMessageActions() {
  if (!actionMessage.value || !actionPanel.value || !actionOrigin?.isConnected) return;
  const view = window.visualViewport, panel = actionPanel.value;
  const leftEdge = (view?.offsetLeft || 0) + 12, rightEdge = (view?.offsetLeft || 0) + (view?.width || window.innerWidth) - 12;
  const streamBox = stream.value?.getBoundingClientRect();
  const topEdge = Math.max((view?.offsetTop || 0) + 12, (streamBox?.top || 0) + 8);
  const bottomEdge = Math.min((view?.offsetTop || 0) + (view?.height || window.innerHeight) - 12, streamBox?.bottom || Infinity);
  const box = actionOrigin.getBoundingClientRect();
  if (box.bottom <= topEdge || box.top >= bottomEdge) { closeMessageActions(false); return; }
  panel.style.maxWidth = Math.max(0, rightEdge - leftEdge) + 'px';
  panel.style.maxHeight = Math.max(0, bottomEdge - topEdge) + 'px';
  const width = panel.offsetWidth, height = panel.offsetHeight, gap = 10;
  const anchorTop = Math.max(box.top, topEdge), anchorBottom = Math.min(box.bottom, bottomEdge);
  const above = anchorTop - topEdge, below = bottomEdge - anchorBottom;
  menuSide.value = above >= height + gap || above >= below ? 'above' : 'below';
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  const left = clamp(box.left + box.width / 2 - width / 2, leftEdge, rightEdge - width);
  const top = clamp(menuSide.value === 'above' ? anchorTop - height - gap : anchorBottom + gap, topEdge, bottomEdge - height);
  menuStyle.value = { left: left + 'px', top: top + 'px', maxWidth: panel.style.maxWidth, maxHeight: panel.style.maxHeight, '--menu-origin': menuSide.value === 'above' ? 'bottom' : 'top', '--menu-arrow-x': clamp(box.left + box.width / 2 - left, 16, width - 16) + 'px' };
}
function scheduleMenuPosition() { cancelAnimationFrame(menuFrame); menuFrame = requestAnimationFrame(positionMessageActions); }
watch(actionMessage, () => { void nextTick(scheduleMenuPosition); });
function startPress(event: PointerEvent, message: ChatMessage) {
  if(selecting.value)return;
  suppressMessageClick = false;
  const target = event.target as HTMLElement;
  if (event.button !== 0 || (target.closest('a,button,audio,video,input') && !target.closest('[data-message-action]'))) return;
  cancelPress(); pressX = event.clientX; pressY = event.clientY;
  const origin = event.currentTarget;
  pressTimer = setTimeout(() => { suppressMessageClick = true; openMessageActions(message, origin); }, 450);
}
function movePress(event: PointerEvent) { if (!pressTimer) return; if (Math.hypot(event.clientX - pressX, event.clientY - pressY) > 10) { suppressMessageClick = true; cancelPress(); } }
function messageClick(event: MouseEvent,message:ChatMessage) {
  if (event.target instanceof Element && event.target.closest('.voice-transcript')) { suppressMessageClick = false; return; }
  if (suppressMessageClick && event.detail !== 0) { event.preventDefault(); event.stopPropagation();suppressMessageClick=false;return; }
  suppressMessageClick = false;
  if(showQuery.value&&!message.attachments.length&&!(event.target instanceof Element&&event.target.closest('a,button,audio,video,input,.voice-transcript'))){event.preventDefault();event.stopPropagation();void locateReply(message.id);}
}
function openQuoteActions(message:ChatMessage,event:Event,keyboard=false){if(!message.reply_to)return;openMessageActions(message,event.currentTarget,keyboard,'quote');}
function startQuotePress(message:ChatMessage,event:PointerEvent){
 suppressMessageClick=false;if(event.button!==0||selecting.value)return;
 cancelPress();pressX=event.clientX;pressY=event.clientY;const origin=event.currentTarget;
 if(message.reply_to)pressTimer=setTimeout(()=>{suppressMessageClick=true;openMessageActions(message,origin,false,'quote');},450);
}
function quoteClick(message:ChatMessage,event:MouseEvent){
 if(suppressMessageClick&&event.detail!==0){suppressMessageClick=false;return;}
 if(event.detail===0){openQuoteActions(message,event,true);return;}
 if(message.reply_to)void locateReply(message.reply_to.id);
}
function locateActionMessage(){const message=actionMessage.value,id=actionKind.value==='quote'?message?.reply_to?.id:message?.id;closeMessageActions(false);if(id)void locateReply(id);}
function closeMessageActions(restoreFocus = true) {
  const active = document.activeElement;
  if (active instanceof HTMLElement && actionPanel.value?.contains(active)) active.blur();
  actionMessage.value = null;
  // Restore focus only for keyboard users. Touch dismissal must not focus the
  // entire media wrapper and leave a large focus rectangle after the menu closes.
  if (restoreFocus && menuKeyboard.value) actionOrigin?.focus({ preventScroll: true });
  actionOrigin = null;
}
function replyToMessage() {
  if (!actionMessage.value || !ready.value) return;
  voiceMode.value = false;
  reply.value = actionMessage.value; selectedContext.value=actionMessage.value.context || null; contextExplicit.value=false; closeMessageActions(false);
  void nextTick(() => input.value?.focus());
}
async function copyMessage() {
  const message = actionMessage.value, account = session.user?.username;
  if (!message?.body) return;
  try { await navigator.clipboard.writeText(message.body); if (session.user?.username === account) ui.toast('已复制'); }
  catch { if (session.user?.username === account) ui.toast('暂时无法复制，请检查剪贴板权限', true); }
  if (session.user?.username === account) closeMessageActions();
}
function menuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); closeMessageActions(); }
  if (event.key !== 'Tab') return;
  const items = [...(actionPanel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
  if (!items.length) return;
  const position = items.indexOf(document.activeElement as HTMLButtonElement);
  event.preventDefault(); items[(position + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
}

const emojiOpen=ref(false);let emojiStart=0,emojiEnd=0;
function toggleEmoji(){if(holdingVoice.value||uploading.value||!composerLoaded.value)return;if(emojiOpen.value){closeEmoji();return;}emojiStart=input.value?.selectionStart??body.value.length;emojiEnd=input.value?.selectionEnd??emojiStart;voiceMode.value=false;toolsOpen.value=false;emojiOpen.value=true;input.value?.blur();}
function closeEmoji(){emojiOpen.value=false;void nextTick(()=>{input.value?.focus();input.value?.setSelectionRange(emojiStart,emojiEnd);});}
function insertEmoji(value:string){if(!ready.value)return;const start=Math.min(emojiStart,body.value.length),end=Math.min(Math.max(start,emojiEnd),body.value.length),text=body.value.slice(0,start)+value+body.value.slice(end);if(text.length>4000){ui.toast('消息文字已达到长度上限');return;}body.value=text;emojiStart=emojiEnd=start+value.length;void nextTick(()=>input.value?.setSelectionRange(emojiStart,emojiEnd));}
useModeBack(emojiOpen,closeEmoji);
const pasteImage=ref<{file:File;url:string;account:string;peer:string}|null>(null);
function clearPasteImage(){if(pasteImage.value)URL.revokeObjectURL(pasteImage.value.url);pasteImage.value=null;}
function composerPaste(event:ClipboardEvent){const files=[...(event.clipboardData?.files||[])];if(!files.length)return;event.preventDefault();if(!ready.value||uploading.value||holdingVoice.value||attachmentActive.value){ui.toast('请先完成当前消息或文件操作');return;}if(files.length!==1||!/^image\/(png|jpeg|gif|webp)$/i.test(files[0].type)){ui.toast('请通过相册或文件入口发送这些内容');return;}const file=files[0];if(!file.size||file.size>32*1024*1024){ui.toast('请粘贴32MB以内的图片，较大图片可通过相册发送');return;}clearPasteImage();pasteImage.value={file,url:URL.createObjectURL(file),account:session.user?.username||'',peer:peer.value};}
function sendPasteImage(){const pending=pasteImage.value;if(!pending||pending.account!==session.user?.username||pending.peer!==peer.value||!ready.value||uploading.value)return;if(attachmentPicker.value?.sendFile(pending.file))clearPasteImage();else ui.toast('请先处理当前文件操作');}
watch([()=>session.user?.username,peer],()=>{emojiOpen.value=false;clearPasteImage();});onUnmounted(clearPasteImage);
const toolsOpen = ref(false), historyOpen = ref(false);
useModeBack(toolsOpen,()=>{toolsOpen.value=false;});
const voiceMode = ref(false), holdingVoice = ref(false), cancelVoiceHold = ref(false), keyboardVoice = ref(false);
const voiceCapture = ref({ recording: false, seconds: 0 });
type PickerScope={account:string;peer:string};
function pickerBusy(value:boolean,scope:PickerScope){if(sameComposerScope(scope,session.user?.username,peer.value)){uploading.value=value;if(!value&&!voiceCapture.value.recording)keyboardVoice.value=false;}}
function pickerActive(value:boolean,scope:PickerScope){if(sameComposerScope(scope,session.user?.username,peer.value))attachmentActive.value=value;}
function pickerCapture(state:PickerScope&{recording:boolean;seconds:number}){if(sameComposerScope(state,session.user?.username,peer.value)){if(voiceCapture.value.recording&&!state.recording)keyboardVoice.value=false;voiceCapture.value={recording:state.recording,seconds:state.seconds};}}
let holdStartY = 0;
function toggleVoiceMode() {
  emojiOpen.value=false;
  voiceMode.value = !voiceMode.value;
  if (voiceMode.value) { toolsOpen.value = false; showMembers.value = false; input.value?.blur(); } else void nextTick(() => input.value?.focus());
}
function beginKeyboardVoice(){if(!ready.value||uploading.value||chat.pending)return;keyboardVoice.value=true;void startVoice();}
function cancelKeyboardVoice(){keyboardVoice.value=false;attachmentPicker.value?.stop(true);}
function beginVoiceHold(event: PointerEvent) {
  if (event.button !== 0 || !ready.value || uploading.value) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  holdStartY = event.clientY; holdingVoice.value = true; cancelVoiceHold.value = false;
  void startVoice();
}
function moveVoiceHold(event: PointerEvent) { if (holdingVoice.value) cancelVoiceHold.value = holdStartY - event.clientY > 48; }
function endVoiceHold(cancel = false) {
  if (!holdingVoice.value) return;
  attachmentPicker.value?.stop(cancel || cancelVoiceHold.value);
  holdingVoice.value = false; cancelVoiceHold.value = false;
}
const input = ref<HTMLTextAreaElement | null>(null);
const stream = ref<HTMLElement | null>(null);
const reading=useConversationViewport(stream,input);
const resizeInput=reading.resize;
type ReadingPoint={account:string;peer:string;generation:number;anchor:ReturnType<typeof reading.capture>;unread:number;filtered:boolean;latest?:boolean};
const quoteOrigin=ref<ReadingPoint|null>(null);
let quoteGeneration=0,returnRevision=0;
const restoringQuote=ref(false);
function readingPoint():ReadingPoint{return {account:chat.account,peer:chat.peer,generation:threadGeneration,anchor:reading.capture(true),unread:unreadBelow.value,filtered:showQuery.value,latest:atLatest.value};}
function pointValid(point:ReadingPoint){return point.account===session.user?.username&&point.account===chat.account&&point.peer===chat.peer&&point.peer===peer.value&&point.generation===threadGeneration&&route.name==='chat';}
function stopReturnRestore(){cancelViewResume();returnRevision++;restoringQuote.value=false;contextPositionLock='';}
function readingGesture(event:KeyboardEvent){if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))stopReturnRestore();}
function dismissQuoteInspection(){cancelViewResume();quoteGeneration++;returnRevision++;contextController?.abort();contextController=null;contextRefreshPending=false;contextMessages.value=[];contextHasOlder.value=false;contextHasNewer.value=false;contextBusy.value=false;contextFailures.value={older:'',newer:'',refresh:''};contextTarget='';contextPositionLock='';quoteView.value=false;quoteOrigin.value=null;locatingDate.value=false;restoringQuote.value=false;}
async function restoreReadingPoint(point:ReadingPoint){
 if(!pointValid(point))return;
 atLatest.value=false;reading.restore(point.anchor);
 const el=stream.value;if(el)atLatest.value=el.scrollHeight-el.scrollTop-el.clientHeight<80;
 unreadBelow.value=point.filtered?point.unread:Math.max(point.unread,unreadBelow.value);
}
async function returnFromQuote(){
 const point=quoteOrigin.value;if(!point)return;
 dismissQuoteInspection();const revision=returnRevision;restoringQuote.value=true;
 await nextTick();if(revision===returnRevision)await restoreReadingPoint(point);
 if(revision===returnRevision)restoringQuote.value=false;
}
useModeBack(quoteView,()=>{void returnFromQuote();});
function toggleTools() { emojiOpen.value=false;if (holdingVoice.value) return; toolsOpen.value = !toolsOpen.value; if (toolsOpen.value) { voiceMode.value = false; input.value?.blur(); } }
const atLatest = reading.atLatest, unreadBelow = ref(0),entryUnread=ref(0);
const memberFilterOpen=ref(false);
const filteredMemberName=computed(()=>filter.value.author?name(filter.value.author):'');
function chooseMemberFilter(actor:string){dismissQuoteInspection();filter.value={...filter.value,author:actor||undefined};memberFilterOpen.value=false;returnToLatest();}
useOutsideDismiss(statusOpen, '.member-count,#chat-member-status', () => { statusOpen.value = false; });
function submitHistorySearch(value:string) {searchText.value=value;searchMessages();searchOpen.value=true;}
const kindLabels={media:'图片与视频',files:'文件',links:'链接',voice:'语音'};
function chooseHistoryCategory(value:'all'|'members'|'date'|'files'|'media'|'links'|'voice'|'mentions'|'replies',text:string) {
  if(value==='all'){clearFilter();searchText.value=text;filter.value={...(peer.value?{peer:peer.value}:{}),q:text.trim()||undefined};return;}
  dismissQuoteInspection();searchText.value=text;const q=text.trim()||undefined;
  if(value==='members'){filter.value={...filter.value,q};memberFilterOpen.value=true;if(!chat.members.length)void chat.refreshMembers();}
  else if(value==='date'){filter.value={...filter.value,q};historyOpen.value=true;}
  else if(value==='mentions'||value==='replies')filter.value={...filter.value,q,related:filter.value.related===value?undefined:value};
  else filter.value={...filter.value,q,kind:filter.value.kind===value?undefined:value};
}
function openChatSearch(){if(quoteView.value)void returnFromQuote();searchOpen.value=true;}
useModeBack(searchOpen,closeMessageSearch);

function openAnnouncementEntry(){
  void router.push({name:'announcements'});
}

useOutsideDismiss(computed(() => toolsOpen.value && !attachmentActive.value), '.composer-expanded,.composer-more', () => { toolsOpen.value = false; showMembers.value = false; });
function returnToLatest() { atLatest.value = true; unreadBelow.value = 0; scrollToLatest(); }
function showLatestMessages(){clearFilter();entryUnread.value=0;returnToLatest();}
const scrollToLatest=reading.bottom;
function focusInput() { emojiOpen.value=false;stopReturnRestore();if (!uploading.value) toolsOpen.value = false; unreadBelow.value=0; reading.focus(); }
watch(body, () => { void nextTick(() => { resizeInput(); if (atLatest.value) scrollToLatest(); }); });
const historyDate = ref(''), locatingDate = ref(false), historyNote = ref('');
const messageDateBounds=computed(()=>{const now=new Date();const today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;return {min:'2000-01-01',max:today};});
function confirmHistoryDate(date:string){dismissQuoteInspection();historyDate.value=date;historyOpen.value=false;const start=new Date(date+'T00:00:00'),next=new Date(start);next.setDate(next.getDate()+1);filter.value={...filter.value,created_from:start.getTime(),created_until:next.getTime()};historyNote.value='查找日期：'+date;}
const attachments = ref<ForwardAttachment[]>([]);
const renameDraft=ref<ForwardAttachment>(),draftName=ref(''),fileStage=ref('');
async function saveDraftName(){
 const old=renameDraft.value;if(!old)return;
 const name=draftName.value.normalize('NFC').trim(),ext=(n:string)=>n.lastIndexOf('.')>0?n.slice(n.lastIndexOf('.')).toLowerCase():'';
 if(!name||[...name].length>160||/[\\/\x00-\x1f\x7f]/.test(name)||ext(name)!==ext(old.name)){ui.toast('请输入文件名并保留原扩展名');return;}
 try{const next=isCloudForward(old)?{...old,name}:(await renameChatFile(old.id,name)).attachment;
  attachments.value=attachments.value.map(a=>a.id===old.id?next:a);renameDraft.value=undefined;
  if(session.user?.username)try{updateForward(session.user.username,next);}catch(e){ui.toast('名称已改，但'+(e instanceof Error?e.message:'本机草稿更新失败'));}
 }catch(e){ui.toast(e instanceof Error?e.message:'改名失败');}
}
function acceptForward(){if(!session.user?.username||isDirect.value)return;try{attachments.value.push(...pendingForwards(session.user.username,6-attachments.value.length,attachments.value.map(a=>a.id)));}catch(e){ui.toast(e instanceof Error?e.message:'群附件暂时无法加入输入栏');}}
function removeDraftAttachment(id:string){attachments.value=attachments.value.filter(a=>a.id!==id);if(session.user?.username)try{removeForwards(session.user.username,[id]);}catch(e){ui.toast(e instanceof Error?e.message:'无法移除待发送附件');}acceptForward();}
onMounted(()=>{acceptForward();window.addEventListener('qn-file-forward',acceptForward);});onUnmounted(()=>window.removeEventListener('qn-file-forward',acceptForward));
useVisibleChatReads(stream, computed(() => session.user?.username || ''));
// HTTP availability does not depend on SSE or unrelated work-list synchronization.
const online = computed(() => session.isAuthenticated && session.link.networkUp);
// Cached identity recovery disables writes without asserting physical network loss.
const confirmedOffline = computed(() => session.status==='offline' && session.link.networkUp===false);
const belongs = computed(() => chat.account === session.user?.username);
// 撤回是对群成员立即生效的删除语义；不把服务端的 recalled 占位投影成一条系统消息。
const messages = computed(() => belongs.value ? (quoteView.value ? contextMessages.value : showQuery.value ? query.messages.value : chat.messages).filter(message => !message.hidden && !message.recalled) : []);
watch(messages,()=>{if(textReader.value){const message=messages.value.find(m=>m.id===textReader.value?.id)||chat.messages.find(m=>m.id===textReader.value?.id);if(!message||message.hidden||message.recalled)textReader.value=null;}},{deep:true});
let selectionRevision=0;
const forwardChoiceRows=ref<ChatMessage[]|null>(null),mergedMessages=ref<ChatMessage[]|null>(null),mergedPending=ref(false);
function updateMergedPending(){try{mergedPending.value=!!readMergedForward(session.user?.username||'');}catch{mergedPending.value=true;}}
function openMerged(rows:ChatMessage[]){closeMessageActions(false);forwardChoiceRows.value=null;mergedMessages.value=JSON.parse(JSON.stringify(rows));}
function chooseForward(mode:'individual'|'merged'){const rows=forwardChoiceRows.value;if(!rows)return;forwardChoiceRows.value=null;if(mode==='merged')openMerged(rows);else if(rows.some(m=>m.attachments.length))openBatchForward(rows);else openForward(rows);}
const selecting=ref(false),selectedIds=ref<string[]>([]),forwardMessages=ref<ChatMessage[]|null>(null),forwardPending=ref(false);
const mediaForwardMessage=ref<ChatMessage|null>(null),mediaForwardOpen=ref(false),mediaForwardPending=ref(false);
function updateMediaForwardPending(){try{mediaForwardPending.value=!!readMediaForward(session.user?.username||'');}catch{mediaForwardPending.value=true;}}
function openMediaForward(message:ChatMessage|null){if(message?.attachments.some(isChatRecord)){openMerged([message]);return;}closeMessageActions(false);input.value?.blur();mediaForwardMessage.value=message?JSON.parse(JSON.stringify(message)):null;mediaForwardOpen.value=true;}
const batchForwardMessages=ref<ChatMessage[]>([]),batchForwardOpen=ref(false),batchForwardPending=ref(false);
function updateBatchForwardPending(){try{batchForwardPending.value=!!readBatchForward(session.user?.username||'');}catch{batchForwardPending.value=true;}}
function openBatchForward(rows:ChatMessage[]){closeMessageActions(false);input.value?.blur();batchForwardMessages.value=JSON.parse(JSON.stringify(rows));batchForwardOpen.value=true;}
const batchDeleteMessages=ref<ChatMessage[]>([]),batchDeleteOpen=ref(false),batchDeletePending=ref(false);
function updateBatchDeletePending(){try{batchDeletePending.value=!!readBatchDelete(session.user?.username||'');}catch{batchDeletePending.value=true;}}
function openBatchDelete(rows:ChatMessage[]){closeMessageActions(false);input.value?.blur();batchDeleteMessages.value=JSON.parse(JSON.stringify(rows));batchDeleteOpen.value=true;}
async function copySelected(){
 const owner=session.user?.username,target=peer.value,generation=threadGeneration,revision=selectionRevision;
 const valid=()=>owner===session.user?.username&&target===peer.value&&generation===threadGeneration&&revision===selectionRevision&&selecting.value&&viewActive.value&&route.name==='chat';
 try{const text=selectionText(selectedMessages.value);await navigator.clipboard.writeText(text);if(valid()){ui.toast('已复制所选文字');stopSelecting();}}
 catch(e){if(valid())ui.reportError(e,'暂时无法复制，请检查剪贴板权限');}
}
const selectedMessages=computed(()=>messages.value.filter(message=>selectedIds.value.includes(message.id)));
function stopSelecting(){selectionRevision++;selecting.value=false;selectedIds.value=[];void nextTick(resizeInput);}
useModeBack(selecting,stopSelecting);
function toggleSelection(message:ChatMessage){
 if(!canSelectMessage(message))return;
 if(selectedIds.value.includes(message.id)){selectedIds.value=selectedIds.value.filter(id=>id!==message.id);selectionRevision++;}
 else if(selectedIds.value.length<MAX_FORWARD_MESSAGES){selectedIds.value.push(message.id);selectionRevision++;}
 else ui.toast('一次最多选择20条消息');
}
function beginSelection(message:ChatMessage|null=actionMessage.value){
 if(!message)return;
 if(holdingVoice.value||uploading.value){ui.toast('请先完成当前录音或文件操作');return;}
 closeMessageActions(false);input.value?.blur();selectedIds.value=[];selectionRevision++;selecting.value=true;toggleSelection(message);
}
function selectionClick(event:MouseEvent,message:ChatMessage){if(!selecting.value)return;event.preventDefault();event.stopPropagation();toggleSelection(message);}
function selectionPointer(event:PointerEvent){if(selecting.value)event.stopPropagation();}
function selectionContext(event:MouseEvent){if(selecting.value){event.preventDefault();event.stopPropagation();}}
function updateForwardPending(){try{forwardPending.value=!!readTextForward(session.user?.username||'');}catch{forwardPending.value=true;}}
function openForward(rows:ChatMessage[]){
 closeMessageActions(false);input.value?.blur();forwardMessages.value=JSON.parse(JSON.stringify(rows));
}
function forwardOne(){const message=actionMessage.value;if(!message)return;if(message.attachments.some(isChatRecord))openMerged([message]);else if(canForwardText(message))openForward([message]);else if(canForwardMedia(message))openMediaForward(message);}
const selectionForwardError=computed(()=>{const blocked=selectedMessages.value.find(m=>!canForwardMessage(m));return blocked?forwardUnavailableReason(blocked):'';});
function forwardSelected(){const rows=selectedMessages.value;if(!rows.length)return;if(selectionForwardError.value){ui.toast(selectionForwardError.value,true);return;}forwardChoiceRows.value=JSON.parse(JSON.stringify(rows));}
function forwardDone(count:number){ui.toast(count>0?'已转发':'转发已完成');stopSelecting();updateForwardPending();}
watch(messages,()=>{const kept=selectedIds.value.filter(id=>messages.value.some(message=>message.id===id&&canSelectMessage(message)));if(kept.length!==selectedIds.value.length)selectionRevision++;selectedIds.value=kept;});
watch([()=>session.user?.username,peer],([owner],previous)=>{if(previous?.[0]&&previous[0]!==owner){pauseMediaForward(previous[0]);pauseBatchForward(previous[0]);pauseMergedForward(previous[0]);pauseBatchDelete(previous[0]);}stopSelecting();forwardChoiceRows.value=null;mergedMessages.value=null;forwardMessages.value=null;mediaForwardOpen.value=false;batchForwardOpen.value=false;updateMergedPending();updateForwardPending();updateMediaForwardPending();updateBatchForwardPending();updateBatchDeletePending();batchDeleteOpen.value=false;},{immediate:true});
onActivated(()=>{updateMergedPending();updateForwardPending();updateMediaForwardPending();updateBatchForwardPending();updateBatchDeletePending();});onDeactivated(()=>{batchDeleteOpen.value=false;stopSelecting();forwardChoiceRows.value=null;mergedMessages.value=null;forwardMessages.value=null;mediaForwardOpen.value=false;batchForwardOpen.value=false;});
const clockNow = ref(Date.now());
const timeMarkers = computed(() => chatTimeMarkers(messages.value));
const messageMap = computed(() => new Map(mergeContextMessages([...query.messages.value,...contextMessages.value,...chat.messages]).map(message=>[message.id,message])));
const quoteMap = computed(()=>new Map([...messageMap.value.values()].flatMap(m=>m.reply_to?[[m.reply_to.id,m.reply_to] as const]:[])));
// Search/context windows are real transcript sources too; unrelated root refresh
// must not abort their work or discard an already displayed result.
watch(messageMap,reconcileTranscriptViews,{deep:true});
function quote(message: ChatMessage) { return message.reply_to ? messageMap.value.get(message.reply_to.id) || message.reply_to : null; }
// A reply selected from search can outlive that result window. Its saved
// snapshot is editing state, so reconcile this one ID without adding history.
const replyChecking=ref(false),replyCheckError=ref('');
let replyCheckController:AbortController|null=null,replyCheckEpoch=0;
function cancelReplyCheck(){replyCheckEpoch++;replyCheckController?.abort();replyCheckController=null;replyChecking.value=false;replyCheckError.value='';}
function clearUnavailableDraftReply(){reply.value=null;if(!contextExplicit.value)selectedContext.value=null;}
async function refreshDraftReply(){
 const draft=reply.value;
 if(!composerLoaded.value||!draft){cancelReplyCheck();return;}
 const known=messageMap.value.get(draft.id)||quoteMap.value.get(draft.id);
 if(known){cancelReplyCheck();if(known.hidden||known.recalled)clearUnavailableDraftReply();return;}
 if(replyCheckController)return;
 const controller=new AbortController(),epoch=++replyCheckEpoch,generation=threadGeneration,account=session.user?.username,target=peer.value;
 replyCheckController=controller;replyChecking.value=true;replyCheckError.value='';
 const valid=()=>epoch===replyCheckEpoch&&!controller.signal.aborted&&generation===threadGeneration&&account===session.user?.username&&target===peer.value&&reply.value?.id===draft.id&&composerLoaded.value&&route.name==='chat';
 try{
  const current=(await communication.message(draft.id,controller.signal)).message;
  if(!valid())return;
  assertContextScope(current,target);if(current.id!==draft.id)throw Error('引用原消息返回不一致');
  if(current.hidden||current.recalled){clearUnavailableDraftReply();ui.toast('引用原消息已不可用，已保留草稿正文');}
  else reply.value=mergeContextMessages([draft,current])[0];
 }catch(e){if(valid())replyCheckError.value='引用原消息暂未核实，请重试或取消引用；草稿正文已保留。';}
 finally{if(epoch===replyCheckEpoch){replyCheckController=null;replyChecking.value=false;}}
}
watch([()=>reply.value?.id,composerLoaded],()=>{cancelReplyCheck();void refreshDraftReply();},{flush:'sync'});
watch(messageMap, () => {
  if (actionMessage.value) {
    const current = messageMap.value.get(actionMessage.value.id);
    if (!current || current.hidden) closeMessageActions(false); else actionMessage.value = current;
  }
  if (reply.value) {
    const current = messageMap.value.get(reply.value.id)||quoteMap.value.get(reply.value.id);
    if (current?.hidden || current?.recalled) clearUnavailableDraftReply();
    else void refreshDraftReply();
  }
}, { flush: 'sync' });
const ready = computed(() => composerLoaded.value && belongs.value && online.value && !chat.sending && !chat.pending && (!reply.value || !replyChecking.value && !replyCheckError.value));
watch(() => messages.value[messages.value.length - 1]?.id, async (_id, previous) => {
  if(viewResumeBusy.value||quoteView.value||locatingDate.value||restoringQuote.value)return;
  clockNow.value = Date.now();
  const el = stream.value; const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (!locatingDate.value && (!previous || (atLatest.value && nearBottom))) { await nextTick(); returnToLatest(); }
  else if (previous && _id !== previous) unreadBelow.value++;
});


function name(username: string) { const member = chat.members.find(m => m.username === username); return member?.nickname || username; }
const memberCount = computed(() => chat.members.length);
const statusReady = computed(() => chat.members.length > 0);
const sortedMembers=computed(()=>[...chat.members].sort(comparePresence));
const onlineMembers = computed(() => chat.members.filter(member => member.online === true));
const offlineMembers = computed(() => chat.members.filter(member => member.online !== true));
function statusText(member: (typeof chat.members)[number]) { return presenceStatus(member, clockNow.value); }
async function toggleStatus() {
  if(isAssistant.value)return;
  if(isDirect.value){void router.push({name:'member',params:{actor:peer.value}});return;}
  statusOpen.value = !statusOpen.value;clockNow.value=Date.now();
  if (statusOpen.value && online.value) await chat.refreshMembers(true);
}
async function refresh() { clockNow.value = Date.now(); if (viewActive.value && session.businessReady && online.value && document.visibilityState !== 'hidden') await Promise.all([chat.refresh(), query.refresh()]); }
watch(() => session.user?.username || '', async account => {
  cancelPress(); closeMessageActions(false);
  statusOpen.value = false;
  showMembers.value = false; searchOpen.value = false; toolsOpen.value = false;
  clearFilter(); selectedContext.value=null;contextExplicit.value=false;contextPicker.value=false;recordOpen.value=false;recordPicker.value=false;
  body.value = ''; mentions.value = []; attachments.value = []; reply.value = null; historyNote.value = ''; historyDate.value = '';
  acceptForward();
  attachmentDraft.value = null; pendingAttachment.value = null;
  voiceMode.value = false; keyboardVoice.value=false; holdingVoice.value = false; cancelVoiceHold.value = false;
  if (account && !chat.initialized) await refresh();
}, { immediate: true });
// Session liveLink owns network/foreground recovery and broadcasts one catch-up.

const attachmentPicker = ref<InstanceType<typeof ChatAttachmentPicker>>();
function captureAttachmentDraft(){
  attachmentDraft.value = {
    mentions: [...mentions.value],
    replyId: reply.value?.id,
    ...(contextExplicit.value ? selectedContext.value
      ? { projectId: selectedContext.value.project_id, workItemId: selectedContext.value.work_item_id || null }
      : { projectId: null, workItemId: null } : {}),
  };
}
function captureFileDraft(){captureAttachmentDraft();returnToLatest();}
async function startVoice() {
  if (!ready.value || uploading.value || chat.pending) return;
  // Freeze the association at the moment recording starts.  A user may change
  // the composer while the microphone is open; the resulting voice message
  // must still belong to the context they started it in.
  captureAttachmentDraft();
  toolsOpen.value=false; showMembers.value=false; input.value?.blur(); await attachmentPicker.value?.record({autoSend:true});
}
function deliveryBody(){return {...attachmentBody({id:''} as ChatAttachment,attachmentDraft.value||{mentions:[]}),attachment_ids:[]};}
function attachmentBody(attachment: ChatAttachment, draft: AttachmentDraft) {
  return { body:'', attachment_ids:[attachment.id], mention_usernames:draft.mentions,
    ...(draft.replyId ? { reply_to_id:draft.replyId } : {}),
    ...(draft.projectId !== undefined ? { project_id:draft.projectId, ...(draft.workItemId ? { work_item_id:draft.workItemId } : {}) } : {}) };
}
async function sendAttachment(attachment: ChatAttachment, draft: AttachmentDraft) {
  const message=attachmentBody(attachment,draft);
  pendingAttachment.value = { attachment, draft };
  if (chat.pending&&JSON.stringify(chat.pending.body)!==JSON.stringify(message) || chat.sending || !belongs.value || !online.value) {
    pendingAttachment.value = { attachment, draft };
    if (belongs.value) ui.toast('附件已上传，消息尚未发送；恢复后可重试', true);
    return false;
  }
  returnToLatest();
  const sent = await chat.send(chat.pending?undefined:message);
  if (sent) { pendingAttachment.value = null; attachmentPicker.value?.delivered(attachment.id); if(!isVoiceMessage(attachment)){toolsOpen.value=false;ui.toast('文件已发送');} }
  else {
    // A validation error clears the store's generic pending operation. Without
    // this UI-level intent, a successfully uploaded voice silently disappears.
    pendingAttachment.value = { attachment, draft };
    ui.toast(chat.error || '附件消息发送失败，请重试', true);
  }
  returnToLatest();
  return !!sent;
}
async function retryAttachment() {
  const pending = pendingAttachment.value;
  if (!pending || chat.sending || !belongs.value || !online.value) return;
  // An uncertain store operation must retain its original body and idempotency key.
  if (chat.pending) {
    const sent = await chat.send();
    if (sent) pendingAttachment.value = null;
    else ui.toast(chat.error || '附件消息发送失败，请重试', true);
    return;
  }
  await sendAttachment(pending.attachment, pending.draft);
}
async function addedAttachment(a: ChatAttachment) {
  const draft = attachmentDraft.value||pendingAttachment.value?.draft;
  if (!draft) return false;
  const sent=await sendAttachment(a,draft);if(sent)attachmentDraft.value=null;return sent;
}
async function send() {
  if (reply.value && (replyChecking.value || replyCheckError.value)) return;
  if (!composerLoaded.value || chat.sending || uploading.value || !online.value || !belongs.value || (!chat.pending && !body.value.trim() && !attachments.value.length)) return;
  const scope={account:session.user?.username||'',peer:peer.value},generation=threadGeneration;
  const valid=()=>sameComposerScope(scope,session.user?.username,peer.value)&&chat.account===scope.account&&chat.peer===scope.peer&&threadGeneration===generation&&viewActive.value&&route.name==='chat';
  if(!valid())return;
  returnToLatest();
  const submitted=composerSnapshot(),expected=JSON.parse(JSON.stringify(submitted)) as ComposerDraft;
  const operation=chat.pending?JSON.parse(JSON.stringify(chat.pending)):null,retrying=!!operation;
  const pendingText=operation?.body.body,pendingFiles=operation?.body.attachment_ids||[];
  let sentFiles=retrying?pendingFiles:submitted.attachments.map(a=>a.id);
  if(!retrying&&submitted.attachments.some(isCloudForward)){
   uploading.value=true;fileStage.value='正在准备群文件…';
   try{
    for(const draft of submitted.attachments){
     if(!isCloudForward(draft))continue;
     const source=draft.cloud_file,controller=new AbortController();
     const real=await shareCloudFile(source,controller.signal,stage=>{if(valid())fileStage.value=stage;},draft.name);
     if(!valid())return;
     const cached=await findAttachment(cloudFileAttachment(source),cloudFileContext(scope.account)).catch(()=>undefined);
     try{if(!valid())return;await cached?.cacheAs?.({...real,kind:source.mime.startsWith('image/')?'image':source.mime.startsWith('video/')?'video':source.mime.startsWith('audio/')?'audio':'file',version:`${real.ver}:${real.sha256}`},{account:scope.account,computer:'cloud',provider:'company',thread:'group'});}catch{}finally{cached?.dispose();}
     if(!valid())return;
     // Only replace this selected draft; later composer edits remain theirs.
     attachments.value=attachments.value.map(a=>a.id===draft.id?real:a);
     expected.attachments=expected.attachments.map(a=>a.id===draft.id?JSON.parse(JSON.stringify(real)):a);
     replaceForward(scope.account,draft.id,real);
    }
    sentFiles=expected.attachments.map(a=>a.id);
   }catch(e){if(valid())ui.toast(e instanceof Error?e.message:'群文件尚未准备好，请重试');return;}
   finally{if(valid()){uploading.value=false;fileStage.value='';}}
  }
  if(!valid())return;
  const message={body:submitted.body.trim(),mention_usernames:[...submitted.mentions],reply_to_id:submitted.reply?.id,attachment_ids:sentFiles,
   ...(submitted.contextExplicit?submitted.selectedContext?{project_id:submitted.selectedContext.project_id,...(submitted.selectedContext.work_item_id?{work_item_id:submitted.selectedContext.work_item_id}:{})}:{project_id:null,work_item_id:null}:{})};
  const sent=await chat.send(retrying?undefined:message);
  if(!valid())return;
  if(sent){
   for(const file of sent.attachments||[])attachmentPicker.value?.delivered(file.id);
   pendingAttachment.value=null;returnToLatest();
   try{removeForwards(scope.account,retrying?pendingFiles:sentFiles);}catch(e){ui.toast(e instanceof Error?e.message:'群附件草稿未能清除，请勿重复发送');}
  }
  const matchesPending=!operation||submitted.body.trim()===(pendingText||'')&&JSON.stringify(submitted.attachments.map(a=>a.id))===JSON.stringify(pendingFiles)
   &&(submitted.reply?.id||null)===(operation.body.reply_to_id||null)&&JSON.stringify(submitted.mentions)===JSON.stringify(operation.body.mention_usernames||[]);
  if(sent&&matchesPending&&sameDraftContent(composerSnapshot(),expected)){
   selectedContext.value=null;contextExplicit.value=false;body.value='';mentions.value=[];reply.value=null;attachments.value=[];acceptForward();
   if(filterActive.value)void query.refresh();
  }else if(sent){
   // A new text/association draft does not retain unchanged files already sent.
   // Keep files added or edited after this submission's snapshot.
   const confirmed=new Set((sent.attachments||[]).map(file=>file.id));
   attachments.value=attachments.value.filter(file=>!confirmed.has(file.id)||!expected.attachments.some(original=>JSON.stringify(original)===JSON.stringify(file)));
  }
}
async function loadOlder() {
  if (listLoading.value || locatingDate.value || !online.value || !canLoadOlder.value) return;
  if(quoteView.value){await loadContextPage('older');return;}
  const el=stream.value,account=chat.account,conversation=chat.peer,generation=threadGeneration,revision=returnRevision,inspection=quoteGeneration;
  const viewportTop = el?.getBoundingClientRect().top || 0;
  const anchor = Array.from(el?.querySelectorAll<HTMLElement>('[data-message-id]') || [])
    .find(node => node.getBoundingClientRect().bottom > viewportTop);
  const id = anchor?.dataset.messageId, offset = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0;
  await (showQuery.value ? query.older() : chat.older()); await nextTick();
  if (el && stream.value === el && account === chat.account && conversation===chat.peer&&generation===threadGeneration&&revision===returnRevision&&inspection===quoteGeneration&&id) {
    const same = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(node => node.dataset.messageId === id);
    if (same) el.scrollTop += same.getBoundingClientRect().top - el.getBoundingClientRect().top - offset;
  }
}
function onHistoryScroll() {
  if(viewResumeBusy.value||locatingDate.value||restoringQuote.value)return;
  const el = stream.value; if (el) { atLatest.value = !quoteView.value&&el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (atLatest.value) unreadBelow.value = 0; }
  saveViewState();cancelPress(); if (actionMessage.value) closeMessageActions(false); if (stream.value && stream.value.scrollTop < 45) void loadOlder(); }
function onViewportChange() { scheduleMenuPosition();keepContextTarget(); }
function positionContextTarget(id:string){
 const el=stream.value,node=Array.from(el?.querySelectorAll<HTMLElement>('[data-message-id]')||[]).find(row=>row.dataset.messageId===id);
 if(!el||!node)throw Error('原消息未能显示，请重试');
 el.scrollTop+=node.getBoundingClientRect().top-el.getBoundingClientRect().top-24;
 const box=node.getBoundingClientRect(),viewport=el.getBoundingClientRect();
 if(box.bottom<=viewport.top||box.top>=viewport.bottom)throw Error('原消息未能定位到可见位置，请重试');
}
function keepContextTarget(){if(quoteView.value&&contextPositionLock&&!locatingDate.value){try{positionContextTarget(contextPositionLock);}catch{/* Explicit locate reports errors; a late media resize does not retry navigation. */}}}
async function locateReply(id: string,quiet=false) {
  if(!session.businessReady)return {positioned:false,error:{code:'session_recovering'}};
  const previous=readingPoint(),wasInspecting=quoteView.value;
  const prior={rows:contextMessages.value,older:contextHasOlder.value,newer:contextHasNewer.value,cursor:contextCursor,target:contextTarget,failures:{...contextFailures.value}};
  if(!wasInspecting)quoteOrigin.value=previous;
  contextController?.abort();const controller=new AbortController();contextController=controller;
  const ticket=++quoteGeneration;returnRevision++;restoringQuote.value=false;contextBusy.value=false;contextFailures.value={older:'',newer:'',refresh:''};
  const account=chat.account,conversation=chat.peer,generation=threadGeneration;
  locatingDate.value=true;atLatest.value=false;quoteView.value=true;contextPositionLock='';
  const valid=()=>!controller.signal.aborted&&quoteGeneration===ticket&&viewActive.value&&chat.account===account&&session.user?.username===account&&chat.peer===conversation&&peer.value===conversation&&route.name==='chat'&&threadGeneration===generation&&!!stream.value;
  let positioned=false,failure:unknown;
  try {
    const result=await loadChatContext(communication,id,conversation,controller.signal);
    if(!valid())return;
    contextMessages.value=result.messages;contextHasOlder.value=result.hasOlder;contextHasNewer.value=result.hasNewer;contextCursor=result.changeCursor;contextTarget=id;
    await nextTick();if(!valid())return;
    positionContextTarget(id);positioned=true;contextPositionLock=id;
    highlighted.value=id;clearTimeout(highlightTimer);highlightTimer=setTimeout(()=>{highlighted.value='';},1400);
  } catch(error){failure=error;if(valid()&&!quiet)ui.reportError(error,'原消息暂未加载，请重试');}
  finally {
    if(valid()){
      locatingDate.value=false;
      if(!positioned){
        controller.abort();contextController=wasInspecting?new AbortController():null;
        quoteView.value=wasInspecting;
        contextMessages.value=prior.rows;contextHasOlder.value=prior.older;contextHasNewer.value=prior.newer;contextCursor=prior.cursor;contextTarget=prior.target;
        if(wasInspecting)contextFailures.value=prior.failures;
        if(!wasInspecting)quoteOrigin.value=null;
        restoringQuote.value=true;await nextTick();if(quoteGeneration===ticket){await restoreReadingPoint(previous);restoringQuote.value=false;}
      }else void refreshContext();
    }
  }
  return {positioned:positioned&&valid(),error:failure};
}
async function loadContextPage(direction:'older'|'newer'){
 const controller=contextController,ticket=quoteGeneration;
 if(!quoteView.value||!controller||controller.signal.aborted||contextBusy.value||locatingDate.value)return;
 const valid=()=>quoteView.value&&quoteGeneration===ticket&&!controller.signal.aborted;
 const edge=direction==='older'?contextMessages.value[0]?.seq:contextMessages.value.at(-1)?.seq;
 if(edge===undefined)return;
 const anchor=reading.capture(true),revision=returnRevision;
 contextPositionLock='';contextBusy.value=true;contextFailures.value[direction]='';
 try{
  const page=await communication.messages({peer:peer.value||undefined,...(direction==='older'?{before:edge}:{after:edge}),limit:25},controller.signal);
  if(!valid())return;
  for(const row of page.messages){assertContextScope(row,peer.value);if(direction==='older'?row.seq>=edge:row.seq<=edge)throw Error('上下文分页未推进，请重试');}
  if(!page.messages.length&&(direction==='older'?page.has_more_old:page.has_more))throw Error('上下文分页未推进，请重试');
  contextMessages.value=mergeContextMessages([...contextMessages.value,...page.messages]);
  if(direction==='older')contextHasOlder.value=!!page.has_more_old;else contextHasNewer.value=!!page.has_more;
  await nextTick();if(valid()&&revision===returnRevision){atLatest.value=false;reading.restore(anchor);}
 }catch(error){if(valid())contextFailures.value[direction]=userError(error,'上下文暂未加载，请重试');}
 finally{if(valid()){contextBusy.value=false;if(contextRefreshPending){contextRefreshPending=false;void refreshContext();}}}
}
function retryContext(){if(!contextMessages.value.length&&contextTarget)void locateReply(contextTarget);else if(contextRetry.value==='refresh')void refreshContext();else void loadContextPage(contextRetry.value);}
async function refreshContext(){
 const controller=contextController,ticket=quoteGeneration;
 if(!quoteView.value||!contextTarget||!controller||controller.signal.aborted)return;
 if(contextBusy.value||locatingDate.value){contextRefreshPending=true;return;}
 contextRefreshPending=false;
 const valid=()=>quoteView.value&&quoteGeneration===ticket&&!controller.signal.aborted;
 contextBusy.value=true;
 const anchor=reading.capture(true),revision=returnRevision;
 try{
  let more=true;
  while(more&&valid()){
   const page=await communication.changes(contextCursor,controller.signal,peer.value||undefined);if(!valid())return;
   if(!Number.isSafeInteger(page.next_change_cursor)||page.next_change_cursor<contextCursor||page.has_more&&page.next_change_cursor<=contextCursor)throw Error('上下文更新未推进');
   const last=contextMessages.value.at(-1)?.seq;
   if(last!==undefined&&page.changes.some(change=>change.message.seq>last&&!change.message.hidden&&!change.message.recalled))contextHasNewer.value=true;
   for(const change of page.changes)assertContextScope(change.message,peer.value);
   contextMessages.value=applyChatChanges(contextMessages.value,page.changes.map(c=>c.message));contextCursor=page.next_change_cursor;more=page.has_more;
  }
  const target=(await communication.message(contextTarget,controller.signal)).message;if(!valid())return;assertContextScope(target,peer.value);
  contextMessages.value=mergeContextMessages([...contextMessages.value,target]);
  contextFailures.value.refresh=target.hidden?'原消息不存在或暂不可见':target.recalled?'原消息已撤回':'';
  atLatest.value=false;await nextTick();if(valid()&&revision===returnRevision)reading.restore(anchor);
 }catch(error){if(valid()){contextFailures.value.refresh=userError(error,'上下文更新失败，请重试');if([401,403,404].includes((error as any)?.status))contextMessages.value=[];}}
 finally{if(valid()){contextBusy.value=false;if(contextRefreshPending){contextRefreshPending=false;void refreshContext();}}}
}
async function mutateMessage(action: 'hide' | 'recall') {
  const message = actionMessage.value, account = chat.account;
  if (!message || !message.allowed_actions?.includes(action)) return;
  closeMessageActions(false);
  // 撤回直接执行；时限和可见范围由服务端 allowed_actions 决定，不在菜单或确认框重复提示。
  if (action === 'recall') {
    if (account !== chat.account || account !== session.user?.username) return;
    if (await chat.changeMessage(message.id, action)) ui.toast('已撤回');
    return;
  }
  const confirmed = await ui.confirm({ title: '删除这条消息？', text: '删除后将从你的聊天记录中隐藏。', label: '删除', danger: true });
  if (!confirmed || account !== chat.account || account !== session.user?.username) return;
  if (await chat.changeMessage(message.id, action)) ui.toast('已删除');
}
function toggleMention(username: string) { mentionSelection.value = mentionSelection.value.includes(username) ? mentionSelection.value.filter(x => x !== username) : [...mentionSelection.value, username]; }
const drafts=useComposerDraftStore();
const composerRestoreAttempt=ref(0),composerRestoreError=ref('');
let composerScope:{account:string;peer:string}|null=null;
function composerSnapshot():ComposerDraft{return JSON.parse(JSON.stringify({body:body.value,mentions:mentions.value,reply:reply.value,attachments:attachments.value,selectedContext:selectedContext.value,contextExplicit:contextExplicit.value,updatedAt:Date.now()}));}
function saveComposer(){
 const scope=composerScope;
 if(!scope||scope.account!==session.user?.username)return;
 const snapshot=composerSnapshot();
 void drafts.save(scope.account,scope.peer,snapshot).catch(()=>{});
}
function cancelViewResume(){
 if(!viewResumeBusy.value&&!pendingViewResume&&(!viewResumeError.value||viewResumeReady))return;
 viewResumeController?.abort();viewResumeController=null;viewResumeBusy.value=false;viewResumeReady=true;pendingViewResume=null;viewResumeError.value='';
}
function saveViewState(){
 const scope=viewResumeScope;if(!viewActive.value||route.name!=='chat'||peer.value!==scope?.peer||!scope||!viewResumeReady||viewResumeBusy.value||locatingDate.value||restoringQuote.value||scope.account!==session.user?.username||chat.account!==scope.account||chat.peer!==scope.peer)return;
 const origin=quoteOrigin.value;
 const value:ChatViewResume={schema:1,peer:scope.peer,filter:JSON.parse(JSON.stringify(filter.value)),searchText:searchText.value,searchOpen:searchOpen.value,historyDate:historyDate.value,historyNote:historyNote.value,point:{anchor:reading.capture(true),latest:atLatest.value,unread:unreadBelow.value},queryRange:filterActive.value?viewRange(query.messages.value):null,context:quoteView.value&&contextTarget&&origin&&viewRange(contextMessages.value)?{target:contextTarget,range:viewRange(contextMessages.value)!,origin:{anchor:origin.anchor,latest:!!origin.latest,unread:origin.unread}}:null};
 const lease=captureApiLease();if(lease.account!==scope.account||!lease.valid())return;
 void metaSet(scope.account,viewResumeKey(scope.peer),value,lease.valid).then(()=>{if(lease.valid()&&viewResumeError.value==='上次阅读位置尚未保存，当前内容仍可继续查看。')viewResumeError.value='';}).catch(()=>{if(lease.valid())viewResumeError.value='上次阅读位置尚未保存，当前内容仍可继续查看。';});
}
async function restoreViewPoint(point:ViewPoint,valid=()=>true){
 await nextTick();if(!valid())return;
 if(point.latest){atLatest.value=true;reading.bottom();}
 else{
  const id=point.anchor?.id;if(id&&!Array.from(stream.value?.querySelectorAll<HTMLElement>('[data-reading-id]')||[]).some(row=>row.dataset.readingId===id))throw Error('原阅读消息已不可用，请重试或返回最新消息');
  atLatest.value=false;reading.restore(point.anchor);
 }
 unreadBelow.value=Math.max(point.unread,unreadBelow.value);
}
async function restoreSavedView(){
 const saved=pendingViewResume,scope=viewResumeScope;if(!saved||!scope)return;
 viewResumeController?.abort();const controller=new AbortController();viewResumeController=controller;const generation=threadGeneration;
 const valid=()=>!controller.signal.aborted&&viewResumeController===controller&&generation===threadGeneration&&route.name==='chat'&&session.user?.username===scope.account&&peer.value===scope.peer;
 viewResumeBusy.value=true;viewResumeError.value='';atLatest.value=false;
 try{
  filter.value=JSON.parse(JSON.stringify(saved.filter));searchText.value=saved.searchText;searchOpen.value=saved.searchOpen;historyDate.value=saved.historyDate;historyNote.value=saved.historyNote;await nextTick();if(!valid())return;
  if(saved.queryRange&&filterActive.value)await query.restoreWindow(saved.queryRange,controller.signal);if(!valid())return;
  if(saved.context){
   const context=saved.context,result=await restoreViewWindow(communication,scope.peer?{peer:scope.peer}:{},context.range,controller.signal);if(!valid())return;
   const original=(await communication.message(context.target,controller.signal)).message;if(!valid())return;assertContextScope(original,scope.peer);
   if(original.id!==context.target||original.hidden||original.recalled||!result.messages.some(row=>row.id===original.id))throw Error('原话已不可用，无法恢复上次上下文');
   quoteOrigin.value={account:scope.account,peer:scope.peer,generation,anchor:context.origin.anchor,unread:context.origin.unread,filtered:filterActive.value,latest:context.origin.latest};
   contextController?.abort();contextController=controller;quoteGeneration++;contextTarget=context.target;contextMessages.value=mergeContextMessages([...result.messages,original]);contextHasOlder.value=result.hasOlder;contextHasNewer.value=result.hasNewer;contextCursor=result.cursor;contextPositionLock='';quoteView.value=true;
  }
  if(!valid())return;await restoreViewPoint(saved.point,valid);if(!valid())return;
  viewResumeReady=true;pendingViewResume=null;
 }catch(e){if(valid()){viewResumeReady=false;viewResumeError.value=userError(e,'上次阅读位置暂未恢复，请重试');}}
 finally{if(valid()){viewResumeBusy.value=false;viewResumeController=null;if(viewResumeReady)saveViewState();}}
}
function resetViewResume(){cancelViewResume();pendingViewResume=null;viewResumeReady=true;viewResumeError.value='';clearFilter();returnToLatest();void nextTick(saveViewState);}
watch([filter,searchText,searchOpen,historyDate,historyNote,quoteView,contextMessages,query.messages],()=>{void nextTick(saveViewState);},{deep:true,flush:'post'});
const draftError=computed(()=>drafts.account===session.user?.username?drafts.errors[peer.value]||'':'');
watch([body,mentions,reply,attachments,selectedContext,contextExplicit],()=>{
 const scope=composerScope;
 if(composerLoaded.value&&scope&&scope.account===session.user?.username&&scope.peer===peer.value&&route.name==='chat')saveComposer();
},{deep:true,flush:'post'});
watch(()=>session.businessReady,ready=>{if(ready&&composerLoaded.value)saveComposer();});
// Input changes already start durable transactions; these also capture the
// current snapshot on a normal navigation or background transition.
function savePageState(){saveComposer();saveViewState();}
onBeforeRouteLeave(()=>{savePageState();});
onBeforeRouteUpdate(()=>{savePageState();});
function saveOnHidden(){if(document.visibilityState==='hidden')savePageState();}
onMounted(()=>{window.addEventListener('pagehide',savePageState);document.addEventListener('visibilitychange',saveOnHidden);});
onUnmounted(()=>{saveComposer();window.removeEventListener('pagehide',savePageState);document.removeEventListener('visibilitychange',saveOnHidden);});
let threadGeneration=0,handledRouteMessage='';
const threadReady=ref(false);
const {error:transferRestoreError,feedback:transferFeedback}=useReadFeedback();
async function retryTransfers(){const a=session.user?.username,p=peer.value,n=threadGeneration;if(!a)return;try{await restoreChatTransfers(a,p);if(n===threadGeneration&&a===session.user?.username)transferFeedback.succeeded();}catch(e){if(n===threadGeneration&&a===session.user?.username){transferFeedback.begin(transfers.value.length>0);transferFeedback.failed(e,'附件待发记录暂未读取，请重试');}}}
watch(()=>[route.name,peer.value,session.user?.username,composerRestoreAttempt.value] as const,async([page,target,account])=>{
 saveViewState();viewResumeController?.abort();viewResumeController=null;viewResumeBusy.value=false;viewResumeReady=false;viewResumeScope=null;pendingViewResume=null;viewResumeError.value='';
 saveComposer();composerScope=null;composerLoaded.value=false;composerRestoreError.value='';drafts.setAccount(account||'');
 const n=++threadGeneration;threadReady.value=false;handledRouteMessage='';keyboardVoice.value=false;endVoiceHold(true);attachmentPicker.value?.stop(true);uploading.value=false;attachmentActive.value=false;attachmentDraft.value=null;pendingAttachment.value=null;fileStage.value='';voiceCapture.value={recording:false,seconds:0};if(page!=='chat'||!account)return;
 body.value='';mentions.value=[];reply.value=null;attachments.value=[];voiceMode.value=false;toolsOpen.value=false;statusOpen.value=false;memberFilterOpen.value=false;searchOpen.value=false;unreadBelow.value=0;atLatest.value=true;selectedContext.value=null;contextExplicit.value=false;clearFilter();cancelMentions();clearTranscripts();
 await chat.setAccount(account,target);if(n!==threadGeneration||route.name!=='chat')return;
 transferFeedback.succeeded();await retryTransfers();
 if(n!==threadGeneration||account!==session.user?.username)return;
 try{await drafts.load(account);}catch{
  if(n===threadGeneration&&account===session.user?.username&&route.name==='chat'&&target===peer.value)composerRestoreError.value='本机草稿暂未读到，请重试恢复后继续编辑。';
  return;
 }
 const saved=drafts.entries[target],draft=saved?JSON.parse(JSON.stringify(saved)) as ComposerDraft:null;
 if(n!==threadGeneration||account!==session.user?.username)return;
 if(draft){body.value=draft.body;mentions.value=draft.mentions;reply.value=draft.reply;attachments.value=draft.attachments;selectedContext.value=draft.selectedContext;contextExplicit.value=draft.contextExplicit;}
 viewResumeScope={account,peer:target};
 // Entering a conversation always opens its latest window; explicit message deep links are handled below.
 pendingViewResume=null;viewResumeReady=true;viewResumeError.value='';
 entryUnread.value=data.notifications.filter(note=>note.kind==='chat_message'&&!note.read_at&&!note.acked_at&&!note.hidden_at&&(note.snapshot?.conversation_peer||'')===target).length;
 composerScope={account,peer:target};composerLoaded.value=true;
 if(session.businessReady)await chat.refresh();
 if(n!==threadGeneration||route.name!=='chat'||account!==session.user?.username||target!==peer.value)return;
 if(typeof route.query.message!=='string'){await nextTick();returnToLatest();}
 if(n===threadGeneration&&route.name==='chat'&&account===session.user?.username&&target===peer.value)threadReady.value=true;
},{immediate:true});
const stopWake = onChatWake(event => {
  if (event.account !== session.user?.username || event.account !== chat.account) return;
  if(viewActive.value&&quoteView.value&&(event.mode==='catchup'||event.kinds.includes('chat_message')))void refreshContext();
  if(viewActive.value&&filterActive.value&&(event.mode==='catchup'||event.kinds.includes('chat_message')&&(!event.conversationPeers?.length||event.conversationPeers.includes(peer.value||''))))void query.refresh(true);
});
// A cached window is display-ready before it is caught up. Route focus must
// wait for this conversation's entry refresh, rather than treating a new message
// absent from the old cache as deleted. Re-entering the same target can focus it.
const {error:routeFocusError,feedback:routeFocusFeedback}=useReadFeedback();let routeFocusBusy=false,routeFocusScope='',routeFocusStopped=false;
const routeFocusRecovery=createRecoveryGate({wake:()=>{void focusRouteMessage();}});
async function focusRouteMessage(){
 const id=route.query.message,scope=JSON.stringify([route.name,session.user?.username,peer.value,id]);
 if(scope!==routeFocusScope){routeFocusRecovery.cancel();routeFocusScope=scope;routeFocusStopped=false;routeFocusFeedback.succeeded();}
 if(route.name!=='chat'||!viewActive.value||!session.businessReady||!threadReady.value||chat.account!==session.user?.username||chat.peer!==peer.value||typeof id!=='string'||!chat.initialized||chat.loading||handledRouteMessage===id||locatingDate.value||routeFocusBusy||routeFocusStopped||!routeFocusRecovery.ready())return;
 routeFocusBusy=true;
 try{
  const result=await locateReply(id,true);if(scope!==routeFocusScope)return;
  if(result?.positioned){handledRouteMessage=id;routeFocusFeedback.succeeded();routeFocusRecovery.completed();}
  else if(result?.error){routeFocusFeedback.begin(chat.messages.length>0);routeFocusFeedback.failed(result.error,'原消息暂未加载，请重试');if(isRetryableFailure(result.error))routeFocusRecovery.failed();else routeFocusStopped=true;}
 }finally{routeFocusBusy=false;if(scope!==routeFocusScope)void focusRouteMessage();}
}
function retryRouteMessage(){routeFocusFeedback.succeeded();routeFocusStopped=false;void focusRouteMessage();}
watch(() => [route.name,route.query.message,session.user?.username,peer.value,session.businessReady,viewActive.value,threadReady.value,chat.initialized,chat.loading],()=>{void focusRouteMessage();});
onUnmounted(()=>routeFocusRecovery.cancel());
onDeactivated(()=>routeFocusRecovery.cancel());
onActivated(()=>{viewActive.value=true;if(route.name==='chat'&&typeof route.query.message!=='string'){clearFilter();returnToLatest();}});
onDeactivated(()=>{saveViewState();emojiOpen.value=false;clearPasteImage();textReader.value=null;dismissQuoteInspection();cancelMentions();memberFilterOpen.value=false;statusOpen.value=false;searchOpen.value=false;contextPicker.value=false;recordPicker.value=false;recordOpen.value=false;toolsOpen.value=false;viewActive.value=false;keyboardVoice.value=false;endVoiceHold(true);attachmentPicker.value?.stop(true);closeMessageActions(false);});
onMounted(() => { window.addEventListener('resize', onViewportChange); window.visualViewport?.addEventListener('resize', onViewportChange); window.visualViewport?.addEventListener('scroll', onViewportChange); });
onUnmounted(() => { viewResumeController?.abort();cancelReplyCheck();contextController?.abort();clearTimeout(highlightTimer); cancelPress(); stopWake(); cancelAnimationFrame(menuFrame); window.removeEventListener('resize', onViewportChange); window.visualViewport?.removeEventListener('resize', onViewportChange); window.visualViewport?.removeEventListener('scroll', onViewportChange); });
</script>
<template>
<Teleport to="body"><ModalSheet v-if="pasteImage" title="发送粘贴的图片？" @close="clearPasteImage"><img class="paste-image-preview" :src="pasteImage.url" alt="待发送的粘贴图片"><p class="field-help">{{pasteImage.file.name}}</p><template #footer><button class="btn" @click="clearPasteImage">取消</button><button class="btn primary" :disabled="!ready||uploading" @click="sendPasteImage">发送图片</button></template></ModalSheet></Teleport>
<Teleport to="body"><BatchDeleteDialog v-if="batchDeleteOpen" :messages="batchDeleteMessages" :peer="peer" :members="chat.members" :online="online" @close="batchDeleteOpen=false" @pending="updateBatchDeletePending" @done="ui.toast('已删除'+$event+'条消息');stopSelecting();void query.refresh();void data.syncNotifications(session.user?.username||'')"/></Teleport>
<Teleport to="body"><ModalSheet v-if="textReader" title="全文阅读" @close="textReader=null"><ChatMessageText class="full-message-text" :text="textReader.body"/><template #footer><button class="btn" @click="textReader=null">关闭</button><button class="btn primary" @click="copyReaderText">复制全文</button></template></ModalSheet></Teleport>
<Teleport to="body"><ModalSheet v-if="renameDraft" title="附件名称" @close="renameDraft=undefined"><input v-model="draftName" class="input" aria-label="附件名称" maxlength="160"><template #footer><button class="btn primary" @click="saveDraftName">保存</button></template></ModalSheet></Teleport>
  <Teleport to="body"><ModalSheet v-if="memberFilterOpen" title="按群成员查找" @close="memberFilterOpen=false"><div class="member-filter-list"><button :aria-pressed="!filter.author" @click="chooseMemberFilter('')">所有成员<AppIcon v-if="!filter.author" name="check"/></button><button v-for="member in sortedMembers" :key="member.username" :aria-pressed="filter.author===member.username" @click="chooseMemberFilter(member.username)"><MemberAvatar :actor="member.username" :name="member.nickname" :size="32"/><span>{{member.nickname||member.username}}</span><AppIcon v-if="filter.author===member.username" name="check"/></button></div><p v-if="!chat.members.length" class="field-help">{{chat.memberLoading?'正在读取成员…':chat.memberError||'暂无可选成员'}}</p></ModalSheet></Teleport>
  <Teleport to="body"><div v-if="holdingVoice" class="voice-capture-overlay" :class="{cancelling:cancelVoiceHold}" role="status"><div class="voice-capture-indicator"><AppIcon name="mic"/><span>{{voiceCapture.recording?voiceCapture.seconds+'″':'正在打开麦克风…'}}</span><small>{{cancelVoiceHold?'松开取消':'松开发送 · 上滑取消'}}</small></div></div></Teleport>
  <div class="chat-page">
    <header v-if="selecting" class="chat-selection-heading"><strong>已选择 {{selectedIds.length}} 条</strong><button @click="stopSelecting">取消</button></header>
    <header v-else class="chat-heading"><button class="icon-btn chat-back" aria-label="返回上一层" data-page-back @click="pageNavigation.back()"><AppIcon name="back"/></button><div><button class="member-count" :aria-expanded="statusOpen" aria-controls="chat-member-status" @click="toggleStatus"><strong>{{conversationName}}</strong><small v-if="!isDirect">{{ memberCount || '—' }} 位成员 · {{ statusReady ? `${onlineMembers.length} 人在线` : '成员状态同步中' }}</small></button></div><button v-if="!quoteView&&(!atLatest||entryUnread>=20)" class="btn small chat-heading-latest" aria-label="显示最新消息" @click="showLatestMessages">最新 ↓</button><button class="icon-btn" aria-label="查找聊天记录" :aria-expanded="searchOpen" @click="openChatSearch"><AppIcon name="search" /></button><button v-if="!isDirect" class="icon-btn" aria-label="公司公告" @click="openAnnouncementEntry"><AppIcon name="megaphone" /><i v-if="announcementUnread" class="count-badge" :aria-label="`${announcementUnread}条未读公告及回复`">{{announcementUnread>99?'99+':announcementUnread}}</i></button></header>
    <ChatSearchPanel v-if="searchOpen&&!quoteView&&!selecting" :direct="isDirect" :autofocus="!viewResumeBusy" :value="searchText" :filter="filter" @close="closeMessageSearch" @input="searchText=$event" @search="submitHistorySearch" @choose="chooseHistoryCategory" />
    <p v-if="!quoteView&&filterActive" class="chat-note chat-query-summary"><span><template v-if="filter.q">关键词：{{filter.q}} · </template><template v-if="filter.kind">{{kindLabels[filter.kind]}} · </template><template v-if="filter.author">成员：{{filteredMemberName}} · </template><template v-if="filter.created_from">日期：{{historyDate}} · </template><template v-if="filter.related">{{filter.related==='mentions'?'@我的':'回复我的'}} · </template><template v-if="filter.project_id||filter.work_item_id">当前工作相关 · </template>查找结果</span><button @click="clearFilter">清除条件</button></p>
    <p v-if="routeFocusError" class="chat-error" role="status">{{routeFocusError}}<button class="btn small" @click="retryRouteMessage">重试定位</button></p>
    <p v-if="showQuery&&queryError" class="chat-error" role="alert">{{ queryError }}<button class="btn small" @click="query.refresh()">重试</button></p>
    <section v-if="statusOpen&&!isDirect" id="chat-member-status" class="member-status-panel" aria-label="成员状态"><div class="member-status-summary"><strong>{{ memberCount }}人</strong><span v-if="statusReady">在线 {{ onlineMembers.length }} · 离线 {{ offlineMembers.length }}</span><span v-else>{{chat.memberLoading?'正在读取成员…':'暂无成员状态'}}</span></div><p v-if="chat.memberError" class="field-help">{{chat.memberError}}<button class="btn small" @click="chat.refreshMembers(true)">重试</button></p><div v-if="statusReady" class="member-status-list"><div v-for="member in sortedMembers" :key="member.username" class="member-status-row"><i :class="member.online === true ? 'online' : 'offline'"></i><MemberAvatar :actor="member.username" :name="member.nickname" :size="24"/><span class="member-status-name">{{ member.nickname || member.username }}</span><small>{{ statusText(member) }}</small></div></div></section>

    <p v-if="viewResumeBusy" class="chat-note" role="status">正在恢复上次阅读位置…<button class="btn small" @click="cancelViewResume">停止恢复</button></p>
    <p v-if="viewResumeError" class="chat-error" role="alert">{{viewResumeError}}<button v-if="pendingViewResume" class="btn small" :disabled="!online||viewResumeBusy" @click="restoreSavedView">重试恢复</button><button class="btn small" @click="resetViewResume">返回最新消息</button></p>
    <div v-if="chat.error && !chat.pending" class="chat-error" role="alert">{{ chat.error }}<button class="btn small" :disabled="chat.loading || !online" @click="refresh">重新获取</button></div>
    <p v-if="transferRestoreError" class="chat-note" role="status">{{transferRestoreError}} <button class="btn small" @click="retryTransfers">重试</button></p>
    <p v-if="confirmedOffline" class="chat-note">当前离线，显示已获取的消息；恢复连接后自动更新。</p>
    <ChatDatePicker v-if="historyOpen" :value="historyDate" :min-date="messageDateBounds.min" :max-date="messageDateBounds.max" @cancel="historyOpen = false" @confirm="confirmHistoryDate" />
    <p v-if="locatingDate" class="chat-history" role="status">正在查找…</p>
    <p v-if="mergedPending&&!selecting" class="chat-note">有未完成的聊天记录转发<button class="btn small" @click="openMerged([])">继续转发</button></p>
    <p v-if="forwardPending&&!selecting" class="chat-note">有尚未确认的转发<button class="btn small" @click="openForward([])">继续转发</button></p>
    <p v-if="mediaForwardPending&&!selecting" class="chat-note">有尚未确认的文件转发<button class="btn small" @click="openMediaForward(null)">继续文件转发</button></p>
    <p v-if="batchForwardPending&&!selecting" class="chat-note">有尚未确认的逐条转发<button class="btn small" @click="openBatchForward([])">继续逐条转发</button></p>
    <p v-if="quoteView&&contextError" class="chat-error" role="alert">{{contextError}}<button class="btn small" :disabled="contextBusy||locatingDate" @click="retryContext">重试</button></p><div v-if="quoteView" class="quote-inspection" role="status"><span>{{locatingDate?'正在查找原消息…':'正在查看原消息'}}</span><button @click="returnFromQuote">{{quoteOrigin?.filtered?'返回查找结果':'返回刚才的位置'}}</button></div>
    <p v-if="batchDeletePending&&!selecting" class="chat-note">有尚未确认的批量删除<button class="btn small" @click="openBatchDelete([])">继续删除</button></p>
    <section ref="stream" class="chat-stream" :aria-label="isDirect?'私聊消息':'公司群消息'" @selectstart.prevent @scroll.passive="onHistoryScroll" @wheel.passive="stopReturnRestore" @pointerdown.capture="stopReturnRestore" @keydown="readingGesture" @load.capture="keepContextTarget">
      <button v-if="canLoadOlder" class="btn ghost older" :disabled="listLoading || !online" @click="loadOlder">{{ listLoading ? '正在加载…' : '向上滑动或点击加载更早消息' }}</button>
      <p v-if="!messages.length&&!chat.pending&&!pendingAttachment&&!transfers.length" class="chat-empty">{{ showQuery ? (queryLoading ? '正在查询消息…' : queryError ? '筛选失败，请重试。' : '没有符合条件的消息。') : chat.restoring ? '正在恢复聊天记录…' : chat.loading ? '正在获取消息…' : chat.error ? isDirect?'暂时无法获取聊天记录，请重试。':'暂时无法获取群消息，请重试。' : confirmedOffline ? '当前离线，恢复连接后同步聊天记录。' : !chat.initialized ? isDirect?'正在读取聊天记录…':'正在连接工作群…' : chat.messages.length ? '暂无可显示的消息。' : isDirect ? '发送第一条消息' : '你已加入公司工作群。还没有人发消息，来打个招呼吧。' }}</p>
      <template v-for="(m, index) in messages" :key="m.id"><time v-if="timeMarkers[index]" class="chat-time-divider" :datetime="new Date(m.created_at).toISOString()">{{ chatTime(m.created_at, clockNow) }}</time><article :data-reading-id="m.id" :data-message-id="m.id" class="chat-message" @click.capture="selectionClick($event,m)" @pointerdown.capture="selectionPointer" @contextmenu.capture="selectionContext" :class="{ own: m.author_username === session.user?.username, highlighted: highlighted === m.id, 'actions-active': actionMessage?.id === m.id, 'selection-mode':selecting, selected:selectedIds.includes(m.id) }">
        <button v-if="selecting" class="message-select" :aria-label="'选择消息：'+messageSnippet(m)" :aria-pressed="selectedIds.includes(m.id)" :disabled="!canSelectMessage(m)"><AppIcon v-if="selectedIds.includes(m.id)" name="check"/></button>
        <MemberAvatar class="chat-avatar" size="var(--message-avatar-size)" preview profile :actor="m.author_username" :name="m.author_name||m.author_username"/>
        <div class="chat-message-main"><div v-if="!isDirect" class="chat-meta">{{ m.author_name || m.author_username }}</div>
          <div v-if="m.context" class="chat-context-tag"><ReferenceNumber :number="contextNumber(m.context)" @open="openContext(m.context)"/><span>{{contextTitle(m.context)}}</span></div>
          <div class="chat-bubble" :class="{ 'media-message': m.attachments.length > 0 }" tabindex="0" aria-label="消息，长按或按回车打开操作" @click.capture="messageClick($event,m)" @pointerdown="startPress($event, m)" @pointermove="movePress" @pointerup="cancelPress" @pointercancel="cancelPress" @pointerleave="cancelPress" @contextmenu.prevent="openMessageActions(m, $event.currentTarget)" @keydown.enter.self.prevent="openMessageActions(m, $event.currentTarget, true)">
            <div v-if="m.mention_usernames.length && !m.mention_usernames.every(u=>m.body.includes('@'+name(u)))" class="chat-mentions">{{ m.mention_usernames.map(u => '@' + name(u)).join(' ') }}</div>
            <ChatMessageText v-if="m.body" :text="m.body" :query="showQuery?filter.q:undefined" @dblclick="!showQuery&&readText(m)"/>
            <template v-for="a in m.attachments" :key="a.id">
              <ChatAttachmentView :attachment="a" :forwardable="canForwardMedia(m)" @forward="openMediaForward(m)" @select="beginSelection(m)"/>
              <div v-if="transcripts[transcriptKey(a)]?.visible" class="voice-transcript" aria-label="语音转文字">
                <p v-if="transcripts[transcriptKey(a)].loading" role="status">{{ transcripts[transcriptKey(a)].phase }}</p>
                <p v-else-if="transcripts[transcriptKey(a)].error" role="alert">{{ transcripts[transcriptKey(a)].error }}<button type="button" @click="convertVoice(m,a)">重试</button></p>
                <p v-else>{{ transcripts[transcriptKey(a)].text }}</p>
                <button v-if="transcripts[transcriptKey(a)].loading" type="button" @click="hideTranscript(a)">取消</button>
              </div>
            </template>
          </div>
          <button v-if="m.reply_to" class="chat-reply-link" aria-label="查看引用的原消息" :disabled="locatingDate" @pointerdown.stop="startQuotePress(m,$event)" @pointermove="movePress" @pointerup="cancelPress" @pointercancel="cancelPress" @pointerleave="cancelPress" @contextmenu.stop.prevent="openQuoteActions(m,$event)" @keydown.enter.stop.prevent="openQuoteActions(m,$event,true)" @click.stop="quoteClick(m,$event)">{{ m.reply_to.author_name || m.reply_to.author_username }}：{{ quote(m)?.recalled ? '引用内容已撤回' : quote(m)?.hidden ? '引用内容不存在' : messageSnippet(quote(m)!) || '附件消息' }}</button>
        </div>
      </article></template>
      <button v-if="showQuery&&query.hasNewer.value" class="btn ghost older" :disabled="queryLoading||!online" @click="query.newer()">加载后续消息</button>
      <button v-if="quoteView&&contextHasNewer" class="btn ghost older" :disabled="contextBusy||locatingDate||!online" @click="loadContextPage('newer')">加载后续消息</button>
      <article v-for="job in quoteView?[]:transfers" :key="job.key" class="chat-message own transfer-message" aria-label="文件传输"><MemberAvatar class="chat-avatar" size="var(--message-avatar-size)" :name="session.displayName"/><div class="chat-message-main"><div class="transfer-card"><div v-if="job.url" class="transfer-preview"><video v-if="job.mime.startsWith('video/')" :src="job.url" muted playsinline preload="metadata"/><img v-else :src="job.url" :alt="job.name"/></div><div class="transfer-copy"><strong>{{job.purpose==='voice'?'语音 · '+Math.max(1,Math.ceil((job.duration||0)/1000))+'″':job.name}}</strong><small>{{job.purpose==='voice'?'':transferSize(job.size)+' · '}}{{job.stage}}</small></div><TransferSector v-if="job.state==='running'&&job.progress?.phase==='upload'&&job.progress.total>0" :value="job.progress?.phase==='upload'?job.progress.loaded/job.progress.total*100:undefined" :label="job.stage"/></div><small v-if="job.error" class="send-failure">{{job.error}}</small><label v-if="job.needsSource" class="btn small">选择原文件继续<input type="file" style="display:none" aria-label="选择原待发文件继续" @change="pickTransferSource(job,$event)"></label><button v-else-if="job.state==='error'||job.state==='cancelled'" class="btn small" :disabled="!online" @click="job.retry()">{{job.needsConfirmation?'确认发送':job.receiptPending?'重试确认':'重试发送'}}</button><button v-if="job.needsConfirmation&&job.state!=='running'" class="btn small" @click="job.discard()">取消选择</button><button v-if="job.state==='running'" class="transfer-cancel" @click="job.cancel()">暂停</button></div><span v-if="job.state==='running'&&job.progress?.phase!=='upload'" class="send-spinner" role="status" :aria-label="job.stage"></span></article>
      <article v-if="!quoteView && belongs && (chat.pending || pendingAttachment)" class="chat-message own pending-message" aria-label="待发送消息">
        <MemberAvatar class="chat-avatar" size="var(--message-avatar-size)" :name="session.displayName"/><div class="chat-message-main"><div class="chat-bubble" :class="{ 'media-message': pendingAttachment }"><ChatAttachmentView v-if="pendingAttachment" :attachment="pendingAttachment.attachment" /><template v-else><p v-if="chat.pending?.body.body">{{ chat.pending.body.body }}</p><p v-if="chat.pending && !chat.pending.body.body">附件消息</p></template></div><small v-if="!chat.sending" class="send-failure">{{ chat.error || '发送未确认，点红色感叹号重试' }}</small></div>
        <span v-if="chat.sending" class="send-spinner" role="status" aria-label="正在发送"></span><button v-else class="send-retry" aria-label="重试发送这条消息" title="重试发送" :disabled="!online||!composerLoaded" @click="chat.pending ? send() : retryAttachment()"><span aria-hidden="true">!</span></button>
      </article>
    </section>

    <section v-if="selecting" class="chat-selection-actions" aria-label="所选消息操作"><button :disabled="!selectedIds.length||selectedMessages.some(m=>!m.body)" @click="copySelected"><AppIcon name="copy"/>复制</button><button :disabled="!selectedIds.length||!online||selectedMessages.some(m=>!canDeleteMessage(m))||!!chat.mutationPending" @click="openBatchDelete(selectedMessages)"><AppIcon name="trash"/>删除</button><button :disabled="!selectedIds.length||!online" @click="forwardSelected"><AppIcon name="message"/>转发{{selectedIds.length?'（'+selectedIds.length+'）':''}}</button></section>
    <section class="chat-composer" :class="{'composer-hidden':selecting||quoteView}" aria-label="发送消息">
      <div v-if="replyChecking" class="chat-note" role="status">正在核实引用原消息…</div>
      <div v-if="replyCheckError" class="chat-note" role="alert">{{replyCheckError}}<button class="btn small" :disabled="!online" @click="refreshDraftReply">重试核实引用</button></div>
      <div v-if="composerRestoreError" class="chat-note" role="alert">{{composerRestoreError}}<button class="btn small" @click="composerRestoreAttempt++">重试恢复草稿</button></div>
      <div v-else-if="draftError" class="chat-note" role="alert">{{draftError}}<button class="btn small" @click="saveComposer">重试保存草稿</button></div>
      <div v-if="chat.mutationPending" class="chat-note">上次{{ chat.mutationPending.action === 'hide' ? '删除' : '撤回' }}结果尚未确认。<button :disabled="!online || chat.mutating" class="btn small" @click="chat.changeMessage()">重试确认</button></div>
      <div class="composer-content">
        <div v-if="reply" class="chat-quote"><span>回复 {{ reply.author_name || reply.author_username }}：{{ messageSnippet(reply) || '附件消息' }}</span><button aria-label="取消引用" @click="reply = null; if (!contextExplicit) selectedContext = null"><AppIcon name="close" /></button></div>
        <div v-if="selectedContext" class="chat-quote selected-context"><span><ReferenceNumber :number="contextNumber(selectedContext)" @open="openContext(selectedContext)"/> {{contextTitle(selectedContext)}}</span><button aria-label="移除事项关联" @click="chooseContext(null)">×</button></div>
        <div v-if="mentions.length&&!mentions.every(u=>body.includes('@'+name(u)))" class="chat-mentions">{{ mentions.map(u => '@' + name(u)).join(' ') }}</div>
        <div class="composer-line">
          <button class="composer-voice" :aria-label="voiceMode ? '切换文字输入' : '切换语音输入'" :disabled="!belongs || holdingVoice" @click="toggleVoiceMode"><svg v-if="!voiceMode" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg><svg v-else viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h2m2 0h2m2 0h2m2 0h2M5 12h2m2 0h2m2 0h2m2 0h2M7 16h10"/></svg></button>
          <button v-if="voiceMode" type="button" class="composer-hold" :class="{ recording: holdingVoice, cancelling: cancelVoiceHold }" :disabled="(!ready || uploading) && !holdingVoice" aria-label="按住说话，松开发送，上滑取消" @pointerdown="beginVoiceHold" @pointermove="moveVoiceHold" @pointerup="endVoiceHold()" @pointercancel="endVoiceHold(true)" @lostpointercapture="endVoiceHold(true)" @contextmenu.prevent @click="$event.detail === 0 && beginKeyboardVoice()"><span v-if="holdingVoice && voiceCapture.recording" class="composer-record-time" aria-label="录音时长">{{ voiceCapture.seconds }} 秒</span>{{ holdingVoice ? cancelVoiceHold ? '松开取消' : voiceCapture.recording ? '松开发送 · 上滑取消' : '正在打开麦克风…' : '按住说话' }}</button>
          <MessageInput v-show="!voiceMode" @element="input = $event" v-model="body" rows="1" @paste="composerPaste" @focus="focusInput" @input="composerInput" @compositionend="composerInput" :aria-label="isDirect?'私聊消息输入':'群消息'" placeholder="发消息…" maxlength="4000" :disabled="!composerLoaded || !belongs || chat.restoring || chat.sending || !!chat.pending" />
          <button class="composer-emoji" :aria-label="emojiOpen?'返回键盘':'打开表情面板'" :aria-expanded="emojiOpen" :disabled="!composerLoaded||holdingVoice||uploading" @pointerdown.prevent @click="toggleEmoji"><AppIcon name="smile"/></button>
          <button class="composer-more" aria-label="更多消息工具" :aria-expanded="toolsOpen" @click="toggleTools"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 12h14"/><path v-if="!toolsOpen" d="M12 5v14"/></svg></button><button v-if="!voiceMode && (body.trim() || attachments.length)" class="btn primary composer-send" :disabled="uploading || !ready" @pointerdown.prevent @click="send">{{ chat.sending ? '发送中…' : '发送' }}</button>
        </div>
        <div class="chat-attachments"><div class="draft-file" v-for="a in attachments" :key="a.id"><AppIcon name="doc"/><button class="draft-name" @click="renameDraft=a;draftName=a.name">{{ a.name }}<small v-if="isCloudForward(a)"> · 待发送</small></button><button class="draft-remove" aria-label="移除附件" @click="removeDraftAttachment(a.id)">×</button></div><small v-if="fileStage" role="status">{{fileStage}}</small></div>
        <EmojiPicker v-if="emojiOpen" @choose="insertEmoji" @close="closeEmoji"/>
        <div v-show="!holdingVoice && (toolsOpen || attachmentActive || keyboardVoice)" class="composer-expanded">

<button v-if="keyboardVoice&&!voiceCapture.recording" class="btn small" @click="cancelKeyboardVoice">取消录音</button>
<ChatAttachmentPicker ref="attachmentPicker" hide-voice :voice-only="voiceMode" v-if="belongs" :peer="peer" :key="session.user?.username+':'+peer" :remaining="6 - attachments.length" :disabled="!composerLoaded || !!reply && (replyChecking || !!replyCheckError) || attachments.length >= 6 || chat.sending || !!chat.pending || !online" @busy="pickerBusy" @capture="pickerCapture" @capture-error="ui.toast($event,true)" @active="pickerActive" @voice-source="captureAttachmentDraft" @file-source="captureFileDraft" :deliver="addedAttachment" :delivery-body="deliveryBody"><button v-if="!isDirect" class="composer-tool" :disabled="!ready" @click="contextPicker = true"><span aria-hidden="true"><AppIcon name="link" /></span>关联事项</button><button v-if="!isDirect" class="composer-tool" data-member-picker-trigger :aria-expanded="showMembers" :disabled="!ready" @click="openMentionPicker()"><span aria-hidden="true"><AppIcon name="users" /></span>同事</button></ChatAttachmentPicker></div>
      </div>
    </section>
    <ChatContextPicker :selected="selectedContext" v-if="contextPicker" @close="contextPicker=false" @choose="chooseContext" />
    <Teleport to="body"><ModalSheet v-if="recordOpen" title="留到工作记录" sub="保留讨论结论与原消息入口，保留引用关系" @close="recordOpen=false">
      <p v-if="recordWrite.pending.value" class="field-help">上次记录尚未确认，将按原内容重试，避免重复。</p>
      <button v-else class="btn soft" @click="recordPicker=true">{{recordContext?.work_title || '选择工作记录'}}</button>
      <textarea v-model="recordSummary" class="input record-summary" aria-label="工作结论摘要" placeholder="写下需要留存的结论" maxlength="2000" :disabled="recordBusy||!!recordWrite.pending.value"></textarea>
      <p v-if="recordError" role="alert" class="error-text">{{recordError}}</p>
      <template #footer><button class="btn primary" :disabled="recordBusy||!online||(!recordWrite.pending.value&&(!recordContext?.work_item_id||!recordSummary.trim()))" @click="saveRecord">{{recordBusy?'保存中…':recordWrite.pending.value?'重试确认':'保存记录'}}</button></template>
    </ModalSheet></Teleport>
    <ChatContextPicker :selected="recordContext" v-if="recordPicker&&recordOpen" work-only @close="recordPicker=false" @choose="recordContext=$event;recordPicker=false" />
    <Teleport to="body"><ModalSheet v-if="showMembers" title="选择提醒的成员" @close="cancelMentions">
      <div class="mention-list"><button v-for="m in sortedMembers.filter(m=>m.username!==session.user?.username)" :key="m.username" class="mention-row" :aria-pressed="mentionSelection.includes(m.username)" @click="toggleMention(m.username)"><MemberAvatar :actor="m.username" :name="m.nickname" :size="36"/><span>{{m.nickname||m.username}}</span><i :class="{checked:mentionSelection.includes(m.username)}">{{mentionSelection.includes(m.username)?'✓':''}}</i></button></div>
      <p v-if="chat.memberError" role="alert">{{chat.memberError}}<button class="btn small" @click="chat.refreshMembers(true)">重试</button></p>
      <template #footer><button class="btn primary" :disabled="!mentionSelection.length" @click="confirmMentions">确认{{mentionSelection.length?'（'+mentionSelection.length+'）':''}}</button></template>
    </ModalSheet></Teleport>
    <Teleport to="body"><ModalSheet v-if="forwardChoiceRows" title="转发方式" @close="forwardChoiceRows=null"><div class="forward-mode-choices"><button class="btn" @click="chooseForward('individual')">逐条转发</button><button class="btn" @click="chooseForward('merged')">合并转发</button></div></ModalSheet><MergedForwardDialog v-if="mergedMessages" :messages="mergedMessages" :members="chat.members" :online="online" @pending="updateMergedPending" @done="forwardDone" @close="mergedMessages=null"/></Teleport>
    <Teleport to="body"><BatchForwardDialog v-if="batchForwardOpen" :messages="batchForwardMessages" :members="chat.members" :online="online" @pending="updateBatchForwardPending" @done="forwardDone" @close="batchForwardOpen=false"/></Teleport>
    <Teleport to="body"><MediaForwardDialog v-if="mediaForwardOpen" :message="mediaForwardMessage" :members="chat.members" :online="online" @pending="updateMediaForwardPending" @done="ui.toast('已转发文件')" @close="mediaForwardOpen=false"/></Teleport>
    <Teleport to="body"><ChatForwardDialog v-if="forwardMessages" :messages="forwardMessages" :members="chat.members" :online="online" @pending="updateForwardPending" @done="forwardDone" @close="forwardMessages=null"/></Teleport>
    <Teleport to="body"><Transition name="message-menu"><div v-if="actionMessage" class="message-actions-mask" @selectstart.prevent @contextmenu.prevent @click.self="closeMessageActions()" @touchmove.self.prevent @keydown="menuKey">
      <section ref="actionPanel" class="message-actions" tabindex="-1" :class="[menuSide, { 'keyboard-menu': menuKeyboard }]" :style="menuStyle" role="dialog" aria-modal="true" :aria-label="actionKind==='quote'?'引用原话操作':'消息操作'">
        <div class="message-action-row">
          <button v-if="actionKind==='message'&&actionMessage.body" aria-label="复制文字" @click="copyMessage"><AppIcon class="menu-optional-icon" name="copy" /><span>复制</span></button>
          <button v-if="actionKind==='message'&&actionMessage.body" aria-label="全文阅读" @click="readText(actionMessage)"><AppIcon class="menu-optional-icon" name="doc"/><span>放大阅读</span></button>
          <button v-if="actionKind==='quote'||showQuery" aria-label="定位到聊天位置" :disabled="!online" @click="locateActionMessage"><AppIcon name="search"/><span>定位到聊天位置</span></button>
          <button class="menu-section-start" v-if="actionKind==='message'&&!quoteView&&(canForwardText(actionMessage)||canForwardMedia(actionMessage))" aria-label="转发消息" :disabled="!online" @click="forwardOne"><AppIcon name="forward"/><span>转发…</span></button>
          <button v-if="actionKind==='message'&&!quoteView&&canSelectMessage(actionMessage)" aria-label="多选消息" @click="beginSelection()"><AppIcon class="menu-optional-icon" name="check"/><span>多选</span></button>
          <button v-for="a in (actionKind==='message'&&!quoteView?actionVoices:[]).filter(a=>transcripts[transcriptKey(a)]?.visible && transcripts[transcriptKey(a)]?.text)" :key="'hide:'+a.id" aria-label="收起文字" @click="hideTranscript(a);closeMessageActions(false)"><AppIcon name="doc"/><span>收起文字</span></button>
          <button v-for="(a,index) in actionKind==='message'&&!quoteView?actionVoices:[]" :key="a.id" :aria-label="actionVoices.length === 1 ? '转文字' : `转文字 ${index+1}`" :disabled="!online" @click="convertVoice(actionMessage!,a)"><AppIcon name="doc"/><span>{{ actionVoices.length === 1 ? '转文字' : `转文字 ${index+1}` }}</span></button>
          <button v-if="actionKind==='message'&&!quoteView&&!actionMessage.recalled && !actionMessage.hidden" aria-label="引用回复" :disabled="!ready" @click="replyToMessage"><AppIcon name="message" /><span>引用</span></button>
          <button v-if="actionKind==='message'&&!quoteView&&!isDirect && !actionMessage.recalled && !actionMessage.hidden" :disabled="!online" @click="openRecord"><AppIcon name="doc"/><span>留到工作</span></button>
          <button class="menu-section-start menu-danger" v-if="actionKind==='message'&&!quoteView&&actionMessage.allowed_actions?.includes('hide')" aria-label="删除" :disabled="chat.mutating || !!chat.mutationPending || !online" @click="mutateMessage('hide')"><AppIcon name="trash" /><span>删除</span></button>
          <button v-if="actionKind==='message'&&!quoteView&&actionMessage.allowed_actions?.includes('recall')" aria-label="撤回" :disabled="chat.mutating || !!chat.mutationPending || !online" @click="mutateMessage('recall')"><AppIcon name="back" /><span>撤回</span></button>
        </div>
      </section>
    </div></Transition></Teleport>
  </div>
</template>
<style scoped>
.chat-composer>.chat-note{max-height:none;overflow:visible}
.mention-list{display:grid;max-height:55vh;overflow-y:auto}.mention-row{display:flex;align-items:center;gap:12px;min-height:56px;border:0;border-bottom:1px solid var(--line);background:transparent;padding:8px 0;text-align:left;font-size:15px}.mention-row>span{flex:1}.mention-row>i{width:20px;height:20px;border:1px solid var(--line);border-radius:4px;font-style:normal;text-align:center}.mention-row>i.checked{background:var(--green);color:white}.mention-row:active{background:var(--green-soft)}
.voice-transcript{width:100%;max-width:280px;min-width:0;overflow-wrap:anywhere;padding:10px 12px;background:var(--paper);border:1px solid var(--line);border-radius:8px;user-select:text;-webkit-user-select:text}
.voice-transcript p{user-select:text;-webkit-user-select:text;white-space:pre-wrap;line-height:1.6}.voice-transcript>div{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:6px}.voice-transcript small{font-size:11px;color:var(--muted)}.voice-transcript button{border:0;background:transparent;color:var(--accent);min-height:32px;padding:4px 8px;font-size:12px}
.composer-voice{display:grid;place-items:center;flex:none;border:0;background:transparent;color:var(--ink);width:48px;height:48px;padding:0}.composer-voice:disabled{opacity:.4}
.composer-record-time{display:inline-block;margin-right:8px;font-variant-numeric:tabular-nums;min-width:3ch}.composer-hold{flex:1;min-width:0;min-height:48px;border:1px solid var(--control-line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:16px;font-weight:500;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}.composer-hold.recording{background:var(--paper-soft)}.composer-hold.cancelling{background:var(--red-soft);color:var(--red);border-color:var(--red)}

.voice-capture-overlay{position:fixed;inset:0;z-index:120;pointer-events:none;display:grid;place-items:center;background:#0005}.voice-capture-indicator{position:relative;display:flex;align-items:center;justify-content:center;gap:10px;box-sizing:border-box;width:180px;height:80px;padding:14px 16px;border-radius:18px;background:#95ec69;color:#204b1e}.voice-capture-indicator:after{content:'';position:absolute;bottom:-9px;left:80px;border-left:10px solid transparent;border-right:10px solid transparent;border-top:10px solid #95ec69}.voice-capture-indicator .icon{width:28px;height:28px;flex:none}.voice-capture-indicator span{font-size:18px;min-width:0;overflow-wrap:anywhere}.voice-capture-indicator small{position:absolute;top:108px;left:-20px;right:-20px;color:white;text-align:center;font-size:13px}.voice-capture-overlay.cancelling .voice-capture-indicator:after{border-top-color:#e66b70}.voice-capture-overlay.cancelling .voice-capture-indicator{background:#e66b70;color:white}
.member-filter-list{display:grid;gap:3px}.member-filter-list button{display:flex;align-items:center;gap:12px;padding:9px 0;min-height:48px;border:0;background:transparent;text-align:left;color:var(--ink);font-size:15px}.member-filter-list button span{flex:1}.member-filter-list button[aria-pressed=true]{color:var(--green-dark)}.member-filter-list button:active{background:var(--green-soft)}.member-filter-chip{display:flex;align-items:center;gap:6px;margin:0 12px;color:var(--green-dark);font-size:13px}.member-filter-chip button{display:grid;place-items:center;border:0;background:transparent;padding:5px;color:inherit}.member-filter-chip .icon{width:15px;height:15px}
.transfer-card{position:relative;display:flex;align-items:center;gap:10px;padding:12px;max-width:260px;border-radius:5px;background:#fff;border:1px solid #e0e0e0}.transfer-preview{width:76px;height:76px;flex:none;overflow:hidden;border-radius:4px;background:#242727}.transfer-preview img,.transfer-preview video{width:100%;height:100%;object-fit:contain}.transfer-copy{min-width:0}.transfer-copy strong{display:block;font-size:14px;font-weight:500;overflow-wrap:anywhere}.transfer-copy small{display:block;color:#888;font-size:11px;line-height:1.5;margin-top:5px}.transfer-cancel{border:0;background:transparent;color:#888;padding:5px 0;font-size:12px}
.pending-message{align-items:center}.send-spinner{width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--muted);border-radius:50%;animation:send-spin .8s linear infinite;flex:none}.send-retry{border:0;background:transparent;color:#ba3b35;font-size:26px;min-width:40px;min-height:44px;padding:0;flex:none}.send-retry>span{display:grid;place-items:center;width:20px;height:20px;margin:auto;border-radius:50%;background:#fa5151;color:white;font-size:15px;font-weight:600}.send-retry:disabled{opacity:.4}.send-failure{display:block;color:#9b3b35;font-size:12px;line-height:1.5;margin-top:6px;max-width:240px}@keyframes send-spin{to{transform:rotate(360deg)}}

.record-summary{margin-top:14px;min-height:110px}

.chat-filters{display:flex;gap:4px;padding:4px 12px;background:var(--paper);flex:none}.chat-filters button{min-height:44px;border:0;background:transparent;padding:7px 10px;color:var(--muted);font-size:13px;border-radius:6px}.chat-filters .selected{color:#2457a7;background:#eaf0fb;font-weight:600}.chat-search{display:flex;align-items:center;gap:6px;min-height:48px;padding:4px 12px}.chat-search .input{flex:1;min-width:0;height:40px;min-height:40px;margin:0;padding:7px 10px;font-size:16px}.chat-search .btn{min-height:40px;height:40px;padding:7px 10px;font-size:14px}.chat-context-tag{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px;max-width:100%;margin:0 0 5px;color:var(--muted);font-size:13px;line-height:1.5}.chat-context-tag>span{min-width:0;overflow-wrap:anywhere;white-space:normal}.selected-context>span{white-space:normal;overflow:visible;overflow-wrap:anywhere}.chat-quote.selected-context{max-height:none}

.chat-navigation{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0 12px 4px;padding:10px;background:var(--paper);border:1px solid var(--line);border-radius:12px}.chat-navigation .btn{min-height:42px;white-space:nowrap}.chat-jump-latest{position:absolute;right:16px;bottom:100px;z-index:3;border:1px solid var(--line);border-radius:20px;background:var(--paper);color:#2457a7;box-shadow:0 2px 8px #0001;padding:10px 14px;font-size:13px}.chat-page{position:relative}

.composer-emoji{flex:none;width:36px;min-height:48px;border:0;background:transparent;padding:6px;color:var(--ink)}.composer-emoji .icon{width:24px;height:24px}.paste-image-preview{display:block;max-width:100%;max-height:45vh;margin:0 auto;object-fit:contain}.full-message-text{font-size:20px;line-height:1.8;user-select:text;-webkit-user-select:text}.chat-context-link{display:block;background:transparent;border:0;color:#4c6485;padding:8px 0;font-size:12px;min-height:36px}.quote-inspection{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--green-soft);font-size:12px;color:var(--ink);flex:none}.quote-inspection button{background:transparent;border:0;color:var(--green-dark);padding:8px;min-height:36px;font-size:12px;flex:none}
.chat-history{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;color:var(--muted)}.chat-history input{max-width:160px;padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink)}.chat-history span{width:100%}.chat-page{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;width:100%;overflow:hidden}.chat-heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.chat-heading{padding:8px 12px;flex:none}.chat-heading>div{margin-right:auto;min-width:0;flex:1}.chat-heading .member-count{max-width:100%}.chat-heading .member-count strong{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chat-heading .icon-btn{flex:none}.chat-heading h1{font-size:18px}.chat-heading .btn{min-height:36px;padding:6px 10px}.chat-heading p{color:var(--muted);font-size:12px;margin-top:6px}.member-count{display:flex;flex-direction:column;align-items:flex-start;gap:2px;border:0;background:transparent;color:var(--ink);padding:4px 0;text-align:left}.member-count strong{font-size:18px;font-weight:650}.member-count small{font-size:11px;color:var(--muted)}.member-status-panel{margin:0 12px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--paper)}.member-status-summary{display:flex;justify-content:space-between;gap:8px;font-size:12px}.member-status-summary span{color:var(--muted)}.member-status-list{display:grid;gap:8px;margin-top:10px}.member-status-row{display:flex;align-items:center;gap:7px;font-size:12px}.member-status-row i{width:7px;height:7px;border-radius:50%;background:#a5b1ac}.member-status-row i.online{background:#53a47b}.member-status-row>.member-status-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.member-status-row small{color:var(--muted);font-size:11px}.chat-stream{display:grid;align-content:start;gap:18px;flex:1;min-height:0;overflow-y:auto;padding:8px 12px;overscroll-behavior:contain}.chat-message{display:flex;gap:8px;min-width:0}.chat-avatar{width:32px;height:32px;flex-shrink:0;border-radius:11px;display:grid;place-items:center;background:var(--green-soft);color:var(--green-dark)}.chat-message-main{min-width:0;max-width:calc(100% - 44px);flex:1}.chat-meta{font-size:12px;color:var(--ink);margin-bottom:6px}.chat-meta time{color:var(--muted);margin-left:8px;font-size:var(--message-time-size)}.chat-bubble{padding:10px 12px;border-radius:2px 16px 16px;background:var(--paper);border:1px solid var(--line);overflow-wrap:anywhere}.own{flex-direction:row-reverse}.own .chat-message-main{flex:0 1 auto}.own .chat-meta{text-align:right}.own .chat-bubble{background:#eaf5f1;border-radius:16px 2px 16px 16px}.own .chat-reply{display:block;margin-left:auto}.chat-time-divider{display:block;text-align:center;font-size:11px;line-height:1.5;color:var(--muted);padding:5px 0}.chat-message-main{flex:0 1 auto}.chat-bubble p{white-space:pre-wrap;font-size:var(--message-font-size);line-height:var(--message-line-height)}.chat-bubble blockquote,.chat-quote{padding:9px 10px;border-left:2px solid #9bbab0;color:var(--muted);background:#f3f6f5;font-size:12px;margin:0 0 8px;white-space:pre-wrap;overflow-wrap:anywhere}.chat-quote{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px 4px 8px}.chat-quote>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chat-quote>button{appearance:none;-webkit-appearance:none;flex:none;display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:0;background:transparent;box-shadow:none;color:var(--muted)}.chat-quote>button .icon{width:15px;height:15px}.chat-reply{font-size:11px;color:var(--muted);padding:5px 0;background:none;border:0}.chat-file{display:flex;gap:8px;align-items:center;padding:10px 0;font-size:13px;overflow-wrap:anywhere}.chat-file small{white-space:nowrap;color:var(--muted)}audio{max-width:100%;height:40px}.chat-composer{display:block!important;visibility:visible!important;position:relative;z-index:2;flex:0 0 auto;min-height:58px;max-height:45%;overflow-y:auto;background:var(--paper);border-top:1px solid var(--line);padding:8px 10px}.composer-line{display:flex;align-items:flex-end;gap:4px}.composer-more{flex:none;width:48px;height:48px;border:1px solid var(--line);border-radius:50%;background:transparent;font-size:26px;color:var(--ink)}.composer-send{flex:none;height:48px;min-height:48px;padding:8px 12px;font-size:14px}.composer-expanded{padding:12px 2px 4px}.chat-history{padding:0 12px}.chat-error,.chat-note{flex:none;max-height:20%;overflow:auto}.chat-quote{max-height:65px;overflow:auto}.chat-attachments{font-size:12px;overflow-wrap:anywhere}.chat-tools{display:flex;align-items:center;gap:3px;flex-wrap:wrap}.chat-tools>.primary{margin-left:auto}.chat-member-picker{display:flex;gap:12px;flex-wrap:wrap;padding:12px 0}.chat-member-picker label{font-size:13px;display:flex;gap:5px;align-items:center}.chat-mentions{font-size:var(--message-meta-size);color:var(--green-dark);margin-bottom:6px;overflow-wrap:anywhere}.chat-error,.chat-note{background:#fff7e9;padding:12px;border-radius:12px;font-size:12px;overflow-wrap:anywhere}.chat-error button{margin-left:8px}.chat-empty{padding:24px 8px;text-align:center;color:var(--muted);font-size:13px}.older{justify-self:center}
.chat-stream,.chat-bubble,.message-actions-mask{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}.actions-active .chat-bubble{background:#e3eee8;transition:background-color .12s ease}
.message-actions-mask{position:fixed;inset:0;z-index:110;background:#18332908;overscroll-behavior:contain}
.message-actions,.message-actions:focus-visible{outline:none;position:absolute;width:max-content;overflow:visible;border:0;border-radius:7px;background:#333;padding:4px;box-shadow:0 4px 14px #0003;transform-origin:center var(--menu-origin,bottom)}
.message-actions::after{content:"";position:absolute;left:var(--menu-arrow-x,50%);transform:translateX(-50%);border:6px solid transparent;pointer-events:none}.message-actions.above::after{top:100%;border-top-color:#333}.message-actions.below::after{bottom:100%;border-bottom-color:#333}.message-action-row{display:flex;flex-wrap:wrap;justify-content:center;align-items:stretch;max-height:inherit;overflow:auto}.message-action-row>button{flex:0 0 58px;width:58px;min-width:0;min-height:52px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;background:transparent;border:0;border-radius:7px;color:#fff;font-size:12px;line-height:1.3;padding:6px 3px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background-color .1s ease}
.message-action-row>button .icon{width:18px;height:18px;stroke-width:1.65}.message-action-row>button small{font-size:9px;white-space:nowrap;color:var(--muted);line-height:1.2}.message-action-row>button:disabled{opacity:.4}.message-action-row>button:active{background:#555}.message-actions:not(.keyboard-menu) .message-action-row>button:focus-visible{outline:none;box-shadow:none}.keyboard-menu .message-action-row>button:focus-visible{outline:1px solid #fff;outline-offset:-2px;background:#555}
.message-menu-leave-active{pointer-events:none}.message-menu-enter-active{transition:opacity .12s ease-out}.message-menu-leave-active{transition:opacity .1s ease-in}.message-menu-enter-active .message-actions,.message-menu-leave-active .message-actions{transition:transform .14s ease,opacity .12s ease}.message-menu-enter-from,.message-menu-leave-to{opacity:0}.message-menu-enter-from .message-actions,.message-menu-leave-to .message-actions{transform:scale(.98)}
.chat-reply-link{display:block;width:100%;text-align:left;border:0;border-left:2px solid #a8bcb4;background:#edf2ee;color:var(--muted);padding:8px 10px;margin-bottom:8px;font-size:var(--message-meta-size);line-height:1.5;overflow-wrap:anywhere}.chat-reply-link span{display:block;font-size:10px;margin-top:3px}.highlighted .chat-bubble{background:#dcece2;transition:background-color .18s ease}.recalled-note{font-size:12px!important;color:var(--muted)}@media(prefers-reduced-motion:reduce){.message-menu-enter-active,.message-menu-leave-active,.message-menu-enter-active .message-actions,.message-menu-leave-active .message-actions,.highlighted .chat-bubble,.actions-active .chat-bubble{transition:none}}
</style>

<style scoped>
.chat-attachments:empty{display:none}.draft-file{display:flex;align-items:center;gap:6px;margin-top:6px;padding:5px 8px;border-radius:7px;background:var(--green-soft);color:var(--ink)}.draft-file>.icon{width:16px;height:16px;flex:none}.draft-name{flex:1;min-width:0;text-align:left;border:0;padding:0;background:transparent;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.draft-remove{border:0;background:transparent;color:var(--muted);width:32px;height:32px;flex:none;font-size:20px}
</style>

<style scoped>
.chat-page .chat-query-summary{display:flex;align-items:center;gap:8px;margin:0;padding:6px 12px;background:transparent;border-radius:0;color:#777;font-size:13px}.chat-query-summary>span{flex:1;min-width:0;overflow-wrap:anywhere}.chat-query-summary>button{flex:none;border:0;background:transparent;color:#4c6485;min-height:40px;padding:6px 4px;font-size:13px}.chat-page .chat-composer.composer-hidden{display:none!important}.chat-selection-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:64px;padding:calc(8px + env(safe-area-inset-top)) 16px 8px;background:#ededed;flex:none}.chat-selection-heading strong{font-size:17px;font-weight:500}.chat-selection-heading button{border:0;background:transparent;color:var(--ink);padding:8px;min-height:44px;font-size:16px}.chat-selection-actions{display:flex;justify-content:center;flex:none;padding:8px 12px max(8px,env(safe-area-inset-bottom));border-top:1px solid var(--line);background:#f3f3f3}.chat-selection-actions button{flex:1;justify-content:center;display:flex;align-items:center;gap:8px;min-height:44px;border:0;background:transparent;padding:8px 4px;color:var(--ink);font-size:13px}.chat-selection-actions button:disabled{opacity:.4}.selection-mode{position:relative;padding-left:28px}.message-select{position:absolute;left:0;top:12px;display:grid;place-items:center;width:22px;height:22px;padding:2px;border:1px solid #aaa;border-radius:50%;background:transparent;color:white}.message-select[aria-pressed=true]{background:#07b75e;border-color:#07b75e}.message-select:disabled{opacity:.3}.message-select .icon{width:16px;height:16px}.chat-message.selection-mode.selected{background:#00000006;border-radius:5px}.chat-selection-actions .icon{width:20px;height:20px}
</style>

<style scoped>.forward-mode-choices{display:grid;gap:6px}.forward-mode-choices .btn{justify-content:flex-start;text-align:left;min-height:44px}</style>
