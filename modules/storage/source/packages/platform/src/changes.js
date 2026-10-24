import { installProjectEventStream } from './project-event-stream.mjs';
import {changeSchemas} from './change-contracts.js';
import { bearer, DomainError } from './http.js';
import { sourceFromRequest } from './source.js';
import { decide } from './decision.js';
import { canonical, digest } from './canonical.js';
import { transaction } from './db.js';
/** Durable optional change polling; notifications and caches are not access authority. */
export function installChanges(app, pool, config) {
    const authorize=async(request,project_id)=>{
        const body={project_id};return decide(config,bearer(request),config.audience==='mem'?'mem.read':'v8.project.read',body,body,sourceFromRequest(request));
    };
    installProjectEventStream(app,pool,{authorize,snapshot:async(request,project_id)=>{
        const body={project_id},handle=await authorize(request,project_id);
        return transaction(pool,async client=>{
            await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            const result=(await client.query('SELECT evidence.project_snapshot($1,$2,$3) AS result',[handle.handle,digest(body),canonical(body)])).rows[0]?.result;
            return {...result,cursor:result.delivery_highwater};
        });
    }});
    for (const snapshot of [true, false])
        app.post(snapshot ? '/v2/changes/snapshot' : '/v2/changes', async (request) => {
            const schema=snapshot?changeSchemas.snapshot:changeSchemas.poll;
            const parsed = schema.safeParse(request.body);
            if (!parsed.success)
                throw new DomainError('invalid_input');
            const body = parsed.data;
            const action = config.audience === 'mem' ? 'mem.read' : 'v8.project.read';
            const handle = await decide(config, bearer(request), action, body, body, sourceFromRequest(request));
            return transaction(pool, async (client) => {
                if (snapshot)
                    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
                const name = snapshot ? 'evidence.project_snapshot' : 'evidence.project_changes';
                const result=(await client.query('SELECT ' + name + '($1,$2,$3) AS result', [handle.handle, digest(body), canonical(body)])).rows[0]?.['result'];
                return snapshot&&result?{...result,cursor:result.delivery_highwater,continuation:{tool:'hub.changes',arguments:{project_id:body.project_id,cursor:result.delivery_highwater}}}:result;
            });
        });
}
//# sourceMappingURL=changes.js.map