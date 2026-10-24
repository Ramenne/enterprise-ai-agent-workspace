<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, onMounted, inject, nextTick } from "vue";
import { useSessionStore } from "@/session/store";
import { collaboration, type Computer } from "@/collaboration/api";
import {
  runCommand,
  delay,
  waitCommand,
  UnconfirmedCommand,
} from "@/collaboration/commands";
import {readOutbox,writeOutbox,type Outgoing} from '@/collaboration/outbox';
import {findNativeMessageReceipt} from '@/collaboration/receipt';
import { savePending, loadPending, clearPending } from "@/collaboration/pending";
import CollaborationMessage from '@/ui/components/CollaborationMessage.vue';
import {mergeMessages,mergeTurns,type VisibleTurn} from '@/collaboration/presentation';
import PairScanner from "@/ui/components/PairScanner.vue";
import ModalSheet from "@/ui/components/ModalSheet.vue";
import {useRoute,useRouter} from 'vue-router';
import {cacheKey,readCache,writeCache,removeReadCache} from '@/collaboration/readCache';
import {useConversationViewport} from '@/ui/useConversationViewport';
import ChoiceSelect from '@/ui/components/ChoiceSelect.vue';
import MessageInput from '@/ui/components/MessageInput.vue';
import AgentQuestions from '@/ui/components/AgentQuestions.vue';
const route=useRoute(),router=useRouter();
const stream=ref<HTMLElement|null>(null),input=ref<HTMLTextAreaElement|null>(null);
const reading=useConversationViewport(stream,input);
type Task = { actions?:string[]; pinned?:boolean; section_id?:string; section_name?:string; section_order?:number; project_order?:number; thread_order?:number; id: string; title: string; cwd: string; project_id?: string; project_name?: string; updated_at?: number };
type Turn = VisibleTurn;
type Pending = {
  id: string;
  turn_id: string;
  kind: string;
  title: string;
  detail?: string;
  questions?: {
    id: string;
    question: string;
    options?: { label: string; description: string }[];
  }[];
};
const exitCollaboration = inject<() => void>('exitCollaboration', () => { location.href = '/chat'; });
const menuTask=ref<Task|null>(null),menuMessage=ref<import('@/collaboration/presentation').VisibleMessage|null>(null);
const menuNotice=ref('');
function supportsAction(action:string){return !!menuTask.value?.actions?.includes(action);}
let pressTimer:ReturnType<typeof setTimeout>|undefined,pressX=0,pressY=0,pressed=false;
function cancelPress(){clearTimeout(pressTimer);}
function startPress(e:PointerEvent,action:()=>void){
  if(e.button!==0)return;pressed=false;cancelPress();pressX=e.clientX;pressY=e.clientY;
  pressTimer=setTimeout(()=>{pressed=true;action();},450);
}
function movePress(e:PointerEvent){if(Math.hypot(e.clientX-pressX,e.clientY-pressY)>10)cancelPress();}
function consumePress(e:MouseEvent){if(pressed){e.preventDefault();e.stopPropagation();pressed=false;}}
async function copyText(text:string){try{await navigator.clipboard.writeText(text);menuMessage.value=null;menuTask.value=null;}catch{menuNotice.value='复制未成功，请重试';}}
async function setPinned(){await organiseTask(menuTask.value?.pinned?'unpin':'pin');}
async function organiseTask(operation:'pin'|'unpin'){
  const t=menuTask.value,account=session.user?.username;
  if(!t||!supportsAction(operation)||!account||busy.value||activeMutation.value||uncertain.value||pendingError.value||!runnable.value)return;
  const id=crypto.randomUUID(),signal=accountController.signal,epoch=generation;
  const entry={id,computer:selected.value,provider:provider.value,thread:t.id,operation};
  try{savePending(account,entry);}catch{menuNotice.value='无法保存操作记录，未执行';return;}
  activeMutation.value=id;busy.value=true;
  try{
    await runCommand(selected.value,{operation,provider:provider.value,thread_id:t.id},signal,id);
    clearPending(account,id);if(signal.aborted)return;uncertain.value=null;menuTask.value=null;
    applyTaskOrganisation(account,entry);
    if(epoch===generation)await listTasks();
  }catch(e){
    if(e instanceof UnconfirmedCommand)uncertain.value=entry;
    if(!(e instanceof UnconfirmedCommand)&&!signal.aborted){clearPending(account,id);uncertain.value=null;}
    if(!signal.aborted)menuNotice.value=e instanceof Error?e.message:'任务操作未确认';
  }finally{if(activeMutation.value===id)activeMutation.value=null;if(epoch===generation)busy.value=false;}
}
function applyTaskOrganisation(account:string,entry:{computer:string;provider?:string;thread:string;operation?:string}){
  if(!entry.operation||!['pin','unpin'].includes(entry.operation))return;
  // Use the original account/device/provider even if the user navigated elsewhere.
  const kinds=['list:true','list:false'];
  for(const kind of kinds)removeReadCache(cacheKey(account,entry.computer,entry.provider||'codex',kind));
}
const provider = ref('codex'), query = ref(''), archived = ref(false);
const providerName = computed(() => provider.value === 'qoder' ? 'Qoder CN' : 'Codex');
const taskList = ref<HTMLElement | null>(null);
const listScroll = ref(0);
const collapsed = ref<string[]>([]);
const canInterrupt = ref(false);
const stopOperation=ref<'interrupt'|'stop_task'>('interrupt');
const selectionKey = () => 'employeeclient:collaboration:selection:' + (session.user?.username || '');
function remember() {
  if (!session.user?.username) return;
  try { localStorage.setItem(selectionKey(), JSON.stringify({computer:selected.value, provider:provider.value, query:query.value, archived:archived.value, scroll:listScroll.value, collapsed:collapsed.value})); } catch {}
}
function remembered(): Record<string, any> {
  try { return JSON.parse(localStorage.getItem(selectionKey()) || '{}'); } catch { return {}; }
}
function changeProvider(value:string) { archived.value=false; query.value=''; collapsed.value=[]; listScroll.value=0; selectComputer(selected.value,value); }
function changeArchive(){listScroll.value=0;remember();void selectComputer(selected.value);}
function toggleGroup(id:string) { collapsed.value = collapsed.value.includes(id) ? collapsed.value.filter(x=>x!==id) : [...collapsed.value,id]; remember(); }
const groups = computed(() => {
  const map = new Map<string,{id:string,name:string,tasks:Task[],order:number}>();
  for (const t of tasks.value) {
    const name=t.section_name || t.project_name || t.cwd?.split('/').filter(Boolean).pop() || '独立任务';
    if (!(t.title+' '+name).toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())) continue;
    const id=t.section_id || t.project_id || t.cwd || 'standalone';
    if(!map.has(id))map.set(id,{id,name,tasks:[],order:t.pinned?-2:t.section_id?-1:(t.project_order??999)});
    map.get(id)!.tasks.push(t);
  }
  return [...map.values()].sort((a,b)=>a.order-b.order).map(g=>({...g,tasks:g.tasks.sort((a,b)=>(a.section_order??a.thread_order??999)-(b.section_order??b.thread_order??999))}));
});
function scrollTasks() {
  const node=taskList.value;if(!node)return;listScroll.value=node.scrollTop;remember();
  if(node.scrollHeight-node.scrollTop-node.clientHeight<160 && taskCursor.value && !loading.value)void listTasks(true);
}
const session = useSessionStore();
const computers = ref<Computer[]>([]),
  selected = ref(""),
  tasks = ref<Task[]>([]),
  task = ref<Task | null>(null);
const turns = ref<Turn[]>([]),
  live = ref<Turn[]>([]),
  requests = ref<Pending[]>([]);
const status = ref(""),
  turnId = ref(""),
  notice = ref(""),
  error = ref(""),
  deviceError = ref("");
const cursor = ref<string | null>(null),
  taskCursor = ref<string | null>(null),
  code = ref(""),
  draft = ref("");
const loading = ref(false),
  busy = ref(false),
  pairing = ref(false),
  showPair = ref(false),
  showDevices = ref(false),
  canControl = ref(false);
