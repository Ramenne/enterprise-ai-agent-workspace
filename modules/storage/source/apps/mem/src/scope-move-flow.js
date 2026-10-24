import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { decide } from '../../../packages/platform/src/decision.js';
import { canonical, digest } from '../../../packages/platform/src/canonical.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
import { sqlFunction } from '../../../packages/platform/src/db.js';
import {moveScopeSchema as schema} from './effect-contracts.mjs';
export function registerScopeMove(app, pool, config) {
    app.post('/v2/materials/move-scope', async (request) => {
        const parsed = schema.safeParse(request.body);
        if (!parsed.success)
            throw new DomainError('invalid_move_scope');
        const b = parsed.data, token = bearer(request), source = sourceFromRequest(request), d = digest(b), p = canonical(b);
        // Receipt lookup is current original-scope metadata only, not a grant to the new scope/content.
        let status;
        try {
            status = await decide(config, token, 'mem.write', { project_id: b.project_id, material_id: b.material_id }, b, source);
        }
        catch (e) {
            if (!(e instanceof DomainError) || e.status !== 403)
                throw e;
            status = await decide(config, token, 'mem.write', { project_id: b.target_project_id, material_id: b.material_id }, b, source);
        }
        const replay = await sqlFunction(pool, 'mem.move_scope_status', [status.handle, d, p]);
        if (replay)
            return replay;
        const src = await decide(config, token, 'mem.write', { project_id: b.project_id, material_id: b.material_id }, b, source);
        let share = null, target = null;
        if (b.mode !== 'proposal') {
            try {
                share = (await decide(config, token, 'mem.share', { project_id: b.project_id, material_id: b.material_id }, b, source)).handle;
                target = (await decide(config, token, 'mem.write', { project_id: b.target_project_id, ...(b.target_collection_id ? { collection_id: b.target_collection_id } : {}), ...(b.target_area_id ? { area_id: b.target_area_id } : {}) }, b, source)).handle;
            }
            catch (e) {
                if (!(e instanceof DomainError) || ![401, 403].includes(e.status))
                    throw e;
            }
        }
        return sqlFunction(pool, 'mem.move_scope', [src.handle, share, target, d, p]);
    });
}
//# sourceMappingURL=scope-move-flow.js.map