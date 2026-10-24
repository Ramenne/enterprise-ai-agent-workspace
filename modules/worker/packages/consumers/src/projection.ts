import {ConsumerError,type PublicApiTransport} from './transport.js';

export interface Aggregate {domain:string;aggregate_id:string;aggregate_revision:number;state:string;}
export interface ChangeEvent {event_id:string;domain:string;aggregate_id:string;aggregate_revision:number;event_type:string;event_group:string;group_index:number;group_size:number;}
export type ProjectionStatus='uninitialized'|'current'|'offline'|'partial'|'gap_pending'|'scope_lost';
export interface ProjectionCheckpoint {
 contract:'hub-consumer-v1';project_id:string;binding_id:string;cursor:string|null;
 aggregates:Aggregate[];pending:ChangeEvent[];seen_ids:string[];status:ProjectionStatus;checked_at:string|null;
 last_error?:{code:string;status:number;retryable:boolean};
}
export interface ProjectionView {status:ProjectionStatus;items:Aggregate[];pending_groups:number;warnings:string[];checked_at:string|null;error_code?:string;retryable?:boolean;downloaded_bytes_recalled:false;}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function requireUuid(value:unknown):string {if(typeof value!=='string'||!uuid.test(value))throw new ConsumerError('invalid_uuid');return value;}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new ConsumerError('invalid_feed_contract',0,true);return value as Record<string,unknown>;}
function integer(value:unknown,min=0):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)throw new ConsumerError('invalid_feed_revision',0,true);return value;}
function text(value:unknown):string{if(typeof value!=='string'||value.length<1||value.length>200)throw new ConsumerError('invalid_feed_contract',0,true);return value;}
const key=(item:{domain:string;aggregate_id:string})=>item.domain+':'+item.aggregate_id;
function parseSnapshot(value:unknown):{cursor:string;aggregates:Aggregate[]}{
 const data=record(value);
 if(data['coverage']!=='project_material_and_work_revisions'||data['complete']===false||data['state']==='partial'||!Array.isArray(data['aggregates']))
  throw new ConsumerError('snapshot_incomplete',0,true);
 const aggregates=data['aggregates'].map((value:unknown)=>{const item=record(value);return {domain:text(item['domain']),aggregate_id:requireUuid(item['aggregate_id']),aggregate_revision:integer(item['aggregate_revision']),state:text(item['state'])};});
 if(new Set(aggregates.map(key)).size!==aggregates.length)throw new ConsumerError('duplicate_snapshot_aggregate',0,true);
 return {cursor:requireUuid(data['delivery_highwater']),aggregates};
}
function parseEvent(value:unknown):ChangeEvent{
 const item=record(value);const group_size=integer(item['group_size'],1),group_index=integer(item['group_index'],1);
 if(group_index>group_size)throw new ConsumerError('invalid_event_group',0,true);
 return {event_id:requireUuid(item['event_id']),domain:text(item['domain']),aggregate_id:requireUuid(item['aggregate_id']),
  aggregate_revision:integer(item['aggregate_revision'],1),event_type:text(item['event_type']),event_group:requireUuid(item['event_group']),group_index,group_size};
}
/** Events are refresh hints. Only complete current-authorized snapshots replace views. */
export class ProjectConsumer {
 private checkpoint:ProjectionCheckpoint;
 private syncing=false;
 private bindingChecked=false;
 constructor(readonly api:PublicApiTransport,readonly projectId:string,readonly binding:()=>Promise<string>,
   checkpoint?:ProjectionCheckpoint){
  requireUuid(projectId);
  this.checkpoint=checkpoint?structuredClone(checkpoint):{contract:'hub-consumer-v1',project_id:projectId,binding_id:'',cursor:null,aggregates:[],pending:[],seen_ids:[],status:'uninitialized',checked_at:null};
  if(this.checkpoint.contract!=='hub-consumer-v1'||this.checkpoint.project_id!==projectId)throw new ConsumerError('checkpoint_scope_mismatch');
  this.checkpoint.aggregates=this.checkpoint.aggregates.map(value=>{const item=record(value);return {domain:text(item['domain']),aggregate_id:requireUuid(item['aggregate_id']),aggregate_revision:integer(item['aggregate_revision']),state:text(item['state'])};});
  this.checkpoint.pending=this.checkpoint.pending.map(parseEvent);
  if(this.checkpoint.cursor!==null)requireUuid(this.checkpoint.cursor);
  if(checkpoint&&this.checkpoint.status==='current')this.checkpoint.status='offline';
 }
 exportCheckpoint():ProjectionCheckpoint{return structuredClone(this.checkpoint);}
 private cachedView():ProjectionView{
  const hidden=!this.bindingChecked||this.checkpoint.status==='scope_lost';
  return {status:this.bindingChecked?this.checkpoint.status:'uninitialized',items:hidden?[]:structuredClone(this.checkpoint.aggregates),
   pending_groups:hidden?0:new Set(this.checkpoint.pending.map(e=>e.event_group)).size,
   warnings:!this.bindingChecked?['current_credential_channel_unchecked']:hidden?['current_access_lost_managed_view_hidden']:this.checkpoint.status==='current'?[]:['projection_is_previous_authorized_snapshot_not_current_authority'],
   checked_at:hidden?null:this.checkpoint.checked_at,...(this.checkpoint.last_error?{error_code:this.checkpoint.last_error.code,retryable:this.checkpoint.last_error.retryable}:{}),
   downloaded_bytes_recalled:false};
 }
 async view():Promise<ProjectionView>{
  // Rendering is also a credential-channel boundary, not merely polling.
  // Re-reading a rotated/switched provider never exposes the previous channel.
  try{const current=await this.binding();this.bindingChecked=true;
   if(this.checkpoint.binding_id&&current!==this.checkpoint.binding_id)this.checkpoint.status='scope_lost';}
  catch{this.bindingChecked=true;this.checkpoint.status='scope_lost';}
  return this.cachedView();
 }
 async sync(options:{limit?:number;maxPages?:number;signal?:AbortSignal;resync?:boolean}={}):Promise<ProjectionView>{
  if(this.syncing)throw new ConsumerError('consumer_sync_in_progress');
  const limit=options.limit??100,maxPages=options.maxPages??20;integer(limit,1);integer(maxPages,1);
  if(limit>500)throw new ConsumerError('invalid_page_limit');
  this.syncing=true;let bindingId='';let visibilityLocked=this.checkpoint.status==='scope_lost';
  try{
   bindingId=await this.binding();
   this.bindingChecked=true;
   if(this.checkpoint.binding_id&&this.checkpoint.binding_id!==bindingId){
    // Different credential never inherits another member/client's visible cache.
    this.checkpoint.status='scope_lost';this.checkpoint.cursor=null;this.checkpoint.pending=[];
    visibilityLocked=true;
   }
   const staged=structuredClone(this.checkpoint);staged.binding_id=bindingId;
   const requestOptions={expectedBinding:bindingId,...(options.signal?{signal:options.signal}:{})};
   const observed=new Map(staged.pending.map(e=>[e.event_id,e]));
   const seen=new Set(staged.seen_ids);let cursor=options.resync?null:staged.cursor;
   let seeded:ReturnType<typeof parseSnapshot>|undefined;
   if(cursor===null){seeded=parseSnapshot(await this.api.postJson('/v2/changes/snapshot',{project_id:this.projectId},requestOptions));cursor=seeded.cursor;}
   let exhausted=seeded!==undefined,resync=false;const cursors=new Set<string>();
   for(let page=0;!seeded&&page<maxPages;page++){
    if(cursors.has(cursor))throw new ConsumerError('repeated_opaque_cursor',0,true);cursors.add(cursor);
    const data=record(await this.api.postJson('/v2/changes',{project_id:this.projectId,cursor,limit},requestOptions));
    if(data['state']==='resync_required'){resync=true;break;}
    if(data['state']!=='current'||data['coverage']!=='current_authorized_project_metadata_only'||!Array.isArray(data['events']))
     throw new ConsumerError('change_page_incomplete',0,true);
    const events=data['events'].map(parseEvent);if(events.length>limit)throw new ConsumerError('invalid_change_page',0,true);
    for(const event of events){
     const prior=observed.get(event.event_id);
     if(prior&&JSON.stringify(prior)!==JSON.stringify(event))throw new ConsumerError('event_identity_conflict',0,true);
     if(!seen.has(event.event_id))observed.set(event.event_id,event);
    }
    cursor=requireUuid(data['cursor']);if(events.length<limit){exhausted=true;break;}
   }
   if(!exhausted&&!resync)throw new ConsumerError('change_page_budget_partial',0,true);
   // Feed filtering can hide newly restricted material changes. A fresh authorized
   // inventory is the authority for removals even when there were zero events.
   const snapshot=seeded??parseSnapshot(await this.api.postJson('/v2/changes/snapshot',{project_id:this.projectId},requestOptions));
   if(await this.binding()!==bindingId)throw new ConsumerError('credential_changed_during_sync',401);
   const revisions=new Map(snapshot.aggregates.map(item=>[key(item),item.aggregate_revision]));
   const pending:ChangeEvent[]=[];const groups=new Map<string,ChangeEvent[]>();
   for(const event of observed.values()){const list=groups.get(event.event_group)??[];list.push(event);groups.set(event.event_group,list);}
   for(const events of groups.values()){
    const size=events[0]!.group_size;
    if(events.some(e=>e.group_size!==size)||new Set(events.map(e=>e.group_index)).size!==events.length)
     throw new ConsumerError('event_group_conflict',0,true);
    // A frozen snapshot may already contain a committed group's newer revision
    // before the dispatcher delivers all its events; do not apply the old event.
    if(events.every(e=>!revisions.has(key(e))||revisions.get(key(e))!>=e.aggregate_revision)){
     for(const event of events)seen.add(event.event_id);
    }else pending.push(...events);
   }
   this.checkpoint={...staged,cursor:snapshot.cursor,aggregates:snapshot.aggregates,pending,
    seen_ids:[...seen].slice(-10000),status:pending.length?'gap_pending':'current',checked_at:new Date().toISOString()};
   delete this.checkpoint.last_error;
   return this.cachedView();
  }catch(error){
   const e=error instanceof ConsumerError?error:new ConsumerError('consumer_sync_failed',0,true);
   this.checkpoint.status=visibilityLocked||!bindingId||e.status===401||e.status===403?'scope_lost':e.code.includes('partial')||e.code.includes('incomplete')?'partial':'offline';
   this.checkpoint.last_error={code:e.code,status:e.status,retryable:e.retryable};
   // Prior checkpoint cursor/data are retained; no failed half-page clears views.
   return this.cachedView();
  }finally{this.syncing=false;}
 }
}
