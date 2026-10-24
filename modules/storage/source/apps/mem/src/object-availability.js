import {objectSchemas} from './effect-contracts.mjs';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
import { digest } from '../../../packages/platform/src/canonical.js';
import { prepareVerifiedRead } from './objects.js';
export function providerFailure(error) {
    const e = error;
    if(['InvalidObjectState','restore_required'].includes(e.code??e.name??''))return'restore_required';
 if(['RestoreAlreadyInProgress','restoring'].includes(e.code??e.name??''))return'restoring';
 if (e.$metadata?.httpStatusCode === 403)
        return 'forbidden';
    if (e.$metadata?.httpStatusCode === 404)
        return 'not_found';
    if (['AbortError', 'TimeoutError', 'RequestTimeout', 'TimeoutError'].includes(e.name ?? '') || ['ETIMEDOUT', 'ECONNABORTED', 'RequestTimeout'].includes(e.code ?? ''))
        return 'timeout';
    if (error instanceof DomainError && ['object_integrity_mismatch', 'object_version_mismatch'].includes(error.code))
        return 'integrity_mismatch';
    return 'provider_error';
}
export async function observeFixed(adapter, locator, expected, budget, beforeRead) {
    try {
        const actual = { provider: locator.provider, bucket: locator.bucket, key: locator.key, versionId: locator.version_id };
        const s3 = adapter;
        const bounded = s3.client && s3.config ? { mode: 'real', copyToImmutable: (a, b) => adapter.copyToImmutable(a, b), read: async (object) => {
                if (object.bucket !== s3.config.bucket)
                    throw new DomainError('invalid_fixed_object');
                const r = await s3.client.send(new GetObjectCommand({ Bucket: object.bucket, Key: object.key, VersionId: object.versionId }), { abortSignal: AbortSignal.timeout(10000) });
                if (r.VersionId && r.VersionId !== object.versionId)
                    throw new DomainError('object_version_mismatch', 503);
                if (!r.Body || !(Symbol.asyncIterator in r.Body))
                    throw new DomainError('object_stream_unavailable', 503);
                return r.Body;
            } } : adapter;
        const verified = await prepareVerifiedRead(bounded, actual, expected, budget, beforeRead);
        await verified.cleanup();
        return { locator, status: 'verified', ...expected };
    }
    catch (error) {
        if (error instanceof DomainError && error.code.startsWith('capacity_'))
            throw error;
        const status = providerFailure(error);
        return { locator, status, provider_code: status };
    }
}
export function registerObjectAvailability(app, adapter, call, budget) {
    for (const command of ['probe', 'import_copy'])
        app.post(command === 'probe' ? '/v2/objects/probe' : '/v2/objects/repair', async (request) => {
            const schema = objectSchemas[command];
            const parsed = schema.safeParse(request.body);
            if (!parsed.success)
                throw new DomainError('invalid_input');
            if (!adapter || adapter.mode !== 'real')
                throw new DomainError('object_store_unconfigured', 503, true);
            const body = { ...parsed.data, command }, token = bearer(request), source = sourceFromRequest(request), action = command === 'import_copy' ? 'mem.write' : 'mem.read';
            const prepared = await call(token, source, 'object_probe_prepare', action, body);
            if (prepared['state'] !== 'prepared')
                return prepared;
            const input = parsed.data;
            let authorizedSource;
            if (input.source_ref)
                authorizedSource = await call(token, source, 'read_version', 'mem.read', input.source_ref);
            const locators = command === 'probe' ? prepared['locators'] : input.source_ref ? [authorizedSource['object']] : [input.fixed_copy];
            if (command === 'import_copy' && !input.source_ref) {
                const original = prepared['locators'][0];
                const copy = locators[0];
                if (copy.provider !== original.provider || copy.bucket !== original.bucket || copy.key !== original.key)
                    throw new DomainError('repair_copy_must_match_registered_target', 403);
            }
            const observations = [];
            for (const locator of locators)
                observations.push(await observeFixed(adapter, locator, { sha256: String(prepared['sha256']), size: Number(prepared['size']) }, budget, async () => { await call(token, source, 'object_probe_prepare', action, body); }));
            if (input.source_ref)
                await call(token, source, 'read_version', 'mem.read', input.source_ref);
            return call(token, source, 'object_probe_finish', action, { ...body, operation_id: prepared['operation_id'], original_request_hash: digest(body), observations });
        });
}
//# sourceMappingURL=object-availability.js.map