import {apiRequest,captureApiLease} from '@/api/client';
import {hubCache} from './hub-data';
export type MemberBalance={actor_id:string;balance_points:number|null;visibility?:string};
export function readMemberBalance(actor:string,lease=captureApiLease(),options:any={}){
 return hubCache.read(lease,'member-balance-v1:'+actor,async()=>{
  const value=await apiRequest<MemberBalance>('GET','/business/v1/members/'+encodeURIComponent(actor)+'/points',{timeoutMs:45000});
  if(value.actor_id!==actor)throw Object.assign(Error('成员身份不符'),{status:403});
  return value;
 },options) as Promise<MemberBalance>;
}
