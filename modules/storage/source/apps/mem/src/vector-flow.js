import {legacyVectorRegisterSchema as register,legacyVectorSearchSchema as search} from './vector-contracts.mjs';
import { randomUUID } from 'node:crypto';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
export function registerVectorFlow(app, call, options = {}) {
    app.post('/v2/materials/vector-index', async (request) => { if (options.legacyWritesEnabled !== true)
        throw new DomainError('legacy_fulltext_vector_index_disabled_use_Agent_description', 410); const parsed = register.safeParse(request.body); if (!parsed.success)
        throw new DomainError('invalid_input'); const body = { ...parsed.data, idempotency_key: parsed.data.idempotency_key ?? randomUUID() }; return call(bearer(request), sourceFromRequest(request), 'vector_register', 'mem.process', body); });
    app.post('/v2/materials/vector-search', async (request) => { const parsed = search.safeParse(request.body); if (!parsed.success)
        throw new DomainError('invalid_input'); return call(bearer(request), sourceFromRequest(request), 'vector_search', 'mem.read', parsed.data); });
}
//# sourceMappingURL=vector-flow.js.map