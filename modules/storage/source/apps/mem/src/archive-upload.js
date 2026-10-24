import {archivePublishSchema,uploadOperationIdSchema} from './upload-contracts.mjs';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
import { verifyFinal } from './objects.js';
export function registerArchiveUpload(app, adapter, uploads, call, budget) {
    app.post('/v2/uploads/:id/publish-archive', async (request) => {
        const parsed = archivePublishSchema.safeParse(request.body), id = uploadOperationIdSchema.safeParse(request.params.id);
        if (!parsed.success || !id.success)
            throw new DomainError('invalid_input');
        const b = { ...parsed.data, operation_id: id.data }, token = bearer(request), source = sourceFromRequest(request);
        const invoke = (name, body) => call(token, source, name, 'mem.upload', body);
        if (b.attempt !== undefined && b.fencing_token !== undefined)
            return invoke('publish_archive_upload', b);
        if (!adapter)
            throw new DomainError('object_store_unconfigured', 503, true);
        if (uploads) {
            const staging = await invoke('upload_control', { project_id: b.project_id, operation_id: b.operation_id, command: 'list' });
            if (staging['state'] !== 'completed')
                throw new DomainError('staging_upload_incomplete', 409);
        }
        const capacity = await budget?.acquire('verify', 0, { deadline: Date.now() + 25000 });
        try {
            const claimed = await invoke('claim_archive_upload', b);
            if (claimed['state'] === 'published')
                return claimed;
            capacity?.limitUntil(Date.parse(String(claimed['lease_until'])));
            const verified = await verifyFinal(adapter, String(claimed['staging_key']), { sha256: String(claimed['expected_hash']), size: Number(claimed['expected_size']) }, capacity ? { configured: true, acquire: async () => capacity, close: async () => { }, status: () => ({ state: 'held' }) } : undefined, async () => { await invoke('upload_effect_check', { project_id: b.project_id, operation_id: b.operation_id, attempt: claimed['attempt'], fencing_token: claimed['fencing_token'] }); });
            const fence = { ...b, attempt: claimed['attempt'], fencing_token: claimed['fencing_token'] };
            await invoke('verify_upload', { ...fence, provider: verified.provider, bucket: verified.bucket, object_key: verified.key, provider_version_id: verified.versionId, sha256: verified.sha256, size: verified.size });
            return invoke('publish_archive_upload', fence);
        }
        finally {
            await capacity?.release();
        }
    });
}
//# sourceMappingURL=archive-upload.js.map