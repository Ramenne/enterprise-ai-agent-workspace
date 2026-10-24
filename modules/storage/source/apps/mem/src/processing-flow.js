import {processingStartSchema,processingQuerySchema,processingResumeSchema,processingCancelSchema} from './processing-contracts.mjs';
import { randomUUID } from 'node:crypto';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success)
    throw new DomainError('invalid_input'); return result.data; }
function mutationKey(request, supplied) {
    const invocation = request.headers['x-hub-invocation-id'];
    return supplied ?? (typeof invocation === 'string' && invocation.length > 0 && invocation.length <= 200 ? invocation : randomUUID());
}
export function registerProcessingFlow(app, call) {
    const invoke = (request, name, action, body) => call(bearer(request), sourceFromRequest(request), name, action, body);
    app.post('/v2/processing-runs', async (request) => {
        const body = parse(processingStartSchema, request.body);
        return invoke(request, 'begin_processing', 'mem.process', { ...body, idempotency_key: mutationKey(request, body.idempotency_key) });
    });
    app.post('/v2/processing-runs/query', async (request) => {
        const body = parse(processingQuerySchema, request.body);
        return invoke(request, 'processing_run', 'mem.read', { project_id: body.project_id, processing_run_id: body.run_id });
    });
    app.post('/v2/processing-runs/resume', async (request) => {
        const body = parse(processingResumeSchema, request.body);
        const { run_id, ...changes } = body;
        return invoke(request, 'resume_processing', 'mem.process', { ...changes, processing_run_id: run_id, idempotency_key: mutationKey(request, body.idempotency_key) });
    });
    app.post('/v2/processing-runs/cancel', async (request) => {
        const body = parse(processingCancelSchema, request.body);
        const { run_id, ...changes } = body;
        return invoke(request, 'cancel_processing', 'mem.process', { ...changes, processing_run_id: run_id, idempotency_key: mutationKey(request, body.idempotency_key) });
    });
}
//# sourceMappingURL=processing-flow.js.map