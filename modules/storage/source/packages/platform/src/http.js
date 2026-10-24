import {platformFailure} from './failure-contract.mjs';
import Fastify from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
export class DomainError extends Error {
    code;
    status;
    retryable;
    constructor(code, status = 400, retryable = false) {
        super(code);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}
export function errorResponse(error,requestId=randomUUID()){return platformFailure(error,{explicit:error instanceof DomainError,requestId});}
export function server(name) {
    const app = Fastify({ bodyLimit: 2 * 1024 * 1024, requestTimeout: 30000, logger: {
            level: process.env['LOG_LEVEL'] ?? 'info',
            redact: { paths: ['req.headers.authorization', 'req.headers["x-hub-management-key"]', 'req.headers["x-hub-model-key"]', 'req.headers["x-hub-model-rpc-key"]', 'req.headers.cookie', 'req.headers["x-hub-service-key"]',
                    'res.headers["set-cookie"]', 'password', 'token', 'secret', 'access_token', 'refresh_token'], censor: '[redacted]' }
        }, genReqId: () => randomUUID() });
    app.get('/health', async () => ({ service: name, status: 'running', version: '2.0.0-dev.1' }));
    app.setErrorHandler((error, request, reply) => {
        const result=errorResponse(error,request.id);
        request.log.warn({...result.diagnostic,request_id:request.id},'request failed');
        reply.code(result.status).send(result.body);
    });
    return app;
}
export function bearer(request) {
    const value = request.headers.authorization;
    if (!value?.startsWith('Bearer ') || value.length > 4096)
        throw new DomainError('unauthenticated', 401);
    return value.slice(7);
}
export function sameSecret(actual, expected) {
    if (!actual || !expected)
        return false;
    const a = Buffer.from(actual), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
export async function run(app, port, host = '127.0.0.1') {
    await app.listen({ host, port });
    const stop = () => { app.close().then(() => process.exit(0)).catch(() => process.exit(1)); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
}
//# sourceMappingURL=http.js.map