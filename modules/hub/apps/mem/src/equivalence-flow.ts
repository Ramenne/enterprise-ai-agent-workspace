import type {FastifyInstance,FastifyRequest} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const uuid=z.uuid(),key=z.string().min(1).max(200),scope={project_id:uuid};
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new DomainError('invalid_input');return result.data;}
function mutationKey(request:FastifyRequest,supplied:string|undefined){const invocation=request.headers['x-hub-invocation-id'];return supplied??(typeof invocation==='string'&&invocation.length>0&&invocation.length<=200?invocation:randomUUID());}
export function registerEquivalenceFlow(app:FastifyInstance,call:Call){
 const invoke=(request:FastifyRequest,name:string,action:string,body:Record<string,unknown>)=>call(bearer(request),sourceFromRequest(request),name,action,body);
 app.post('/v2/material-equivalences',async(request,reply)=>{const body=parse(z.object({...scope,material_id:uuid.optional(),canonical_material_id:uuid.optional(),collection_id:uuid.optional(),mode:z.enum(['alias','proposal']).optional(),reason:z.json().optional(),basis:z.json().optional(),claim:z.json().optional(),expected_alias_revision:z.number().int().nonnegative().default(0),idempotency_key:key.optional()}).strict(),request.body);const result=await invoke(request,'equivalence_create','mem.write',{...body,idempotency_key:mutationKey(request,body.idempotency_key)});if(result['state']==='conflict')reply.code(409);return result;});
 app.post('/v2/material-equivalences/query',async request=>{const body=parse(z.object({...scope,material_id:uuid.optional(),equivalence_id:uuid.optional(),collection_id:uuid.optional()}).strict().refine(value=>value.material_id!==undefined||value.equivalence_id!==undefined),request.body);return invoke(request,'equivalence_query','mem.read',body);});
 app.post('/v2/material-equivalences/undo',async(request,reply)=>{const body=parse(z.object({...scope,material_id:uuid,equivalence_id:uuid,idempotency_key:key.optional(),reason:z.json().optional(),basis:z.json().optional()}).strict(),request.body);const result=await invoke(request,'equivalence_undo','mem.write',{...body,idempotency_key:mutationKey(request,body.idempotency_key)});if(result['state']==='conflict')reply.code(409);return result;});
}
