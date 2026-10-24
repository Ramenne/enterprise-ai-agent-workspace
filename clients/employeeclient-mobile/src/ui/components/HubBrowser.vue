<script setup lang="ts">
import {referenceCopyText} from '@/ui/referenceCopy.mjs';
import {computed,onMounted,onBeforeUnmount,onDeactivated,onActivated,nextTick,watch,ref} from 'vue';
import {useRouter,useRoute,onBeforeRouteLeave} from 'vue-router';
import {useSessionStore} from '@/session/store';
import {useUiStore} from '@/store/ui';
import {metaGet,metaSet} from '@/session/db';
import {captureApiLease} from '@/api/client';
import {authorizedProjects,projectPickerOptions,numberLabel,fileName,projectScopeValue} from '@/native/discovery.mjs';
import {attributeSelectionCatalog,projectScopeOptions} from '@/native/attribute-query.mjs';
import {readProjects,readCatalog} from '@/native/hub-data';
import {useReadFeedback} from '@/ui/useReadFeedback';
import AttributeSelect from './AttributeSelect.vue';
const root=ref<HTMLElement|null>(null);
const props=defineProps<{mode?:'work'|'search'|'files';selectable?:boolean;onlyProject?:string;selectedWorkId?:string}>();
const emit=defineEmits<{select:[work:any,project:any];ready:[project:any]}>();
const session=useSessionStore(),ui=useUiStore(),router=useRouter(),route=useRoute();
const lease=captureApiLease();
const projects=ref<any[]>([]),project=ref(''),visibility=ref(''),query=ref(''),submittedQuery=ref('');
const catalogRows=ref<any[]>([]),searchRows=ref<any[]|null>(null),selected=ref<Record<string,string>>({});
const {error,feedback}=useReadFeedback({retry:()=>retry(),ready:()=>session.businessReady});
const moreByProject=ref<Record<string,boolean>>({}),facetRows=ref<any[]>([]),facetMore=ref(false),facetBusy=ref(false);
const hasMore=computed(()=>Object.values(moreByProject.value).some(Boolean));
const busy=ref(false),searchBusy=ref(false),complete=ref(false),truncated=ref(false),windowSize=ref(50);
let viewActive=true,retainedScroll:{scroll:number;attributeScroll:number}|null=null;
let alive=true,viewReady=false,generation=0,queryGeneration=0,scopeAbort:AbortController|undefined,queryAbort:AbortController|undefined;
let retrySource:'projects'|'catalog'='projects';
const projectChoices=computed(()=>projects.value.filter(p=>!visibility.value||projectScopeValue(p)===visibility.value));
const targetProjects=computed(()=>projectChoices.value.filter(p=>!project.value||p.project_id===project.value));
const scopeOptions=computed(()=>projectScopeOptions(projects.value));
const projectOptions=computed(()=>projectPickerOptions(projectChoices.value));
const filtersOpen=ref(false);
const selectedCount=computed(()=>Object.values(selected.value).filter(Boolean).length);
const attributes=computed(()=>attributeSelectionCatalog(facetRows.value.length?facetRows.value:catalogRows.value,selected.value));
const matched=computed(()=>catalogRows.value);
const visible=computed(()=>matched.value.slice(0,windowSize.value));