const pendingError = ref(false);
const devicesLoading=ref(true),deviceVerified=ref(false),connectionStale=ref(false);
const activeMutation=ref<string|null>(null),outgoing=ref<Outgoing[]>([]);
const optionsLoading=ref(false),optionsError=ref(''),showCreate=ref(false),newMessage=ref(''),newProject=ref(''),newModel=ref(''),newEffort=ref(''),selectedModel=ref(''),selectedEffort=ref('');
const nativeOptions=ref<{models:{id:string;label:string;default_effort?:string;supported_efforts?:string[]}[];projects:{id:string;name:string}[];capabilities:Record<string,boolean>}>({models:[],projects:[],capabilities:{}});
type NativeQueued={id:string;client_id:string;text:string;attachments:number;editable:boolean;state?:string;steerable?:boolean;removable?:boolean};
const desktopQueue=ref<NativeQueued[]>([]),queueCursor=ref<string|null>(null),queueSync=ref(false),queueLoading=ref(false);
const editingQueue=ref<NativeQueued|null>(null),queueEditText=ref('');
const actualModel=ref(''),actualEffort=ref('');
const sendModelSelect=ref(false),nativeQueue=ref(false),canSteer=ref(false),canAnswerQuestion=ref(false),clockNow=ref(Date.now());
const currentOutgoing=computed(()=>outgoing.value.filter(r=>r.computer===selected.value&&r.provider===provider.value&&r.thread===task.value?.id));
const modelChoices=computed(()=>[{value:'',label:'沿用电脑设置'},...nativeOptions.value.models.map(m=>({value:m.id,label:m.label}))]);
const modelSettingsAvailable=computed(()=>provider.value==='codex'||sendModelSelect.value||nativeOptions.value.capabilities.model_select===true);
const newEffortChoices=computed(()=>choicesForEffort(newModel.value));
const effortChoices=computed(()=>choicesForEffort(selectedModel.value));
function choicesForEffort(model:string){return [{value:'',label:'模型默认'},...(nativeOptions.value.models.find(m=>m.id===model)?.supported_efforts||[]).map(value=>({value,label:({none:'关闭',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'} as Record<string,string>)[value]||value}))];}
watch(selectedModel,()=>{if(nativeOptions.value.models.length&&!effortChoices.value.some(e=>e.value===selectedEffort.value))selectedEffort.value='';});
watch(newModel,()=>{if(!newEffortChoices.value.some(e=>e.value===newEffort.value))newEffort.value='';});
const projectChoices=computed(()=>[{value:'',label:'独立任务'},...nativeOptions.value.projects.map(p=>({value:p.id,label:p.name}))]);
let eventsActive=false;
let eventConnecting=false;
let activeWatch:{computer:string;provider:string;thread:string;id:string}|null=null;
function persistOutgoing(){if(session.user?.username)writeOutbox(session.user.username,outgoing.value);}
function reviseOutgoing(id:string,patch:Partial<Outgoing>){outgoing.value=outgoing.value.map(r=>r.id===id?{...r,...patch}:r);try{persistOutgoing();return true;}catch{pendingError.value=true;error.value="消息记录未能保存，发送已暂停";return false;}}
function cancelOutgoing(row:Outgoing){if(!['queued','failed'].includes(row.state)||!session.user)return false;const next=outgoing.value.filter(r=>r.id!==row.id);try{writeOutbox(session.user.username,next);outgoing.value=next;return true;}catch{pendingError.value=true;error.value='待发记录未能更新，发送已暂停';return false;}}
function editOutgoing(row:Outgoing){if(draft.value.trim()||!['queued','failed'].includes(row.state))return;if(!cancelOutgoing(row))return;draft.value=row.text;selectedModel.value=row.model||'';selectedEffort.value=row.effort||'';void nextTick(()=>input.value?.focus());}
function queueMessage(){
  if(!task.value||!draft.value.trim()||pendingError.value)return;
  const row:Outgoing={id:crypto.randomUUID(),computer:selected.value,provider:provider.value,thread:task.value.id,text:draft.value.trim(),model:selectedModel.value||undefined,effort:selectedModel.value&&selectedEffort.value?selectedEffort.value:undefined,createdAt:Date.now(),state:'queued',previousIds:messages.value.filter(m=>m.role==='user').map(m=>m.id)};
  outgoing.value=[...outgoing.value,row];
  try{persistOutgoing();}catch{outgoing.value=outgoing.value.filter(r=>r.id!==row.id);error.value='待发消息未能保存，请检查本机存储';return;}
  draft.value='';reading.atLatest.value=true;void nextTick(reading.bottom);void drainOutgoing();
}
async function drainOutgoing(){
  if(!task.value||busy.value||activeMutation.value||uncertain.value||pendingError.value||!runnable.value||(!canControl.value&&!queueSync.value)||(!queueSync.value&&requests.value.length))return;
  // Codex's default is a next-turn queue; only the explicit action steers.
  // Qoder owns the boundary at which its native queued supplement is consumed.
  if(running.value&&!queueSync.value&&!nativeQueue.value)return;
  const row=currentOutgoing.value.find(r=>r.state==='queued');if(!row)return;
  if(row.model&&!sendModelSelect.value&&running.value&&!queueSync.value)return;
  await mutate(running.value&&queueSync.value?'queue_add':'send',{message:row.text,...(row.model?{model:row.model}:{}),...(row.effort?{effort:row.effort}:{})},row.text,row.id);
}
async function steerOutgoing(row:Outgoing){
  if(row.state!=='queued'||!currentOutgoing.value.includes(row))return;
  if(!running.value){await drainOutgoing();return;}
  if(!canSteer.value||busy.value||activeMutation.value||uncertain.value||!runnable.value||requests.value.length)return;
  // Steering belongs to the active turn. The queued model choice must not
  // silently restart that turn or change the model of work already running.
  await mutate('steer',{message:row.text},row.text,row.id);
}
function editNativeQueue(row:NativeQueued){if(!row.editable||!queueSync.value)return;editingQueue.value=row;queueEditText.value=row.text;}
async function saveQueueEdit(){
  const row=editingQueue.value;if(!row||!queueEditText.value.trim())return;
  await mutate('queue_update',{queue_id:row.id,message:queueEditText.value.trim()});
  if(!error.value&&!uncertain.value)editingQueue.value=null;
}
async function moreQueue(){
  if(!task.value||!queueCursor.value||queueLoading.value)return;
  queueLoading.value=true;const epoch=generation;
  try{const r=await runCommand(selected.value,{operation:'queue_list',provider:provider.value,thread_id:task.value.id,cursor:queueCursor.value},context.signal);
    if(epoch===generation){desktopQueue.value=[...new Map([...desktopQueue.value,...r.queue].map((q:NativeQueued)=>[q.id,q])).values()];queueCursor.value=r.queue_cursor;}
  }catch(e){if(epoch===generation&&!context.signal.aborted)error.value=e instanceof Error?e.message:'队列读取失败';}
  finally{if(epoch===generation)queueLoading.value=false;}
}
function reconcileOutgoing(){
  const all=messages.value;
  // Codex writes the command ID into the native user message. That receipt is
  // stronger than a gateway timeout and can settle an uncertain send without
  // replaying it. Qoder's older projection lacks this ID: text matching is
  // only used for an already accepted row, never to clear an unknown write.
  const exact=(row:Outgoing)=>all.some(m=>m.role==='user'&&m.client_id===row.id);
  const nativeQueueReceipt=(row:Outgoing)=>desktopQueue.value.some(q=>q.client_id===row.id);
  const proven=(row:Outgoing)=>nativeQueueReceipt(row)||exact(row)||
    (row.provider==='qoder'&&row.state==='accepted'&&all.some(m=>m.role==='user'&&m.text.trim()===row.text&&!row.previousIds.includes(m.id)));
  if(uncertain.value&&session.user?.username&&outgoing.value.some(row=>row.id===uncertain.value?.id&&row.state==='unknown'&&(exact(row)||nativeQueueReceipt(row)))){
    try{clearPending(session.user.username,uncertain.value.id);uncertain.value=null;notice.value='消息已在电脑会话中确认';}
    catch{pendingError.value=true;error.value='已收到电脑消息，但本机记录未能更新';return;}
  }
  const next=outgoing.value.filter(row=>!currentOutgoing.value.includes(row)||!['accepted','unknown'].includes(row.state)||!proven(row));
  if(next.length!==outgoing.value.length){outgoing.value=next;try{persistOutgoing();}catch{pendingError.value=true;error.value="已接收消息的本机记录未能更新，自动发送已暂停";}}
}
async function loadOptions(){
  if(!runnable.value||optionsLoading.value)return;
  optionsLoading.value=true;optionsError.value='';const epoch=generation;
  try{const r=await runCommand(selected.value,{operation:'options',provider:provider.value},context.signal);
    if(epoch===generation)nativeOptions.value={models:r.models||[],projects:r.projects||[],capabilities:r.capabilities||{}};
  }catch(e){if(epoch===generation&&!context.signal.aborted)optionsError.value=e instanceof Error?e.message:'暂时无法读取模型';}
  finally{if(epoch===generation)optionsLoading.value=false;}
}
function beginCreate(){showCreate.value=true;newMessage.value='';newProject.value='';newModel.value='';newEffort.value='';void loadOptions();}
async function createConversation(){
  if(!newMessage.value.trim()||activeMutation.value||uncertain.value||pendingError.value||!runnable.value||!nativeOptions.value.capabilities.create)return;
  const account=session.user!.username,cid=selected.value,p=provider.value,epoch=generation,id=crypto.randomUUID(),text=newMessage.value.trim(),signal=accountController.signal;
  const entry={id,computer:cid,provider:p,thread:'new:'+id,operation:'create',message:text};
  try{savePending(account,entry);}catch{optionsError.value='无法保存新建记录，未提交';return;}
  activeMutation.value=id;busy.value=true;
  try{const r=await runCommand(cid,{operation:'create',provider:p,message:text,...(newProject.value?{project_id:newProject.value}:{}),...(newModel.value?{model:newModel.value}:{}),...(newModel.value&&newEffort.value?{effort:newEffort.value}:{})},signal,id);
    if(signal.aborted)return;clearPending(account,id);if(epoch!==generation)return;
    showCreate.value=false;newMessage.value='';const t={id:r.thread_id,title:r.title||text.slice(0,60),cwd:''};tasks.value=[t,...tasks.value];
    // The desktop accepted the first prompt. Reuse the durable delivery row
    // until native history replaces it; never fabricate a native message ID.
    outgoing.value=[...outgoing.value,{id,computer:cid,provider:p,thread:t.id,text,createdAt:Date.now(),state:'accepted',previousIds:[]}];
    try{persistOutgoing();}catch{pendingError.value=true;error.value='已创建会话，本机消息缓存暂未保存';}
    busy.value=false;if(activeMutation.value===id)activeMutation.value=null;
    await openTask(t);
  }catch(e){if(signal.aborted)return;if(e instanceof UnconfirmedCommand){if(typeof e.result?.thread_id==='string')entry.thread=e.result.thread_id;uncertain.value=entry;savePending(account,entry);showCreate.value=false;}if(epoch===generation)optionsError.value=e instanceof Error?e.message:'新建未确认';if(!(e instanceof UnconfirmedCommand)&&!signal.aborted)clearPending(account,id);}
  finally{if(activeMutation.value===id)activeMutation.value=null;if(epoch===generation)busy.value=false;}
}
async function listenForChanges(){
  if(!task.value||!runnable.value||eventConnecting||eventsActive)return;
  eventConnecting=true;
  const epoch=generation,signal=context.signal,cid=selected.value,tid=task.value.id,p=provider.value,watchId=crypto.randomUUID();
  try{
    activeWatch={computer:cid,provider:p,thread:tid,id:watchId};
    const initial=await collaboration.watch(cid,watchId,p,tid,signal);
    if(epoch!==generation)return;activeWatch={computer:cid,provider:p,thread:tid,id:watchId};eventsActive=true;eventConnecting=false;clearTimeout(timer);
    let revision=initial.revision;await updateLive();
    while(epoch===generation&&!signal.aborted){
      const e=await collaboration.events(cid,watchId,revision,signal);if(epoch!==generation)return;
      if(e.watch_active===false){const renewed=await collaboration.watch(cid,watchId,p,tid,signal);revision=renewed.revision;await updateLive();continue;}
      if(e.changed||e.revision!==revision){revision=e.revision;projectionDirty=true;await updateLive();}
      if(e.wait_deferred)await delay(750,signal);
    }
  }catch(e){
    if(epoch!==generation||signal.aborted)return;stopWatching();
    // Legacy/disconnected relay fallback only; the normal path is event driven.
    void updateLive();
  }
}
function stopWatching(){
  const previous=activeWatch;activeWatch=null;eventsActive=false;eventConnecting=false;
  if(previous&&!accountController.signal.aborted){
    // A short independent cancellation survives view unmount. apiRequest still
    // captures the current account credential/epoch before any account switch.
    const cleanup=new AbortController(),deadline=setTimeout(()=>cleanup.abort(),3000);
    void collaboration.watch(previous.computer,previous.id,previous.provider,null,cleanup.signal).catch(()=>{}).finally(()=>clearTimeout(deadline));
  }
}

const uncertain = ref<{
  id: string;
  computer: string;
  provider?: string;
  operation?: string;
  thread: string;
  message?: string;
} | null>(null);
let generation = 0,
  context = new AbortController(),
  accountController = new AbortController(),
  timer: ReturnType<typeof setTimeout> | undefined;
let deviceRead = 0;
let historyFetchedAt=0,listFetchedAt=0,controlFailures=0,projectionDirty=false;
let historyRevision:string|undefined;
const drafts = new Map<string, string>();
const computer = computed(() =>
  computers.value.find((c) => c.id === selected.value),
);
const runnable = computed(
  () => deviceVerified.value && computer.value?.online && session.status === "online",
);
const messages = computed(() => mergeMessages(turns.value,live.value));
const running = computed(() => status.value === "inProgress");
const startedAt=computed(()=>[...turns.value,...live.value].find(t=>t.id===turnId.value)?.started_at);
const elapsed=computed(()=>startedAt.value?Math.max(0,Math.floor((clockNow.value-startedAt.value)/1000)):null);
const workingTime=computed(()=>elapsed.value===null?'':elapsed.value<60?elapsed.value+'秒':Math.floor(elapsed.value/60)+'分'+elapsed.value%60+'秒');
// Transport acknowledgements never imply that the desktop started thinking.
// Only a fresh native execution state animates the response area.
const activityMode=computed(()=>connectionStale.value?'reconnecting':requests.value.length?null:status.value==='failed'?'failed':running.value?'working':null);
const activityLabel=computed(()=>activityMode.value==='reconnecting'?'正在重新连接电脑':activityMode.value==='failed'?'执行未完成':'正在处理');
const draftKey = () => provider.value + ":" + selected.value + ":" + (task.value?.id || "");
function readKey(kind:string){return cacheKey(session.user?.username||'',selected.value,provider.value,kind);}
function saveReading(){
  if(!task.value||!session.user?.username)return;
  writeCache(readKey('thread:'+task.value.id),{turns:turns.value,live:live.value,cursor:cursor.value,draft:draft.value,scroll:stream.value?.scrollTop||0,atLatest:reading.atLatest.value,status:status.value,queue:desktopQueue.value,historyFetchedAt,historyRevision,projectionVersion:needsMediaUpgrade?0:2});
}
function resetContext() {
  stopWatching();controlFailures=0;projectionDirty=false;nativeQueue.value=false;canSteer.value=false;sendModelSelect.value=false;connectionStale.value=false;optionsLoading.value=false;
  actualModel.value="";actualEffort.value="";nativeOptions.value={models:[],projects:[],capabilities:{}};selectedModel.value="";selectedEffort.value="";optionsError.value="";
  desktopQueue.value=[];queueCursor.value=null;queueSync.value=false;queueLoading.value=false;editingQueue.value=null;
  generation++;
  historyDirty=false;historyRevision=undefined;
  context.abort();
  context = new AbortController();
  clearTimeout(timer);
  loading.value = false;
  busy.value = false;
  canControl.value = false;canInterrupt.value=false;
  requests.value = [];
  live.value = [];
  notice.value = "";
  error.value = "";
  status.value = "";
  turnId.value = "";
}
const serviceRetired=ref(false);
async function refreshDevices() {
  if(serviceRetired.value)return;
  const seq = ++deviceRead,
    signal = accountController.signal;
  try {
    const r = await collaboration.computers(signal);
    if (signal.aborted || seq !== deviceRead) return;
    const wasOnline = computer.value?.online,wasVerified=deviceVerified.value;
    const hadSelected=!!selected.value;
    computers.value = r.computers;deviceVerified.value=true;
    writeCache(cacheKey(session.user!.username,"","","computers"),r.computers);
    if (!selected.value && r.computers.length) {
      const saved=remembered();
      const choice=r.computers.find(c=>c.id===saved.computer) || r.computers[0];
      selectComputer(choice.id);
    }
    if (hadSelected && selected.value && !wasOnline && computer.value?.online && !task.value) { error.value = ""; if(!listFetchedAt||Date.now()-listFetchedAt>60000)void listTasks(); }
    deviceError.value = "";
    if(task.value&&computer.value?.online){
      if(!eventsActive)void listenForChanges();
      else if(!wasVerified||!wasOnline||projectionDirty)void updateLive();
    }
    if (selected.value && !r.computers.some((c) => c.id === selected.value))
      selectComputer("");
  } catch (e) {
    if (signal.aborted || seq !== deviceRead) return;
    deviceVerified.value=false;
    if(e&&typeof e==='object'&&'status' in e&&e.status===410){
      serviceRetired.value=true;clearInterval(deviceTimer);showPair.value=false;showDevices.value=false;
      computers.value=computers.value.map(c=>({...c,online:false}));
      deviceError.value='当前版本暂不支持电脑任务协作';
    }else deviceError.value = "暂时无法连接电脑，已读内容仍可查看";
  }finally{if(!signal.aborted&&seq===deviceRead)devicesLoading.value=false;}
}
async function selectComputer(id: string, nextProvider = provider.value) {
  saveReading();
  drafts.set(draftKey(), draft.value);
  resetContext();
  provider.value = nextProvider;
  selected.value = id;
  task.value = null;
  tasks.value = [];
  turns.value = [];
  draft.value = "";
  cursor.value = null;
  taskCursor.value = null;
  showDevices.value = false;
  remember();
  const epoch=generation;
  const cached=id?await readCache<{tasks:Task[];cursor:string|null;pages?:number}>(readKey('list:'+archived.value)):null;
  if(epoch!==generation)return;
  listPages=cached?.value.pages||1;listFetchedAt=cached?.at||0;
  if(cached){tasks.value=cached.value.tasks;taskCursor.value=cached.value.cursor;}
  if(id&&computer.value?.online&&(!cached||Date.now()-cached.at>60000))void listTasks();
}
let listPages=1;
async function listTasks(more = false) {
  if (loading.value || !selected.value || !computer.value?.online) return;
  const epoch = generation,
    signal = context.signal,
    cid = selected.value,archiveView=archived.value;
  loading.value = true;
  try {
    // Port of Jiling TaskListCache.fetch: refresh the full loaded prefix atomically.
    const rows=new Map<string,Task>(more?tasks.value.map(t=>[t.id,t]):[]);
    let next=more?taskCursor.value:null,pages=more?listPages:0;
    const count=more?1:Math.max(1,listPages),seen=new Set<string|null>();
    for(let i=0;i<count;i++){
      if(seen.has(next))throw new Error('任务分页重复，请刷新');seen.add(next);
      const r=await runCommand(cid,{operation:'list',provider:provider.value,
        archived:archiveView,...(next?{cursor:next}:{})},signal);
      if(epoch!==generation)return;
      for(const t of r.threads)rows.set(t.id,t);
      next=r.cursor;pages++;if(!next)break;
    }
    tasks.value=[...rows.values()];taskCursor.value=next;listPages=pages;listFetchedAt=Date.now();
    writeCache(readKey('list:'+archiveView),{tasks:tasks.value,cursor:next,pages});
    await nextTick();
    if (!more && taskList.value) taskList.value.scrollTop=listScroll.value;
    error.value = "";
  } catch (e) {
    if (epoch === generation && !signal.aborted)
      error.value = e instanceof Error ? e.message : "任务读取失败";
  } finally {
    if (epoch === generation) loading.value = false;
  }
}
async function openTask(value: Task) {
  saveReading();
  drafts.set(draftKey(), draft.value);
  resetContext();
  task.value = value;
  turns.value = [];
  cursor.value = null;
  draft.value = drafts.get(draftKey()) || "";
  const epoch = generation;loading.value=true;
  const cached=await readCache<{turns:Turn[];live:Turn[];cursor:string|null;draft:string;scroll:number;atLatest:boolean;status?:string;queue?:NativeQueued[];historyFetchedAt?:number;historyRevision?:string;projectionVersion?:number}>(readKey('thread:'+value.id));
  if(epoch!==generation)return;
  loading.value=false;historyFetchedAt=cached?.value.historyFetchedAt||0;historyRevision=cached?.value.historyRevision;needsMediaUpgrade=!!cached&&cached.value.projectionVersion!==2;
  if(cached){turns.value=cached.value.turns;live.value=cached.value.live;cursor.value=cached.value.cursor;status.value=cached.value.status||'';desktopQueue.value=cached.value.queue||[];draft.value=drafts.get(draftKey())??cached.value.draft;reading.atLatest.value=cached.value.atLatest;}
  else reading.atLatest.value=true;
  if(route.query.thread!==value.id)await router.push({query:{...route.query,thread:value.id}});
  // Render the task and accepted prompt immediately. History and live state
  // are independent reads; neither should delay opening the conversation.
  if(!cached)void history();
  await nextTick();if(epoch!==generation)return;reading.observe();reading.resize();
  if(cached&&!cached.value.atLatest&&stream.value)stream.value.scrollTop=cached.value.scroll;
  else reading.bottom();
  if (epoch === generation) {void listenForChanges();}
}
async function history(older = false, recovering = false) {
  if (!task.value || loading.value) return;
  const epoch = generation,
    signal = context.signal,
    tid = task.value.id;
  loading.value = true;
  const previousHeight=stream.value?.scrollHeight||0,previousTop=stream.value?.scrollTop||0;
  try {
    const r = await runCommand(
      selected.value,
      {
        operation: "history", provider:provider.value,
        thread_id: tid,
        ...(older && cursor.value ? { cursor: cursor.value } : {}),
      },
      signal,
    );
    if (epoch !== generation) return;
    if(!older){historyFetchedAt=Date.now();historyRevision=r.source_revision;}
    turns.value = older || recovering ? mergeTurns(turns.value,r.turns) : r.turns;
    cursor.value = r.cursor;
    reconcileOutgoing();
    await nextTick();
    if(older&&stream.value)stream.value.scrollTop=previousTop+stream.value.scrollHeight-previousHeight;
    else if(reading.atLatest.value)reading.bottom();
    saveReading();
    error.value = "";
  } catch (e) {
    if(epoch!==generation||signal.aborted)return;
    const message=e instanceof Error?e.message:'历史读取失败';
    if(older&&!recovering&&/阅读位置|该轮消息已更新/.test(message)){
      // Restart only the read cursor after a connector restart; preserve visible history.
      cursor.value=null;loading.value=false;await history(false,true);
    }else error.value=message;
  } finally {
    if (epoch === generation) loading.value = false;
  }
}
let liveSequence = 0;
let historyDirty=false;
let needsMediaUpgrade=false;
async function catchUpHistory(known:Set<string>,epoch:number,signal:AbortSignal,upgrade=false){
  if(!task.value||loading.value)return;
  const tid=task.value.id,previousCursor=cursor.value,anchor=reading.capture();
  loading.value=true;
  let next:string|null=null;let revision:string|undefined;const visited=new Set<string>();
  try{
    do{
      const r=await runCommand(selected.value,{operation:'history',provider:provider.value,thread_id:tid,...(next?{cursor:next}:{})},signal);
      if(epoch!==generation)return;
      if(next===null){revision=r.source_revision;if(r.source_revision&&r.turn_id)turnId.value=r.turn_id;}
      turns.value=mergeTurns(turns.value,r.turns);
      next=r.cursor;
      // Stop at the previously read boundary only after any split messages are
      // complete. This also fills >2 new turns accumulated while away.
      const reached=r.turns.some((t:Turn)=>known.has(t.id)&&mergeMessages(turns.value.filter(x=>x.id===t.id),[])
        .every(m=>!m.missingPrefix&&(!m.total_length||[...m.text].length>=m.total_length)));
      if(reached){cursor.value=previousCursor;break;}
      cursor.value=next;
      if(next&&visited.has(next))throw new Error('历史分页暂未前进，已加载内容保留');
      if(next)visited.add(next);
    }while(next);
    if(upgrade)needsMediaUpgrade=false;
    historyDirty=false;historyRevision=revision;historyFetchedAt=Date.now();reconcileOutgoing();await nextTick();reading.restore(anchor);saveReading();
  }catch(e){if(epoch===generation&&!signal.aborted)notice.value='新增历史暂未同步完整，已加载的消息仍可查看。';}
  finally{if(epoch===generation)loading.value=false;}
}
async function updateLive() {
  if (!task.value) return;
  clearTimeout(timer);
  const epoch = generation,
    signal = context.signal,
    seq = ++liveSequence;
  try {
    if (runnable.value && !busy.value) {
      const r = await runCommand(
        selected.value,
        { operation: "control", provider:provider.value, thread_id: task.value.id },
        signal,
      );
      if (epoch !== generation || seq !== liveSequence) return;
      const anchor=reading.capture();
      const known=new Set([...turns.value,...live.value].map(t=>t.id));
      const includesHistory=r.history_included!==false;
      const changed=includesHistory ? JSON.stringify(live.value)!==JSON.stringify(r.turns)
        : !r.source_revision||r.source_revision!==historyRevision;
      if(includesHistory){
        turns.value=mergeTurns(turns.value,live.value);
        live.value=r.turns;
      }else if(live.value.length){
        // Migrate caches produced by the older control-with-history protocol.
        // Otherwise stale live chunks would win over fresh history of the same ID.
        turns.value=mergeTurns(turns.value,live.value);live.value=[];
      }
      await nextTick();if(epoch!==generation||seq!==liveSequence)return;
      reading.restore(anchor);
      saveReading();
      actualModel.value=r.model||'';actualEffort.value=r.effort||'';
      status.value = r.status;connectionStale.value=false;controlFailures=0;projectionDirty=false;
      turnId.value = r.turn_id || (includesHistory||changed ? "" : turnId.value);
      requests.value = r.requests || [];
      queueSync.value=r.capabilities?.queue_sync===true;
      if(queueSync.value){desktopQueue.value=r.queue||[];queueCursor.value=r.queue_cursor||null;}
      canControl.value = r.capabilities?.send !== false;
      nativeQueue.value=r.capabilities?.native_queue===true;canSteer.value=r.capabilities?.steer===true;sendModelSelect.value=r.capabilities?.model_select===true;
      canAnswerQuestion.value=r.capabilities?.question_answer===true;

      stopOperation.value=provider.value==='qoder'?'stop_task':'interrupt';
      canInterrupt.value = stopOperation.value==='stop_task'?r.capabilities?.stop_task===true:r.capabilities?.interrupt===true;
      notice.value = r.notice || "";
      for(const receipt of r.guides||[]){
        const row=currentOutgoing.value.find(row=>row.id===receipt.id&&['guiding','unknown'].includes(row.state));
        if(!row)continue;
        if(receipt.state==='consumed'||receipt.state==='acknowledged')reviseOutgoing(row.id,{state:'accepted',error:undefined});
        else if(receipt.state==='rejected')reviseOutgoing(row.id,{state:'failed',error:'Qoder 未接受这条引导'});
        else if(receipt.state==='unconfirmed')reviseOutgoing(row.id,{state:'unknown',error:'引导结果尚未确认，不会自动重发'});
      }
      reconcileOutgoing();saveReading();void drainOutgoing();
      if(changed)historyDirty=true;
      if(needsMediaUpgrade&&r.presentation_version===2){
        // Rehydrate the previously loaded span once after upgrading from text-only
        // projections. Preserve the existing content and reading position throughout.
        const oldest=turns.value[0]?.id||live.value[0]?.id;
        await catchUpHistory(new Set(oldest?[oldest]:[]),epoch,signal,true);
      }else if(historyDirty&&(!includesHistory||known.size))await catchUpHistory(known,epoch,signal);
    } else {canControl.value=false;projectionDirty=true;}
  } catch (e) {
    if (epoch !== generation || seq !== liveSequence || signal.aborted) return;
    canControl.value = false;
    connectionStale.value=true;projectionDirty=true;controlFailures++;
    // An event was consumed, but its projection failed. Recover without waiting
    // for another native change (a final answer may be the last event).
    if(eventsActive)timer=setTimeout(()=>void updateLive(),Math.min(15000,1000*2**Math.min(controlFailures-1,4)));
  } finally {
    if (epoch === generation && seq === liveSequence) {
      if(!eventsActive)timer=setTimeout(()=>void listenForChanges(),5000);
      else if(historyDirty&&!connectionStale.value)timer=setTimeout(()=>void updateLive(),3000);
    }
  }
}
async function mutate(
  operation: string,
  extra: Record<string, unknown>,
  message?: string,
  commandId?: string,
) {
  if (
    !task.value ||
    busy.value || activeMutation.value ||
    !runnable.value ||
    !(['interrupt','stop_task'].includes(operation)?canInterrupt.value:operation.startsWith('queue_')?queueSync.value:canControl.value) ||
    uncertain.value ||
    pendingError.value
  )
    return;
  const epoch = generation,
    accountSignal = accountController.signal,
    account = session.user!.username,
    cid = selected.value,
    tid = task.value.id,
    id = commandId || crypto.randomUUID();
  const entry = { id, computer: cid, provider:provider.value, thread: tid, message, operation };
  try {
    savePending(account, entry);
  } catch {
    error.value = "无法保存原指令编号，未发送，请检查本机存储。";
    return;
  }
  activeMutation.value=id;
  if(commandId)reviseOutgoing(id,{state:"sending"});
  busy.value = true;
  error.value = "";
  liveSequence++;
  clearTimeout(timer);
  let acknowledged=false;
  try {
    const r = await runCommand(
      cid,
      { operation, provider:provider.value, thread_id: tid, ...extra },
      accountSignal,
      id,
    );
    if (accountSignal.aborted) return;
    acknowledged=true;
    const durable=!commandId||reviseOutgoing(id,{state:r.state==='guide_pending'?"guiding":"accepted",delivery:r.state==='queued'?'queued':'submitted'});
    if(durable)clearPending(account, id);
    uncertain.value = null;
    if (message !== undefined) drafts.delete(entry.provider + ":" + cid + ":" + tid);
    if (epoch !== generation) return;
    notice.value = r.notice || "";
    if(r.queued){const index=desktopQueue.value.findIndex(q=>q.id===r.queued.id);if(index<0)desktopQueue.value.push(r.queued);else desktopQueue.value[index]=r.queued;}
    if(r.queued&&commandId)reconcileOutgoing();
    if(operation==='queue_steer'&&r.state==='guide_pending')desktopQueue.value=desktopQueue.value.map(q=>q.id===extra.queue_id?{...q,state:'guiding',editable:false,steerable:false,removable:false}:q);
    else if(['queue_delete','queue_steer'].includes(operation))desktopQueue.value=desktopQueue.value.filter(q=>q.id!==extra.queue_id);
    if((operation==='send'||operation==='queue_add') && extra.model && selectedModel.value===extra.model && (!extra.effort||selectedEffort.value===extra.effort)){selectedModel.value='';selectedEffort.value='';}
    if (message !== undefined && !commandId && draft.value===message) draft.value = "";
  } catch (e) {
    if(accountSignal.aborted)return;
    if(acknowledged){pendingError.value=true;error.value='电脑已接收操作，本机记录未能更新；请勿重复发送';return;}
    if(e instanceof UnconfirmedCommand){uncertain.value=entry;if(commandId)reviseOutgoing(id,{state:'unknown',error:'发送结果待确认'});}
    else {clearPending(account,id);if(commandId)reviseOutgoing(id,{state:'failed',error:e instanceof Error?e.message:'发送失败'});}
    if(epoch===generation&&!commandId)error.value=e instanceof Error?e.message:'提交未确认';
  } finally {
    if(activeMutation.value===id)activeMutation.value=null;
    if (epoch === generation)busy.value=false;
    if(!accountSignal.aborted&&task.value)void updateLive();
  }
}

async function checkUncertain() {
  if (!uncertain.value || busy.value) return;
  const entry = uncertain.value,
    signal = accountController.signal,
    account = session.user!.username;
  busy.value = true;
  try {
    const result=await waitCommand(entry.id, signal);
    clearPending(account, entry.id);
    if (signal.aborted) return;
    uncertain.value = null;
    if(outgoing.value.some(r=>r.id===entry.id))reviseOutgoing(entry.id,{state:"accepted",error:undefined});
    notice.value = "已确认操作成功";
    if(entry.operation==='create'&&result.thread_id&&entry.computer===selected.value&&entry.provider===provider.value){showCreate.value=false;await openTask({id:result.thread_id,title:result.title||'新会话',cwd:''});}
    applyTaskOrganisation(account,entry);
    if(entry.operation&&['pin','unpin'].includes(entry.operation))await listTasks();
    if (
      (entry.provider || "codex") === provider.value &&
      entry.computer === selected.value &&
      entry.thread === task.value?.id &&
      entry.message === draft.value
    )
      draft.value = "";
  } catch (e) {
    if (!signal.aborted) {
      if(e instanceof UnconfirmedCommand&&entry.provider==='codex'&&['send','steer','queue_add'].includes(entry.operation||'')&&entry.thread&&!entry.thread.startsWith('new:')){
        try{
          const found=await findNativeMessageReceipt(entry.id,async cursor=>{
            const page=await runCommand(entry.computer,{operation:'history',provider:'codex',thread_id:entry.thread,...(cursor?{cursor}:{})},signal);
            return {turns:page.turns,cursor:page.cursor};
          });
          if(found){
            clearPending(account,entry.id);uncertain.value=null;
            if(outgoing.value.some(row=>row.id===entry.id))reviseOutgoing(entry.id,{state:'accepted',error:undefined});
            notice.value='消息已在电脑会话中确认';
            if(entry.computer===selected.value&&entry.thread===task.value?.id)void updateLive();
            return;
          }
        }catch{/* Keep the original uncertain state when history cannot be read. */}
      }
      error.value = e instanceof Error ? e.message : "结果仍未确认";
      if(e instanceof UnconfirmedCommand&&entry.operation==='create'&&typeof e.result?.thread_id==='string'){entry.thread=e.result.thread_id;uncertain.value={...entry};savePending(account,entry);}
      if (!(e instanceof UnconfirmedCommand)) {
        clearPending(account, entry.id);
        uncertain.value = null;
        if(outgoing.value.some(r=>r.id===entry.id))reviseOutgoing(entry.id,{state:"failed",error:e instanceof Error?e.message:"发送失败"});
      }
    }
  } finally {
    if (!signal.aborted) busy.value = false;
  }
}
const manuallyChecked = ref(false);
watch(() => uncertain.value?.id, () => { manuallyChecked.value = false; });
function resolveManually() {
  const entry = uncertain.value;
  const account = session.user?.username;
  if (!entry || !account || busy.value || !manuallyChecked.value) return;
  try {
    clearPending(account, entry.id);
    uncertain.value = null;
    outgoing.value=outgoing.value.filter(r=>r.id!==entry.id);persistOutgoing();
    draft.value = '';
    drafts.delete((entry.provider || 'codex') + ':' + entry.computer + ':' + entry.thread);
    notice.value = '已按你的核对解除限制，没有重发原指令。';
  } catch { error.value = '原操作记录未能更新，请稍后重试。'; }
}
async function pair() {
  if (pairing.value) return;
  const signal = accountController.signal;
  pairing.value = true;
  try {
    const c = await collaboration.pair(code.value, signal);
    if (signal.aborted) return;
    code.value = "";
    showPair.value = false;
    await refreshDevices();
    if (signal.aborted) return;
    selectComputer(c.id);
    notice.value = "已绑定，等待 Mac 允许连接；上线后自动读取任务。";
  } catch (e) {
    if (!signal.aborted)
      deviceError.value = e instanceof Error ? e.message : "配对失败";
  } finally {
    if (!signal.aborted) pairing.value = false;
  }
}
async function revoke(c: Computer) {
  if (!confirm("解绑 " + c.name + "？后续指令将停止，已经开始的任务可能继续。"))
    return;
  const signal = accountController.signal;
  try {
    await collaboration.revoke(c.id, signal);
    if (!signal.aborted) await refreshDevices();
  } catch (e) {
    if (!signal.aborted)
      deviceError.value = e instanceof Error ? e.message : "解绑未确认";
  }
}
function back(updateRoute=true) {
  saveReading();
  drafts.set(draftKey(), draft.value);
  resetContext();
  task.value = null;
  turns.value = [];
  draft.value = "";
  if(updateRoute&&route.query.thread){const q={...route.query};delete q.thread;void router.replace({query:q});}
  void nextTick(() => { if(taskList.value)taskList.value.scrollTop=listScroll.value; });
}
watch(()=>route.query.thread,(id,old)=>{if(!id&&old&&task.value)back(false);});
watch(draft,()=>void nextTick(reading.resize));
function resumeConnection(){if(!document.hidden&&session.user?.username){projectionDirty=!!task.value;void refreshDevices();}}
onMounted(()=>{window.addEventListener('online',resumeConnection);document.addEventListener('visibilitychange',resumeConnection);});
let deviceTimer: ReturnType<typeof setInterval> | undefined;
const clockTimer=setInterval(()=>{clockNow.value=Date.now();},1000);
watch(
  () => session.user?.username,
  (account) => {
    resetContext();
    accountController.abort();
    accountController = new AbortController();
    deviceRead++;
    clearInterval(deviceTimer);
    drafts.clear();
    serviceRetired.value=false;computers.value = [];devicesLoading.value=!!account;deviceVerified.value=false;outgoing.value=[];activeMutation.value=null;
    selected.value = "";
    tasks.value = [];
    task.value = null;
    turns.value = [];
    draft.value = "";
    uncertain.value = null;
    pendingError.value = false;
    showPair.value = false;
    showDevices.value = false;showCreate.value=false;
    pairing.value = false;
    if (account) {
      const saved=remembered();provider.value=saved.provider==='qoder'?'qoder':'codex';
      query.value=typeof saved.query==='string'?saved.query:'';archived.value=saved.archived===true;
      listScroll.value=Number(saved.scroll)||0;collapsed.value=Array.isArray(saved.collapsed)?saved.collapsed:[];
      try {
        uncertain.value = loadPending(account);outgoing.value=readOutbox(account);
      } catch {
        pendingError.value = true;
        error.value = "原操作记录读取失败，请先在 Mac 核对，发送已暂停。";
      }
      const signal=accountController.signal;
      void (async()=>{
        const cached=await readCache<Computer[]>(cacheKey(account,'','','computers'));
        if(signal.aborted)return;
        if(cached){computers.value=cached.value.map(c=>({...c,online:false}));const choice=cached.value.find(c=>c.id===saved.computer)||cached.value[0];if(choice)await selectComputer(choice.id);}
        if(!signal.aborted)await refreshDevices();
      })();
      // Active task watches already report connection/output changes. Only the idle
      // computer directory needs compatibility reconciliation (no presence event API).
      deviceTimer = setInterval(() => {if(!document.hidden&&!eventsActive&&!eventConnecting)void refreshDevices();},30000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  window.removeEventListener('online',resumeConnection);document.removeEventListener('visibilitychange',resumeConnection);clearInterval(clockTimer);saveReading();cancelPress();
  remember();
  resetContext();
  accountController.abort();
  clearInterval(deviceTimer);
});
</script>
<template>
  <section
    class="collab"
    @keydown.esc="
      showPair = false;
      showDevices = false;
    "
  >
    <header class="collab-head">
      <button class="nav-back" aria-label="返回" @click="task ? back() : exitCollaboration()">‹</button>
      <button v-if="!task && computers.length && !serviceRetired" class="computer-choice" @click="showDevices=true">{{ computer?.name || '电脑' }} <span>⌄</span></button>
      <span v-else-if="!task" class="header-label">电脑协作</span>
      <ChoiceSelect v-if="selected && !task && !serviceRetired" class="provider-choice" :model-value="provider" label="任务来源" :options="[{value:'codex',label:'Codex'},{value:'qoder',label:'Qoder CN'}]" @update:model-value="changeProvider" />
      <button v-if="!task && !serviceRetired" class="connect-link" @click="showPair=true">连接</button>
      <div v-if="task" class="active-task-title"><strong :title="task.title">{{ task.title }}</strong><small class="task-state">{{ providerName }}</small></div>

    </header>
    <p v-if="deviceError" class="collab-alert" role="alert">
      {{ deviceError }}
      <button v-if="!serviceRetired" class="btn small" @click="refreshDevices">刷新设备</button>
    </p>
    <div v-if="uncertain" class="collab-alert" role="status">
      有一条原操作结果未确认，不会自动重复发送。<button
        class="btn small"
        :disabled="busy"
        @click="checkUncertain"
      >
        核对原操作
      </button>
      <button v-if="uncertain.operation==='create' && !uncertain.thread.startsWith('new:') && uncertain.computer===selected && uncertain.provider===provider" class="btn small" :disabled="busy" @click="openTask({id:uncertain.thread,title:'新会话',cwd:''})">查看已建会话</button>
      <details><summary>在 Mac 核对后恢复</summary>
        <p>原任务：{{ uncertain.thread }} · 操作：{{ uncertain.id }}</p>
        <p>请在对应 Mac 查看原任务是否已经执行。解除限制不会取消、重试或证明原操作失败。</p>
        <label><input v-model="manuallyChecked" type="checkbox" />我已在 Mac 核对原任务，确认可以继续</label>
        <button class="btn small" :disabled="busy || !manuallyChecked" @click="resolveManually">解除限制，不重发</button>
      </details>
    </div>
    <div v-if="!selected&&!serviceRetired" class="collab-empty" role="status"><template v-if="devicesLoading"><span class="activity-spinner" aria-hidden="true"></span><span class="sr-only">正在连接电脑</span></template><p v-else>{{ deviceError ? '暂时无法读取电脑' : '连接电脑，继续你的工作' }}</p></div>
    <div v-else-if="selected" class="collab-workspace" :class="{ 'has-task': task }">
      <aside class="task-list" ref="taskList" @scroll.passive="scrollTasks">
        <div class="list-tools">
          <input v-model="query" type="search" placeholder="搜索任务或项目" aria-label="搜索任务或项目" @input="remember" />
          <button class="icon-action" aria-label="新建会话" :disabled="!runnable" @click="beginCreate">＋</button>
          <button class="icon-action" aria-label="刷新任务" :disabled="loading || !runnable" @click="listTasks()">↻</button>
        </div>
        <div class="list-meta"><span>{{ !deviceVerified ? '连接中' : computer?.online ? '在线' : '离线' }} · {{ tasks.length }} 个任务{{ taskCursor ? ' · 还有更多' : '' }}</span>
          <label><input type="checkbox" v-model="archived" @change="changeArchive" />已归档</label>
        </div>
        <section v-for="group in groups" :key="group.id" class="project-group">
          <button class="group-title" @click="toggleGroup(group.id)"><span>{{ collapsed.includes(group.id)?'›':'⌄' }}</span>{{ group.name }}<small>{{ group.tasks.length }}</small></button>
          <div v-if="!collapsed.includes(group.id)">
            <div v-for="t in group.tasks" :key="t.id" class="task-entry" @click.capture="consumePress" @pointerdown="startPress($event,()=>{menuNotice='';menuTask=t})" @pointermove="movePress" @pointerup="cancelPress" @pointercancel="cancelPress" @contextmenu.prevent="menuNotice='';menuTask=t">
              <button class="task-row" :class="{selected:task?.id===t.id}" @click="openTask(t)"><strong>{{ t.title }}</strong></button>
              <button class="task-more" :aria-label="t.title+'：更多'" @click="menuNotice='';menuTask=t">···</button>
            </div>
          </div>
        </section>
        <p v-if="deviceVerified && !computer?.online" class="empty-note">电脑离线，连接后自动刷新。</p>
        <p v-else-if="!tasks.length" class="empty-note">{{ loading?'正在读取任务…':'暂无任务' }}</p>
        <p v-else-if="!groups.length" class="empty-note">没有匹配的任务</p>
        <button v-if="taskCursor" class="load-more" :disabled="loading" @click="listTasks(true)">{{ loading?'正在加载…':'加载更多任务' }}</button>
      </aside>
      <section v-if="task" class="conversation" :data-execution-state="status">
        <details v-if="notice" class="collab-notice"><summary>连接详情</summary>{{ notice }}</details>
        <div ref="stream" class="conversation-body" @scroll.passive="reading.scroll">
          <button
            v-if="cursor"
            class="history-more"
            :disabled="loading"
            @click="history(true)"
          >
            <span v-if="loading" class="activity-spinner" aria-hidden="true"></span>{{ loading ? "加载中" : "查看更早记录" }}
          </button>
          <div v-if="loading && !messages.length && !currentOutgoing.length" class="conversation-skeleton" role="status" aria-label="正在加载消息"><span></span><span></span><span></span></div>
          <div v-for="m in messages" :key="m.id" :data-reading-id="m.id" @click.capture="consumePress" @pointerdown="startPress($event,()=>{menuNotice='';menuMessage=m})" @pointermove="movePress" @pointerup="cancelPress" @pointercancel="cancelPress" @contextmenu.prevent="menuNotice='';menuMessage=m"><CollaborationMessage :message="m" :provider-name="providerName" :media-context="{account:session.user?.username||'',computer:selected,provider,thread:task.id}" /></div>
          <p v-if="!messages.length && !loading && !currentOutgoing.length" class="empty-note">
            暂无消息
          </p>
          <article v-for="row in currentOutgoing.filter(r=>r.state!=='queued')" :key="row.id" class="outgoing-message" :data-reading-id="row.id">
            <p>{{ row.text }}</p>
            <div class="delivery-state" role="status"><span v-if="row.state==='sending'||row.state==='guiding'" class="activity-spinner" aria-hidden="true"></span>
              <span v-if="row.state==='queued'">队列中</span>
              <span v-else-if="row.state==='guiding'" title="引导已提交到连接器，等待 Qoder 接收确认">等待接收</span>
              <span v-else-if="row.state==='unknown'||row.state==='failed'">{{row.state==='unknown'?'发送结果待确认':'发送失败'}}</span>
              <span v-else-if="row.state==='accepted'" :aria-label="row.delivery==='queued'?'电脑已接收，等待处理':'电脑已接收'" :title="row.delivery==='queued'?'电脑已接收，等待处理':'电脑已接收'">{{row.delivery==='queued'?'✓ 等待处理':'✓'}}</span>
              <span v-else class="sr-only">发送中</span>
              <time>{{ new Date(row.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) }}</time>
            </div>
            <small v-if="row.error">{{ row.error }}</small>
            <div v-if="['queued','failed'].includes(row.state)" class="outgoing-actions"><button type="button" :disabled="!!draft.trim()" @click="editOutgoing(row)">编辑</button><button type="button" @click="cancelOutgoing(row)">取消</button></div>
          </article>
          <div v-if="activityMode" class="response-activity-slot">
            <Transition name="response-activity">
              <div v-if="activityMode" :key="activityMode" class="response-activity" :class="activityMode" role="status" :aria-label="activityLabel">
                <span v-if="activityMode==='working'" class="activity-orbit" aria-hidden="true"><i></i><i></i><i></i></span>
                <span v-else-if="activityMode==='reconnecting'" class="activity-spinner" aria-hidden="true"></span>
                <span v-if="activityMode==='working'" class="activity-caption" aria-hidden="true">{{providerName}}<time v-if="workingTime">{{workingTime}}</time></span>
                <span v-else>{{activityMode==='failed'?'本轮未完成，请查看执行详情':'重新连接中'}}</span>
              </div>
            </Transition>
          </div>
          <section v-for="r in requests" :key="r.id" class="approval" :class="{'approval-question':r.kind==='questions'}">
            <h3>{{ r.title }}</h3>
            <pre v-if="r.detail">{{ r.detail }}</pre>
            <AgentQuestions v-if="r.kind === 'questions' && (provider === 'codex' || canAnswerQuestion)" :key="r.turn_id+':'+r.id" :questions="r.questions||[]" :allow-skip="provider==='qoder'" :disabled="busy || !canControl || !runnable || !!uncertain || !!pendingError"
              @answer="value=>mutate('respond',{request_id:r.id,turn_id:r.turn_id,decision:'answer',answers:value})"
              @skip="mutate('respond',{request_id:r.id,turn_id:r.turn_id,decision:'skip'})" />
            <div v-else-if="r.kind === 'questions'" class="question-readonly">
              <AgentQuestions :questions="r.questions||[]" :disabled="true" readonly />
              <p class="question-source-note">连接器尚未启用答题，请先更新并允许 Mac 辅助功能访问。普通发言不能解除等待。</p>
            </div>
            <template v-else-if="r.kind === 'approval'"
              ><button
                class="btn"
                :disabled="busy || !canControl || !runnable || !!uncertain || pendingError"
                @click="
                  mutate('respond', {
                    request_id: r.id,
                    turn_id: r.turn_id,
                    decision: 'decline',
                  })
                "
              >
                拒绝</button
              ><button
                class="btn primary"
                :disabled="busy || !canControl || !runnable || !!uncertain || pendingError"
                @click="
                  mutate('respond', {
                    request_id: r.id,
                    turn_id: r.turn_id,
                    decision: 'accept',
                  })
                "
              >
                允许此请求
              </button></template
            >
          </section>
        </div>
        <form
          class="agent-composer"
          @submit.prevent="queueMessage"
        >
          <div v-if="desktopQueue.length || currentOutgoing.some(r=>r.state==='queued')" class="queued-followups" aria-label="待发队列">
            <div v-for="row in desktopQueue" :key="'native:'+row.id" class="queued-followup native-queued">
              <span class="queue-mark" aria-label="待发消息">≡</span><p :title="row.text">{{row.text}}<small v-if="row.attachments"> · {{row.attachments}} 个附件</small></p>
              <span v-if="row.state==='guiding'" class="delivery-state" role="status"><span class="activity-spinner" aria-hidden="true"></span>等待接收</span>
              <span v-else-if="row.state==='unknown'" class="delivery-state">结果待确认</span>
              <span v-else-if="row.state==='rejected'" class="delivery-state">未被接收</span>
              <button v-if="running && canSteer && row.steerable!==false" type="button" class="queue-steer" :disabled="busy || !queueSync || !runnable || !!uncertain || pendingError || requests.length>0" @click="mutate('queue_steer',{queue_id:row.id})">调整方向</button>
              <button v-if="row.editable" type="button" :disabled="busy || !queueSync || !runnable || !!uncertain" @click="editNativeQueue(row)" aria-label="编辑待发消息">编辑</button>
              <button v-if="row.removable!==false" type="button" :disabled="busy || !queueSync || !runnable || !!uncertain" @click="mutate('queue_delete',{queue_id:row.id})" aria-label="取消待发消息">×</button>
            </div>
            <button v-if="queueCursor" type="button" class="load-more" :disabled="queueLoading" @click="moreQueue">更多待发消息</button>
            <div v-for="row in currentOutgoing.filter(r=>r.state==='queued')" :key="row.id" class="queued-followup">
              <span class="queue-mark" aria-label="队列中">≡</span><p :title="row.text">{{row.text}}</p>
              <button v-if="running && canSteer" type="button" class="queue-steer" :disabled="busy || !!activeMutation || !runnable || !!uncertain || pendingError || requests.length>0" @click="steerOutgoing(row)">调整方向</button>
              <button type="button" :disabled="!!draft.trim()" @click="editOutgoing(row)" aria-label="编辑待发消息">编辑</button>
              <button type="button" @click="cancelOutgoing(row)" aria-label="取消待发消息">×</button>
            </div>
          </div>
          <div v-if="modelSettingsAvailable" class="composer-model">
            <button v-if="!nativeOptions.models.length" type="button" class="model-fetch" :disabled="optionsLoading" @click="loadOptions">{{optionsLoading?"读取模型…":selectedModel?"模型 · 已选择":"模型 · 沿用电脑设置"}}</button>
            <template v-else><ChoiceSelect v-model="selectedModel" label="模型" :options="modelChoices" :disabled="busy" />
              <ChoiceSelect v-if="selectedModel && effortChoices.length>1 && nativeOptions.capabilities.effort_select" v-model="selectedEffort" label="思考强度" :options="effortChoices" :disabled="busy" />
            </template>
            <span v-if="optionsError" class="settings-note">{{optionsError}}</span>
            <span v-if="running && selectedModel" class="settings-note">补充沿用本轮模型，所选设置用于下一轮</span>
          </div>
          <small v-if="actualModel" class="settings-note">电脑：{{nativeOptions.models.find(m=>m.id===actualModel)?.label||actualModel}}<template v-if="actualEffort"> · {{choicesForEffort(actualModel).find(e=>e.value===actualEffort)?.label||actualEffort}}</template></small>
          <label for="agent-input" class="sr-only">发送消息</label
          ><MessageInput
            @element="input = $event"
            id="agent-input"
            @focus="reading.focus"
            v-model="draft"
            maxlength="3000"
            rows="1"
            placeholder="发消息…"
          />
          <div class="composer-actions">
            <button v-if="canInterrupt && (running || stopOperation==='stop_task')" type="button" class="composer-stop" :aria-label="stopOperation==='stop_task'?'停止任务':'停止'" :disabled="busy || !runnable || !!uncertain || pendingError" @click="mutate(stopOperation, stopOperation==='interrupt'?{ turn_id: turnId }:{})"><span aria-hidden="true">■</span></button>
            <button
              class="composer-send"
              :aria-label="busy || running || !runnable || !!uncertain || (provider==='qoder' && requests.length>0) ? '加入队列' : '发送'"
              :disabled="
                pendingError || !draft.trim()
              "
            >
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
            </button>
          </div>
        </form>
      </section>
      <div v-else class="conversation-placeholder">
        选择一个已有任务，继续电脑上的工作。
      </div>
    </div>
    <p v-if="error" class="collab-alert" role="alert">{{ error }}</p>
    <ModalSheet v-if="editingQueue" title="编辑待发消息" @close="editingQueue=null">
      <form class="new-conversation" @submit.prevent="saveQueueEdit"><MessageInput v-model="queueEditText" aria-label="待发消息内容" maxlength="3000" /><button class="btn primary" :disabled="busy || !queueEditText.trim() || !runnable || !!uncertain">保存</button></form>
    </ModalSheet>
    <ModalSheet v-if="showCreate" title="新建会话" @close="showCreate=false">
      <form class="new-conversation" @submit.prevent="createConversation">
        <ChoiceSelect v-model="newProject" label="项目" :options="projectChoices" :disabled="busy || optionsLoading" />
        <ChoiceSelect v-if="nativeOptions.models.length" v-model="newModel" label="模型" :options="modelChoices" :disabled="busy || optionsLoading" />
        <ChoiceSelect v-if="newModel && newEffortChoices.length>1 && nativeOptions.capabilities.effort_select" v-model="newEffort" label="思考强度" :options="newEffortChoices" :disabled="busy || optionsLoading" />
        <MessageInput v-model="newMessage" aria-label="新会话消息" placeholder="想做些什么？" maxlength="3000" />
        <p v-if="optionsLoading" class="subtle" role="status"><span class="activity-spinner" aria-hidden="true"></span>正在读取电脑设置</p>
        <p v-else-if="optionsError" role="alert">{{ optionsError }}<button type="button" class="btn small" @click="loadOptions">重试</button></p>
        <p v-else-if="!nativeOptions.capabilities.create" class="subtle">当前连接器暂未提供新建能力，请在电脑新建后刷新。</p>
        <button class="btn primary" :disabled="busy || !!activeMutation || !!uncertain || pendingError || !runnable || !newMessage.trim() || !nativeOptions.capabilities.create">{{busy?'正在创建':'开始'}}</button>
      </form>
    </ModalSheet>
    <ModalSheet v-if="menuTask||menuMessage" :title="menuTask?'任务操作':'消息操作'" @close="menuTask=null;menuMessage=null">
      <div class="collab-actions">
        <button v-if="menuTask&&supportsAction(menuTask.pinned?'unpin':'pin')&&!archived" :disabled="busy||!!uncertain||!runnable||pendingError" @click="setPinned">{{menuTask.pinned?'取消置顶':'置顶'}}</button>
        <button @click="copyText(menuTask?.title||menuMessage?.text||'')">{{menuTask?'复制标题':'复制正文'}}</button>
        <p v-if="menuNotice" role="status">{{menuNotice}}</p>
      </div>
    </ModalSheet>
    <ModalSheet
      v-if="showPair || showDevices"
      :title="showPair ? '连接电脑' : '我的电脑'"
      @close="
        showPair = false;
        showDevices = false;
      "
    >
      <div class="collab-modal-content">
        <form v-if="showPair" @submit.prevent="pair">
          <p>
            在 Mac 打开员工客户端连接器，显示二维码。扫码后绑定到当前账号：{{
              session.displayName
            }}。
          </p>
          <PairScanner :disabled="pairing" @scanned="(value) => { code = value; pair(); }" />
          <p v-if="pairing" role="status">正在绑定当前账号…</p>
          <p class="subtle">配对后还需在 Mac 确认账号并允许连接。</p>
        </form>
        <div v-else>
          <div v-for="c in computers" :key="c.id" class="device-manage">
            <button class="device" @click="selectComputer(c.id)">
              <strong>{{ c.name }}</strong
              ><span>{{ c.online ? "在线" : "离线" }}</span></button
            ><button class="btn small" @click="revoke(c)">解绑</button>
          </div>
          <p v-if="!computers.length">尚未绑定电脑。</p>
          <button
            class="btn"
            @click="
              showDevices = false;
              showPair = true;
            "
          >
            连接另一台电脑
          </button>
        </div>
      </div>
    </ModalSheet>
  </section>
</template>
<style scoped>
.collab{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--paper);color:var(--ink);touch-action:pan-y;-webkit-touch-callout:none;user-select:none}
.collab-head{display:flex;align-items:center;height:54px;flex:none;padding:6px 12px;gap:8px;border-bottom:1px solid var(--line);background:var(--paper)}
.collab-head button{font:inherit;border:0;background:transparent;color:var(--ink);min-height:40px;margin:0}
.nav-back{font-size:30px!important;width:36px;flex:none;padding:0}
.computer-choice{font-weight:600!important;max-width:42%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 6px}.computer-choice span{color:var(--muted)}
.header-label{flex:1}.connect-link{margin-left:auto!important;font-size:14px!important;color:var(--accent)!important;padding:0 4px}
.provider-choice{min-width:0;max-width:145px}.provider-choice :deep(.choice-select-trigger){min-height:36px;font-size:13px;padding:6px 8px;border:0;background:var(--paper-soft)}
.active-task-title{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.active-task-title strong{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task-state{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);white-space:nowrap}.stop-task{flex:none;font-size:13px!important;color:var(--red)!important}
.collab-workspace{flex:1;min-height:0;overflow:hidden;display:grid;grid-template-columns:260px minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
.task-list{padding:12px 16px 24px;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y}
.list-tools{display:flex;gap:8px;align-items:center}.list-tools input{flex:1;min-width:0;min-height:40px;border:0;border-radius:8px;background:var(--paper-soft);padding:9px 12px;font:inherit;font-size:16px}
.icon-action{flex:none;border:0;background:transparent;width:36px;height:40px;font-size:24px;color:var(--muted)}
.list-meta{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:12px;margin:14px 0}.list-meta label{display:flex;gap:6px;align-items:center}.list-meta input{width:16px;height:16px;margin:0}
.group-title{display:flex;align-items:center;gap:8px;text-align:left;width:100%;background:transparent;border:0;padding:12px 0 6px;font:inherit;font-size:13px;font-weight:600;color:var(--muted)}.group-title small{margin-left:auto;font-weight:400}
.task-entry{display:flex;align-items:center;gap:4px}.task-row{flex:1;min-width:0;display:flex;align-items:center;text-align:left;margin:0;padding:13px 8px;min-height:50px;border-radius:8px;border:0;background:transparent;color:var(--ink)}.task-row strong{font-size:15px;font-weight:500;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.task-row:active,.task-row.selected{background:var(--paper-soft)}.task-more{border:0;background:transparent;font:inherit;font-size:20px;min-height:44px;width:32px;color:var(--muted)}
.load-more,.history-more{display:flex;align-items:center;justify-content:center;gap:8px;min-height:40px;margin:8px auto 28px;border:0;background:transparent;color:var(--muted);font:inherit;font-size:13px;padding:8px 14px;border-radius:8px}.history-more:active{background:var(--paper-soft)}
.conversation{min-width:0;min-height:0;overflow:hidden;display:flex;flex-direction:column}.conversation-body{padding:20px 16px 8px;min-height:0;overflow:auto;flex:1;overscroll-behavior:contain;touch-action:pan-y}
.agent-composer{flex:none;display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;padding:8px 12px calc(8px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--paper)}
.agent-composer>.message-input{flex:1}.agent-composer>.composer-model{flex-basis:100%;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}.settings-note{font-size:12px;color:var(--muted)}.model-fetch{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;min-height:30px;padding:4px 8px}.composer-model :deep(.choice-select-menu){top:auto;bottom:calc(100% + 5px)}.composer-model :deep(.choice-select-trigger){width:auto;min-height:30px;padding:4px 8px;font-size:12px;border:0}.agent-composer>.btn,.agent-composer>div>.btn{min-height:44px;padding:8px 12px;margin:0}
.outgoing-message{margin:0 0 20px auto;max-width:94%;border-radius:12px;background:var(--paper-soft);padding:12px 16px;overflow-wrap:anywhere}.outgoing-message p{margin:0;white-space:pre-wrap;line-height:1.65}.delivery-state{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--muted);margin-top:8px}.delivery-state time{margin-left:auto}.outgoing-message small{display:block;color:var(--red);font-size:12px;margin-top:6px}.outgoing-actions{display:flex;gap:16px;margin-top:4px}.outgoing-actions button{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;min-height:32px}
.collab-alert{flex:none;background:var(--paper-soft);color:var(--ink);font-size:13px;padding:10px 16px;line-height:1.6;margin:0;max-height:30vh;overflow:auto;border-bottom:1px solid var(--line)}.collab-alert details p{margin:8px 0}.collab-alert .btn{margin-left:8px}.collab-notice{font-size:12px;color:var(--muted);padding:6px 16px;flex:none;max-height:100px;overflow:auto}.collab-notice summary{min-height:28px;cursor:pointer}
.collab-empty,.conversation-placeholder{padding:48px 16px;text-align:center;color:var(--muted);font-size:14px;line-height:1.7}.empty-note,.subtle{color:var(--muted);font-size:13px;line-height:1.7}.collab-empty{margin:auto}
.activity-spinner{display:inline-block;width:11px;height:11px;flex:none;border:1.5px solid var(--line);border-top-color:var(--muted);border-radius:50%;animation:activity-spin .8s linear infinite}@keyframes activity-spin{to{transform:rotate(360deg)}}
.conversation-skeleton{display:grid;gap:20px;padding:12px 0}.conversation-skeleton span{display:block;height:50px;border-radius:8px;background:var(--paper-soft);width:75%}.conversation-skeleton span:nth-child(2){margin-left:auto;width:55%}
.approval{padding:16px;border:1px solid var(--line);border-radius:12px;margin:20px 0;background:var(--paper)}.approval h3{font-size:15px;line-height:1.5;margin:0 0 16px}.approval pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:260px;overflow:auto;margin:12px 0}.approval label{display:block;margin:14px 0;line-height:1.6}.approval small{display:block;color:var(--muted)}.question-readonly{display:grid;gap:16px}.question-source-note{border-top:1px solid var(--line);padding-top:14px;margin:0;color:var(--muted);font-size:13px;line-height:1.6}
.approval textarea,.collab-modal-content input{display:block;width:100%;box-sizing:border-box;font:inherit;border:1px solid var(--control-line);border-radius:8px;padding:12px;margin:8px 0;resize:none;background:var(--paper);color:var(--ink)}
.collab input:focus,.collab textarea:focus{outline:none;box-shadow:none;border-color:#aeb8c3}.collab input,.collab textarea{user-select:text;-webkit-user-select:text}
.collab-modal-content p{line-height:1.7;margin:16px 0}.device-list{display:grid;gap:10px;margin:20px 0}.device{display:flex;flex:1;justify-content:space-between;gap:10px;align-items:center;border:1px solid var(--line);border-radius:8px;background:var(--paper);padding:16px;color:var(--ink);font:inherit;min-width:0}.device strong{overflow-wrap:anywhere}.device span{font-size:12px;white-space:nowrap;color:var(--muted)}.device-manage{display:flex;gap:10px;margin:14px 0}
.collab-actions{display:grid;gap:8px}.collab-actions>button{min-height:44px;border:0;border-radius:8px;background:var(--paper-soft);color:var(--ink);font:inherit;text-align:left;padding:10px 14px}.collab-actions .destructive{color:var(--red)}.collab-actions p{font-size:13px;line-height:1.6;margin:4px 0}
.new-conversation{display:grid;gap:16px;padding:8px 0}.new-conversation .message-input{width:100%;min-height:88px}.new-conversation>.btn{justify-self:end}.new-conversation p{font-size:13px;line-height:1.6}
@media(max-width:700px){.collab-workspace{display:flex;flex-direction:column}.task-list{width:100%}.has-task .task-list{display:none}.conversation{flex:1}.conversation-placeholder{display:none}}
/* Animate only the small activity layer; never fade or translate history on refresh. */
.queued-followups{flex-basis:100%;min-width:0;max-height:144px;overflow:auto;border:1px solid var(--line);border-radius:12px;padding:4px 8px;background:var(--paper-soft)}
.queued-followup{display:flex;gap:8px;align-items:center;min-height:40px}.queued-followup+.queued-followup{border-top:1px solid var(--line)}.queued-followup p{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin:0;font-size:13px}.queue-mark{color:var(--muted);font-size:16px}.queued-followup button{flex:none;font:inherit;font-size:12px;border:0;background:transparent;color:var(--muted);padding:6px 2px;min-height:36px}.queued-followup .queue-steer{color:var(--ink)}.queued-followup button:disabled{opacity:.4}
.response-activity-slot{min-height:30px;flex:none;margin:2px 0 14px}
.response-activity{display:flex;align-items:center;gap:10px;height:30px;font-size:12px;color:var(--muted)}
.activity-caption{display:flex;align-items:center;gap:10px}.activity-caption time{font-variant-numeric:tabular-nums;font-size:11px}
.activity-orbit{display:inline-flex;gap:4px;align-items:center;width:30px;height:20px}
.activity-orbit i{display:block;width:5px;height:5px;border-radius:50%;background:currentColor;animation:response-pulse 1.35s ease-in-out infinite}
.activity-orbit i:nth-child(2){animation-delay:.16s}.activity-orbit i:nth-child(3){animation-delay:.32s}
@keyframes response-pulse{0%,70%,100%{opacity:.3;transform:translateY(0)}35%{opacity:1;transform:translateY(-3px)}}
.response-activity-enter-active,.response-activity-leave-active{transition:opacity .16s ease}
.response-activity-enter-from,.response-activity-leave-to{opacity:0}
.composer-actions{display:flex;align-items:center;gap:6px}.composer-send,.composer-stop{display:grid;place-items:center;width:44px;height:44px;flex:none;border:0;border-radius:50%;padding:0;margin:0;cursor:pointer;transition:background-color .15s ease,opacity .15s ease}
.composer-send{background:var(--ink);color:var(--paper)}.composer-send:disabled{opacity:.3;cursor:default}.composer-stop{background:var(--paper-soft);color:var(--ink);font-size:15px}.composer-stop:disabled{opacity:.4}
.composer-send:focus-visible,.composer-stop:focus-visible{outline:2px solid var(--muted);outline-offset:2px}
.agent-composer>.settings-note{flex-basis:100%;padding:0 8px}
@media(prefers-reduced-motion:reduce){.activity-spinner,.activity-orbit i{animation:none}.response-activity-enter-active,.response-activity-leave-active,.composer-send,.composer-stop{transition:none}.activity-orbit i{opacity:.65}}
</style>
