// Business snapshots come from JSON APIs. Persist plain values, never Vue
// proxies: IndexedDB's structured clone cannot store reactive objects.
export function jsonSnapshot(value) {
 return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
