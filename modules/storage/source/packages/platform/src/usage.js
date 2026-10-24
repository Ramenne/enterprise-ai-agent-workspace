import { UsageSpool } from './usage-spool.js';
import { createHash, randomUUID } from 'node:crypto';
import { sqlFunction } from './db.js';
import { beginObservedScope, observedHandles } from './observed-scope.js';
/** Input paths record observed API parameter use, never field values or inferred model understanding. */
export function inputPaths(body, method, route) {
    const result = new Map();
    const read = method === 'GET' || /\/(read(?:-chunk)?|query|search|page|history|head|snapshot|materialize|enumerations|manager-candidates|pending-registration|fields)(\/|$)/.test(route) || /^\/v2\/(material-enumerations|offline-exports)(\/|$)/.test(route);
    const visit = (value, path, depth) => {
        if (depth > 8 || result.size >= 190)
            return;
        if (Array.isArray(value)) {
            result.set(path, { path, purpose: read ? 'filter' : 'write' });
            for (const item of value.slice(0, 16))
                visit(item, path + '[]', depth + 1);
            return;
        }
        if (value && typeof value === 'object') {
            const entries = Object.entries(value);
            if (!entries.length)
                result.set(path, { path, purpose: read ? 'filter' : 'write' });
            for (const [key, item] of entries) {
                if (['password', 'token', 'secret', 'access_token', 'refresh_token', 'authorization'].includes(key.toLowerCase()))
                    continue;
                const next = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? path + '.' + key : path + '[' + JSON.stringify(key) + ']';
                visit(item, next, depth + 1);
            }
            return;
        }
        result.set(path, { path, purpose: /\.(sort|sort_by|order_by)$/.test(path) ? 'sort' : read ? 'filter' : 'write' });
    };
    if (body !== undefined)
        visit(body, 'request', 0);
    result.set('response', { path: 'response', purpose: 'return' });
    return [...result.values()].filter(item => item.path.length <= 240 && !/[\u0000-\u001f]/.test(item.path));
}
function logicalId(request, route) {
    const body = request.body;
    const provided = typeof body?.['idempotency_key'] === 'string' ? body['idempotency_key'] : request.headers['idempotency-key'];
    if (typeof provided !== 'string')
        return /^[0-9a-f-]{36}$/i.test(request.id) ? request.id : randomUUID();
    // Authenticated channel credential partitions retry keys; only the derived UUID is persisted.
    const hex = createHash('sha256').update(String(request.headers.authorization ?? request.headers.cookie ?? '') + '\0' + route + '\0' + provided).digest('hex').slice(0, 32);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
const statuses = new WeakMap();
const closers = new WeakMap();
/** Flush once after HTTP drain, while the caller-owned DB pool is still open. */
export async function closeUsage(app) { await closers.get(app)?.(); }
export function usageStatus(app) { return statuses.get(app)?.() ?? { state: 'unknown' }; }
export function installUsage(app, pool, options = {}) {
    const spool = options.pool && options.directory ? new UsageSpool(options.pool, options.directory) : undefined;
    statuses.set(app, () => spool?.status() ?? { state: 'shared_pool_legacy', coverage: 'direct_usage_observation' });
    if (spool) {
        let closing;
        const closeOnce = () => closing ??= spool.close();
        closers.set(app, closeOnce);
        app.addHook('onReady', () => spool.start());
        app.addHook('onClose', closeOnce);
    }
    const started = new WeakMap();
    app.addHook('onRequest', (request, _reply, done) => { started.set(request, performance.now()); beginObservedScope(request, done); });
    app.addHook('onResponse', async (request, reply) => {
        const route = request.routeOptions.url ?? request.url.split('?')[0] ?? 'unknown';
        if (route === '/health' || route.startsWith('/internal/') || !route.startsWith('/v2/'))
            return;
        const duration = Math.max(0, performance.now() - (started.get(request) ?? performance.now()));
        const traffic = /batch|offline-export/.test(route) ? 'batch' : 'work';
        const observed = request.method === 'GET' ? request.query : request.body;
        const paths = inputPaths(observed, request.method, route);
        try {
            const observation = { request: logicalId(request, route), action: route, schema_version: 'api-params.v2', traffic, success: reply.statusCode < 400, coverage: 'api_parameter_paths_observed;consumer_field_use_unknown', result_count: null, duration_ms: duration, paths, handles: observedHandles(request) };
            if(options.scopeHandles)observation.handles=await options.scopeHandles(request,observation);
            if (spool)
                await spool.enqueue(observation);
            else
                await sqlFunction(pool, 'evidence.record_usage_scoped', [observation.request, route, observation.schema_version, traffic, observation.success, observation.coverage, null, duration, JSON.stringify(paths), observation.handles]);
        }
        catch {
            request.log.warn({ error_code: 'usage_observation_not_persisted', route, request_id: request.id, coverage: 'governance_observation_incomplete' }, 'governance observation unavailable');
        }
    });
}
//# sourceMappingURL=usage.js.map