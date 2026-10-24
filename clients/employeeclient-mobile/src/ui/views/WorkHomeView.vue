<script setup lang="ts">
import {useModeBack} from '@/ui/components/modalFocus';
import {pageNavigation} from '@/app/router';
import {safeDetailReturn} from '@/native/detail-model.mjs';
import {referenceCopyText} from '@/ui/referenceCopy.mjs';
import PullToRefresh from '@/ui/components/PullToRefresh.vue';
import {fullDate} from '@/ui/date.mjs';
import {ref,computed,watch,onMounted,onBeforeUnmount,onDeactivated,onActivated,nextTick} from 'vue';
import {useRouter,useRoute,onBeforeRouteLeave} from 'vue-router';
import {useSessionStore} from '@/session/store';
import {useUiStore} from '@/store/ui';
import {captureApiLease} from '@/api/client';
import {metaGet,metaSet} from '@/session/db';
import {readProjects,readWorkCatalog} from '@/native/hub-data';
import {onChatWake} from '@/platform/chatEvents';
import {createRecoveryGate} from '@/platform/recoveryGate.mjs';
import {isRetryableFailure} from '@/domain/userError.mjs';
import {myProjects,numberLabel,projectPickerOptions} from '@/native/discovery.mjs';
import {attributeSelectionCatalog,valueLabel} from '@/native/attribute-query.mjs';
import {useReadFeedback} from '@/ui/useReadFeedback';
import AttributeSelect from '@/ui/components/AttributeSelect.vue';
import AppIcon from '@/ui/components/AppIcon.vue';
defineOptions({name:'WorkHomeView'});
const session=useSessionStore(),ui=useUiStore(),router=useRouter(),route=useRoute();
const {error,feedback}=useReadFeedback();
const projects=ref<any[]>([]),project=ref(''),rows=ref<any[]>([]),query=ref(''),selected=ref<Record<string,string>>({}),busy=ref(false),limit=ref(40);
const hasMore=ref(false),facetRows=ref<any[]>([]),facetMore=ref(false),facetBusy=ref(false);
let rowAbort:AbortController|undefined,queryTimer:ReturnType<typeof setTimeout>|undefined;
const root=ref<InstanceType<typeof PullToRefresh>|null>(null);
let viewActive=true,restoringView=true,savedScroll=0;
function scrollHost(){let node=root.value?.$el?.parentElement as HTMLElement|null;while(node){if(/auto|scroll/.test(getComputedStyle(node).overflowY))return node;node=node.parentElement;}return document.scrollingElement;}
let alive=true,epoch=0,viewReady=false,loadingDirectory=false;
let failedStep:'directory'|'rows'='directory',workDirty=false;
const retryWaiting=ref(false);
const recovery=createRecoveryGate({wake:()=>{if(alive&&viewActive&&session.businessReady){retryWaiting.value=false;void retry();}}});
const chatReturn=computed(()=>{const target=route.query.returnTo;return typeof target==='string'&&/^\/chat(?:\?|$)/.test(target)&&safeDetailReturn(target)===target?target:'';});
const chosen=computed(()=>projects.value.find(p=>p.project_id===project.value));
const choices=computed(()=>projectPickerOptions(projects.value));
const filtersOpen=ref(false);
useModeBack(filtersOpen,()=>{filtersOpen.value=false;});
const selectedCount=computed(()=>Object.values(selected.value).filter(Boolean).length);
const attributes=computed(()=>attributeSelectionCatalog(facetRows.value.length?facetRows.value:rows.value,selected.value));
const matched=computed(()=>rows.value);
const ordered=computed(()=>[...matched.value].sort((a,b)=>{
 const rank=(s:string)=>['active','in_progress'].includes(s)?0:s==='completed'?1:2;
 return rank(a.state)-rank(b.state)||(Date.parse(b.updated_at||'')||0)-(Date.parse(a.updated_at||'')||0);
}));
const viewKey='human-work-view-v1';
async function saveView(){if(!viewActive||restoringView)return;const lease=captureApiLease();savedScroll=scrollHost()?.scrollTop||0;if(lease.valid())await metaSet(lease.account,viewKey,{project:project.value,query:query.value,selected:selected.value,limit:limit.value,scroll:savedScroll},lease.valid).catch(()=>{});}
async function loadRows(more=false){
 if(!viewActive||session.status==='offline'&&session.link?.networkUp===false){workDirty=true;return;}
 if(busy.value&&!loadingDirectory||!recovery.ready())return;
 workDirty=false;
 rowAbort?.abort();rowAbort=new AbortController();const signal=rowAbort.signal;
 const lease=captureApiLease(),n=++epoch,p=chosen.value;if(!p||!lease.valid())return;
 failedStep='rows';
 const valid=()=>alive&&n===epoch&&lease.valid();busy.value=true;feedback.begin(rows.value.length>0);
 // Switching projects cannot show the last project's records as the new one.
 const apply=(v:any)=>{if(valid()){rows.value=v.rows;hasMore.value=!!v.hasMore;feedback.begin(rows.value.length>0);}};
 try{const value=await readWorkCatalog(lease,p,{query:query.value,selected:selected.value,more,signal,onSnapshot:apply});apply(value);feedback.succeeded();retryWaiting.value=false;recovery.completed();}
 catch(e){if(valid()){const transient=isRetryableFailure(e);feedback.failed(e,'工作暂未更新，请重试');if(transient&&viewActive){retryWaiting.value=true;recovery.failed();}if([401,403].includes((e as any)?.status)){rows.value=[];if((e as any)?.status===401)session.onUnauthorized();}}}
 finally{if(valid()){busy.value=false;if(workDirty&&viewActive){workDirty=false;void loadRows();}}}
}
async function load(force=false){
 if(loadingDirectory)return;
 const lease=captureApiLease();busy.value=true;loadingDirectory=true;failedStep='directory';feedback.begin(projects.value.length>0);
 try{
  const saved=await metaGet<any>(lease.account,viewKey).catch(()=>null);
  savedScroll=saved?.scroll||0;query.value=saved?.query||'';selected.value=saved?.selected||{};filtersOpen.value=Object.values(selected.value).some(Boolean);limit.value=saved?.limit||40;
  let signature='',rowsFlight:Promise<void>|undefined;
  const apply=(list:any[])=>{
   if(!alive||!lease.valid())return;
   projects.value=myProjects(list,lease.account);
   const requested=String(route.query.project||project.value||saved?.project||'');
   project.value=projects.value.find(p=>p.project_id===requested)?.project_id||projects.value.find(p=>p.project_id==='ad44cc0e-159e-4e0f-a5ca-73d3920240d9')?.project_id||projects.value[0]?.project_id||'';
   viewReady=true;
   // Cached project metadata must open its cached work immediately; the
   // background directory/qualification refresh is not a rendering gate.
   const next=JSON.stringify(chosen.value||null);
   if(next!==signature){signature=next;rowsFlight=chosen.value?loadRows():undefined;if(!chosen.value){epoch++;rows.value=[];}}
  };
  apply(await readProjects(lease,{force,maxAge:Infinity,onSnapshot:apply}));if(!alive||!lease.valid())return;
  await rowsFlight;if(filtersOpen.value)void loadFacets();await nextTick();if(viewActive&&lease.valid()){const host=scrollHost();if(host)host.scrollTop=savedScroll;}
 }catch(e){if(alive&&lease.valid()){failedStep='directory';feedback.failed(e,'项目暂未更新，请重试');if(isRetryableFailure(e)&&viewActive){retryWaiting.value=true;recovery.failed();}if([401,403].includes((e as any)?.status)){epoch++;projects.value=[];rows.value=[];if((e as any)?.status===401)session.onUnauthorized();}}}finally{if(alive&&lease.valid()){busy.value=false;loadingDirectory=false;restoringView=false;}}
}
async function retry(){if(busy.value||!recovery.ready())return;if(failedStep==='directory'||!chosen.value)await load(true);else await loadRows();}
function changeProject(){rowAbort?.abort();clearTimeout(queryTimer);facetRows.value=[];facetMore.value=false;hasMore.value=false;epoch++;busy.value=false;recovery.cancel();retryWaiting.value=false;feedback.succeeded();savedScroll=0;const host=scrollHost();if(host)host.scrollTop=0;rows.value=[];selected.value={};limit.value=40;void saveView();void loadRows();}
function queryChanged(){if(restoringView||!viewReady)return;rowAbort?.abort();epoch++;busy.value=false;recovery.cancel();retryWaiting.value=false;feedback.succeeded();limit.value=40;clearTimeout(queryTimer);queryTimer=setTimeout(()=>void loadRows(),300);}
function select(key:string,value:string){selected.value={...selected.value,[key]:value};queryChanged();}
async function loadFacets(more=false){if(facetBusy.value||!chosen.value)return;const p=chosen.value,lease=captureApiLease();facetBusy.value=true;try{const v=await readWorkCatalog(lease,p,{more});if(alive&&lease.valid()&&chosen.value?.project_id===p.project_id){facetRows.value=v.rows;facetMore.value=!!v.hasMore;}}catch(e){if([401,403].includes((e as any)?.status))facetRows.value=[];}finally{facetBusy.value=false;}}
function toggleFilters(){filtersOpen.value=!filtersOpen.value;if(filtersOpen.value)void loadFacets();}
async function loadMore(){limit.value+=40;if(ordered.value.length<limit.value&&hasMore.value)await loadRows(true);}

