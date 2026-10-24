import {projectScopeSchema as project,uploadOperationIdSchema,uploadControlSchemas} from './upload-contracts.mjs';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
function parse(s, b) { const result = s.safeParse(b); if (!result.success)
    throw new DomainError('invalid_input'); return result.data; }
export function registerUploads(app, adapter, call) {
    for (const route of Object.keys(uploadControlSchemas))
        app.post('/v2/uploads/:id/' + route, async (request) => {
            try {
                if (!adapter)
                    throw new DomainError('object_store_unconfigured', 503, true);
                const schema = uploadControlSchemas[route];
                const b = parse(schema, request.body);
                const operation_id = parse(uploadOperationIdSchema, request.params.id);
                const token = bearer(request);
                const source = sourceFromRequest(request);
                const control = (command, extra = {}) => call(token, source, 'upload_control', 'mem.upload', { ...b, operation_id, command, ...extra });
                const admitted = async (extra = {}) => { let result = await control('ticket', extra); if (result['state'] === 'ticket_wait' && result['mode'] === 'multipart') {
                    let parts;
                    try {
                        parts = await adapter.parts(String(result['staging_key']), String(result['upload_id']));
                    }
                    catch {
                        await control('list');
                        return { ...result, provider_observation: 'unavailable;not_inferred_uploaded' };
                    }
                    await control('parts_seen', { parts });
                    result = await control('ticket', extra);
                } return result; };
                const delivered = async (s, ticket, extra) => control('ticket_issued', { ...extra, ticket_generation: s['ticket_generation'], intent_epoch: s['intent_epoch'], signed_expires_at: ticket.expires_at });
                if (route === 'put-ticket' || route === 'multipart/begin') {
                    let s = await control('begin', { mode: route === 'put-ticket' ? 'put' : 'multipart' });
                    if (s['state'] === 'starting') {
                        const upload_id = route === 'put-ticket' ? null : await adapter.multipartBegin(String(s['staging_key']), operation_id);
                        s = await control('bind', { lease_token: s['lease_token'], upload_id });
                    }
                    if (route === 'multipart/begin')
                        return { operation_id, state: s['state'], part_size: s['part_size'], size: s['size'], lease_until: s['lease_until'], next_step: 'upload_authorized_parts' };
                    s = await admitted({ size: s['size'], part_number: 0 });
                    if (s['state'] === 'ticket_wait')
                        return { operation_id, ...s, publication_state: 'not_published' };
                    const ticket = await adapter.putTicket(String(s['staging_key']), Number(s['size']), operation_id, { expires_at: String(s['ticket_expires_at']) });
                    const final = await delivered(s, ticket, { size: s['size'], part_number: 0 });
                    return { operation_id, state: 'uploading', ticket, size: s['size'], admission: final['admission'], ticket_generation: s['ticket_generation'], publication_state: 'not_published' };
                }
                if (route === 'put/status') {
                    const s = await control('list');
                    if (s['mode'] !== 'put')
                        throw new DomainError('upload_mode_conflict', 409);
                    const receipt = await adapter.completed(String(s['staging_key']), operation_id, Number(s['size']));
                    const observed = receipt && s['state'] === 'open' ? await control('put_seen', { receipt }) : s;
                    return { operation_id, state: receipt ? 'staging_complete' : 'uploading', receipt, admission: observed['admission'], publication_state: 'not_published' };
                }
                if (route === 'put/complete') {
                    const s = await control('complete');
                    if (['completed', 'aborted'].includes(String(s['state'])))
                        return { operation_id, state: s['state'], receipt: s['receipt'], publication_state: 'not_published' };
                    if (s['mode'] !== 'put')
                        throw new DomainError('upload_mode_conflict', 409);
                    let receipt;
                    try { receipt = await adapter.completed(String(s['staging_key']), operation_id, Number(s['size'])); }
                    catch(error) { if(error instanceof DomainError && error.code==='staging_object_mismatch') await control('validation_failed',{lease_token:s['lease_token'],reason:'staging_object_mismatch'});throw error; }
                    if (!receipt)
                        throw new DomainError('staging_upload_incomplete', 409);
                    const result = await control('finish', { lease_token: s['lease_token'], receipt });
                    return { operation_id, state: result['state'], receipt: result['receipt'], admission: result['admission'], publication_state: 'not_published' };
                }
                if (route === 'multipart/part-ticket') {
                    const s = await admitted();
                    if (s['mode'] !== 'multipart')
                        throw new DomainError('upload_mode_conflict', 409);
                    if (s['state'] === 'ticket_wait')
                        return { operation_id, ...s, publication_state: 'not_published' };
                    const ticket = await adapter.partTicket(String(s['staging_key']), String(s['upload_id']), Number(b['part_number']), Number(b['size']), { expires_at: String(s['ticket_expires_at']) });
                    const final = await delivered(s, ticket, {});
                    return { operation_id, state: 'uploading', part_number: b['part_number'], ticket, admission: final['admission'], ticket_generation: s['ticket_generation'], publication_state: 'not_published' };
                }
                if (route === 'multipart/list' || route === 'multipart/resume') {
                    const s = await control(route.endsWith('resume') ? 'resume' : 'list');
                    if (['completed', 'aborted'].includes(String(s['state'])))
                        return { operation_id, state: s['state'], receipt: s['receipt'], publication_state: 'not_published' };
                    if (s['mode'] !== 'multipart')
                        throw new DomainError('upload_mode_conflict', 409);
                    let parts;
                    try {
                        parts = await adapter.parts(String(s['staging_key']), String(s['upload_id']));
                    }
                    catch (error) {
                        if (error.$metadata?.httpStatusCode !== 404)
                            throw error;
                        const receipt = await adapter.completed(String(s['staging_key']), operation_id, Number(s['size']));
                        if (!receipt)
                            throw new DomainError('multipart_provider_state_unknown', 503, true);
                        if (s['state'] === 'completing') {
                            if (new Date(String(s['lease_until'])).getTime() <= Date.now())
                                return { operation_id, state: 'provider_completed_sql_pending', receipt, publication_state: 'not_published', next_step: 'complete_to_record_provider_receipt' };
                            const recovered = await control('finish', { lease_token: s['lease_token'], receipt });
                            return { operation_id, state: recovered['state'], receipt, publication_state: 'not_published' };
                        }
                        return { operation_id, state: 'provider_completed_sql_pending', receipt, publication_state: 'not_published', next_step: 'complete_to_record_provider_receipt' };
                    }
                    const observed = s['state'] === 'open' ? await control('parts_seen', { parts }) : s;
                    return { operation_id, state: s['state'], parts, admission: observed['admission'], part_size: s['part_size'], expected_size: s['size'], publication_state: 'not_published' };
                }
                const command = route.endsWith('abort') ? 'abort' : 'complete';
                const s = await control(command);
                if (['completed', 'aborted'].includes(String(s['state'])))
                    return { operation_id, state: s['state'], receipt: s['receipt'], publication_state: 'not_published' };
                if (s['mode'] !== 'multipart')
                    throw new DomainError('upload_mode_conflict', 409);
                const receipt = command === 'abort' ? await adapter.abort(String(s['staging_key']), String(s['upload_id']), operation_id, Number(s['size'])) : await adapter.complete(String(s['staging_key']), String(s['upload_id']), operation_id, Number(s['size']), Number(s['part_size']));
                const result = await control('finish', { lease_token: s['lease_token'], receipt });
                return { operation_id, state: result['state'], receipt: result['receipt'], admission: result['admission'], publication_state: 'not_published', next_step: command === 'abort' ? 'upload_cancelled' : 'publish_with_final_hash_verification' };
            }
            catch (error) {
                if (error instanceof DomainError)
                    throw error;
                const status = error.$metadata?.httpStatusCode;
                if (status !== undefined)
                    throw new DomainError(status === 403 ? 'object_store_forbidden' : status === 404 ? 'object_store_state_unknown' : 'object_store_unavailable', 503, status !== 403);
                throw error;
            }
        });
    app.post('/v2/materials/gc-candidates', async (request) => { const body = parse(project, request.body); return call(bearer(request), sourceFromRequest(request), 'gc_candidates', 'mem.delete', body); });
}
