import type {HubApiClient} from './transport.js';
import {ProjectConsumer,type ProjectionCheckpoint,type ProjectionView} from './projection.js';
import {downloadFixed,type FixedReference} from './local-files.js';
import {prepareReplay,replay} from './replay.js';

export interface CheckpointStore {
 load(projectId:string,bindingId:string):Promise<ProjectionCheckpoint|undefined>;
 save(checkpoint:ProjectionCheckpoint):Promise<unknown>;
}
/** Integrable EmployeeClient bridge, not an already-updated mobile application. */
export class EmployeeClientConsumer {
 private constructor(readonly api:HubApiClient,readonly consumer:ProjectConsumer,readonly store?:CheckpointStore){}
 static async open(api:HubApiClient,projectId:string,store?:CheckpointStore){
  const binding=await api.bindingId(),saved=await store?.load(projectId,binding);
  return new EmployeeClientConsumer(api,new ProjectConsumer(api,projectId,()=>api.bindingId(),saved),store);
 }
 view(){return this.consumer.view();}
 async refresh(options:Parameters<ProjectConsumer['sync']>[0]={}):Promise<ProjectionView>{
  const view=await this.consumer.sync(options),checkpoint=this.consumer.exportCheckpoint();
  if(checkpoint.binding_id&&this.store)await this.store.save(checkpoint);return view;
 }
 async readWork(projectId:string,workItemId:string){
  return this.api.postJson('/v2/work-items/read',{project_id:projectId,work_item_id:workItemId});
 }
}
/** New public-API adapter for an existing Mac/web file tool to integrate. */
export class LegacyFileToolConsumer {
 constructor(readonly mem:HubApiClient){}
 readFixed(reference:FixedReference,directory:string,options:Parameters<typeof downloadFixed>[3]={}){
  return downloadFixed(this.mem,reference,directory,options);
 }
 renamePlacement(body:{project_id:string;placement_id:string;expected_revision:number;logical_path:string},logicalKey:string){
  return replay(this.mem,prepareReplay('/v2/placements/patch',body,logicalKey));
 }
 writeText(body:{project_id:string;logical_path:string;text:string;material_id?:string;base_version_id?:string;base_revision?:number},logicalKey:string){
  return replay(this.mem,prepareReplay('/v2/materials/write-text',body,logicalKey));
 }
 resumeText(body:{project_id:string;resume_id:string;base_version_id?:string;base_revision?:number;save_as_new?:boolean;logical_path?:string},logicalKey:string){
  // Frozen API resume schema has no idempotency_key body field. Its durable draft
  // retains the original logical key; keep header/key and exact resume payload.
  return replay(this.mem,prepareReplay('/v2/materials/write-text/resume',body,logicalKey,{bodyKey:false}));
 }
}
