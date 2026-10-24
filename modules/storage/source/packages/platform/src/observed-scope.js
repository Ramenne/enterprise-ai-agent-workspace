import { AsyncLocalStorage } from 'node:async_hooks';
const current = new AsyncLocalStorage();
const requests = new WeakMap();
/** Lives in the HTTP continuation, never in caller-supplied body/source fields. */
export function beginObservedScope(request, continueRequest) {
    const scope = { handles: new Set() };
    requests.set(request, scope);
    current.run(scope, continueRequest);
}
export function recordSuccessfulCapability(args) {
    if (args.length !== 3 || typeof args[0] !== 'string' || !/^[0-9a-f-]{36}$/i.test(args[0]) || typeof args[1] !== 'string' || !/^[0-9a-f]{64}$/.test(args[1]) || typeof args[2] !== 'string')
        return;
    // SQL validates whether this is a real, consumed handle for this service.
    current.getStore()?.handles.add(args[0]);
}
export function observedHandles(request) { return [...(requests.get(request)?.handles ?? [])]; }
//# sourceMappingURL=observed-scope.js.map