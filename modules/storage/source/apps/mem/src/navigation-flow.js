import {navigationRoutes} from './navigation-contracts.mjs';
import { bearer, DomainError } from '../../../packages/platform/src/http.js';
import { sourceFromRequest } from '../../../packages/platform/src/source.js';
export function registerMaterialNavigation(app, call) {
    for (const [path, name, schema] of navigationRoutes)
        app.post(path, async (request) => {
            const parsed = schema.safeParse(request.body);
            if (!parsed.success)
                throw new DomainError('invalid_input');
            return call(bearer(request), sourceFromRequest(request), name, 'mem.read', parsed.data);
        });
}
//# sourceMappingURL=navigation-flow.js.map