import{executorFailure}from'./external-executor-error.mjs';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
import { canonical, digest } from '../../../packages/platform/src/canonical.js';
import { sqlFunction } from '../../../packages/platform/src/db.js';
import {asrPrepareSchema as prepare,asrJobSchema as job,externalModelTypes} from './external-model-contracts.mjs';
export {externalReleaseSchema,externalRevokeSchema} from './external-model-contracts.mjs';
const {uuid,hash,fixed,target}=externalModelTypes;
function parsed(schema, value) { const result = schema.safeParse(value); if (!result.success)
    throw new DomainError('invalid_input'); return result.data; }
const tuple = z.object({ job_id: uuid, run_id: uuid, project_id: uuid, actor_id: uuid, client_id: uuid, created_client_id: uuid, provider_target_id: target, target_revision: z.number().int().positive(), descriptor_hash: hash, release_id: uuid, release_revision: z.number().int().positive(), input_fixed_ref: fixed.extend({ project_id: uuid, size: z.number().int().nonnegative() }), parameter_hash: hash, source_closure_hash: hash, permit_id: uuid, deadline: z.iso.datetime({ offset: true }), attempt: z.number().int().positive(), fencing_token: uuid }).strict();
export function registerExternalModel(app, pool, call, config) {
    const rpc = config.externalModelRPC, endpoint = rpc ? new URL(rpc.url) : undefined;
    if (endpoint && (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || rpc.key.length < 32))
        throw Error('external_model_private_RPC_registration_required');
    const invoke = (req, name, body) => call(bearer(req), sourceFromRequest(req), name, 'mem.process', body);
    const normalized = (b) => ({ project_id: b.project_id, run_id: b.run_id ?? b.job_id, ...(b.provider_target_id ? { provider_target_id: b.provider_target_id } : {}), ...(b.usage ? { usage: b.usage } : {}) });
    async function prepareJob(req) {
        const b = parsed(prepare, req.body), key = b.idempotency_key ?? (typeof req.headers['x-hub-invocation-id'] === 'string' ? req.headers['x-hub-invocation-id'] : randomUUID());
        const declarationHash = digest({ ...b, idempotency_key: key }), processingKey = 'ASR74:' + digest({ project_id: b.project_id, key });
        const metadata = await invoke(req, 'external_recipe', { project_id: b.project_id, input: b.input, provider_target_id: b.provider_target_id, parameters: b.parameters, processing_key: processingKey, request_hash: declarationHash });
        let bound;
        if (metadata['state'] === 'existing')
            bound = metadata['job'];
        else if (metadata['state'] === 'existing_unbound')
            bound = await invoke(req, 'external_bind', { project_id: b.project_id, run_id: metadata['run_id'], provider_target_id: b.provider_target_id, request_hash: declarationHash });
        else {
            const run = await invoke(req, 'begin_processing', { project_id: b.project_id, idempotency_key: processingKey, inputs: [b.input], output_kind: 'transcript', semantic_kind: 'asr_transcription', recipe: metadata['recipe'], coverage: 'unknown', declaration: { ...b.declaration, external_target_id: b.provider_target_id, external_request_hash: declarationHash }, reuse: b.reuse });
            if (run['state'] === 'reused')
                return { ...run, job_id: run['run_id'], idempotency_key: key, automatic_submit_retry: false };
            bound = await invoke(req, 'external_bind', { project_id: b.project_id, run_id: run['run_id'], provider_target_id: b.provider_target_id, request_hash: declarationHash });
        }
        const current = await invoke(req, 'external_check', { project_id: b.project_id, run_id: bound['run_id'] });
        return { ...current, idempotency_key: key, state: current['state'] === 'scope_needed' ? 'draft_ready_external_scope_needed' : current['state'] };
    }
    app.post('/v2/asr/prepare', prepareJob);
    for (const path of ['attach', 'check', 'status'])
        app.post('/v2/asr/' + path, async (req) => invoke(req, 'external_check', normalized(parsed(job, req.body))));
    app.post('/v2/asr/permit', async (req) => invoke(req, 'external_permit', normalized(parsed(job, req.body))));
    async function relay(req, mode) {
        const body = (mode === 'start' && !req.body?.['job_id'] && !req.body?.['run_id']) ? await prepareJob(req) : await invoke(req, 'external_check', normalized(parsed(job, req.body)));
        if (body['state'] !== 'authorized' && body['state'] !== 'continuation_authorized')
            return body;
        if (!endpoint || !rpc)
            return { ...body, state: 'executor_unavailable', retained_state: 'original_processing_run_and_dispatch_unchanged', next_step: 'install_registered_model_holder;retry_same_job' };
        try {
            const response = await fetch(new URL('/' + mode, endpoint), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { authorization: 'Bearer ' + bearer(req), 'content-type': 'application/json', 'x-hub-model-rpc-key': rpc.key }, body: JSON.stringify({ project_id: body['project_id'], job_id: body['job_id'] }) });
            if(!response.ok){const failure=await executorFailure(response);req.log?.warn?.({error_code:failure.code,error_stage:'asr_executor',request_id:req.id,upstream_request_id:failure.request_id},'ASR executor rejected');throw new DomainError(failure.code,response.status,failure.retryable??response.status>=500);}
            return await response.json();
        }
        catch (error) {
            if (error instanceof DomainError)
                throw error;
            return { ...body, state: 'delivery_unknown', automatic_submit_retry: false, next_step: 'query_same_job;reattach_current_credential;do_not_create_another_submit' };
        }
    }
    app.post('/v2/asr/start', req => relay(req, 'start'));
    app.post('/v2/asr/poll', req => relay(req, 'poll'));
    function holder(req, id) {
        const expected = config.externalModelKeys?.[id], given = req.headers['x-hub-model-key'];
        if (!expected || expected.length < 32 || typeof given !== 'string' || Buffer.byteLength(given) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(given), Buffer.from(expected)))
            throw new DomainError('external_holder_forbidden', 403);
    }
    app.post('/internal/asr/consume', async (req) => { const b = parsed(tuple, req.body); holder(req, b.provider_target_id); return invoke(req, 'external_consume', b); });
    app.post('/internal/asr/outcome', async (req) => {
        const b = parsed(z.object({ project_id: uuid, run_id: uuid, provider_target_id: target, intent_id: uuid, permit: tuple, outcome: z.object({ state: z.enum(['known', 'unknown']), provider_task_id: z.string().min(1).max(500).optional(), provider_request_id: z.string().max(500).optional(), error_code: z.string().max(200).optional() }).strict() }).strict(), req.body);
        holder(req, b.provider_target_id);
        return sqlFunction(pool, 'mem.external_outcome', [canonical(b)]);
    });
}
//# sourceMappingURL=external-model-flow.js.map