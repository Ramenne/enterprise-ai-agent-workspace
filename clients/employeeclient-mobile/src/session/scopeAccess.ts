// A persisted denial is a cache barrier, not a replacement for server authorization.
const denied = new Set<string>();
const key = (a: string) => 'qn.scope-denied.personal.' + a;
export function holdPersonal(a: string): void { if (a) denied.add(a); }
export function personalDenied(a: string): boolean {
  if (denied.has(a)) return true;
  try { return localStorage.getItem(key(a)) === '1'; } catch { return false; }
}
export function denyPersonal(a: string): void {
  denied.add(a);
  // Write barrier before asynchronous IDB cleanup; restart cannot rehydrate stale records.
  localStorage.setItem(key(a), '1');
}
export function allowPersonal(a: string): void {
  localStorage.removeItem(key(a)); denied.delete(a);
}
export function isPersonalRecord(r: Record<string, unknown>): boolean {
  if (!r || typeof r !== 'object') return false;
  return r.scope === 'personal' || r.scope_at_creation === 'personal'
    || (r.snapshot as { scope?: string } | undefined)?.scope === 'personal';
}
