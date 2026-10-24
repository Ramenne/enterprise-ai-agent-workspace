import {createHubCache} from './hub-cache.mjs';
import {NativeClient} from './client.mjs';
import {authorizedProjects} from './discovery.mjs';
import {createQueryProjection} from './query-projection.mjs';
import {metaGet,metaSet,metaRemove} from '@/session/db';
import {captureApiLease} from '@/api/client';
import {serviceOrigin} from '@/api/runtime';
export const hubCache=createHubCache({get:metaGet,put:metaSet,remove:metaRemove});
const client=()=>new NativeClient({base:serviceOrigin()});
const queryProjection=createQueryProjection({get:metaGet,put:metaSet,remove:metaRemove,rpc:(name:string,args:any,signal?:AbortSignal)=>client().rpc(name,args,undefined,signal)});
export function readWorkCatalog(lease:any,project:any,options:any={}){return queryProjection.read(lease,project,{...options,mode:'work'});}
export function projectKey(){return 'projects-related-v1';}
export function catalogKey(project:any,mode:string){return 'catalog:'+mode+':'+project.project_id;}
export function detailKey(project:string,id:string,work=true){return 'detail:'+(work?'work':'file')+':'+project+':'+id;}
export function readProjects(lease= captureApiLease(),options:any={}){
 return hubCache.read(lease,projectKey(),async()=>{
  const list=authorizedProjects(await client().projects());
  const teams=list.filter((p:any)=>p.visibility==='team');
  for(let start=0;start<teams.length;start+=4)await Promise.all(teams.slice(start,start+4).map(async(p:any)=>{
   if(p.owner_id===lease.account||p.manager_id===lease.account){p._member_related=true;return;}
   try{
    const state=await hubCache.read(lease,'membership:'+p.project_id,()=>client().rpc('hufu.access.permissions',{project_id:p.project_id}),{force:options.force});
    if(state.actor_id!==lease.account)throw Error('成员项目资格身份不一致');
    p._member_related=(state.qualifications||[]).some((q:any)=>q.project_id===p.project_id&&q.principal_id===lease.account&&q.effective_now===true&&q.actions?.includes('v8.work.read'));
   }catch(e){if([401].includes((e as any)?.status))throw e;if((e as any)?.status!==403)throw e;p._member_related=false;}
  }));
  return list;
 },options);
}

export function readHubDetail(lease:any,project:string,id:string,work=true,options:any={}){
 return hubCache.read(lease,detailKey(project,id,work),()=>client().rpc(work?'v8.work.read':'mem.material.head',{project_id:project,...(work?{work_item_id:id}:{material_id:id})}),options);
}
export function readCatalog(lease:any,project:any,mode='search',options:any={}){return queryProjection.read(lease,project,{...options,mode});}
export async function warmHubDirectory(account:string){
 const lease=captureApiLease();if(lease.account!==account||!lease.valid())return;
 const projects=await readProjects(lease);if(!lease.valid())return;
 const p=projects.find((p:any)=>p.project_id==='ad44cc0e-159e-4e0f-a5ca-73d3920240d9');
 // Warm only the directory. Opening a view owns its bounded data query.
 void p;
}
