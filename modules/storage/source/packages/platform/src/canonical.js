import { createHash } from 'node:crypto';
/** Stable JSON for fingerprints. Undefined, nonfinite numbers and objects with prototypes are rejected. */
export function canonical(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
        const record = value;
        return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
    }
    throw new TypeError('unsupported canonical JSON value');
}
export function digest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
//# sourceMappingURL=canonical.js.map