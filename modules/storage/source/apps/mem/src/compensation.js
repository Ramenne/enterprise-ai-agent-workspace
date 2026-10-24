import {infrastructureFailure} from '../../../packages/platform/src/failure-contract.mjs';
import {compensationSchemas} from './effect-contracts.mjs';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
export function registerCompensation(app, call) {
    app.post('/v2/compensations/plan', async (request) => { const parsed = compensationSchemas.plan.safeParse(request.body); if (!parsed.success)
        throw new DomainError('invalid_input'); return call(bearer(request), sourceFromRequest(request), 'compensation_plan', 'mem.read', parsed.data); });
    app.post('/v2/compensations/apply', async (request) => {
        const parsed = compensationSchemas.apply.safeParse(request.body);
        if (!parsed.success)
            throw new DomainError('invalid_input');
        const { choices, ...body } = parsed.data;
        const results = [];
        for (let index = 0; index < choices.length; index++) {
            const selected = choices[index];
            const { action, ...choice } = selected;
            try {
                const result = await call(bearer(request), sourceFromRequest(request), 'compensation_apply', action, { ...body, ...choice, idempotency_key: body.idempotency_key + ':' + index });
                results.push({ index, ...result });
            }
            catch (error) {
                const e = error;
                results.push({ index, state: 'failed', error_code: error instanceof DomainError ? error.code : infrastructureFailure(e)?.code ?? (e.code === '40001' ? 'revision_conflict' : 'compensation_unassessed'), retained_state: 'later_writes_and_prior_successful_items_preserved' });
            }
        }
        return { state: results.some(x => ['failed', 'conflict', 'partial'].includes(String(x.state))) ? 'partial' : 'compensated', items: results, coverage: 'all_agent_selected_items_attempted' };
    });
}
//# sourceMappingURL=compensation.js.map