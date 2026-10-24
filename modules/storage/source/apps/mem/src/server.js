import {coreRoutes,publishSchema,operationIdSchema,batchSchema,offlinePrepareSchema,offlinePageSchema,fixedReferenceSchema} from './core-contracts.mjs';
import {registerWorkspaceQuery} from './workspace-query.mjs';
import {preserveInvocationArguments} from '../../../packages/platform/src/response-decoration.mjs';
import {createStorageCommands} from '../../../packages/storage-tiers/src/operation-outcome.mjs';
import {registerMaterialLifecycle,installMaterialLifecycleScheduler} from './material-lifecycle.mjs';
import {registerStagedSearch} from './staged-search.mjs';
import {semanticBroker} from './semantic-transport.mjs';
import{registerFileNumber}from'./file-number-flow.mjs';
import{registerLegacySelfInventory}from'./legacy-self-inventory.mjs';
import {registerMaterialWarming}from'./material-warming.mjs';
import {registerMaterialProperties}from'./material-properties.mjs';
import{registerMaterialLocate}from'./material-locate.mjs';
import {registerReferenceResolve} from './reference-resolve.mjs';
import {registerLegacyLookup} from './legacy-lookup.mjs';
import {createArchiveLifecycle} from '../../../packages/storage-tiers/src/archive-lifecycle.mjs';
import {registerArchiveLifecycle} from '../../../packages/storage-tiers/src/archive-lifecycle-http.mjs';
import {knownCopyEvidence,knownRetirementDenial} from '../../../packages/storage-tiers/src/known-copy-evidence.mjs';
import {registerStorageTiers} from '../../../packages/storage-tiers/src/storage-tier-flow.mjs';
import { registerScopeMove } from './scope-move-flow.js';
import { registerLegacyFlow } from './legacy-flow.js';
import { registerExternalModel, externalReleaseSchema, externalRevokeSchema } from './external-model-flow.js';
import { Readable } from 'node:stream';
import { registerGC } from './gc-flow.js';
import { recordSuccessfulCapability } from '../../../packages/platform/src/observed-scope.js';
import { registerCompensation } from './compensation.js';
import { registerObjectAvailability } from './object-availability.js';
import { registerVectorFlow } from './vector-flow.js';
import { registerDescriptionFlow } from './description-flow.js';
import { installChanges } from '../../../packages/platform/src/changes.js';
import { installUsage } from '../../../packages/platform/src/usage.js';
import { cacheFor } from './verified-cache.js';
import { AuthorizedDownload } from './authorized-download.js';
import { z } from 'zod';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
import { server, bearer, DomainError, errorResponse } from '../../../packages/platform/src/http.js';
import { database, sqlFunction } from '../../../packages/platform/src/db.js';
import { decide } from '../../../packages/platform/src/decision.js';
import { canonical, digest } from '../../../packages/platform/src/canonical.js';
import { registerAgentFlow } from './agent-flow.js';
import { registerProcessingFlow } from './processing-flow.js';
import { registerGovernanceFlow } from './governance-flow.js';
import { registerEquivalenceFlow } from './equivalence-flow.js';
import { registerMaterialNavigation } from './navigation-flow.js';
import { registerArchiveUpload } from './archive-upload.js';
import { registerUploads } from './upload-http.js';
import { tokens, tokenRecipe } from './tokenize.js';
import { verifyFinal } from './objects.js';
function parse(schema, value) { const result = schema.safeParse(value); if (!result.success)
    throw new DomainError('invalid_input'); return result.data; }
const responseFields = new Set(['operation_id', 'state', 'domain_revision', 'content_revision', 'metadata_revision', 'fixed_refs', 'receipt', 'coverage', 'retryable', 'error_code', 'retained_state', 'next_step', 'material_id', 'staging_key', 'business_registration', 'snapshot_id', 'returned_count', 'total_count', 'next_cursor', 'expires_at', 'processing_pending', 'contract_version', 'items', 'recipe', 'run_id', 'inputs', 'outputs', 'technical_state', 'attempt', 'fencing_token', 'lease_until', 'semantic_status', 'placement_id', 'collection_id', 'read_receipt_id', 'invalidation_id', 'affected_count', 'disclosure_id', 'quality_status', 'version_id', 'maintenance']);
export function publicResponse(result) { const out = {}; for (const [key, value] of Object.entries(result))
    if (responseFields.has(key))
        out[key] = value; if (result['id'])
    out['run_id'] = result['id']; return out; }
