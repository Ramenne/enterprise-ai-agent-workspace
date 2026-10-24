import {governanceSchema as schema} from './governance-contracts.mjs';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
export function registerGovernanceFlow(app, call) {
    app.post('/v2/governance/fields', async (request) => { const parsed = schema.safeParse(request.body); if (!parsed.success)
        throw new DomainError('invalid_input'); if (parsed.data.window_start && parsed.data.window_end && Date.parse(parsed.data.window_end) <= Date.parse(parsed.data.window_start))
        throw new DomainError('invalid_usage_window'); return call(bearer(request), sourceFromRequest(request), 'field_governance', 'mem.read', parsed.data); });
}
//# sourceMappingURL=governance-flow.js.map