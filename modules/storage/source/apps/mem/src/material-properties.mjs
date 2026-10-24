import{registerMaterialPath}from'./material-path.mjs';
/** Current-authority property and use routes; optional observations never gate originals. */
export function registerMaterialProperties(app,{z,bearer,sourceFromRequest,call,DomainError,pool,sqlFunction}){
 registerMaterialPath(app,{z,bearer,sourceFromRequest,call,DomainError});
 app.post('/v2/materials/usage-candidates',async request=>{const r=z.object({project_id:z.uuid(),window_days:z.number().int().min(1).max(3650).optional(),limit:z.number().int().min(1).max(100).optional()}).strict().safeParse(request.body);if(!r.success)throw new DomainError('invalid_input');return call(bearer(request),sourceFromRequest(request),'material_use_candidates','mem.read',r.data);});
 app.post('/v2/material-enumerations/page-display',async request=>{const r=z.object({project_id:z.uuid(),snapshot_id:z.uuid(),cursor:z.number().int().nonnegative(),limit:z.number().int().min(1).max(500).default(100)}).strict().safeParse(request.body);if(!r.success)throw new DomainError('invalid_input');return call(bearer(request),sourceFromRequest(request),'enumeration_page_display','mem.read',r.data);});
 const scope={project_id:z.uuid(),material_id:z.uuid()};
 app.post('/v2/materials/importance-designate',async request=>{
  const r=z.object({...scope,special:z.boolean(),human_instruction:z.string().min(1).max(4000),reason:z.string().max(2000).optional(),importance_level:z.number().int().min(1).max(3).optional(),expected_revision:z.number().int().nonnegative(),idempotency_key:z.string().min(1).max(200)}).strict().safeParse(request.body);
  if(!r.success)throw new DomainError('invalid_input');
  return call(bearer(request),sourceFromRequest(request),'importance_designate','mem.write',r.data);
 });
 const schemas={attributes:z.object(scope).strict(),usage:z.object({...scope,window_days:z.number().int().min(1).max(3650).optional()}).strict(),use:z.object({...scope,version_id:z.uuid(),event_key:z.string().min(1).max(200),kind:z.enum(['body_read','adopted','reused']),reason:z.string().max(2000).optional(),work_item_id:z.uuid().optional(),source_context:z.record(z.string(),z.unknown()).optional()}).strict()};
 for(const route of ['attributes','usage','use'])app.post('/v2/materials/'+route,async request=>{const r=schemas[route].safeParse(request.body);if(!r.success)throw new DomainError('invalid_input');return call(bearer(request),sourceFromRequest(request),{attributes:'material_attributes',usage:'material_use_read',use:'material_use_record'}[route],'mem.read',r.data);});
}
