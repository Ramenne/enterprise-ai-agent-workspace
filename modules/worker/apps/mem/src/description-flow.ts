/** Agent-authored descriptions are optional enrichment attached to a fixed original version. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {bearer,DomainError} from '../../../packages/platform/src/http.js';
import {sourceFromRequest} from '../../../packages/platform/src/source.js';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const uuid=z.uuid();
const fixed={project_id:uuid,material_id:uuid,version_id:uuid,sha256:z.string().regex(/^[a-f0-9]{64}$/)};
const recipe=z.object({name:z.string().min(1).max(200),version:z.string().min(1).max(100),parameters:z.record(z.string(),z.unknown()).default({})}).strict();
const space=z.object({provider:z.string().min(1).max(200),model:z.string().min(1).max(200),dimension:z.literal(512),recipe}).strict();
const embedding=z.array(z.number().finite()).length(512);
const key=z.string().min(1).max(200).optional();
export const descriptionReadSchema=z.object({...fixed,description_revision:z.number().int().positive().optional()}).strict();
export const descriptionSaveSchema=z.object({...fixed,text:z.string().max(1500000),expected_revision:z.number().int().nonnegative().default(0),source_declaration:z.record(z.string(),z.unknown()).default({}),state:z.enum(['active','draft','withdrawn']).default('active'),idempotency_key:key,reason:z.unknown().optional(),evidence:z.unknown().optional()}).strict();
export const descriptionIndexSchema=z.object({...fixed,description_revision:z.number().int().positive(),description_sha256:z.string().regex(/^[a-f0-9]{64}$/),embedding,space,idempotency_key:key}).strict();
export const descriptionSearchSchema=z.object({project_id:uuid,embedding,space,top_k:z.number().int().min(1).max(100).default(10),mode:z.enum(['exact','hnsw','ivfflat']).default('exact'),include_historical:z.boolean().default(false),compare_exact:z.boolean().default(false)}).strict();
export const descriptionPendingSchema=z.object({project_id:uuid,cursor:uuid.optional(),limit:z.number().int().min(1).max(100).default(20),include_historical:z.boolean().default(false)}).strict();
export function registerDescriptionFlow(app:FastifyInstance,call:Call){
 const routes:Array<[string,string,string,z.ZodType,boolean]>=[
  ['description-read','description_read','mem.read',descriptionReadSchema,false],
  ['description-save','description_save','mem.write',descriptionSaveSchema,true],
  ['description-vector-index','description_vector_register','mem.process',descriptionIndexSchema,true],
  ['description-vector-search','description_vector_search','mem.read',descriptionSearchSchema,false],
  ['description-pending','description_pending','mem.read',descriptionPendingSchema,false],
 ];
 for(const [path,name,action,schema,mutation]of routes)app.post('/v2/materials/'+path,async request=>{
  const parsed=schema.safeParse(request.body);if(!parsed.success)throw new DomainError('invalid_input');
  const body=parsed.data as Record<string,unknown>;
  if(mutation)body['idempotency_key']??=randomUUID();
  // Current actor/client/source and final CAS are derived by the existing decision+SQL path.
  return call(bearer(request),sourceFromRequest(request),name,action,body);
 });
}
