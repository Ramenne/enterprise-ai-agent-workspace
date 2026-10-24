import {descriptionReadSchema,descriptionSaveSchema,descriptionIndexSchema,descriptionSearchSchema,descriptionPendingSchema} from './description-contracts.mjs';
export {descriptionReadSchema,descriptionSaveSchema,descriptionIndexSchema,descriptionSearchSchema,descriptionPendingSchema} from './description-contracts.mjs';
import {descriptionPolicy,inspectDescription} from './description-policy.mjs';
import { randomUUID,createHash } from 'node:crypto';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
export function registerDescriptionFlow(app, call, indexDescription) {
    app.get('/v2/materials/description-policy',async()=>descriptionPolicy);
    const routes = [
        ['description-read', 'description_read', 'mem.read', descriptionReadSchema, false],
        ['description-save', 'description_save', 'mem.write', descriptionSaveSchema, true],
        ['description-vector-index', 'description_vector_register', 'mem.process', descriptionIndexSchema, true],
        ['description-vector-search', 'description_vector_search', 'mem.read', descriptionSearchSchema, false],
        ['description-pending', 'description_pending', 'mem.read', descriptionPendingSchema, false],
    ];
    for (const [path, name, action, schema, mutation] of routes)
        app.post('/v2/materials/' + path, async (request) => {
            const parsed = schema.safeParse(request.body);
            if (!parsed.success)
                throw new DomainError('invalid_input');
            const body = parsed.data;
            if (mutation)
                body['idempotency_key'] ??= randomUUID();
            // Current actor/client/source and final CAS are derived by the existing decision+SQL path.
            const token=bearer(request),source=sourceFromRequest(request);
            if(name==='description_save'){
                const inspected=inspectDescription(body);if(!inspected.valid)throw new DomainError(inspected.error_code);
                const saved=await call(token,source,name,action,body);
                let indexing={state:'not_requested_for_inactive_description'};
                if(body.state==='active'&&indexDescription){
                    const fixed_ref={material_id:body.material_id,version_id:body.version_id,sha256:body.sha256};
                    try{const revision=saved.description?.revision??saved.latest_description_revision;const idempotency_key='description-auto-index:'+createHash('sha256').update(JSON.stringify({fixed_ref,revision})).digest('hex');const result=await indexDescription(token,source,{project_id:body.project_id,fixed_ref,idempotency_key},'mem.semantic.index_fixed');indexing={state:result.description_revision&&revision&&result.description_revision!==revision?'newer_description_indexed':result.state,error_code:result.error_code??null,...(result.http_status?{http_status:result.http_status,retryable:result.retryable}:{}),description_revision:result.description_revision??result.receipt?.description_revision??null};}
                    catch(e){const code=e?.code||e?.message;indexing={state:'needs_vector_update',error_code:/^[a-z][a-z0-9_]{0,100}$/.test(code||'')?code:'semantic_dependency_unavailable',http_status:Number.isInteger(e?.status)?e.status:503,retryable:e?.retryable??true,description_saved:true};}
                }
                return {...saved,description_policy_version:descriptionPolicy.version,description_warnings:inspected.warnings,automatic_index:indexing};
            }
            return call(token,source,name,action,body);
        });
}
//# sourceMappingURL=description-flow.js.map