const viewKey='hub-view:'+JSON.stringify([props.mode||'search',props.onlyProject||'',!!props.selectable]);
function scrollHost(){let node=root.value?.parentElement;while(node){if(/auto|scroll/.test(getComputedStyle(node).overflowY))return node;node=node.parentElement;}return document.scrollingElement;}
function viewState(){return {project:project.value,visibility:visibility.value,query:query.value,submitted:submittedQuery.value,selected:selected.value,window:windowSize.value,scroll:scrollHost()?.scrollTop||0,attributeScroll:root.value?.querySelector('.hub-attribute-bar')?.scrollLeft||0};}
async function saveView(){if(!viewActive||!lease.valid())return;const state=viewState();retainedScroll={scroll:state.scroll,attributeScroll:state.attributeScroll};await metaSet(lease.account,viewKey,JSON.parse(JSON.stringify(state)),lease.valid).catch(()=>{});}
function clearQueryFlight(){queryGeneration++;queryAbort?.abort();searchBusy.value=false;searchRows.value=null;windowSize.value=50;}
async function loadScope(force=false,more=false){
 const n=++generation;scopeAbort?.abort();scopeAbort=new AbortController();const signal=scopeAbort.signal;
 if(!more)clearQueryFlight();busy.value=true;feedback.begin(catalogRows.value.length>0);complete.value=false;truncated.value=false;
 const targets=[...targetProjects.value],valid=()=>alive&&n===generation&&lease.valid()&&!signal.aborted;
 try{
  const loaded=new Map<string,any[]>(targets.map(p=>[p.project_id,catalogRows.value.filter(r=>r.project_id===p.project_id)]));
  const apply=()=>{if(valid())catalogRows.value=targets.flatMap(p=>loaded.get(p.project_id)||[]);};
  for(const p of targets){if(more&&!moreByProject.value[p.project_id])continue;const page=await readCatalog(lease,p,props.mode||'search',{force,more,signal,query:submittedQuery.value,selected:selected.value,onSnapshot:(snapshot:any)=>{loaded.set(p.project_id,snapshot.rows);moreByProject.value={...moreByProject.value,[p.project_id]:!!snapshot.hasMore};apply();}});if(!valid())return;loaded.set(p.project_id,page.rows);apply();}
  if(!valid())return;complete.value=true;feedback.succeeded();

 }catch(e){if(valid()){retrySource='catalog';feedback.failed(e,'内容暂未更新，请重试');if([401,403].includes((e as any)?.status)){catalogRows.value=[];searchRows.value=null;if((e as any)?.status===401)session.onUnauthorized();}}}
 finally{if(valid())busy.value=false;}
}
async function loadProjects(force=false){busy.value=true;feedback.begin(projects.value.length>0);try{
 const cached=await metaGet<any>(lease.account,viewKey).catch(()=>null);
 let started=false,signature='',scopeFlight:Promise<void>|undefined;
 const applyDirectory=(list:any[])=>{
  if(!alive||!lease.valid())return;
  const next=authorizedProjects(list,session.user?.username).filter((p:any)=>!props.onlyProject||p.project_id===props.onlyProject);
  const changed=JSON.stringify(next)!==signature;signature=JSON.stringify(next);projects.value=next;
  if(!started){
   visibility.value=scopeOptions.value.some(o=>o.value===cached?.visibility)?cached.visibility:'';
   const requested=props.onlyProject||String(route.query.project||cached?.project||'');
   project.value=projectChoices.value.find(p=>p.project_id===requested)?.project_id||(cached?.project===''?'':projectChoices.value.find(p=>p.project_id==='ad44cc0e-159e-4e0f-a5ca-73d3920240d9')?.project_id||projectChoices.value[0]?.project_id||'');
   query.value=typeof cached?.query==='string'?cached.query:'';submittedQuery.value=typeof cached?.submitted==='string'?cached.submitted:'';
   selected.value=cached?.selected&&typeof cached.selected==='object'?cached.selected:{};filtersOpen.value=Object.values(selected.value).some(Boolean);
   started=true;
   viewReady=true;
  }else if(project.value&&!projectChoices.value.some(p=>p.project_id===project.value)){project.value='';catalogRows.value=[];}
  emit('ready',projects.value.find(p=>p.project_id===project.value)||null);
  if(changed)scopeFlight=loadScope(force);
 };
 applyDirectory(await readProjects(lease,{force,onSnapshot:applyDirectory}));
 await scopeFlight;if(filtersOpen.value)void loadFacets();
 if(alive&&lease.valid()){windowSize.value=Number.isSafeInteger(cached?.window)&&cached.window>=50?cached.window:50;await nextTick();if(alive&&lease.valid()){retainedScroll={scroll:cached?.scroll||0,attributeScroll:cached?.attributeScroll||0};const host=scrollHost();if(host)host.scrollTop=retainedScroll.scroll;const bar=root.value?.querySelector('.hub-attribute-bar');if(bar)bar.scrollLeft=cached?.attributeScroll||0;}}
 }catch(e){if(alive&&lease.valid()){retrySource='projects';feedback.failed(e,'项目暂未更新，请重试');if([401,403].includes((e as any)?.status)){generation++;scopeAbort?.abort();projects.value=[];catalogRows.value=[];searchRows.value=null;if((e as any)?.status===401)session.onUnauthorized();}}}finally{if(alive&&lease.valid())busy.value=false;}}

