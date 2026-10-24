import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const recipe=z.object({name:z.string().min(1).default('unknown'),version:z.string().min(1).default('unknown'),parameters:z.record(z.string(),z.unknown()).default({})}).strict();
const space=z.object({provider:z.string().min(1).default('unknown'),model:z.string().min(1).default('unknown'),dimension:z.number().int().min(1).max(16000).optional(),recipe:recipe.default({name:'unknown',version:'unknown',parameters:{}})}).strict();
const vector=z.array(z.number().finite()).min(1).max(16000);
const register=z.object({project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),embedding:vector.optional(),space:space.optional(),segment:z.object({byte_start:z.number().int().nonnegative(),byte_end:z.number().int().nonnegative()}).strict().optional(),coverage:z.enum(['complete','partial','unknown']).default('unknown'),idempotency_key:z.string().min(1).max(200).optional()}).strict();
const search=z.object({project_id:z.uuid(),embedding:vector,space:space.default({provider:'unknown',model:'unknown',recipe:{name:'unknown',version:'unknown',parameters:{}}}),top_k:z.number().int().min(1).max(100).default(10),mode:z.enum(['exact','hnsw','ivfflat']).default('exact'),compare_exact:z.boolean().default(false)}).strict();
export function registerVectorFlow(app:FastifyInstance,call:Call,options:{legacyWritesEnabled?:boolean}={}){
 app.post('/v2/materials/vector-index',async request=>{if(options.legacyWritesEnabled!==true)throw new DomainError('legacy_fulltext_vector_index_disabled_use_Agent_description',410);const parsed=register.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');const body={...parsed.data,idempotency_key:parsed.data.idempotency_key??randomUUID()};return call(bearer(request),sourceFromRequest(request),'vector_register','mem.process',body);});
 app.post('/v2/materials/vector-search',async request=>{const parsed=search.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');return call(bearer(request),sourceFromRequest(request),'vector_search','mem.read',parsed.data);});
}
