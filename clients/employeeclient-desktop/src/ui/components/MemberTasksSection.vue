<script setup lang="ts">
import {readMemberBalance} from '@/native/member-points';
import {useSessionStore} from '@/session/store';
import {useReadFeedback} from '@/ui/useReadFeedback';
import {ref,computed,watch,onBeforeUnmount} from 'vue';
import {apiRequest,captureApiLease} from '@/api/client';
import {hubCache} from '@/native/hub-data';
import {taskState,pointsText,taskPointsLabel} from '@/native/personal-tasks';
const props=defineProps<{actor:string}>(),session=useSessionStore();
const points=ref<number|null>(null),rows=ref<any[]>([]),expanded=ref(false),busy=ref(false),pointStatus=ref('读取中…');
let generation=0,pointBusy=false;
const {error,feedback}=useReadFeedback({retry:()=>loadTasks(),ready:()=>session.businessReady});
const {error:pointError,feedback:pointFeedback}=useReadFeedback({retry:()=>loadPoints(),ready:()=>session.businessReady});
const current=computed(()=>rows.value.filter(t=>t.execution_state!=='completed'));
async function loadPoints(){
 if(pointBusy)return;pointBusy=true;const n=generation,actor=props.actor,lease=captureApiLease(),valid=()=>n===generation&&lease.valid();pointFeedback.begin(points.value!==null);
 try{const v=await readMemberBalance(actor,lease);if(!valid())return;if(v.actor_id!==actor)throw Error('成员身份不符');points.value=v.balance_points;pointStatus.value=v.balance_points===null?'暂不可查看':'';pointFeedback.succeeded();}
 catch(e){if(valid()){if([401,403].includes((e as any)?.status))points.value=null;pointFeedback.failed(e,'积分暂未读取');}}finally{if(valid())pointBusy=false;}
}
async function loadTasks(){
 if(busy.value)return;busy.value=true;const n=generation,actor=props.actor,lease=captureApiLease(),valid=()=>n===generation&&lease.valid();feedback.begin(rows.value.length>0);
 try{const nextRows:any[]=[];let cursor:string|null=null;const seen=new Set();do{
  const v=await hubCache.read(lease,'member-board-v4:'+actor+':tasks:'+(cursor||''),()=>apiRequest<any>('GET','/business/v1/members/'+encodeURIComponent(actor)+'/tasks',{query:cursor?{cursor}:{},timeoutMs:45000}));
  if(!valid())return;if(v.actor_id!==actor)throw Error('成员身份不符');nextRows.push(...v.items);cursor=v.next_cursor;if(cursor&&seen.has(cursor))throw Error('任务分页未推进');if(cursor)seen.add(cursor);
 }while(cursor);if(valid()){rows.value=nextRows;feedback.succeeded();}}
 catch(e){if(valid()){if([401,403].includes((e as any)?.status))rows.value=[];feedback.failed(e,'任务暂未读取，请重试');}}finally{if(valid())busy.value=false;}
}
function load(){void loadTasks();void loadPoints();}
watch(()=>props.actor,()=>{generation++;pointBusy=false;busy.value=false;rows.value=[];points.value=null;expanded.value=false;pointStatus.value='读取中…';feedback.succeeded();pointFeedback.succeeded();load();},{immediate:true});
watch(()=>session.businessReady,ready=>{if(ready)load();});
onBeforeUnmount(()=>{generation++;});
</script>
<template><section class="member-tasks"><div class="points"><span>积分余额</span><strong>{{points===null?(pointError||pointStatus):pointsText(points)+' 积分'}}</strong></div><button class="heading" :aria-expanded="expanded" @click="expanded=!expanded">接取的任务 <span>{{current.length||''}} {{expanded?'⌃':'⌄'}}</span></button><div class="collapse" :class="{open:expanded}" :inert="!expanded"><div><p v-if="error" role="status">{{error}} <button class="btn small" :disabled="busy" @click="load">重试</button></p><p v-else-if="!current.length">{{busy?'正在读取…':'暂无接取任务'}}</p><details v-for="t in current" :key="t.id"><summary>{{t.title}}{{taskPointsLabel(t.base_points_cents)}}<small>{{taskState(t.execution_state)}}</small></summary><p>{{t.description||'暂无补充说明'}}</p></details></div></div></section></template>
<style scoped>.points,.heading{display:flex;justify-content:space-between;padding:14px 4px;font-size:14px}.heading{width:100%;border:0;border-bottom:1px solid var(--line);background:none;color:var(--ink)}.points strong{font-size:14px;font-weight:500}.collapse{display:grid;grid-template-rows:0fr;transition:grid-template-rows .2s ease}.collapse.open{grid-template-rows:1fr}.collapse>div{overflow:hidden}details{padding:12px 4px;border-bottom:1px solid var(--line);font-size:14px}summary{cursor:pointer}small{float:right;color:var(--muted)}p{font-size:13px;color:var(--muted);white-space:pre-wrap}</style>
