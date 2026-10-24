import type {FastifyInstance} from 'fastify';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
import {z} from 'zod';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
export interface GCRelay {url:string;key:string;}
export function registerGC(app:FastifyInstance,call:Call,relay?:GCRelay){
 const endpoint=relay?new URL(relay.url):undefined;
 if(endpoint&&(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.pathname!=='/execute'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||relay!.key.length<32))throw Error('GC_protected_executor_registration_required');
 const scope={project_id:z.uuid()};const plan=z.object({...scope,operation_id:z.uuid().optional(),material_id:z.uuid().optional(),target_version_id:z.uuid().optional(),idempotency_key:z.string().min(1).max(200),judgment:z.record(z.string(),z.unknown()).optional()}).strict().refine(b=>Boolean(b.operation_id)!==Boolean(b.material_id)&&(!b.target_version_id||Boolean(b.material_id)));
 const existing=z.object({...scope,plan_id:z.uuid()}).strict();
 for(const [path,name,action,schema]of [
  ['plan','gc_plan','mem.delete',plan],['scan','gc_scan','mem.delete',existing],
  ['retry','gc_retry','mem.destroy',existing.extend({irreversible_confirmed:z.literal(true)})],
  ['destroy','gc_destroy','mem.destroy',existing.extend({irreversible_confirmed:z.literal(true)})],
  ['status','gc_status','mem.delete',existing],
  ['read-lease','gc_read_lease','mem.read',z.object({...scope,material_id:z.uuid(),version_id:z.uuid(),read_receipt_id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),ttl_seconds:z.number().int().min(5).max(900).optional(),command:z.enum(['renew','release'])}).strict()]
 ]as const)app.post('/v2/materials/gc/'+path,async(request,reply)=>{
  const b=schema.safeParse(request.body);if(!b.success)throw new DomainError('invalid_input');const token=bearer(request),source=sourceFromRequest(request);
  const sends=path==='destroy'||path==='retry';
  if(sends){
   if(!relay||!endpoint)return reply.code(503).send({state:'executor_unavailable',retained_state:'plan_unchanged_not_sealed',authorization:'not_asserted',next_step:'Root_install_scoped_GC_executor'});
   try{const ready=await fetch(new URL('/ready',endpoint),{headers:{'x-hub-gc-key':relay.key},redirect:'error',signal:AbortSignal.timeout(2000)});const metadata=await ready.json() as {state?:string};if(!ready.ok||metadata.state!=='configured')throw Error('unavailable');}
   catch{return reply.code(503).send({state:'executor_unavailable',retained_state:'plan_unchanged_not_sealed',next_step:'Root_check_scoped_GC_runtime_dependencies'});}
  }
  const result=await call(token,source,name,action,b.data);const {execution_token:privateToken,...publicResult}=result;
  if(!sends)return publicResult;
  try{
   const response=await fetch(endpoint!,{method:'POST',headers:{'content-type':'application/json','x-hub-gc-key':relay!.key},redirect:'error',signal:AbortSignal.timeout(5000),body:JSON.stringify({plan_id:result['id'],execution_token:privateToken,locators:result['remaining_locators']??result['locators']??[result['locator']],lease_until:result['lease_until']})});
   if(response.status!==202)throw Error('executor_rejected');const receipt=await response.json() as {state?:string;descriptor_persisted?:boolean};
   return {...publicResult,execution:{state:receipt.state,descriptor_persisted:receipt.descriptor_persisted},next_step:'query_same_gc_plan_until_durable_provider_receipt'};
  }catch{return {...publicResult,execution:{state:'delivery_unknown_query_plan_or_executor_journal',automatic_effect_retry:false},retained_state:'sealed_intent_and_permanent_fence_retained',next_step:'query_same_gc_plan_do_not_create_another_delete'};}
 });
}
