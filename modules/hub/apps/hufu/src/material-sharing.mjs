import {createHash,randomUUID}from'node:crypto';
export function registerMaterialSharing(app,{z,bearer,sqlFunction,pool,DomainError}){
 const scope={project_id:z.uuid(),material_id:z.uuid()};
 const schemas={grant:z.object({...scope,recipient_id:z.uuid().optional(),recipient_name:z.string().min(1).max(200).optional(),access:z.enum(['read','edit']).default('read'),expires_at:z.iso.datetime().optional(),until_revoked:z.boolean().optional(),idempotency_key:z.string().min(1).max(200).optional()}).strict(),revoke:z.object({...scope,share_id:z.uuid(),idempotency_key:z.string().min(1).max(200).optional()}).strict(),list:z.object(scope).strict(),received:z.object({}).strict()};
 for(const command of Object.keys(schemas))app.post('/v2/material-shares/'+command,async request=>{const r=schemas[command].safeParse(request.body);if(!r.success)throw new DomainError('invalid_input');const b={...r.data,command};if(command==='grant'||command==='revoke')b.idempotency_key??=randomUUID();if(command==='grant'&&b.expires_at===undefined&&b.until_revoked===undefined)b.until_revoked=true;return sqlFunction(pool,'authz.material_share',[createHash('sha256').update(bearer(request)).digest('hex'),b]);});
}
