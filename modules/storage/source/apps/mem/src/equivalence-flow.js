import { randomUUID } from 'node:crypto';
import {equivalenceSchemas} from './equivalence-contracts.mjs';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success)
    throw new DomainError('invalid_input'); return result.data; }
function mutationKey(request, supplied) { const invocation = request.headers['x-hub-invocation-id']; return supplied ?? (typeof invocation === 'string' && invocation.length > 0 && invocation.length <= 200 ? invocation : randomUUID()); }
export function registerEquivalenceFlow(app, call) {
    const invoke = (request, name, action, body) => call(bearer(request), sourceFromRequest(request), name, action, body);
    app.post('/v2/material-equivalences', async (request, reply) => { const body = parse(equivalenceSchemas.create, request.body); const result = await invoke(request, 'equivalence_create', 'mem.write', { ...body, idempotency_key: mutationKey(request, body.idempotency_key) }); if (result['state'] === 'conflict')
        reply.code(409); return result; });
    app.post('/v2/material-equivalences/query', async (request) => { const body = parse(equivalenceSchemas.query, request.body); return invoke(request, 'equivalence_query', 'mem.read', body); });
    app.post('/v2/material-equivalences/undo', async (request, reply) => { const body = parse(equivalenceSchemas.undo, request.body); const result = await invoke(request, 'equivalence_undo', 'mem.write', { ...body, idempotency_key: mutationKey(request, body.idempotency_key) }); if (result['state'] === 'conflict')
        reply.code(409); return result; });
}
//# sourceMappingURL=equivalence-flow.js.map