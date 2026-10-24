<script setup lang="ts">
import {computed,ref,watch,onActivated,onBeforeUnmount} from 'vue';
import {useSessionStore} from '@/session/store';
import {captureApiLease} from '@/api/client';
import {readPersonal,taskState,pointsText,taskPointsLabel,type PersonalTask,type TaskPage,type Points} from '@/native/personal-tasks';
import {useReadFeedback} from '@/ui/useReadFeedback';
import AppIcon from './AppIcon.vue';
const session=useSessionStore(),points=ref<number|null>(null),tasks=ref<PersonalTask[]>([]),next=ref<string|null>(null);
const {error:pointError,feedback:pointFeedback}=useReadFeedback({retry:()=>loadPoints(),ready:()=>session.businessReady}),{error:taskError,feedback:taskFeedback}=useReadFeedback({retry:()=>loadTasks(),ready:()=>session.businessReady});
const pointBusy=ref(false),taskBusy=ref(false),expanded=ref(false),history=ref(false);
let alive=true,generation=0;
const active=computed(()=>tasks.value.filter(t=>t.execution_state!=='completed'));
const completed=computed(()=>tasks.value.filter(t=>t.execution_state==='completed'));
const visible=computed(()=>history.value?completed.value:active.value);
const stateKey=()=> 'qn.personal-tasks-expanded-v1:'+session.user?.username;
function toggle(){expanded.value=!expanded.value;try{localStorage.setItem(stateKey(),String(expanded.value));}catch{}}
async function loadPoints(force=false){const lease=captureApiLease(),n=generation;if(!lease.account||pointBusy.value)return;pointBusy.value=true;pointFeedback.begin(points.value!==null);
 const apply=(value:Points)=>{if(alive&&n===generation&&lease.valid()){points.value=value.balance_points;pointFeedback.begin(true);}};
 try{apply(await readPersonal<Points>('points',lease,{force,onSnapshot:apply}));if(n===generation&&lease.valid())pointFeedback.succeeded();}catch(e){if(alive&&n===generation&&lease.valid()){pointFeedback.failed(e,'积分暂未更新，请重试');if([401,403].includes((e as any)?.status))points.value=null;}}finally{if(alive&&n===generation&&lease.valid())pointBusy.value=false;}}
async function loadTasks(force=false,more=false){if(taskBusy.value)return;const lease=captureApiLease(),n=generation,cursor=more?next.value:undefined;if(!lease.account||more&&!cursor)return;taskBusy.value=true;taskFeedback.begin(tasks.value.length>0);
 const apply=(value:TaskPage)=>{if(!alive||n!==generation||!lease.valid())return;tasks.value=more?[...new Map([...tasks.value,...value.items].map(t=>[t.id,t])).values()]:value.items;next.value=value.next_cursor;taskFeedback.begin(true);};
 try{const value=await readPersonal<TaskPage>('tasks',lease,{force,onSnapshot:apply},cursor||undefined);if(cursor&&value.next_cursor===cursor)throw Error('任务分页未推进，请重试');apply(value);if(n===generation&&lease.valid())taskFeedback.succeeded();}catch(e){if(alive&&n===generation&&lease.valid()){taskFeedback.failed(e,'任务暂未更新，请重试');if([401,403].includes((e as any)?.status)){tasks.value=[];next.value=null;}}}finally{if(alive&&n===generation&&lease.valid())taskBusy.value=false;}}