export function createServer(config) {
    if (config.objectAdapter?.mode === 'test')
        throw new Error('test object adapter cannot serve formal material API');
    const app = server('mem');
    if (config.objectAdapter)
        app.addHook('onClose', async () => cacheFor(config.objectAdapter, config.ioBudget).close());
    const pool = config.pool ?? database(config.databaseUrl);
    app.addHook('preSerialization', async (_request,_reply,payload) => preserveInvocationArguments(payload,await sqlFunction(pool,'mem.file_number_decorate',[payload])));
    installUsage(app, pool, { ...(config.usagePool ? { pool: config.usagePool } : {}), ...(config.usageSpoolDirectory ? { directory: config.usageSpoolDirectory } : {}) });
    installChanges(app, pool, config);
    if (!config.pool)
        app.addHook('onClose', async () => pool.end());
    async function call(token, source, name, action, body) {
        const resource = { ...body, project_id: body['project_id'], ...(body['material_id'] ? { material_id: body['material_id'] } : {}) };
        const decision = await decide(config, token, action, resource, body, source);
        return sqlFunction(pool, 'mem.' + name, [decision.handle, digest(body), canonical(body)]);
    }
    registerWorkspaceQuery(app,{z,bearer,sourceFromRequest,call,DomainError});
    registerFileNumber(app,{z,bearer,sourceFromRequest,DomainError,pool,sqlFunction,call,hufuUrl:config.hufuUrl});
    registerLegacySelfInventory(app,{z,bearer,pool,DomainError});
    registerMaterialLocate(app,{z,bearer,sourceFromRequest,DomainError,pool,sqlFunction,call,hufuUrl:config.hufuUrl});
 registerReferenceResolve(app,{z,bearer,sourceFromRequest,DomainError,pool,sqlFunction,call,hufuUrl:config.hufuUrl});
 const lifecycle=createArchiveLifecycle({call,provider:config.storageTierProvider,loadKnownCopyEvidence:knownCopyEvidence('/srv/workspace',process.getuid()),loadKnownRetirementDenial:knownRetirementDenial('/srv/workspace',process.getuid())});
const retirementCommands=registerArchiveLifecycle(app,{z,bearer,sourceFromRequest,DomainError,lifecycle,call});
const tierCommands=registerStorageTiers(app,{z,bearer,sourceFromRequest,call,digest,DomainError,provider:config.storageTierProvider,budget:config.ioBudget,afterCopyCreated:(token,source,body)=>lifecycle(token,source,body)});
 registerScopeMove(app, pool, config);
    registerGC(app, call, config.gcExecutor);
    registerExternalModel(app, pool, call, config);
    registerLegacyFlow(app, call);
 registerLegacyLookup(app,{z,bearer,sourceFromRequest,call,DomainError});
    registerObjectAvailability(app, config.objectAdapter, call, config.ioBudget);
    registerCompensation(app, call);
    registerVectorFlow(app, call, { legacyWritesEnabled: config.legacyVectorWritesEnabled === true });
    const searchBroker=semanticBroker({url:config.semanticUrl??process.env['SEMANTIC_URL'],error:(code,status,retryable)=>new DomainError(code,status,retryable)});
    registerDescriptionFlow(app, call, searchBroker);
    registerStagedSearch(app,{z,bearer,sourceFromRequest,DomainError,call,semantic:searchBroker,findNumber:async(token,source,number)=>{
      const response=await app.inject({method:'POST',url:'/v2/materials/by-number',headers:{authorization:'Bearer '+token,...(source?{'x-hub-source-context':Buffer.from(JSON.stringify(source)).toString('base64url')}:{})},payload:{number}});
      if(response.statusCode!==200){const r=response.json();throw new DomainError(r.error_code??'number_lookup_failed',response.statusCode,r.retryable??false);}
      return response.json();
    }});
    registerUploads(app, config.uploads, call);
    registerAgentFlow(app, config.objectAdapter, config.uploads, call, config.ioBudget);
    registerProcessingFlow(app, call);
    registerGovernanceFlow(app, call);
 let storageCommands;
 const warmCommand=registerMaterialWarming(app,{z,bearer,sourceFromRequest,call,provider:config.storageTierProvider,DomainError,storage:(...args)=>storageCommands(...args)});
 storageCommands=createStorageCommands({tiers:tierCommands,warm:warmCommand,retirement:retirementCommands,errorResponse,log:app.log});
 const runLifecycle=registerMaterialLifecycle(app,{z,bearer,sourceFromRequest,call,DomainError,storage:storageCommands});
 installMaterialLifecycleScheduler(app,{pool,credentialPath:process.env['HUB2_LIFECYCLE_CREDENTIAL_FILE'],runLifecycle,errorResponse});
 registerMaterialProperties(app,{z,bearer,sourceFromRequest,call,DomainError,pool,sqlFunction});
    registerEquivalenceFlow(app, call);
    registerMaterialNavigation(app, call);
    registerArchiveUpload(app, config.objectAdapter, config.uploads, call, config.ioBudget);
    app.post('/v2/materials/fixed-reference', async (request) => { const body = parse(fixedReferenceSchema, request.body); const token = bearer(request), source = sourceFromRequest(request); const result = await call(token, source, 'read_version', 'mem.read', body); await call(token, source, 'gc_read_lease', 'mem.read', { ...body, read_receipt_id: result['read_receipt_id'], command: 'release' }); return { state: 'authorized_fixed_reference', fixed_ref: result['fixed_ref'] }; });

    for (const [path, name, action, schema] of coreRoutes)
        app.post(path, async (request) => { if (path === '/v2/disclosures' && request.body?.['provider_target_id']) {
            const value = parse(externalReleaseSchema, request.body);
            const { resource_selector, ...body } = value;
            return call(bearer(request), sourceFromRequest(request), 'external_release_create', 'mem.share', { ...body, external_release_selector: resource_selector });
        } if (path === '/v2/disclosures/revoke' && request.body?.['release_id'])
            return call(bearer(request), sourceFromRequest(request), 'external_release_revoke', 'mem.share', parse(externalRevokeSchema, request.body)); const parsed = schema.safeParse(request.body); if (!parsed.success)
            throw new DomainError('invalid_input'); const body = parsed.data; if (name === 'index_text') {
            body['recipe'] = tokenRecipe;
            body['token_text'] = tokens(String(body['text'])).join(' ');
        } if (name === 'search_materials')
            body['token_text'] = tokens(String(body['query'] ?? '')).join(' '); return publicResponse(await call(bearer(request), sourceFromRequest(request), name, action, body)); });
    app.post('/v2/uploads/:id/publish', async (request) => {
        const body = parse(publishSchema, request.body);
        const operation_id = parse(operationIdSchema, request.params.id);
        const token = bearer(request);
        if (body.attempt !== undefined && body.fencing_token !== undefined)
            return call(token, sourceFromRequest(request), 'publish_upload', 'mem.upload', { ...body, operation_id });
        // A rebase already owns verified immutable bytes and a current fence.
        // Derive internal fields server-side; keep the original publish permission/CAS checks.
        if (body.attempt === undefined && body.fencing_token === undefined) {
            const retained = await call(token, sourceFromRequest(request), 'retained_upload_candidate', 'mem.upload', {project_id:body.project_id,operation_id});
            if (retained.ready === true) return call(token, sourceFromRequest(request), 'publish_upload', 'mem.upload', {...body,operation_id,attempt:retained.attempt,fencing_token:retained.fencing_token});
        }
        if (!config.objectAdapter)
            throw new DomainError('object_store_unconfigured', 503, true);
        if (config.uploads) {
            const staging = await call(token, sourceFromRequest(request), 'upload_control', 'mem.upload', { project_id: body.project_id, operation_id, command: 'list' });
            if (staging['state'] !== 'completed')
                throw new DomainError('staging_upload_incomplete', 409);
        }
        const capacity = await config.ioBudget?.acquire('verify', 0, { deadline: Date.now() + 25000 });
        try {
            const claimed = await call(token, sourceFromRequest(request), 'claim_upload', 'mem.upload', { ...body, operation_id });
            if (claimed['state'] === 'published')
                return claimed;
            capacity?.limitUntil(Date.parse(String(claimed['lease_until'])));
            const verified = await verifyFinal(config.objectAdapter, String(claimed['staging_key']), { sha256: String(claimed['expected_hash']), size: Number(claimed['expected_size']) }, capacity ? { configured: true, acquire: async () => capacity, close: async () => { }, status: () => ({ state: 'held' }) } : undefined, async () => { await call(token, sourceFromRequest(request), 'upload_effect_check', 'mem.upload', { project_id: body.project_id, operation_id, attempt: claimed['attempt'], fencing_token: claimed['fencing_token'] }); });
            const fence = { ...body, operation_id, attempt: claimed['attempt'], fencing_token: claimed['fencing_token'] };
            await call(token, sourceFromRequest(request), 'verify_upload', 'mem.upload', { ...fence, provider: verified.provider, bucket: verified.bucket, object_key: verified.key, provider_version_id: verified.versionId, sha256: verified.sha256, size: verified.size });
            return call(token, sourceFromRequest(request), 'publish_upload', 'mem.upload', fence);
        }
        finally {
            await capacity?.release();
        }
    });
    app.post('/v2/material-batches', async (request) => {
        const body = parse(batchSchema, request.body);
        const token = bearer(request);
        const source = sourceFromRequest(request);
        const batch = await call(token, source, 'begin_batch', 'mem.read', body);
        const readOutcomes = () => call(token, source, 'batch_outcome', 'mem.read', { project_id: body.project_id, batch_id: batch['operation_id'] });
        let saved = await readOutcomes();
        for (let index = 0; index < body.items.length; index++) {
            if (saved['complete'] === true)
                break;
            const { kind, ...input } = body.items[index];
            const effectBody = { ...input, project_id: body.project_id, idempotency_key: body.idempotency_key + ':' + index, batch_operation_id: batch['operation_id'], batch_item_index: index };
            const resource = { ...effectBody, ...(effectBody['material_id'] ? { material_id: effectBody['material_id'] } : {}) };
            let effectHandle = null;
            let decisionFailure;
            try {
                effectHandle = (await decide(config, token, kind === 'trash' ? 'mem.delete' : 'mem.write', resource, effectBody, source)).handle;
            }
            catch (error) {
                if (!(error instanceof DomainError) || error.status !== 403)
                    throw error;
                decisionFailure = 'forbidden';
            }
            const scope = { project_id: body.project_id, batch_id: batch['operation_id'], item_index: index, ...(decisionFailure ? { decision_failure: decisionFailure } : {}) };
            const readDecision = await decide(config, token, 'mem.read', scope, scope, source);
            saved = await sqlFunction(pool, 'mem.batch_item_execute', [readDecision.handle, digest(scope), canonical(scope), effectHandle, digest(effectBody), canonical(effectBody)]);
            // SQL usage_context ignores unconsumed candidates (failed/replayed items); committed effects keep their real material/source scope.
            if (effectHandle)
                recordSuccessfulCapability([effectHandle, digest(effectBody), canonical(effectBody)]);
        }
        saved = await readOutcomes();
        return { operation_id: saved['operation_id'], state: saved['state'], items: saved['items'], coverage: 'all_requested_items_attempted', next_step: 'retry_same_batch_key_or_explicit_compensation' };
    });
    app.post('/v2/offline-exports', async (request) => { const body = parse(offlinePrepareSchema, request.body); const snapshot = await call(bearer(request), sourceFromRequest(request), 'enumerate', 'mem.read', body); return { ...snapshot, state: 'prepared', export_contract: 'mem-offline-v1', secrets_included: false, next_step: 'fetch_all_export_pages_before_replacing_local_index' }; });
    app.post('/v2/offline-exports/page', async (request, reply) => {
        const body = parse(offlinePageSchema, request.body);
        const token = bearer(request);
        if (!config.objectAdapter)
            throw new DomainError('object_store_unconfigured', 503, true);
        const closed = new AbortController();
        reply.raw.once('close', () => closed.abort());
        const capacity = await config.ioBudget?.acquire('verify', 0, { deadline: Date.now() + 25000, signal: closed.signal });
        let transportOwned = false, capacityReleased = false;
        const releaseCapacity = async () => { if (capacityReleased)
            return; capacityReleased = true; await capacity?.release(); };
        try {
            const page = await call(token, sourceFromRequest(request), 'enumeration_page', 'mem.read', body);
            const materials = page['items'];
            const copies = [];
            let byteCount = 0;
            for (const item of materials) {
                const prepared = await call(token, sourceFromRequest(request), 'read_version', 'mem.read', { project_id: body.project_id, material_id: item['material_id'], version_id: item['version_id'] });
                const fixed = prepared['fixed_ref'];
                if (byteCount + fixed.size > 32 * 1024 * 1024)
                    throw new DomainError('export_page_byte_limit_reduce_page_or_fetch_fixed_file', 409);
                const o = prepared['object'];
                const object = { provider: o['provider'], bucket: o['bucket'], key: o['key'], versionId: o['version_id'] };
                const chunks = [];
                let received = 0;
                const input = await config.objectAdapter.read(object);
                for await (const chunk of capacity ? await capacity.meter(input, false) : input) {
                    received += chunk.byteLength;
                    if (received > fixed.size)
                        throw new DomainError('object_integrity_mismatch', 503, true);
                    chunks.push(Buffer.from(chunk));
                }
                const bytes = Buffer.concat(chunks);
                const { sha256 } = await import('../../../packages/platform/src/canonical.js');
                if (bytes.length !== fixed.size || sha256(bytes) !== fixed.sha256)
                    throw new DomainError('object_integrity_mismatch', 503, true);
                byteCount += bytes.length;
                copies.push({ material: item, fixed_ref: fixed, bytes_base64: bytes.toString('base64'), read_receipt_id: prepared['read_receipt_id'], delivery_state: 'prepared' });
            }
            reply.raw.once('finish', () => { for (const copy of copies)
                void call(token, sourceFromRequest(request), 'record_read', 'mem.read', { project_id: body.project_id, read_receipt_id: copy['read_receipt_id'], state: 'sent' }).catch(() => request.log.warn({ error_code: 'read_receipt_pending' }, 'export delivery evidence pending')); });
            const result = { state: 'prepared', export_contract: 'mem-offline-v1', snapshot_id: page['snapshot_id'], returned_count: copies.length, total_count: page['total_count'], next_cursor: page['next_cursor'], coverage: page['coverage'], copies, generated_at: new Date().toISOString(), secrets_included: false, next_step: 'acknowledge_delivery_and_verify_all_pages_before_replacing_local_index' };
            if (capacity) {
                await capacity.phase('read');
                const output = Readable.from(await capacity.meter((async function* () { yield Buffer.from(JSON.stringify(result)); })(), false));
                reply.header('content-type', 'application/json; charset=utf-8');
                const release = () => { void releaseCapacity(); };
                reply.raw.once('finish', release);
                reply.raw.once('close', release);
                if (reply.raw.destroyed || request.raw.aborted)
                    throw new DomainError('download_client_closed_no_body_sent', 499);
                const sent = reply.send(output);
                transportOwned = true;
                return sent;
            }
            return result;
        }
        finally {
            if (!transportOwned)
                await releaseCapacity();
        }
    });
    app.post('/v2/files/read', async (request, reply) => {
        const body = parse(fixedReferenceSchema, request.body);
        const token = bearer(request);
        const source = sourceFromRequest(request);
        const closed = new AbortController();
        reply.raw.once('close', () => closed.abort());
        if (!config.objectAdapter)
            throw new DomainError('object_store_unconfigured', 503, true);
        const prepared = await call(token, source, 'read_version', 'mem.read', body);
        const o = prepared['object'];
        const object = { provider: o['provider'], bucket: o['bucket'], key: o['key'], versionId: o['version_id'] };
        const fixed = prepared['fixed_ref'];
        const preparedLease = { ...body, sha256: fixed.sha256, read_receipt_id: prepared['read_receipt_id'], ttl_seconds: 10 };
        let verified;
        try {
            verified = await cacheFor(config.objectAdapter, config.ioBudget).acquire(object, fixed, async () => { await call(token, source, 'gc_read_lease', 'mem.read', { ...preparedLease, command: 'renew' }); });
        }
        catch (e) {
            await call(token, source, 'gc_read_lease', 'mem.read', { ...preparedLease, command: 'release' }).catch(() => { });
            if(e.code==='restore_required'){
                const info=await call(token,source,'storage_tier_info','mem.read',body);
                const restoration=await app.inject({method:'POST',url:'/v2/objects/storage-tier/restore',headers:{authorization:'Bearer '+token},payload:{...body,idempotency_key:'lifecycle-read:'+body.version_id+':'+(info.operation_id??'original')+':'+new Date().toISOString().slice(0,10),days:7,retrieval:'Standard'}});
                const result=restoration.json();
                return reply.code(restoration.statusCode>=400?restoration.statusCode:409).send({state:'restoring',error_code:'restore_required',restoration:result,fixed_ref:fixed,retryable:true,next_step:'retry_same_fixed_file_read_when_restore_ready',primary_tier:info.primary_tier,importance_unchanged:true});
            }
            throw e;
        }
        const { createReadStream } = await import('node:fs');
        let outputCapacity;
        let fresh;
        try {
            outputCapacity = await config.ioBudget?.acquire('read', 0, { deadline: Date.now() + 25000, signal: closed.signal });
            if (reply.raw.destroyed || request.raw.aborted)
                throw new DomainError('download_client_closed_no_body_sent', 499);
            fresh = await call(token, source, 'read_version', 'mem.read', body);
        }
        catch (error) {
            await outputCapacity?.release();
            await verified.cleanup();
            throw error;
        }
        // SQL580 owns lease facts and object-destruction fencing. Every renewal uses
        // the same current fixed-version/source permission, never latest-head equality.
        const leaseBody = { ...body, sha256: fixed.sha256, read_receipt_id: fresh['read_receipt_id'], ttl_seconds: 10 };
        const input = createReadStream(verified.path);
        input.pause();
        let transportStarted = false;
        const delivery = outputCapacity ? Readable.from(await outputCapacity.meter(input, false)) : verified.meterOutput ? Readable.from(await verified.meterOutput(input)) : input;
        delivery.pause();
        const guarded = new AuthorizedDownload({ expectedBytes: fixed.size, ...config.streamAuthorization, cancelSource: () => { input.destroy(); delivery.destroy(); }, cancelTransport: () => { if (transportStarted)
                reply.raw.destroy(); }, authorize: async (signal) => {
                const effect = { ...leaseBody, command: 'renew' };
                const decision = await decide(config, token, 'mem.read', effect, effect, source);
                if (signal.aborted)
                    throw new DomainError('download_authorization_timeout', 503);
                const lease = await sqlFunction(pool, 'mem.gc_read_lease', [decision.handle, digest(effect), canonical(effect)]);
                if (signal.aborted)
                    throw new DomainError('download_authorization_timeout', 503);
                if (lease['state'] !== 'leased' || lease['physical_state'] !== 'retained' || lease['material_id'] !== body.material_id || lease['sha256'] !== fixed.sha256 || lease['version_id'] !== body.version_id)
                    throw new DomainError('download_current_permission_denied', 403);
                return { expiresAt: Math.min(Date.parse(decision.expires_at), Date.parse(String(lease['expires_at']))) };
            } });
        // Before reply.send owns the stream, failed initial checks still need an error listener.
        guarded.on('error', () => undefined);
        input.on('error', () => guarded.cancel('download_object_stream_failed'));
        delivery.on('error', () => guarded.cancel('download_capacity_dependency_unknown'));
        outputCapacity?.signal.addEventListener('abort', () => guarded.cancel('download_capacity_dependency_unknown'), { once: true });
        const release = () => call(token, source, 'gc_read_lease', 'mem.read', { ...leaseBody, command: 'release' }).catch(() => request.log.warn({ error_code: 'read_use_lease_expiry_pending' }, 'read use lease expires without renewal'));
        try {
            await guarded.start();
            if (reply.raw.destroyed || request.raw.aborted)
                throw new DomainError('download_client_closed_no_body_sent', 499);
            await call(token, source, 'gc_read_lease', 'mem.read', { ...body, sha256: fixed.sha256, read_receipt_id: prepared['read_receipt_id'], command: 'release' });
        }
        catch (error) {
            guarded.cancel('download_initial_permission_failed');
            await release();
            await outputCapacity?.release();
            await verified.cleanup();
            throw error;
        }
        reply.header('x-hub-read-receipt', String(fresh['read_receipt_id']));
        reply.header('content-type', 'application/octet-stream');
        const socket = reply.raw.socket;
        const socketBytesBefore = socket?.bytesWritten ?? 0;
        reply.raw.once('finish', () => { if (guarded.completeDelivery())
            void call(token, source, 'record_read', 'mem.read', { project_id: body.project_id, read_receipt_id: fresh['read_receipt_id'], state: 'sent' }).catch(() => request.log.warn({ error_code: 'read_receipt_pending' }, 'delivery evidence pending')); });
        reply.raw.once('close', () => {
            guarded.cancel('download_client_closed');
            request.log.info({ event: 'authorized_download_terminal', read_receipt_id: fresh['read_receipt_id'], ...guarded.snapshot(), application_budget: config.ioBudget?.status(), socket_bytes_written_delta: Math.max(0, (socket?.bytesWritten ?? socketBytesBefore) - socketBytesBefore), socket_bytes_include_headers: true, client_received_bytes_not_asserted: true }, 'fixed download terminal');
            void release();
            void outputCapacity?.release();
            void verified.cleanup();
        });
        transportStarted = true;
        delivery.pipe(guarded);
        return reply.send(guarded);
    });
    return app;
}
//# sourceMappingURL=server.js.map