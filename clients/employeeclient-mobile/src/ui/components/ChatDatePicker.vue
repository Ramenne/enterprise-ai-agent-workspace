<script setup lang="ts">
import { computed, ref, nextTick } from 'vue';
import ModalSheet from './ModalSheet.vue';
const props = defineProps<{ value?: string; minDate?: string; maxDate?: string }>();
const emit = defineEmits<{ confirm: [date: string]; cancel: [] }>();
const now = new Date();
const stamp = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const today = stamp(now.getFullYear(), now.getMonth(), now.getDate());
const minDate = computed(() => props.minDate && /^\d{4}-\d{2}-\d{2}$/.test(props.minDate) ? props.minDate : '2000-01-01');
const maxDate = computed(() => {
  const candidate = props.maxDate && /^\d{4}-\d{2}-\d{2}$/.test(props.maxDate) ? props.maxDate : today;
  return candidate < minDate.value ? minDate.value : candidate > today ? today : candidate;
});
const initial = computed(() => {
  const candidate = props.value && /^\d{4}-\d{2}-\d{2}$/.test(props.value) ? props.value : maxDate.value;
  return candidate < minDate.value ? minDate.value : candidate > maxDate.value ? maxDate.value : candidate;
});
const selected = ref(initial.value), year = ref(Number(initial.value.slice(0, 4))), month = ref(Number(initial.value.slice(5, 7)) - 1);
const years = computed(() => { const start = Number(minDate.value.slice(0, 4)), end = Number(maxDate.value.slice(0, 4)); return Array.from({ length: end - start + 1 }, (_, i) => end - i); });
const minMonth=computed(()=>Number(minDate.value.slice(0,4))*12+Number(minDate.value.slice(5,7))-1);
const maxMonth=computed(()=>Number(maxDate.value.slice(0,4))*12+Number(maxDate.value.slice(5,7))-1);
const startMonth=ref(Math.max(minMonth.value,year.value*12+month.value-1));
const endMonth=ref(Math.min(maxMonth.value,year.value*12+month.value+1));
const monthList=computed(()=>Array.from({length:endMonth.value-startMonth.value+1},(_,i)=>{const key=startMonth.value+i,y=Math.floor(key/12),m=key%12,offset=new Date(y,m,1).getDay();return {key,y,m,days:[...Array(offset).fill(0),...Array.from({length:new Date(y,m+1,0).getDate()},(_,n)=>n+1)]};}));
function inRange(date:string){return date>=minDate.value&&date<=maxDate.value;}
function monthInRange(y:number,m:number){const first=new Date(y,m,1),last=new Date(y,m+1,0);return stamp(last.getFullYear(),last.getMonth(),last.getDate())>=minDate.value&&stamp(first.getFullYear(),first.getMonth(),1)<=maxDate.value;}
function jump(){let key=year.value*12+month.value;key=Math.max(minMonth.value,Math.min(maxMonth.value,key));year.value=Math.floor(key/12);month.value=key%12;startMonth.value=Math.max(minMonth.value,key-1);endMonth.value=Math.min(maxMonth.value,key+1);}
function selectYear(value:number){year.value=value;jump();}
const monthsHost=ref<HTMLElement|null>(null);
async function earlier(){const before=monthsHost.value?.scrollHeight||0;startMonth.value=Math.max(minMonth.value,startMonth.value-3);await nextTick();if(monthsHost.value)monthsHost.value.scrollTop+=monthsHost.value.scrollHeight-before;}
function choose(date:string){if(!inRange(date))return;selected.value=date;emit('confirm',date);}

</script>
<template>
 <ModalSheet title="按日期查找" modal-class="chat-date-modal" back @close="emit('cancel')">
  <div class="calendar-month"><select :value="year" aria-label="年份" @change="selectYear(Number(($event.target as HTMLSelectElement).value))"><option v-for="y in years" :key="y" :value="y">{{y}}年</option></select><select v-model.number="month" aria-label="月份" @change="jump"><option v-for="m in 12" :key="m" :value="m-1" :disabled="!monthInRange(year,m-1)">{{m}}月</option></select></div>
  <div class="calendar-week"><span v-for="d in ['日','一','二','三','四','五','六']" :key="d">{{d}}</span></div>
  <div ref="monthsHost" class="calendar-months" aria-label="日期月份列表">
   <button v-if="startMonth>minMonth" class="calendar-earlier" @click="earlier">更早月份</button>
   <section v-for="block in monthList" :key="block.key" class="calendar-block"><h3>{{block.y}}年{{block.m+1}}月</h3><div class="calendar-grid"><template v-for="(d,i) in block.days" :key="i"><span v-if="!d"/><button v-else :aria-label="stamp(block.y,block.m,d)" :aria-pressed="selected===stamp(block.y,block.m,d)" :class="{today:today===stamp(block.y,block.m,d)}" :disabled="!inRange(stamp(block.y,block.m,d))" @click="choose(stamp(block.y,block.m,d))"><span>{{d}}</span><small v-if="today===stamp(block.y,block.m,d)">今天</small></button></template></div></section>
  </div>
 </ModalSheet>
</template>
<style scoped>
:global(.chat-date-modal){width:100%;max-width:560px;height:min(760px,96dvh);max-height:96dvh!important}:global(.chat-date-modal .modal-body){display:flex;flex-direction:column;min-height:0;padding:0!important;overflow:hidden}:global(.chat-date-modal .modal-header){background:#ededed;padding:8px 12px;min-height:52px}:global(.chat-date-modal .modal-header .icon-btn){order:-1}:global(.chat-date-modal .modal-title){flex:1;text-align:center;margin-right:44px}:global(.chat-date-modal .modal-title h2){font-size:18px;font-weight:500}
.calendar-month{display:flex;flex:none;align-items:center;padding:6px 14px}.calendar-month select{border:0;background:transparent;color:var(--muted);min-height:40px;font-size:15px;padding:4px}.calendar-week,.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}.calendar-week{flex:none;background:#f7f7f7;color:#939393;font-size:13px;padding:9px 12px;text-align:center}.calendar-months{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;touch-action:pan-y;padding:0 12px max(12px,env(safe-area-inset-bottom))}.calendar-block{margin:16px 0 26px}.calendar-block h3{font-size:14px;font-weight:400;color:#aaa;padding:10px 4px;border-bottom:1px solid var(--line-soft);margin-bottom:10px}.calendar-grid{row-gap:6px}.calendar-grid button{display:flex;flex-direction:column;align-items:center;justify-content:center;border:0;background:transparent;min-height:48px;font-size:18px;color:var(--ink);padding:4px 0}.calendar-grid button>span{display:grid;place-items:center;width:34px;height:34px;border-radius:50%}.calendar-grid .today>span,.calendar-grid button[aria-pressed=true]>span{background:var(--green);color:#fff}.calendar-grid button:disabled{opacity:.3}.calendar-grid small{font-size:10px;color:var(--green);line-height:1.1}.calendar-earlier{display:block;margin:auto;border:0;background:transparent;color:var(--muted);font-size:13px;padding:10px;min-height:40px}@media(max-width:600px){:global(.chat-date-modal){height:100%;max-height:100%!important;border-radius:0!important}}
</style>
