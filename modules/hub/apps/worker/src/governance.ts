/** Counts presence once per observed object. Whole JSON return is a separate usage path. */
export function propertyOccurrence(objects: readonly unknown[], options: { dynamicContainers?: readonly string[]; unknownObjects?: number } = {}) {
 const counts: Record<string, number> = Object.create(null) as Record<string, number>;
 let unknownPathsObjects = 0;
 const dynamic = new Set(options.dynamicContainers ?? []);
 for (const object of objects) {
  const seen = new Set<string>(); let incomplete = false;
  const visit = (value: unknown, path: string, depth: number): void => {
   if (depth > 20) { incomplete = true; return; }
   if (path) seen.add(path);
   if (Array.isArray(value)) { for (const item of value) visit(item, (path || '$') + '[*]', depth + 1); }
   else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
     const normalized = dynamic.has(path) ? '*' : key;
     if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(normalized) && normalized !== '*') { incomplete = true; continue; }
     visit(child, path ? path + '.' + normalized : normalized === '*' ? '$.*' : normalized, depth + 1);
    }
   }
  };
  visit(object, '', 0); if (incomplete) unknownPathsObjects++; for (const path of seen) counts[path] = (counts[path] ?? 0) + 1;
 }
 return { observed_objects: objects.length, unknown_objects: options.unknownObjects ?? 0, counts,
  coverage: 'supplied_snapshot_only', unknown_path_objects: unknownPathsObjects, path_coverage: unknownPathsObjects ? 'partial' : 'canonical_paths', request_usage: 'separate_recorded_logical_requests', adoption_effect: 'not_measured' };
}
