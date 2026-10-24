import { DomainError } from './http.js';
/** Optional attribution only; this header never chooses an actor or grants an action. */
export function sourceFromRequest(request) {
    const raw = request.headers['x-hub-source-context'];
    if (raw === undefined)
        return undefined;
    if (typeof raw !== 'string' || raw.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(raw))
        throw new DomainError('invalid_source_context');
    try {
        const result = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!result || typeof result !== 'object' || Array.isArray(result))
            throw new Error('object required');
        return result;
    }
    catch {
        throw new DomainError('invalid_source_context');
    }
}
//# sourceMappingURL=source.js.map