function scopeChanged(){feedback.succeeded();facetRows.value=[];moreByProject.value={};catalogRows.value=[];if(project.value&&!projectChoices.value.some(p=>p.project_id===project.value))project.value='';void loadScope();}
async function retry(){if(busy.value)return;if(retrySource==='projects')await loadProjects(true);else await loadScope(true);}
function selectAttribute(key:string,value:string){selected.value={...selected.value,[key]:value};windowSize.value=50;void loadScope();}
async function search(text=query.value.trim()){submittedQuery.value=text;await loadScope();}
async function loadMore(){windowSize.value+=50;if(matched.value.length<windowSize.value&&hasMore.value)await loadScope(false,true);}
async function loadFacets(more=false){if(facetBusy.value)return;facetBusy.value=true;const signature=JSON.stringify(targetProjects.value.map(p=>p.project_id));try{const rows:any[]=[];let remaining=false;for(const p of targetProjects.value){const result=await readCatalog(lease,p,props.mode||'search',{more});rows.push(...result.rows);remaining ||= !!result.hasMore;}if(alive&&lease.valid()&&signature===JSON.stringify(targetProjects.value.map(p=>p.project_id))){facetRows.value=rows;facetMore.value=remaining;}}catch(e){if([401,403].includes((e as any)?.status))facetRows.value=[];}finally{facetBusy.value=false;}}
function toggleFilters(){filtersOpen.value=!filtersOpen.value;if(filtersOpen.value)void loadFacets();}

async function open(row:any){if(props.selectable){const p=projects.value.find(p=>p.project_id===row.project_id);if(p)emit('select',row,p);return;}await saveView();if(!alive||!lease.valid())return;const returnTo=route.fullPath;ui.closeOverlay();void router.push({name:row.type==='work'?'work-detail':'material-detail',params:{id:row.work_item_id||row.material_id},query:{project:row.project_id,returnTo,...(props.mode==='search'&&route.name!=='search'?{returnSearch:'1'}:{})}});}
async function copy(row:any){const label=row.type==='work'?numberLabel(row.short_no):row.display_no,p=projects.value.find(p=>p.project_id===row.project_id),text=referenceCopyText(label,p?.title);if(!text){ui.toast('项目名称尚未读取，请稍后重试',true);return;}try{await navigator.clipboard.writeText(text);ui.toast('已复制编号和项目名称');}catch{ui.openOverlay('copyFallback',{text});}}
watch(()=>route.query.project,p=>{if(route.name!==(props.mode==='files'?'files':'work')||props.mode==='search'||props.onlyProject)return;const requested=String(p||'');if(requested&&requested!==project.value&&projects.value.some(p=>p.project_id===requested)){project.value=requested;void loadScope();}});
watch([project,visibility,query,submittedQuery,selected,windowSize],()=>{if(viewReady&&alive)void saveView();},{deep:true});
onBeforeRouteLeave(()=>saveView());
onDeactivated(()=>{viewActive=false;});
onActivated(()=>{viewActive=true;if(viewReady&&retainedScroll)void nextTick(()=>{if(!viewActive||!retainedScroll)return;const host=scrollHost();if(host)host.scrollTop=retainedScroll.scroll;const bar=root.value?.querySelector('.hub-attribute-bar');if(bar)bar.scrollLeft=retainedScroll.attributeScroll;});});
watch(()=>session.businessReady,ready=>{if(ready&&alive&&viewActive&&!busy.value&&(!catalogRows.value.length||error.value))void loadProjects();});
onMounted(loadProjects);onBeforeUnmount(()=>{void saveView();alive=false;generation++;queryGeneration++;scopeAbort?.abort();queryAbort?.abort();});
</script>
<template><section ref="root" class="hub-browser">
 <h1 v-if="(!selectable&&mode!=='search')||route.name==='search'">{{mode==='search'?'查找':mode==='work'?'工作':'项目资料'}}</h1>
 <form class="hub-search compact-search" @submit.prevent="search()"><input v-model="query" class="input" aria-label="关键词或编号" placeholder="关键词或编号" maxlength="200"><button class="btn soft" :disabled="!targetProjects.length">搜索</button><button v-if="targetProjects.length" type="button" class="btn ghost" :aria-expanded="filtersOpen" @click="toggleFilters">筛选{{selectedCount?' · '+selectedCount:''}}</button></form>
 <div v-if="!onlyProject" class="hub-scope-bar" aria-label="查询范围">
  <AttributeSelect v-if="!onlyProject" v-model="visibility" label="范围" :options="scopeOptions" @update:model-value="scopeChanged"/>
  <AttributeSelect v-if="!onlyProject" v-model="project" label="项目" :options="projectOptions" @update:model-value="scopeChanged"/>
 </div>
 <div v-if="filtersOpen" class="hub-attribute-bar" aria-label="查询属性">
  <AttributeSelect v-for="field in attributes" :key="field.key" :model-value="selected[field.key]||''" :label="field.label" :options="field.options" @update:model-value="selectAttribute(field.key,$event)"/><button v-if="facetMore" class="btn small" :disabled="facetBusy" @click="loadFacets(true)">更多筛选值</button>
 </div>
 <p v-if="error" role="alert" class="error-text">{{error}}<button class="btn small" :disabled="busy" @click="retry">重试</button></p>
 <p v-if="(busy||searchBusy)&&!catalogRows.length" role="status" class="hub-status">{{busy?'正在读取属性…':'正在搜索…'}}</p>
 <div class="hub-results"><article v-for="row in visible" :key="row.type+':'+(row.work_item_id||row.material_id)" class="hub-row">
  <button class="hub-open" :aria-pressed="selectable?row.work_item_id===selectedWorkId:undefined" @click="open(row)"><strong>{{row.type==='work'?row.goal:fileName(row)}}</strong><span>{{row.type==='work'?numberLabel(row.short_no):row.display_no||'资料'}}<template v-if="selectable&&row.work_item_id===selectedWorkId"> · 已选择</template><template v-if="!project"> · {{projects.find(p=>p.project_id===row.project_id)?.title}}</template></span></button>
  <button v-if="!selectable&&(row.type==='work'?numberLabel(row.short_no):row.display_no)" class="hub-copy" aria-label="复制编号和项目名称" @click="copy(row)">复制</button>
 </article></div>
 <button v-if="matched.length>windowSize||hasMore" class="btn small" :disabled="busy" @click="loadMore">显示更多</button>
 <p v-if="!busy&&!searchBusy&&!visible.length&&!error" class="hub-empty">{{!projects.length?'当前账号没有可访问项目':complete?'没有匹配内容':'内容尚未读取完整'}}</p>
 <p v-if="!complete&&!busy&&!searchBusy&&catalogRows.length" class="hub-status">显示已保存的内容，尚未完成更新。</p>
