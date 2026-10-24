import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
import {legacyFixedSchema,legacyImportSchema,legacyResolveSchema} from './legacy-contracts.mjs';
export {legacyFixedSchema,legacyImportSchema,legacyResolveSchema} from './legacy-contracts.mjs';
export function registerLegacyFlow(app, call) {
    const parse = (schema, value) => { const p = schema.safeParse(value); if (!p.success)
        throw new DomainError('invalid_input'); return p.data; };
    app.post('/v2/legacy/references/import', async (req) => {
        const body = parse(legacyImportSchema, req.body), verified = [];
        // Use the verified published fixed version with current source authority.
        const token=bearer(req),source=sourceFromRequest(req);
        for(const item of body.items)if(item.reference_kind==='fixed'){
          const f=item.fixed_ref;
          if(!f||item.original_content_sha256!==f.sha256||!item.source_record_sha256||!item.legacy_version)throw new DomainError('legacy_fixed_proof_required');
          const selected=await call(token,source,'read_version','mem.read',{project_id:body.project_id,material_id:f.material_id,version_id:f.version_id});
          try{
            const ref=selected.fixed_ref;
            if(ref?.material_id!==f.material_id||ref?.version_id!==f.version_id||ref?.sha256!==f.sha256||ref?.size!==f.size)throw new DomainError('legacy_fixed_integrity_mismatch',409);
            verified.push(f);
          }finally{
            await call(token,source,'gc_read_lease','mem.read',{project_id:body.project_id,material_id:f.material_id,version_id:f.version_id,sha256:f.sha256,read_receipt_id:selected.read_receipt_id,command:'release'});
          }
        }
        return call(bearer(req), sourceFromRequest(req), 'legacy_reference_import', 'mem.process', { ...body, verified_fixed_refs: verified });
    });
    app.post('/v2/legacy/references/resolve', req => call(bearer(req), sourceFromRequest(req), 'legacy_reference_resolve', 'mem.read', parse(legacyResolveSchema, req.body)));
}
//# sourceMappingURL=legacy-flow.js.map