watch(()=>session.user?.username,()=>{generation++;pointFeedback.succeeded();taskFeedback.succeeded();points.value=null;tasks.value=[];next.value=null;pointError.value='';taskError.value='';pointBusy.value=false;taskBusy.value=false;history.value=false;expanded.value=false;try{expanded.value=localStorage.getItem(stateKey())==='true';}catch{}void loadPoints();void loadTasks();},{immediate:true});
watch(()=>session.businessReady,ready=>{if(ready){void loadPoints();void loadTasks();}});
onActivated(()=>{void loadPoints();if(!next.value)void loadTasks();});
onBeforeUnmount(()=>{alive=false;});
</script>
<template><section class="personal-tasks">
 <div class="points-row"><span>积分余额</span><strong>{{points===null?(pointBusy?'读取中…':'暂不可用'):pointsText(points)+' 积分'}}</strong></div>
 <p v-if="pointError" class="read-feedback" role="status">{{pointError}} <button class="text-action" :disabled="pointBusy" @click="loadPoints(true)">重试</button></p>
 <button class="tasks-heading" :aria-expanded="expanded" aria-controls="own-tasks" @click="toggle"><AppIcon name="doc"/><span>我的任务</span><small v-if="active.length">{{active.length}}</small><AppIcon name="chevron" :class="{expanded}"/></button>
 <div class="task-collapse" :class="{open:expanded}" :inert="!expanded" :aria-hidden="!expanded"><div id="own-tasks" class="task-list">
  <div class="task-filters"><button :class="{selected:!history}" @click="history=false">当前任务</button><button :class="{selected:history}" @click="history=true">已完成</button><button class="refresh" :disabled="taskBusy" @click="loadTasks(true);loadPoints(true)">刷新</button></div>
  <p v-if="taskError" class="read-feedback" role="status">{{taskError}} <button class="text-action" @click="loadTasks(true)">重试</button></p>
  <p v-if="!visible.length" class="empty">{{taskBusy?'正在读取任务…':taskError?'':'暂无'+(history?'已完成任务':'当前任务')}}</p>
  <details v-for="task in visible" :key="task.id" class="own-task"><summary><span>{{task.title}}{{taskPointsLabel(task.terms.base_points_cents)}}</span><small>{{taskState(task.execution_state)}}</small><AppIcon name="chevron"/></summary><div class="task-detail">
   <p v-if="task.project_name" class="project-name">{{task.project_name}}</p><p v-if="task.description">{{task.description}}</p><p v-if="task.direction">{{task.direction}}</p>
   <p v-if="typeof task.terms.base_points_cents==='number'" class="terms">约定积分 {{pointsText(task.terms.base_points_cents/100)}} 积分</p>
   <RouterLink v-if="task.project_id&&task.work_item_id" :to="{name:'work-detail',params:{id:task.work_item_id},query:{project:task.project_id,returnTo:'/profile'}}">查看关联工作</RouterLink>
  </div></details>
  <button v-if="next" class="more" :disabled="taskBusy" @click="loadTasks(false,true)">{{taskBusy?'正在读取…':'查看更多任务'}}</button>
 </div></div>
</section></template>
<style scoped>
.personal-tasks{margin:0 0 18px;background:var(--paper);border:1px solid var(--line);border-radius:10px;overflow:hidden}.points-row{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;justify-content:space-between;padding:14px 12px;border-bottom:1px solid var(--line);font-size:14px}.points-row>span{flex:none}.points-row strong{max-width:100%;margin-left:auto;overflow-wrap:anywhere;text-align:right;font-size:18px;font-weight:600;color:var(--green)}.tasks-heading{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:12px;border:0;background:transparent;color:var(--ink);font-size:15px;text-align:left}.tasks-heading>span{flex:1}.tasks-heading small{font-size:12px;color:var(--muted)}.icon{width:18px;height:18px;flex:none;color:var(--muted)}.tasks-heading>.icon:last-child{transition:transform .2s}.icon.expanded{transform:rotate(90deg)}.task-collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s ease}.task-collapse.open{grid-template-rows:1fr}.task-list{min-height:0;overflow:clip}.task-filters{display:flex;flex-wrap:wrap;gap:6px 14px;padding:10px 12px;border-top:1px solid var(--line)}.task-filters button,.text-action,.more{border:0;background:transparent;color:var(--muted);font-size:13px;padding:5px 0}.task-filters .selected,.text-action,.more{color:var(--green)}.task-filters .refresh{margin-left:auto}.empty,.error-text{font-size:13px;margin:10px 12px;color:var(--muted)}.own-task{border-top:1px solid var(--line)}.own-task summary{display:flex;align-items:center;gap:8px;list-style:none;padding:12px;font-size:14px;cursor:pointer}.own-task summary::-webkit-details-marker{display:none}.own-task summary>span{flex:1;min-width:0;overflow-wrap:anywhere}.own-task summary>small{flex:none;white-space:nowrap;font-size:12px;color:var(--muted)}.own-task[open] summary>.icon{transform:rotate(90deg)}.own-task summary:active,.tasks-heading:active{background:var(--green-soft)}.task-detail{padding:0 12px 12px;font-size:13px;line-height:1.6;overflow-wrap:anywhere}.task-detail p{margin:0 0 8px;white-space:pre-wrap}.project-name,.terms{color:var(--muted)}.more{display:block;margin:8px auto 12px}@media(prefers-reduced-motion:reduce){.task-collapse,.tasks-heading>.icon:last-child{transition:none}}
</style>

<style scoped>
.read-feedback{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 12px;font-size:12px;line-height:1.6;color:var(--muted);background:none;border:0;padding:0;border-radius:0}
</style>