</section></template>
<style scoped>
.hub-browser{--hub-surface:var(--bg);width:100%;max-width:560px;margin:auto;min-width:0}.hub-browser h1{font-size:20px;line-height:1.4;margin:0 0 12px}:global(.modal-body .hub-browser){--hub-surface:var(--paper)}.hub-scope-bar,.hub-attribute-bar{display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;padding:0 20px 0 0;mask-image:linear-gradient(to right,#000 calc(100% - 14px),transparent);scrollbar-width:thin}.hub-search{position:sticky;top:0;z-index:2;background:var(--hub-surface);box-shadow:none;display:flex;align-items:center;gap:8px;min-height:44px;margin:4px 0 8px}.hub-search input{flex:1;min-width:0;font-size:16px;margin:0;height:max(var(--search-height),calc(1.55em + 10px));min-height:var(--search-height);padding:4px 10px;border-color:var(--line)}.hub-search .btn{flex:none;height:max(var(--search-height),calc(1.55em + 10px));min-height:var(--search-height);padding:4px 12px;font-size:14px;position:relative}.hub-search .btn.ghost{padding:4px 6px}.hub-search .btn::after{content:'';position:absolute;inset:-4px 0}.hub-status{font-size:13px;color:var(--muted);line-height:1.5;margin:8px 0}.hub-row{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--line-soft);padding:4px 0}.hub-open{border:0;background:transparent;text-align:left;flex:1;min-width:0;padding:12px 0;color:var(--ink)}.hub-open strong{font-size:16px;line-height:1.5;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.hub-open span{display:block;font-size:13px;color:var(--muted);margin-top:6px;overflow-wrap:anywhere}.hub-open p{font-size:14px;color:var(--muted);line-height:1.5;margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.hub-copy{border:0;background:transparent;color:var(--accent);font-size:14px;min-height:44px;padding:8px;flex:none}.hub-empty{padding:24px 12px;text-align:center;font-size:14px;color:var(--muted)}
</style>
