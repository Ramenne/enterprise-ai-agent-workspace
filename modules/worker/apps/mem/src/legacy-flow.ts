import type {FastifyInstance,FastifyRequest}from'fastify';
import {z}from'zod';
import {bearer,DomainError}from'../../../packages/platform/src/http.js';
import {sourceFromRequest}from'../../../packages/platform/src/source.js';
type Call=(token:string,source:unknown,name:string,action:string,body:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const uuid=z.uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const legacyFixedSchema=z.object({material_id:uuid,version_id:uuid,sha256:hash,size:z.number().int().nonnegative()}).strict();
export const legacyImportSchema=z.object({project_id:uuid,import_scope_id:uuid,source_system:z.string().min(1).max(200),idempotency_key:z.string().min(1).max(200),items:z.array(z.object({category:z.enum(['file_alias','plan_versions','code_versions','artifact_addresses','issue_sources','supplement_sources','activity_sources','personal_archive','group_attachment']),source_id:z.string().min(1).max(256),field_path:z.string().min(1).max(1024),original_address:z.string().max(8192).default(''),reference_kind:z.enum(['fixed','latest','unknown','unfinished']),expected_revision:z.number().int().nonnegative(),legacy_version:z.number().int().nonnegative().optional(),fixed_ref:legacyFixedSchema.optional(),material_id:uuid.optional(),source_record_sha256:hash.optional(),original_content_sha256:hash.optional(),declaration:z.record(z.string(),z.unknown()).default({})}).strict()).min(1).max(100)}).strict();
export const legacyResolveSchema=z.object({project_id:uuid,binding_id:uuid}).strict();
export function registerLegacyFlow(app:FastifyInstance,call:Call):void{
 const parse=<T>(schema:z.ZodType<T>,value:unknown)=>{const p=schema.safeParse(value);if(!p.success)throw new DomainError('invalid_input');return p.data;};
 app.post('/v2/legacy/references/import',async(req:FastifyRequest)=>{
  const body=parse(legacyImportSchema,req.body),verified:Array<z.infer<typeof legacyFixedSchema>>=[];
  // Fixed versions were verified when published. Link registration rechecks
  // current source access and immutable identity without downloading them again.
  // Ordinary requests cannot supply the server-derived verified_fixed_refs.
  const token=bearer(req),source=sourceFromRequest(req);
  for(const item of body.items)if(item.reference_kind==='fixed'){
   const f=item.fixed_ref;if(!f||item.original_content_sha256!==f.sha256||!item.source_record_sha256||!item.legacy_version)throw new DomainError('legacy_fixed_proof_required');
   const selected=await call(token,source,'read_version','mem.read',{project_id:body.project_id,material_id:f.material_id,version_id:f.version_id});
   try{
    const ref=selected['fixed_ref'] as Record<string,unknown>|undefined;
    if(ref?.['material_id']!==f.material_id||ref?.['version_id']!==f.version_id||ref?.['sha256']!==f.sha256||ref?.['size']!==f.size)throw new DomainError('legacy_fixed_integrity_mismatch',409);
    verified.push(f);
   }finally{
    await call(token,source,'gc_read_lease','mem.read',{project_id:body.project_id,material_id:f.material_id,version_id:f.version_id,sha256:f.sha256,read_receipt_id:selected['read_receipt_id'],command:'release'});
   }
  }
  return call(bearer(req),sourceFromRequest(req),'legacy_reference_import','mem.process',{...body,verified_fixed_refs:verified});
 });
 app.post('/v2/legacy/references/resolve',req=>call(bearer(req),sourceFromRequest(req),'legacy_reference_resolve','mem.read',parse(legacyResolveSchema,req.body)));
}