async function open(row:any){await saveView();void router.push({name:'work-detail',params:{id:row.work_item_id},query:{project:row.project_id,returnTo:route.fullPath}});}
async function copy(row:any){const p=projects.value.find(p=>p.project_id===(row.project_id||project.value)),text=referenceCopyText(numberLabel(row.short_no),p?.title);if(!text){ui.toast('项目名称尚未读取，请稍后重试',true);return;}try{await navigator.clipboard.writeText(text);ui.toast('已复制编号和项目名称');}catch{ui.openOverlay('copyFallback',{text});}}
function updated(row:any){const t=Date.parse(row.updated_at||'');return fullDate(t);}
// An overwrite update can terminate the WebView without Vue unmounting it.
// Save view changes as they happen, not only when the user leaves the page.
watch(query,()=>queryChanged());
watch([project,query,selected,limit],()=>{if(viewReady&&alive)void saveView();},{deep:true});
onBeforeRouteLeave(()=>saveView());
const stopWorkWake=onChatWake(event=>{if(event.account!==session.user?.username||!(event.mode==='catchup'||event.kinds.includes('hub_update')))return;workDirty=true;if(viewActive&&!busy.value){workDirty=false;void loadRows();}});
watch(()=>session.businessReady,ready=>{if(ready&&viewActive&&!busy.value){if(!chosen.value)void load();else void loadRows();}});
onMounted(()=>load());onActivated(async()=>{viewActive=true;const requested=String(route.query.project||'');if(requested&&requested!==project.value&&projects.value.some(p=>p.project_id===requested)){project.value=requested;changeProject();}await nextTick();if(viewActive){const host=scrollHost();if(host)host.scrollTop=savedScroll;if(viewReady&&!busy.value&&(workDirty||retryWaiting.value||error.value))void loadRows();}});
onDeactivated(()=>{viewActive=false;filtersOpen.value=false;});onBeforeUnmount(()=>{void saveView();alive=false;rowAbort?.abort();clearTimeout(queryTimer);epoch++;recovery.cancel();stopWorkWake();});
</script>
<template><PullToRefresh ref="root" class="work-board" :refresh="retry" :busy="busy&&!rows.length" :error="error" label="刷新工作">
 <header class="work-toolbar"><div class="work-heading"><button v-if="chatReturn" class="btn ghost work-chat-return" data-page-back @click="pageNavigation.back()"><AppIcon name="back"/>返回聊天</button><h1>工作</h1></div>
  <div class="work-project"><AttributeSelect v-model="project" label="项目" :options="choices" @update:model-value="changeProject"/></div>
  <form class="work-search" @submit.prevent="queryChanged"><AppIcon name="search"/><input v-model="query" aria-label="搜索工作" placeholder="搜索工作或编号" type="search" @input="limit=40"/><button v-if="chosen" type="button" class="work-filter-toggle" :aria-expanded="filtersOpen" @click="toggleFilters">筛选{{selectedCount?' · '+selectedCount:''}}</button></form>
  <div v-if="filtersOpen" class="work-attributes" aria-label="工作属性"><AttributeSelect v-for="f in attributes" :key="f.key" :model-value="selected[f.key]||''" :label="f.label" :options="f.options" @update:model-value="select(f.key,$event)"/><button v-if="facetMore" class="btn small" :disabled="facetBusy" @click="loadFacets(true)">更多筛选值</button></div>
 </header>
 <p v-if="error" class="work-load-status" role="status">{{error}}<button class="btn small" @click="retry" :disabled="busy||retryWaiting">{{retryWaiting?'稍后自动重试':'重试'}}</button></p>
 <p v-if="busy&&!rows.length" class="empty">首次读取工作…</p>
 <div class="work-list"><article v-for="row in ordered.slice(0,limit)" :key="row.work_item_id" class="work-card">
  <button class="work-main" @click="open(row)"><strong>{{row.goal}}</strong><span class="work-meta"><span>{{numberLabel(row.short_no)}}</span><span class="work-state" :class="{done:row.state==='completed'}">{{valueLabel(row.state,'state')}}</span><time v-if="updated(row)" :datetime="row.updated_at" :aria-label="'更新于 ' + updated(row)">{{updated(row)}}</time></span></button>
  <button class="work-copy" aria-label="复制工作编号和项目名称" @click="copy(row)"><AppIcon name="copy"/></button>
 </article></div>
 <button v-if="ordered.length>limit||hasMore" class="btn small" :disabled="busy" @click="loadMore">更多工作</button>
 <p v-if="!busy&&!error&&!ordered.length" class="empty">{{projects.length?'没有匹配的工作':'暂无与你有关的项目'}}</p>
