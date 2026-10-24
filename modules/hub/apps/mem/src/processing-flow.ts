import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const uuid=z.uuid(),scope={project_id:uuid},fixed=z.object({material_id:uuid,version_id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const recipe=z.object({name:z.string().min(1).optional(),version:z.string().min(1).optional(),parameters:z.record(z.string(),z.unknown()).optional(),provider:z.string().min(1).optional(),model:z.string().min(1).optional()}).strict();
const coverage=z.enum(['raw_export','user_attachment','agent_summary','partial','unknown']);
const key=z.string().min(1).max(200),semantic=z.string().min(1).max(200),declaration=z.record(z.string(),z.unknown());
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new DomainError('invalid_input');return result.data;}
function mutationKey(request:FastifyRequest,supplied:string|undefined):string {
 const invocation=request.headers['x-hub-invocation-id'];return supplied??(typeof invocation==='string'&&invocation.length>0&&invocation.length<=200?invocation:randomUUID());
}
export function registerProcessingFlow(app:FastifyInstance,call:Call):void {
 const invoke=(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>call(bearer(request),sourceFromRequest(request),name,action,body);
 app.post('/v2/processing-runs',async request=>{
  const body=parse(z.object({...scope,idempotency_key:key.optional(),inputs:z.array(fixed).max(100).default([]),output_kind:z.enum(['transcript','experience','skill','context','summary','other']).default('other'),semantic_kind:semantic.optional(),recipe:recipe.default({}),coverage:coverage.default('unknown'),declaration:declaration.default({}),reuse:z.boolean().default(false)}).strict(),request.body);
  return invoke(request,'begin_processing','mem.process',{...body,idempotency_key:mutationKey(request,body.idempotency_key)});
 });
 app.post('/v2/processing-runs/query',async request=>{
  const body=parse(z.object({...scope,run_id:uuid}).strict(),request.body);
  return invoke(request,'processing_run','mem.read',{project_id:body.project_id,processing_run_id:body.run_id});
 });
 app.post('/v2/processing-runs/resume',async request=>{
  const body=parse(z.object({...scope,run_id:uuid,idempotency_key:key.optional(),inputs:z.array(fixed).max(100).optional(),recipe:recipe.optional(),semantic_kind:semantic.optional(),coverage:coverage.optional(),declaration:declaration.optional(),expected_revision:z.number().int().positive().optional(),reclaim:z.boolean().default(false)}).strict(),request.body);
  const {run_id,...changes}=body;
  return invoke(request,'resume_processing','mem.process',{...changes,processing_run_id:run_id,idempotency_key:mutationKey(request,body.idempotency_key)});
 });
 app.post('/v2/processing-runs/cancel',async request=>{
  const body=parse(z.object({...scope,run_id:uuid,idempotency_key:key.optional(),reason:z.string().max(2000).optional()}).strict(),request.body);
  const {run_id,...changes}=body;
  return invoke(request,'cancel_processing','mem.process',{...changes,processing_run_id:run_id,idempotency_key:mutationKey(request,body.idempotency_key)});
 });
}
