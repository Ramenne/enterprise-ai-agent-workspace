/** Ordinary current-authority exact registry lookup; no credential/source body. */
export function registerLegacyLookup(app,{z,bearer,sourceFromRequest,call,DomainError}){
 const schemas={lookup:z.object({project_id:z.uuid(),source_system:z.string().min(1).max(200),source_id:z.string().min(1).max(256),
  field_path:z.string().min(1).max(1024),category:z.enum(['file_alias','plan_versions','code_versions','artifact_addresses','issue_sources','supplement_sources','activity_sources','personal_archive','group_attachment']).default('file_alias'),actor_namespace:z.boolean().default(true)}).strict(),
  receipt:z.object({project_id:z.uuid(),original_idempotency_key:z.string().min(1).max(200)}).strict()};
 for(const path of ['lookup','receipt'])app.post('/v2/legacy/references/'+path,async req=>{
  const b=schemas[path].safeParse(req.body);if(!b.success)throw new DomainError('invalid_input');
  return call(bearer(req),sourceFromRequest(req),path==='lookup'?'legacy_binding_lookup':'legacy_import_receipt',path==='lookup'?'mem.read':'mem.process',b.data);
 });
}
export function legacyLookupTools(z){
 const base={project_id:z.uuid()};return[
  {name:'mem.legacy.reference_lookup',path:'/v2/legacy/references/lookup',action:'mem.read',schema:z.object({...base,source_system:z.string().min(1).max(200),source_id:z.string().min(1).max(256),field_path:z.string().min(1).max(1024),actor_namespace:z.boolean().default(true)}).strict()},
  {name:'mem.legacy.import_receipt',path:'/v2/legacy/references/receipt',action:'mem.process',schema:z.object({...base,original_idempotency_key:z.string().min(1).max(200)}).strict()}
 ];
}
export function createLookupPorts(mem){return{
 lookupBinding:async({mapping,source_system,source_id,field_path})=>{const r=await mem('/v2/legacy/references/lookup',{project_id:mapping.project_id,source_system,source_id,field_path,actor_namespace:true});return r.binding_id?r:null;},
 queryImport:async({mapping,logicalKey})=>{const r=await mem('/v2/legacy/references/receipt',{project_id:mapping.project_id,original_idempotency_key:logicalKey});return r.state==='imported'?r:null;}
};}