</PullToRefresh></template>
<style scoped>
.work-load-status{display:flex;align-items:center;gap:8px;padding:8px 12px;color:var(--muted);font-size:13px}.work-board{max-width:560px;margin:auto;min-width:0}.work-toolbar{position:sticky;top:0;z-index:2;background:var(--paper);padding:12px 12px 10px;border-radius:10px}.work-heading{display:flex;align-items:center;justify-content:space-between}.work-heading{justify-content:flex-start;gap:12px}.work-chat-return{display:inline-flex;align-items:center;gap:4px;min-height:44px}.work-heading h1{font-size:20px;line-height:1.4}.work-project{display:flex;align-items:center;gap:10px;margin-top:8px}.scope-label{font-size:12px;color:var(--muted);white-space:nowrap}.work-search{display:flex;align-items:center;gap:8px;border:1px solid var(--line);border-radius:10px;background:#fff;min-height:34px;padding:0 10px;margin:10px 0 6px}.work-search>.icon{width:16px;color:var(--muted);flex:none}.work-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;font:inherit;font-size:16px;height:max(var(--search-height),calc(1.55em + 4px))}.work-filter-toggle{flex:none;position:relative;min-height:max(var(--search-height),calc(1.55em + 8px));padding:4px 6px;border:0;background:transparent;color:var(--accent-dark);font-size:14px}.work-filter-toggle::after{content:'';position:absolute;inset:-4px 0}.work-attributes{display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin}.work-list{margin-top:8px;padding:0 12px}.work-card{display:flex;gap:6px;align-items:center;border-bottom:1px solid var(--line-soft)}.work-main{border:0;background:transparent;text-align:left;flex:1;min-width:0;padding:15px 0;color:var(--ink)}.work-main strong{font-size:16px;line-height:1.45;font-weight:550;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.work-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:8px}.work-state{padding:2px 7px;border-radius:5px;background:var(--green-soft);color:var(--green)}.work-state.done{background:#eef0f1;color:var(--muted)}.work-copy{background:transparent;border:0;color:var(--muted);padding:10px;min-height:44px;flex:none}.work-copy>.icon{width:18px}.empty{text-align:center;color:var(--muted);font-size:14px;padding:22px 8px}
</style>
