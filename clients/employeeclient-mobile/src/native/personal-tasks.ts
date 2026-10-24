import {apiRequest,captureApiLease} from '@/api/client';
import {readMemberBalance} from './member-points';
import {hubCache} from './hub-data';
export type PersonalTask={id:string;title:string;project_name:string;description:string;direction:string;execution_state:string;personal_state:string;claimed_at:string;terms:{base_points_cents?:number|null;cash_cents?:number|null};project_id:string|null;work_item_id:string|null};
export type TaskPage={actor_id:string;items:PersonalTask[];next_cursor:string|null};
export type Points={actor_id:string;balance_points:number|null};
export function readPersonal<T extends Points|TaskPage>(kind:'points'|'tasks',lease= captureApiLease(),options:any={},cursor?:string){
 if(kind==='points')return readMemberBalance(lease.account,lease,options) as Promise<T>;
 return hubCache.read(lease,'personal-board-v1:'+kind+':'+(cursor||''),async()=>{
  const value=await apiRequest<T>('GET','/business/v1/me/'+kind,{query:cursor?{cursor}:{},timeoutMs:45000});
  if(value.actor_id!==lease.account)throw Object.assign(Error('账号数据不一致'),{status:403});
  return value;
 },options) as Promise<T>;
}
const states:Record<string,string>={waiting:'待接取',claimed:'已接取',in_progress:'进行中',partial:'部分完成',blocked:'受阻',completed:'已完成',not_applicable:'未接取',unknown:'状态待核对'};
export const taskState=(value:string)=>states[value]||'状态待核对';
export const pointsText=(value:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value);

export const taskPointsLabel=(cents:number|null|undefined)=>typeof cents==='number'&&Number.isSafeInteger(cents)&&cents>=0?'（'+pointsText(cents/100)+' 积分）':'（积分待补）';
