import {textSchema,readChunkSchema,textResumeSchema,textQuerySchema,textReadChunkSchema} from './agent-contracts.mjs';
import {infrastructureFailure} from '../../../packages/platform/src/failure-contract.mjs';
import { Readable } from 'node:stream';
import { cacheFor } from './verified-cache.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
import { sha256, digest } from '../../../packages/platform/src/canonical.js';
import { verifyFinal } from './objects.js';
const uuid = z.uuid();
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success)
    throw new DomainError('invalid_input'); return result.data; }
export function chunkView(bytes, encoding) {
    let text;
    let utf8_state = 'not_requested';
    if (encoding === 'utf8') {
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
            utf8_state = 'complete_codepoints';
        }
        catch {
            utf8_state = 'boundary_or_invalid_utf8_use_exact_base64';
        }
    }
    return { bytes_base64: bytes.toString('base64'), chunk_sha256: sha256(bytes), ...(text !== undefined ? { text } : {}), utf8_state };
}
export function registerAgentFlow(app, adapter, uploads, call, budget) {
    const invoke = (r, n, a, b) => call(bearer(r), sourceFromRequest(r), n, a, b);
    app.post('/v2/files/read-chunk', async (request, reply) => {
        const b = parse(readChunkSchema, request.body);
        if (!adapter)
            throw new DomainError('object_store_unconfigured', 503, true);
        const closed = new AbortController();
        reply.raw.once('close', () => closed.abort());
        const prepared = await invoke(request, 'read_range', 'mem.read', b);
        const o = prepared['object'];
        const fixed = prepared['fixed_ref'];
        const object = { provider: o['provider'], bucket: o['bucket'], key: o['key'], versionId: o['version_id'] };
        const file = await cacheFor(adapter, budget).acquire(object, fixed, async () => { await invoke(request,'gc_read_lease','mem.read',{project_id:b.project_id,material_id:b.material_id,version_id:b.version_id,read_receipt_id:prepared['read_receipt_id'],sha256:fixed.sha256,ttl_seconds:10,command:'renew'}); });
        let capacity;
        let transportOwned = false, capacityReleased = false;
        const releaseCapacity = async () => { if (capacityReleased)
            return; capacityReleased = true; await capacity?.release(); };
        try {
            capacity = await budget?.acquire('read', 0, { deadline: Date.now() + 25000, signal: closed.signal });
            const fresh = await invoke(request, 'read_range', 'mem.read', b);
            const releaseReadUse=()=>{for(const receipt of [prepared['read_receipt_id'],fresh['read_receipt_id']])void invoke(request,'gc_read_lease','mem.read',{project_id:b.project_id,material_id:b.material_id,version_id:b.version_id,read_receipt_id:receipt,command:'release'}).catch(()=>request.log.warn({error_code:'chunk_use_lease_release_pending'},'chunk read use lease expires without renewal'));};reply.raw.once('finish',releaseReadUse);reply.raw.once('close',releaseReadUse);
const range = fresh['range'];
            const bytes = Buffer.alloc(range.end_exclusive - range.start);
            const fd = await open(file.path, 'r');
            try {
                let received = 0;
                while (received < bytes.length) {
                    const result = await fd.read(bytes, received, bytes.length - received, range.start + received);
                    if (!result.bytesRead)
                        throw new DomainError('object_integrity_mismatch', 503, true);
                    received += result.bytesRead;
                }
            }
            finally {
                await fd.close();
            }
            reply.raw.once('finish', () => { void invoke(request, 'record_read', 'mem.read', { project_id: b.project_id, material_id: b.material_id, version_id: b.version_id, read_receipt_id: fresh['read_receipt_id'], state: 'sent' }).catch(() => request.log.warn({ error_code: 'read_receipt_pending' }, 'chunk delivery evidence pending')); });
            const result = { state: 'prepared', fixed_ref: fresh['fixed_ref'], ...chunkView(bytes, b.encoding), range, coverage: range.start === 0 && range.end_exclusive === fixed.size ? 'whole_original' : 'partial_original', next_offset: range.end_exclusive < fixed.size ? range.end_exclusive : null, read_receipt: { id: fresh['read_receipt_id'], state: 'prepared', understanding: 'not_inferred' }, whole_fixed_integrity: 'verified' };
            if (capacity) {
                const outputCapacity = capacity;
                const stream = Readable.from(await outputCapacity.meter((async function* () { yield Buffer.from(JSON.stringify(result)); })(), false));
                reply.header('content-type', 'application/json; charset=utf-8');
                const release = () => { void releaseCapacity(); };
                reply.raw.once('finish', release);
                reply.raw.once('close', release);
                if (reply.raw.destroyed || request.raw.aborted)
                    throw new DomainError('download_client_closed_no_body_sent', 499);
                const sent = reply.send(stream);
                transportOwned = true;
                return sent;
            }
            return result;
        }
        finally {
            if (!transportOwned)
                await releaseCapacity();
            await file.cleanup();
        }
    });
    async function publishDraft(request, draft, overrides = {}) {
        const b = { ...draft['body'], ...overrides };
        const source = b['source'];
        const actual_inputs = source?.['actual_inputs'] === undefined ? [] : parse(z.array(z.object({ material_id: uuid, version_id: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strip()).max(1000), source['actual_inputs']);
        const id = String(draft['resume_id']);
        const common = { resume_id: id, idempotency_key: draft['idempotency_key'] };
        if (b['material_id'] && (b['base_revision'] === undefined || b['base_version_id'] === undefined))
            return { operation_id: id, ...common, state: 'base_required', retained_state: 'append_only_text_candidate', next_step: 'choose_current_base_or_save_as_new_material' };
        const existing = draft['upload_operation'];
        if (existing && !b['save_as_new']) {
            if (existing['state'] === 'published')
                return { ...existing['receipt'], ...common, upload_operation_id: existing['operation_id'] };
            if (existing['state'] === 'conflict' && overrides['base_revision'] !== undefined) {
                const rebased = await invoke(request, 'rebase_upload', 'mem.upload', { project_id: b['project_id'], operation_id: existing['operation_id'], expected_revision: b['base_revision'], expected_version_id: b['base_version_id'], idempotency_key: 'text-rebase:' + id + ':' + digest(overrides) });
                const result = await invoke(request, 'publish_text_upload', 'mem.upload', { project_id: b['project_id'], operation_id: existing['operation_id'], attempt: rebased['attempt'], fencing_token: rebased['fencing_token'], actual_inputs });
                return { ...result, ...common, upload_operation_id: existing['operation_id'] };
            }
            if (existing['state'] === 'verified' && new Date(String(existing['lease_until'])).getTime() > Date.now()) {
                const result = await invoke(request, 'publish_text_upload', 'mem.upload', { project_id: b['project_id'], operation_id: existing['operation_id'], attempt: existing['attempt'], fencing_token: existing['fencing_token'], actual_inputs });
                return { ...result, ...common, upload_operation_id: existing['operation_id'] };
            }
        }
        if (!uploads || !adapter)
            return { operation_id: id, ...common, state: 'provider_configuration_required', retained_state: 'durable_text_draft', next_step: 'resume_when_object_provider_available' };
        const bytes = Buffer.from(String(b['text']), 'utf8');
        const upload = { project_id: b['project_id'], idempotency_key: 'text:' + id + (b['save_as_new'] ? ':new' : ''), logical_path: b['logical_path'], sha256: sha256(bytes), size: bytes.length, expected_revision: b['base_revision'] ?? 0, expected_version_id: b['base_version_id'] ?? null, ...(b['material_id'] ? { material_id: b['material_id'] } : {}), properties: { source_claim: b['source'] ?? { state: 'unknown' }, ...(b['properties'] ?? {}) }, origin_kind: 'member_submission', producer: 'agent_text' };
        const capacity = await budget?.acquire('verify', 0, { deadline: Date.now() + 25000 });
        try {
            const op = await invoke(request, 'begin_upload', 'mem.upload', upload);
            if (op['state'] === 'published')
                return { ...op['receipt'], ...common, upload_operation_id: op['operation_id'] };
            await uploads.writeStaging(String(op['staging_key']), bytes, String(op['operation_id']), capacity);
            const claimed = await invoke(request, 'claim_text_upload', 'mem.upload', { project_id: b['project_id'], operation_id: op['operation_id'] });
            if (claimed['state'] === 'published')
                return { ...claimed, ...common };
            capacity?.limitUntil(Date.parse(String(claimed['lease_until'])));
            const verified = await verifyFinal(adapter, String(claimed['staging_key']), { sha256: sha256(bytes), size: bytes.length }, capacity ? { configured: true, acquire: async () => capacity, close: async () => { }, status: () => ({ state: 'held' }) } : undefined, async () => { await invoke(request, 'upload_effect_check', 'mem.upload', { project_id: b['project_id'], operation_id: op['operation_id'], attempt: claimed['attempt'], fencing_token: claimed['fencing_token'] }); });
            const fence = { project_id: b['project_id'], operation_id: op['operation_id'], attempt: claimed['attempt'], fencing_token: claimed['fencing_token'] };
            await invoke(request, 'verify_upload', 'mem.upload', { ...fence, provider: verified.provider, bucket: verified.bucket, object_key: verified.key, provider_version_id: verified.versionId, sha256: verified.sha256, size: verified.size });
            const published = await invoke(request, 'publish_text_upload', 'mem.upload', { ...fence, actual_inputs });
            return { ...published, ...common, upload_operation_id: op['operation_id'], agent_calls: 1 };
        }
        finally {
            await capacity?.release();
        }
    }
    async function respondDraft(request, reply, draft, overrides = {}) { try {
        return await publishDraft(request, draft, overrides);
    }
    catch (error) {
        const e = error, failure=infrastructureFailure(error);
        const code = error instanceof DomainError ? error.code : failure?.code ?? ( e.code === '40001' ? 'revision_conflict' : e.code === '23505' ? (e.constraint === 'placements_active_path' ? 'logical_path_conflict' : 'idempotency_conflict') : e.$metadata?.httpStatusCode === 403 ? 'object_provider_permission_required' : e.$metadata ? 'object_provider_unavailable' : 'internal_error');
        const status = error instanceof DomainError ? error.status : failure?.status ?? (code.includes('conflict') ? 409 : e.$metadata ? 503 : 500);
        reply.code(status);
        return { operation_id: draft['resume_id'], resume_id: draft['resume_id'], idempotency_key: draft['idempotency_key'], state: code === 'logical_path_conflict' ? 'base_required' : code === 'object_provider_permission_required' ? 'provider_configuration_required' : 'pending', error_code: code, retryable: status === 503 && code !== 'object_provider_permission_required', retained_state: 'durable_text_draft', next_step: code === 'logical_path_conflict' ? 'choose_material_and_explicit_base_or_save_as_new' : 'query_or_resume_same_text_draft' };
    } }
    app.post('/v2/materials/write-text', async (request, reply) => { const b = parse(textSchema, request.body); const invocation = request.headers['x-hub-invocation-id']; const key = b.idempotency_key ?? (typeof invocation === 'string' && invocation.length <= 200 ? invocation : randomUUID()); const draft = await invoke(request, 'save_text_draft', 'mem.upload', { ...b, idempotency_key: key }); return respondDraft(request, reply, draft); });
    app.post('/v2/materials/write-text/resume', async (request, reply) => { const b = parse(textResumeSchema, request.body); const draft = await invoke(request, 'text_draft', 'mem.upload', b); return respondDraft(request, reply, draft, { ...(b.material_id ? { material_id: b.material_id } : {}), ...(b.base_revision !== undefined ? { base_revision: b.base_revision } : {}), ...(b.base_version_id ? { base_version_id: b.base_version_id } : {}), ...(b.save_as_new ? { save_as_new: true, material_id: undefined, base_revision: 0, base_version_id: null, logical_path: b.logical_path ?? String(draft['body']['logical_path']).slice(0, 960) + '.candidate-' + String(draft['resume_id']) } : {}) }); });
    app.post('/v2/materials/write-text/query', async (request) => { const b = parse(textQuerySchema, request.body); return invoke(request, 'read_text_draft', 'mem.read', b); });
    app.post('/v2/materials/write-text/read-chunk', async (request) => { const b = parse(textReadChunkSchema, request.body); let result; try {
        result = await invoke(request, 'read_text_draft_chunk', 'mem.read', b);
    }
    catch (error) {
        const e = error;
        if (e.code === 'P0001' && e.message === 'invalid_range')
            throw new DomainError('invalid_range');
        throw error;
    } if (typeof result['bytes_base64'] !== 'string')
        return result; const bytes = Buffer.from(result['bytes_base64'], 'base64'); const view = chunkView(bytes, 'utf8'); if (view.chunk_sha256 !== result['chunk_sha256'])
        throw new DomainError('draft_chunk_integrity_mismatch', 503, true); return { ...result, ...view }; });
}
//# sourceMappingURL=agent-flow.js.map
