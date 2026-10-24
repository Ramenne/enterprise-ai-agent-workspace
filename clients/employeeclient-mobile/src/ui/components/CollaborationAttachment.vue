<script setup lang="ts">
import {useRouter} from 'vue-router';
import {CLOUD_FILE_CHANGED,cloudFileContext,cloudFileAttachment,cachedCloudFile,lookupCloudFile,cloudDownload,type CloudFile} from '@/files/cloud';
import {CLOUD_JOB_CHANGED,getCloudJob,pendingCloudJob,startCloudJob,type CloudJob} from '@/files/cloudJobs';
import {ACQUISITION_CHANGED,getAcquisition,startAcquisition,type AcquisitionJob} from '@/files/acquisition';
import {LOCAL_SAVE_CHANGED,getLocalSave,reconcileLocalSave,startLocalSave,type LocalSaveJob} from '@/files/localSave';
import {GROUP_SEND_CHANGED,beginNewGroupSend,completedGroupSend,pendingGroupSendNote,getGroupSend,startGroupSend,type GroupSendJob} from '@/files/groupSend';
import {ref,computed,onBeforeUnmount,onMounted,watch,nextTick,onDeactivated} from 'vue';
import {Attachment,MediaContext,findAttachment,LoadedMedia,safeRemote,attachmentRevision,sourceIdentity} from '@/collaboration/media';
import {useSessionStore} from '@/session/store';
import ModalSheet from './ModalSheet.vue';
import ChatImageViewer from './ChatImageViewer.vue';
import TransferSector from './TransferSector.vue';
import AppIcon from './AppIcon.vue';
import {Capacitor} from '@capacitor/core';
import {isSaveCancelled} from '@/platform/saveFile';
const props=defineProps<{attachment:Attachment;context:MediaContext;cloudFile?:CloudFile;embeddedInMessage?:boolean;forwardable?:boolean}>();
const emit=defineEmits<{forward:[];select:[]}>();
function chooseMessageForward(){menu.value=false;expanded.value=false;emit('forward');}
function chooseMessageSelection(){menu.value=false;expanded.value=false;emit('select');}
const session=useSessionStore(),router=useRouter();
const media=ref<LoadedMedia>(),busy=ref(false),error=ref(''),expanded=ref(false),saveMessage=ref(''),loaded=ref(0),total=ref<number>(),text=ref('');
let restoreController:AbortController|undefined;
let observer:IntersectionObserver|undefined;
const surface=ref<HTMLElement>();
type Destination='cloud'|'local';
const destination=ref<Destination>(),fileName=ref(''),fileNameInput=ref<HTMLInputElement>();
const editingName=ref(false);
const repeatSave=ref(false);
const destinationDone=ref(false);
const menu=ref(false),cloud=ref<CloudFile>(),cloudStage=ref('');
const acquisition=ref<AcquisitionJob>(),localSave=ref<LocalSaveJob>(),groupSend=ref<GroupSendJob>();
const choosingSave=ref(false);
const previewLoading=ref(false),groupDialog=ref(false),groupNote=ref('');
let openImageWhenReady=false;
const streamingUrl=ref('');let streamController:AbortController|undefined;
const isCollaboration=computed(()=>!!props.cloudFile||['codex','qoder'].includes(props.context.provider));
const backgrounded=ref(false);
let generation=0;
// The card can be replaced by a fresh conversation snapshot while its file
// job continues. Keep the user's confirmation sheet with the source identity,
// including across a WebView reload, until they close or background it.
const actionKey=()=>`qn:file-action:${JSON.stringify(sourceIdentity(props.attachment,props.context))}`;
let restoringAction=false;
function persistAction(){
 if(restoringAction)return;
 try{
  if(!destination.value&&!groupDialog.value){sessionStorage.removeItem(actionKey());return;}
  sessionStorage.setItem(actionKey(),JSON.stringify({destination:destination.value,fileName:fileName.value,editingName:editingName.value,destinationDone:destinationDone.value,groupDialog:groupDialog.value,groupNote:groupNote.value}));
 }catch{}
}
function restoreAction(){
 restoringAction=true;
 try{
  const saved=JSON.parse(sessionStorage.getItem(actionKey())||'null');
  if(saved?.destination==='cloud'||saved?.destination==='local'){
   destination.value=saved.destination;
   fileName.value=typeof saved.fileName==='string'?saved.fileName:props.attachment.name;
   editingName.value=!!saved.editingName;
   // Completion must be re-derived from a file/job receipt, never solely from
   // a saved UI flag after the page has been reloaded.
   destinationDone.value=false;
  }else if(saved?.groupDialog){groupDialog.value=true;groupNote.value=typeof saved.groupNote==='string'?saved.groupNote:'';}
 }catch{}finally{restoringAction=false;}
}
watch([destination,fileName,editingName,destinationDone,groupDialog,groupNote],persistAction,{flush:'sync'});
async function restore(){
 restoreAction();
 cloud.value=props.cloudFile||(isCollaboration.value?cachedCloudFile(props.attachment,props.context):undefined);
 acquisition.value=getAcquisition(props.attachment,props.context);
 localSave.value=getLocalSave(props.attachment,props.context);
 if(destination.value==='local'&&['complete','handed_off'].includes(localSave.value?.state||''))destinationDone.value=true;
 groupSend.value=getGroupSend(props.attachment,props.context);
 const confirmedGroupMessage=groupSend.value?.state==='complete'?groupSend.value.messageId:completedGroupSend(props.attachment,props.context);
 if(groupDialog.value&&confirmedGroupMessage){
  const id=confirmedGroupMessage;groupDialog.value=false;
  void router.push({path:'/chat',query:id?{message:id}:{}});
 }else if(groupDialog.value&&groupSend.value?.state==='error')error.value=groupSend.value.error||'未确认发到工作群，请重试';
 const personalJob=getCloudJob(props.attachment,props.context);
 const job=personalJob;
 if(job)showCloudJob(job);
 const epoch=generation,ctx=JSON.stringify(props.context),id=props.attachment.id;
 const result=await findAttachment(props.attachment,props.context).catch(()=>undefined);
 if(epoch!==generation||ctx!==JSON.stringify(props.context)||id!==props.attachment.id||session.user?.username!==props.context.account){result?.dispose();return;}
 localSave.value=reconcileLocalSave(props.attachment,props.context,result);
 if(Capacitor.isNativePlatform()&&result&&!result.saved&&destination.value==='local')destinationDone.value=false;
 if(result&&!media.value&&!busy.value){media.value=result;saveMessage.value=result.saved?`已保存到${result.location}`:'已在应用内缓存';if(result.saved&&destination.value==='local')destinationDone.value=true;}
 else result?.dispose();
 observe();
 if(isCollaboration.value&&!cloud.value){
  const c=new AbortController();restoreController=c;
  const saved=await lookupCloudFile(props.attachment,props.context,c.signal).catch(()=>undefined);
  if(epoch===generation&&!c.signal.aborted){cloud.value=saved;if(saved){if(!media.value)saveMessage.value='已存到梦空间';if(destination.value==='cloud'&&saved.name===fileName.value)destinationDone.value=true;}}
 }
 if(epoch!==generation||session.user?.username!==props.context.account||job?.state==='running')return;
 const pending=pendingCloudJob(props.attachment,props.context);
 if(pending){
  if(pending.state==='error')error.value='上次保存未完成，可用原文件名重试；已上传部分将先核对云端';
  else void saveCloud(pending.targetName);
 }
}
const transferStage=ref<'download'|'save'|'cloud'|'share'>('download');
function observe(){observer?.disconnect();if(props.attachment.kind!=='image'||props.attachment.url||props.attachment.unavailable||session.user?.username!==props.context.account)return;observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer?.disconnect();void load();}},{rootMargin:'100px'});if(surface.value)observer.observe(surface.value);}
onMounted(()=>void restore());
const label=computed(()=>cloud.value?.name||props.attachment.name);
const fileFormat=computed(()=>{
 const extension=label.value.match(/\.([a-z0-9]{1,8})$/i)?.[1];
 return extension?.toUpperCase()||'文件';
});
const format=(n:number)=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.ceil(n/1024)+' KB';
const progressPercent=computed(()=>{if(groupSend.value?.state==='running'&&groupSend.value.progressPercent!==undefined)return groupSend.value.progressPercent;const job=acquisition.value;if(job?.state==='running'&&job.total)return Math.min(100,Math.floor(job.loaded/job.total*100));return total.value&&total.value>0?Math.min(100,Math.floor(loaded.value/total.value*100)):undefined;});
// A completed transfer is not proof that its bytes are still present. The
// checkmark is shown only after the verified cache can actually be opened.
const acquired=computed(()=>!!media.value);
const compactImage=computed(()=>props.embeddedInMessage&&props.attachment.kind==='image');
let suppressImageClick=false;
function imageClick(){if(suppressImageClick){suppressImageClick=false;return;}expanded.value=true;}
let imagePress:ReturnType<typeof setTimeout>|undefined,imagePressStart:{x:number;y:number}|undefined;
function cancelImagePress(){clearTimeout(imagePress);imagePress=undefined;imagePressStart=undefined;}
function beginImagePress(e:PointerEvent){cancelImagePress();suppressImageClick=false;if(e.pointerType==='mouse'&&e.button!==0)return;imagePressStart={x:e.clientX,y:e.clientY};imagePress=setTimeout(()=>{imagePress=undefined;imagePressStart=undefined;suppressImageClick=true;openActions();},500);}
function moveImagePress(e:PointerEvent){if(imagePressStart&&Math.hypot(e.clientX-imagePressStart.x,e.clientY-imagePressStart.y)>8)cancelImagePress();}
onDeactivated(()=>{cancelImagePress();expanded.value=false;menu.value=false;});
const compactFile=computed(()=>props.embeddedInMessage&&props.attachment.kind==='file');
const transferring=computed(()=>busy.value||previewLoading.value||acquisition.value?.state==='running'||localSave.value?.state==='running'||groupSend.value?.state==='running');
const status=computed(()=>{
 if(choosingSave.value)return '请在系统窗口选择保存位置';
 if(groupSend.value?.state==='running')return groupSend.value.stage;
 if(localSave.value?.state==='running')return localSave.value.stage;
 if(acquisition.value?.state==='running')return acquisition.value.total?`${progressPercent.value}% · ${format(acquisition.value.loaded)} / ${format(acquisition.value.total)}`:`已获取 ${format(acquisition.value.loaded)}`;
 if(cloudStage.value)return cloudStage.value;
 if(busy.value)return transferStage.value==='share'?'正在打开分享方式…':total.value?`${Math.min(100,Math.floor(loaded.value/total.value*100))}% · ${format(loaded.value)} / ${format(total.value)}`:`正在获取文件…`;
 if(saveMessage.value==='已交给浏览器打开，请在新标签页确认')return saveMessage.value;
 const facts=[acquired.value?'已取得文件':null,media.value?.saved||localSave.value?.state==='complete'?'已保存本机':null,
  localSave.value?.state==='handed_off'&&!media.value?.saved?'已交给浏览器下载，请在下载列表确认':null,
  cloud.value?'已存梦空间':null,groupSend.value?.state==='complete'?'已发工作群':null].filter(Boolean);
 if(facts.length)return facts.join(' · ');
 if(localSave.value?.state==='handed_off')return localSave.value.stage;
 if(saveMessage.value)return saveMessage.value;
 return props.attachment.size!==undefined?format(props.attachment.size):'';
});
function clear(){generation++;restoreController?.abort();streamController?.abort();streamingUrl.value='';cloud.value=undefined;cloudStage.value='';destination.value=undefined;destinationDone.value=false;editingName.value=false;repeatSave.value=false;groupDialog.value=false;groupNote.value='';previewLoading.value=false;openImageWhenReady=false;acquisition.value=undefined;localSave.value=undefined;groupSend.value=undefined;observer?.disconnect();media.value?.dispose();media.value=undefined;busy.value=false;backgrounded.value=false;expanded.value=false;text.value='';saveMessage.value='';menu.value=false;error.value='';loaded.value=0;total.value=undefined;}
function showCloudJob(job:CloudJob){if(job.account!==props.context.account)return;cloudStage.value=job.state==='running'?job.stage:'';if(job.file)cloud.value=job.file;if(job.state==='running'){busy.value=!backgrounded.value;transferStage.value='cloud';}else if(job.state==='error'){busy.value=false;error.value=job.error||'保存未完成，可重试';}else{busy.value=false;saveMessage.value=job.stage;if(destination.value==='cloud'&&job.file?.name===fileName.value)destinationDone.value=true;}}
function fileSource(a:Attachment,ctx:MediaContext,known?:CloudFile){
 const mayCloud=isCollaboration.value;
 return async(signal:AbortSignal):Promise<Attachment>=>{
  let f=known||cachedCloudFile(a,ctx);
  if(mayCloud&&!f)f=await lookupCloudFile(a,ctx,signal).catch(()=>undefined);
  if(signal.aborted)throw new DOMException('已取消','AbortError');
  return f?{...a,unavailable:undefined,url:undefined,sha256:f.sha256,resolveUrl:async(s:AbortSignal)=>(await cloudDownload(f!,s)).download_url}:a;
 };
}
function startFile(a:Attachment,ctx:MediaContext,known?:CloudFile){
 const job=startAcquisition(a,ctx,fileSource(a,ctx,known));acquisition.value={...job};return job;
}
async function previewStream(a:Attachment,ctx:MediaContext,known?:CloudFile){
 const c=new AbortController();streamController=c;
 try{
  const source=await fileSource(a,ctx,known)(c.signal);
  const url=source.url||await source.resolveUrl?.(c.signal);
  if(!url)return false;
  if(!c.signal.aborted){streamingUrl.value=safeRemote(url);saveMessage.value='在线播放 · 尚未下载完整文件';}
  return true;
 }finally{if(streamController===c)streamController=undefined;}
}
async function load(download=false,requestedName?:string,repeat=false){
 if(session.user?.username!==props.context.account||(!download&&previewLoading.value))return;
 error.value='';saveMessage.value='';const epoch=generation,ctx={...props.context},attachment={...props.attachment},known=cloud.value;
 const active=()=>epoch===generation&&session.user?.username===ctx.account;
 if(download){
  if(busy.value)return;busy.value=true;choosingSave.value=true;
  try{
   const job=await startLocalSave(attachment,ctx,requestedName||label.value,fileSource(attachment,ctx,known),getAcquisition(attachment,ctx)?.state==='running'?getAcquisition(attachment,ctx):undefined,repeat);
   if(active()){localSave.value={...job};choosingSave.value=false;}
   const finished=await job.promise;
   if(active()){
    localSave.value={...finished};saveMessage.value=finished.message||'已保存到本机';
    if(!media.value)media.value=await findAttachment(attachment,ctx);
   }
  }catch(e){if(active()&&!isSaveCancelled(e))error.value=e instanceof Error?e.message:'文件保存失败';}
  finally{if(active()){busy.value=false;choosingSave.value=false;}}
  return;
 }
 previewLoading.value=true;
 // A PWA must reserve its preview during the tap; opening a tab after the
 // remote bytes arrive is often rejected as an unsolicited popup.
 const externalPreview=!Capacitor.isNativePlatform()&&attachment.kind==='file'&&!attachment.mime.startsWith('text/')&&attachment.mime!=='application/json'&&attachment.mime!=='application/pdf';
 const preview=externalPreview?window.open('about:blank','_blank'):null;
 let previewOpened=false;
 try{
  if(externalPreview&&!preview)throw Error('请允许在浏览器打开文件后重试');
  if(preview){preview.opener=null;preview.document.title='正在准备文件';preview.document.body.textContent='正在准备文件…';}
  if(!media.value&&(attachment.kind==='video'||attachment.kind==='audio')&&await previewStream(attachment,ctx,known))return;
  if(!media.value){const job=startFile(attachment,ctx,known);await job.promise;if(!active())return;const result=await findAttachment(attachment,ctx);if(!result)throw Error('预览文件未保存在应用缓存，请重试');if(!active()){result.dispose();return;}media.value=result;saveMessage.value='已在应用内缓存';}
  if(!active())return;
  if(props.attachment.kind==='file'){
   if(props.attachment.mime.startsWith('text/')||props.attachment.mime==='application/json'){
    const size=media.value.uploadSource.size,limit=Math.min(size,1048576);
    const previewBlob=media.value.blob?.slice(0,limit)||await media.value.uploadSource.readPart?.(0,limit);
    if(!previewBlob)throw Error('文件内容暂不可读，可选择系统打开方式');
    const preview=await previewBlob.text();if(!active())return;text.value=preview;if(size>1048576)text.value+='\n\n预览到此，完整内容可通过系统打开或保存到本机查看。';expanded.value=true;
   }else if(props.attachment.mime==='application/pdf'&&!Capacitor.isNativePlatform())expanded.value=true;
   else if(preview){preview.location.replace(media.value.url);previewOpened=true;}
   else {await media.value.open();saveMessage.value='已打开系统的文件打开方式';}
  }
 }catch(e){if(active()&&!isSaveCancelled(e))error.value=e instanceof Error?e.message:'附件加载失败，点击重试';}
 finally{if(!previewOpened)preview?.close();if(active()){previewLoading.value=false;if(openImageWhenReady){if(media.value)expanded.value=true;openImageWhenReady=false;}}}
}
function openImage(){
 if(media.value){expanded.value=true;return;}
 openImageWhenReady=true;
 if(!previewLoading.value)void load();
}
async function saveCloud(requestedName?:string){
 menu.value=false;if(busy.value)return;backgrounded.value=false;busy.value=true;transferStage.value='cloud';error.value='';const epoch=generation,ctx={...props.context},a={...props.attachment},known=cloud.value,targetName=requestedName||label.value;const active=()=>epoch===generation&&session.user?.username===ctx.account;
 let held:LoadedMedia|undefined;
 try{
  // A separate cache lease is held until upload completes. Destroying this
  // card cannot close the native file handle used by the cloud transfer.
  held=await findAttachment(a,ctx);
  if(!held&&!Number.isSafeInteger(a.size)){
   const acquiring=startAcquisition(a,ctx,fileSource(a,ctx,known));await acquiring.promise;
   held=await findAttachment(a,ctx);
   if(!held)throw Error('文件大小尚未确认，无法保存到梦空间');
  }
  let job=startCloudJob(a,ctx,held?.uploadSource,known,targetName);
  if(active())showCloudJob(job);
  let finished:CloudJob;
  try{finished=await job.promise;}
  catch(e){
   if(held||known||(!a.url&&!a.resolveUrl))throw e;
   // Prefer Mac-origin upload. A URL source is the fallback if that bridge
   // cannot supply the bytes; a route change still does not cancel the fetch.
   const acquiring=startAcquisition(a,ctx,fileSource(a,ctx,known));await acquiring.promise;
   held=await findAttachment(a,ctx);
   if(!held)throw Error('文件获取完成，但未找到已验证缓存');
   job=startCloudJob(a,ctx,held.uploadSource,undefined,targetName);
   if(active())showCloudJob(job);
   finished=await job.promise;
  }
  if(finished.file)await held?.cacheAs?.(cloudFileAttachment(finished.file),cloudFileContext(ctx.account));
  if(active())showCloudJob(finished);
 }catch(e){if(active())error.value=e instanceof Error?e.message:'保存未完成，可重试继续';}
 finally{held?.dispose();if(active()){busy.value=false;cloudStage.value='';}}
}
async function forward(){
 menu.value=false;
 if(groupSend.value?.state==='running')return;
 beginNewGroupSend(props.attachment,props.context);groupNote.value=pendingGroupSendNote(props.attachment,props.context)||'';
 await confirmGroupSend();
}
async function confirmGroupSend(){
 if(groupSend.value?.state==='running'||session.user?.username!==props.context.account)return;
 const epoch=generation,ctx={...props.context},a={...props.attachment};
 error.value='';
 const job=startGroupSend(a,ctx,groupNote.value,cloud.value);groupSend.value={...job};
 try{
  const completed=await job.promise;
  if(epoch===generation&&session.user?.username===ctx.account){groupSend.value={...completed};groupDialog.value=false;await router.push({path:'/chat',query:completed.messageId?{message:completed.messageId}:{}});}
 }catch(e){if(epoch===generation&&session.user?.username===ctx.account)error.value=e instanceof Error?e.message:'未确认发到工作群，请重试';}
}
function openActions(){if(props.attachment.kind!=='image')expanded.value=false;menu.value=true;}
function chooseDestination(next:Destination,repeat=false){menu.value=false;destination.value=next;destinationDone.value=false;repeatSave.value=repeat;editingName.value=false;fileName.value=next==='local'?media.value?.localName||label.value:label.value;error.value='';}
function editName(){editingName.value=true;void nextTick(()=>{fileNameInput.value?.focus();const end=fileName.value.lastIndexOf('.');fileNameInput.value?.setSelectionRange(0,end>0?end:fileName.value.length);});}
async function confirmDestination(){
 const next=destination.value;if(!next)return;
 if(destinationDone.value){destination.value=undefined;destinationDone.value=false;return;}
 const name=fileName.value.normalize('NFC').trim(),original=props.attachment.name;
 const ext=(n:string)=>n.lastIndexOf('.')>0?n.slice(n.lastIndexOf('.')).toLowerCase():'';
 if(!name||[...name].length>160||/[\\/\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..'||ext(name)!==ext(original)){error.value='请输入文件名并保留原扩展名';return;}
 error.value='';
 if(next==='local')await load(true,name,repeatSave.value);else await saveCloud(name);
 const completed=next==='local'?['complete','handed_off'].includes(getLocalSave(props.attachment,props.context)?.state||''):getCloudJob(props.attachment,props.context)?.state==='complete';
 if(!error.value&&completed&&destination.value===next&&!busy.value)destinationDone.value=true;
}

async function share(){
 if(busy.value||session.user?.username!==props.context.account)return;
 // Web Share needs a fresh click. If the bytes are not cached yet, prepare them
 // inside the sheet and let the next tap hand the verified file to the OS.
 const preparing=!Capacitor.isNativePlatform()&&!media.value;
 busy.value=true;transferStage.value=media.value?'share':'download';error.value='';const epoch=generation,ctx={...props.context},a={...props.attachment},known=cloud.value;
 const active=()=>epoch===generation&&session.user?.username===ctx.account;
 try{if(!media.value){const job=startFile(a,ctx,known);await job.promise;if(!active())return;const result=await findAttachment(a,ctx);if(!result)throw Error('文件未保存在应用缓存，无法分享');if(!active()){result.dispose();return;}media.value=result;}if(active()){if(preparing)saveMessage.value='文件已准备好，请点击分享';else {await media.value.share();saveMessage.value='';menu.value=false;}}}
 catch(e){if(active()&&!isSaveCancelled(e))error.value=e instanceof Error?e.message:'无法分享文件';}finally{if(active())busy.value=false;}
}
async function openSaved(){
 error.value='';
 // Reserve the browser tab during the click. Restoring a cached file is async
 // and opening a new tab after that await is blocked on mobile browsers.
 const preview=Capacitor.isNativePlatform()?null:window.open('about:blank','_blank');
 if(!Capacitor.isNativePlatform()&&!preview){error.value='请允许打开文件预览后重试';return;}
 if(preview){preview.opener=null;preview.document.title='正在打开文件';preview.document.body.textContent='正在打开文件…';}
 let cached:LoadedMedia|undefined;
 try{
  cached=media.value||await findAttachment(props.attachment,props.context);
  if(!cached)throw Error('应用内文件未找到，请重新获取');
  if(preview){preview.location.replace(cached.url);saveMessage.value='已交给浏览器打开，请在新标签页确认';}
  else {await cached.open();saveMessage.value='已打开系统的文件打开方式';}
  menu.value=false;
 }catch(e){preview?.close();error.value=e instanceof Error?e.message:'无法打开文件';}
 finally{if(cached!==media.value&&cached)setTimeout(()=>cached?.dispose(),120000);}
}
async function openInOtherApp(){await openSaved();}
function cancel(){if(acquisition.value?.state==='running')acquisition.value.cancel();}
function background(){backgrounded.value=true;busy.value=false;destination.value=undefined;groupDialog.value=false;saveMessage.value='正在后台保存，可继续浏览';}
function playbackFailed(){error.value='当前设备无法预览此格式，可下载原文件打开';}
watch(()=>[props.context.account,props.context.computer,props.context.provider,props.context.thread,props.attachment.id,attachmentRevision(props.attachment),session.user?.username],async(now,previous)=>{
 // Message refreshes replace projection objects without changing this file.
 // Keep the user's open/download action unless its actual identity changes.
 if(previous&&now.every((value,index)=>value===previous[index]))return;
 if(previous&&JSON.stringify(now)!==JSON.stringify(previous))try{sessionStorage.removeItem(`qn:file-action:${JSON.stringify([previous[0],previous[1],previous[2],previous[3],previous[4],previous[5]])}`);}catch{}
 restoringAction=true;clear();restoringAction=false;await nextTick();await restore();
});
watch(()=>[props.attachment.name,props.cloudFile?.name],()=>{if(props.cloudFile)cloud.value=props.cloudFile;});
function cloudChanged(event:Event){const {account,file}=(event as CustomEvent<{account:string;file:CloudFile}>).detail;if(account===props.context.account&&cloud.value?.id===file.id)cloud.value=file;}
function cloudJobChanged(event:Event){const job=(event as CustomEvent<CloudJob>).detail;if(getCloudJob(props.attachment,props.context)===job)showCloudJob(job);}
function acquisitionChanged(event:Event){
 const job=(event as CustomEvent<AcquisitionJob>).detail;
 if(getAcquisition(props.attachment,props.context)!==job)return;
 acquisition.value={...job};
 if(job.state!=='complete'||media.value)return;
 const epoch=generation,ctx={...props.context},a={...props.attachment};
 void findAttachment(a,ctx).then(result=>{
  if(!result)return;
  if(epoch===generation&&session.user?.username===ctx.account&&!media.value)media.value=result;
  else result.dispose();
 }).catch(()=>{});
}
function localSaveChanged(event:Event){const job=(event as CustomEvent<LocalSaveJob>).detail;if(getLocalSave(props.attachment,props.context)===job){localSave.value={...job};if(destination.value==='local'&&['complete','handed_off'].includes(job.state))destinationDone.value=true;}}
function groupSendChanged(event:Event){const job=(event as CustomEvent<GroupSendJob>).detail;if(getGroupSend(props.attachment,props.context)===job){groupSend.value={...job};if(job.state==='complete'&&groupDialog.value){groupDialog.value=false;void router.push({path:'/chat',query:job.messageId?{message:job.messageId}:{}});}}}
window.addEventListener(CLOUD_FILE_CHANGED,cloudChanged);
window.addEventListener(CLOUD_JOB_CHANGED,cloudJobChanged);
window.addEventListener(ACQUISITION_CHANGED,acquisitionChanged);
window.addEventListener(LOCAL_SAVE_CHANGED,localSaveChanged);
window.addEventListener(GROUP_SEND_CHANGED,groupSendChanged);
onBeforeUnmount(()=>{cancelImagePress();window.removeEventListener(CLOUD_FILE_CHANGED,cloudChanged);window.removeEventListener(CLOUD_JOB_CHANGED,cloudJobChanged);window.removeEventListener(ACQUISITION_CHANGED,acquisitionChanged);window.removeEventListener(LOCAL_SAVE_CHANGED,localSaveChanged);window.removeEventListener(GROUP_SEND_CHANGED,groupSendChanged);restoringAction=true;clear();});
</script>
<template>
 <section ref="surface" class="collab-attachment" :class="{'message-file':embeddedInMessage&&!compactImage,'message-image':compactImage}" data-message-action @pointerdown="embeddedInMessage ? undefined : $event.stopPropagation()" @contextmenu="embeddedInMessage ? undefined : $event.stopPropagation()" @click.stop>
  <button v-if="attachment.kind==='image'&&media" class="image" data-message-action :aria-label="'查看原图 '+label" @click="imageClick" @pointerdown.stop="beginImagePress" @pointermove.stop="moveImagePress" @pointerup.stop="cancelImagePress" @pointercancel.stop="cancelImagePress" @contextmenu.prevent.stop="openActions"><img :src="media.url" :alt="label" @error="playbackFailed"></button>
  <button v-else-if="compactImage" class="image-placeholder" :aria-label="error?'重试获取图片':'查看图片'" @click="openImage" @pointerdown.stop="beginImagePress" @pointermove.stop="moveImagePress" @pointerup.stop="cancelImagePress" @pointercancel.stop="cancelImagePress" @contextmenu.prevent.stop="openActions"><AppIcon name="image"/><span>{{error?'图片获取失败，点击重试':attachment.unavailable?'原图片暂不可用':transferring?'正在读取图片…':'查看图片'}}</span></button>
  <video v-else-if="attachment.kind==='video'&&(media||streamingUrl)" :src="media?.url||streamingUrl" controls playsinline preload="metadata" @error="playbackFailed"></video>
  <audio v-else-if="attachment.kind==='audio'&&(media||streamingUrl)" :src="media?.url||streamingUrl" controls preload="metadata" @error="playbackFailed"></audio>
  <div v-if="!compactImage" class="attachment-heading">
   <button v-if="compactFile" class="file-main" :aria-label="'打开文件 '+label" @click="load()"><span class="file-format-mark" aria-hidden="true">{{fileFormat}}</span><span class="attachment-info"><strong>{{label}}</strong><small>{{attachment.size!==undefined?format(attachment.size):fileFormat}}<span v-if="acquired" class="file-ready" aria-label="文件已在本地缓存"> · ✓</span><template v-if="transferring"> · {{status}}</template></small></span></button>
   <div v-else class="attachment-info"><strong>{{label}}</strong><small role="status">{{fileFormat}} · {{status}}</small></div>
   <TransferSector v-if="acquisition?.state==='running'||groupSend?.state==='running'" :value="progressPercent" :label="status"/>
   <button v-if="compactFile" class="file-more" aria-label="保存或分享文件" @click="openActions"><AppIcon name="more"/></button>
  </div>
  <p v-if="!compactImage&&((attachment.unavailable&&!media&&!cloud)||error)" role="alert">{{error||(typeof attachment.unavailable==='string'?attachment.unavailable:'附件原件暂不可用，可稍后重试')}}</p>
  <div v-if="!compactFile&&!compactImage" class="actions">
   <template v-if="!attachment.unavailable||media||cloud||acquisition?.state==='running'">
    <button v-if="acquisition?.state==='running'" @click="cancel">取消获取</button>
   <button v-if="busy&&transferStage==='cloud'" @click="background">后台继续</button>
    <button v-if="!media||attachment.kind==='file'" :disabled="previewLoading&&attachment.kind!=='image'" @click="attachment.kind==='image'?openImage():load()">{{previewLoading?'正在准备文件…':error?'重试':attachment.kind==='image'?'查看图片':attachment.kind==='video'?'播放视频':attachment.kind==='audio'?'播放音频':'打开文件'}}</button>
    <button aria-label="保存或分享文件" @click="openActions">保存 / 分享</button>
    <button v-if="groupSend?.state==='complete'" @click="router.push({path:'/chat',query:groupSend.messageId?{message:groupSend.messageId}:{}})">查看群消息</button>
   </template>
  </div>
  <Teleport to="body"><ModalSheet v-if="menu" :style="expanded?{zIndex:114}:undefined" :title="label" @close="menu=false"><div class="file-menu"><button v-if="acquisition?.state==='running'" class="btn" @click="cancel();menu=false">取消获取</button>
   <button v-if="isCollaboration&&!cloud" class="btn" @click="chooseDestination('cloud')">保存到梦空间</button>
   <RouterLink v-else-if="cloud" class="btn" :to="{name:'files',query:{scope:'personal'}}" @click="menu=false">已存梦空间 · 查看</RouterLink>
   <button v-if="forwardable" class="btn" aria-label="转发消息" @click="chooseMessageForward">转发</button>
   <button v-if="forwardable" class="btn" aria-label="多选消息" @click="chooseMessageSelection">多选</button>
   <button v-if="(isCollaboration||attachment.groupAttachment)&&(!forwardable||groupSend?.state==='error')" class="btn" :disabled="groupSend?.state==='running'" @click="forward">{{groupSend?.state==='error'?'重试发送到工作群':attachment.groupAttachment?'转发到工作群':'发送到工作群'}}</button>
   <button v-if="!media?.saved&&!['complete','handed_off'].includes(localSave?.state||'')" class="btn" @click="chooseDestination('local')">下载到本机</button>
   <template v-else-if="localSave?.state==='handed_off'&&!media?.saved">
    <p class="handoff-note">已交给浏览器下载，员工客户端无法确认系统是否已保存。文件仍在应用缓存中。</p>
    <button class="btn" @click="openSaved">打开应用内文件</button>
    <button class="btn secondary-action" @click="chooseDestination('local',true)">再次保存到设备</button>
   </template>
   <template v-else>
    <button v-if="media||acquired" class="btn" @click="openSaved">{{Capacitor.isNativePlatform()?'已下载到本机 · 打开方式':'打开应用内文件'}}</button>
    <button class="btn secondary-action" @click="chooseDestination('local',true)">再次保存到设备</button>
   </template>
   <p v-if="acquisition?.state==='running'" class="destination-status" role="status">正在获取文件 · {{status}}，可继续使用其他功能</p>
   <p v-else-if="saveMessage==='文件已准备好，请点击分享'" role="status">文件已准备好，可交给其他应用</p>
   <p v-if="error" role="alert">{{error}}</p>
   <button class="btn" :disabled="busy" @click="share">{{!Capacitor.isNativePlatform()&&media?'用其他应用分享已准备好的文件':'用其他应用分享'}}</button>
   <button v-if="media&&attachment.kind!=='file'" class="btn" :disabled="busy" @click="openInOtherApp">使用其他应用打开</button>
  </div></ModalSheet><ModalSheet v-if="destination" :style="expanded?{zIndex:114}:undefined" :title="destination==='cloud'?'保存到梦空间':'下载到本机'" :sub="destination==='cloud'?'仅自己可见':'保存到设备下载目录'" @close="destination=undefined"><label class="filename-label" for="attachment-file-name">文件名</label><div v-if="!editingName" class="filename-preview"><span>{{fileName}}</span><button type="button" @click="editName">重命名</button></div><input v-else id="attachment-file-name" ref="fileNameInput" v-model="fileName" class="input" aria-label="文件名称" maxlength="160" @keydown.enter.prevent="confirmDestination"><p v-if="busy||localSave?.state==='running'||destinationDone" class="destination-status" role="status">{{destinationDone?saveMessage:status}}</p><p v-if="error" role="alert">{{error}}</p><template #footer><button class="btn primary" :disabled="busy||localSave?.state==='running'" @click="confirmDestination">{{destinationDone?'完成':busy||localSave?.state==='running'?'处理中…':'确认保存'}}</button></template></ModalSheet><ModalSheet v-if="groupDialog" title="发送到工作群" :sub="label" @close="groupDialog=false"><label class="filename-label" for="group-file-note">附言（可选）</label><textarea id="group-file-note" v-model="groupNote" class="input group-note" maxlength="2000" placeholder="说点什么…" :disabled="groupSend?.state==='running'"></textarea><p v-if="groupSend?.state==='running'" class="destination-status" role="status"><TransferSector :value="progressPercent" :label="groupSend.stage"/>{{groupSend.stage}} · 可继续浏览，发送完成后会显示在群聊</p><p v-if="error" role="alert">{{error}}</p><template #footer><button class="btn primary" :disabled="groupSend?.state==='running'" @click="confirmGroupSend">{{groupSend?.state==='running'?'发送中…':'发送'}}</button></template></ModalSheet><ChatImageViewer v-if="expanded&&media&&attachment.kind==='image'" :url="media.url" :name="label" @close="expanded=false" @actions="openActions" @save="chooseDestination('local')"/><ModalSheet v-else-if="expanded&&media" :title="label" modal-class="collaboration-media-preview" @close="expanded=false">
   <img v-if="attachment.kind==='image'" class="original-image" :src="media.url" :alt="label"><iframe v-else-if="attachment.mime==='application/pdf'" class="pdf-preview" :src="media.url" :title="label"></iframe><pre v-else class="full-text">{{text}}</pre>
   <template #footer><button class="btn primary" @click="openActions">保存 / 分享</button></template>
  </ModalSheet></Teleport>
 </section>
</template>
<style scoped>
.filename-label{display:block;color:var(--muted);font-size:12px;margin-bottom:8px}.filename-preview{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;border:1px solid var(--line);border-radius:8px;padding:5px 8px 5px 12px}.filename-preview span{min-width:0;overflow-wrap:anywhere}.filename-preview button{flex:none;min-height:44px;border:0;background:transparent;color:var(--blue);padding:6px 8px}.input{width:100%}.input:focus,.input:focus-visible{outline:none;box-shadow:none;border-color:#aeb8c3}.group-note{min-height:96px;resize:vertical;padding:12px}.file-menu{display:grid;gap:10px}.collab-attachment{border:1px solid var(--line);border-radius:10px;background:var(--paper);margin:10px 0;overflow:hidden;max-width:100%;padding:12px}.attachment-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.attachment-info{display:grid;gap:4px;min-width:0;overflow-wrap:anywhere}.attachment-info strong{font-size:var(--file-title-size);font-weight:600;line-height:1.45;overflow-wrap:anywhere}.attachment-info small{font-size:var(--file-meta-size);color:var(--muted)}.file-progress{flex:none;display:grid;place-items:center;position:relative;width:46px;height:46px;border-radius:50%;background:conic-gradient(var(--blue) var(--file-progress,0%),var(--line) 0);font-size:11px;color:var(--blue);font-weight:600}.file-progress:before{content:'';position:absolute;inset:4px;background:var(--paper);border-radius:50%}.file-progress span{position:relative}.file-progress.indeterminate{border:3px solid var(--line);border-top-color:var(--blue);background:var(--paper);animation:file-spin .9s linear infinite}.file-progress.indeterminate:before{display:none}.file-progress.indeterminate span{animation:file-counter-spin .9s linear infinite}@keyframes file-spin{to{transform:rotate(360deg)}}@keyframes file-counter-spin{to{transform:rotate(-360deg)}}@media(prefers-reduced-motion:reduce){.file-progress.indeterminate,.file-progress.indeterminate span{animation:none}}.actions{display:flex;gap:16px;flex-wrap:wrap;margin-top:6px}.actions button{border:0;background:transparent;color:var(--blue);font:inherit;font-size:14px;min-height:44px;padding:6px 0}.image{display:block;width:100%;border:0;background:transparent;padding:0;margin-bottom:10px}.image img{display:block;max-width:100%;max-height:300px;margin:auto;object-fit:contain}video{display:block;width:100%;max-height:360px;background:#17191d;margin-bottom:10px}audio{width:100%;margin-bottom:10px}p{color:var(--red);font-size:12px;margin:8px 0}p[role="status"],.handoff-note{color:var(--muted)}.original-image{width:100%;height:auto}.pdf-preview{width:100%;height:70vh;border:0}.full-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}:global(.collaboration-media-preview){height:var(--qn-visual-viewport-height,100dvh);max-height:var(--qn-visual-viewport-height,100dvh)!important;border-radius:0!important}
.message-file{width:var(--file-card-width);max-width:100%;margin:0;min-width:0;padding:10px 12px;border:0;border-radius:8px}.message-file .attachment-info{flex:1}.message-file .attachment-heading{align-items:flex-start}.destination-status{color:var(--muted)}.file-ready{color:var(--success,#23765f);font-weight:700}
.file-format-mark{position:relative;flex:none;display:flex;align-items:flex-end;justify-content:center;align-self:center;width:40px;height:52px;padding:0 2px 8px;border-radius:4px;background:#e0e4ec;color:#71809b;font-size:11px;font-weight:650;overflow:hidden}.file-format-mark::after{content:'';position:absolute;top:0;right:0;width:12px;height:12px;background:linear-gradient(45deg,#cbd2de 50%,var(--paper) 50%)}
.handoff-note{color:var(--muted);line-height:1.5;margin:0}.secondary-action{color:var(--muted)}
</style>

<style scoped>
.message-file .attachment-heading{align-items:center;gap:10px}.message-file .attachment-info{gap:3px}.file-main{display:flex;align-items:center;gap:10px;flex:1;border:0;padding:0;background:transparent;text-align:left;color:var(--ink);min-width:0}.file-main strong{font-size:15px;font-weight:500;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.message-file .attachment-info small{font-size:12px;line-height:1.4}.file-format-mark{align-items:center;align-self:center;width:38px;height:42px;padding:0;border:0;border-radius:7px;background:#edf2f5;font-size:10px;color:#53738b}.file-format-mark::after{display:none}.file-more{flex:none;width:24px;height:32px;position:relative;border:0;padding:0;background:transparent;color:var(--muted)}.file-more::after{content:'';position:absolute;inset:-6px -10px}.file-more .icon{width:18px;height:18px}
</style>

<style scoped>
.collab-attachment.message-image{border:0;padding:0;background:transparent;width:fit-content;max-width:200px;border-radius:5px;gap:0;box-shadow:none;overflow:visible}.message-image>.image{display:block;width:auto;max-width:200px;border:0;padding:0;overflow:hidden;background:transparent;border-radius:5px;line-height:0}.message-image>.image img{display:block;width:auto;height:auto;max-width:200px;max-height:260px;object-fit:contain;border-radius:5px}.image-placeholder{width:180px;min-height:120px;padding:12px;border:0;border-radius:5px;background:#e2e2e2;color:#666;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;font-size:12px}.image-placeholder .icon{width:28px;height:28px}
</style>
