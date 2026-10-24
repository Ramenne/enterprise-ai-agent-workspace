/** Add only these entries to current MCP schemas/dispatch. No other schema edits. */
export function storageTierTools(z) {
 const fixed={project_id:z.uuid(),material_id:z.uuid(),version_id:z.uuid()};
 const idempotency_key=z.string().min(1).max(200);
 return [
  {name:'mem.object.archive',path:'/v2/objects/storage-tier/archive',action:'mem.write',schema:z.object({...fixed,idempotency_key,tier:z.enum(['infrequent','archive','deep_archive'])}).strict()},
  {name:'mem.object.restore',path:'/v2/objects/storage-tier/restore',action:'mem.read',schema:z.object({...fixed,idempotency_key,copy_id:z.uuid().optional(),days:z.number().int().min(1).max(365),retrieval:z.enum(['Standard','Bulk','Expedited'])}).strict()},
  {name:'mem.object.storage_status',path:'/v2/objects/storage-tier/status',action:'mem.read',schema:z.object({...fixed,operation_id:z.uuid(),command:z.enum(['archive_copy','restore'])}).strict()}
 ];
}
