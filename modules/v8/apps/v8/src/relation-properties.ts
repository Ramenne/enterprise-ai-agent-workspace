/** A property view of the existing direct-relation ledger, never a second ledger. */
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export class RelationPropertyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

function hasExplanation(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasExplanation);
  return object(value) && Object.values(value).some(hasExplanation);
}

/** Convert an explicitly supplied property into the already authorized work write. */
export function normalizeRelationProperties(
  body: JsonObject,
  parse: (value: unknown) => JsonObject[] | undefined,
): JsonObject {
  const properties = body['properties'];
  if (!object(properties) || !Object.hasOwn(properties, 'relations')) return body;
  if (Array.isArray(body['related']) && body['related'].length > 0)
    throw new RelationPropertyError('conflicting_relation_inputs');
  const relations = parse(properties['relations']);
  if (!relations) throw new RelationPropertyError('invalid_relation_properties');
  for (const relation of relations) {
    const basis = relation['basis'];
    if (!object(basis) || !hasExplanation(basis['explanation']))
      throw new RelationPropertyError('relation_explanation_required');
    if (body['work_item_id'] !== undefined && relation['work_item_id'] === body['work_item_id'])
      throw new RelationPropertyError('self_relation_not_allowed');
  }
  const rest = { ...properties };
  delete rest['relations'];
  const normalized: JsonObject = { ...body, related: relations };
  if (Object.keys(rest).length > 0) normalized['properties'] = rest;
  else delete normalized['properties'];
  return normalized;
}

interface Relation {
  id: string;
  from_work_id: string;
  to_work_id: string;
  basis: JsonObject;
  state: string;
  supersedes: string | null;
  from_project_id?: string;
  to_project_id?: string;
  from_short_no?: number;
  to_short_no?: number;
  history?: {items?: unknown[]; complete?: boolean};
}
function relation(value: unknown): value is Relation {
  return object(value) && ['id', 'from_work_id', 'to_work_id'].every(k => typeof value[k] === 'string')
    && object(value['basis']) && ['active', 'corrected', 'withdrawn'].includes(String(value['state']))
    && (value['supersedes'] === null || typeof value['supersedes'] === 'string');
}

/** Input must be the existing work_read's current-authorized relation view. */
export function relationProperties(workId: string, rows: unknown[], sourceCoverage: unknown): JsonObject {
  // History is supplied only by the guarded domain read, never inferred by clients.
  const delivered = rows.flatMap(row => relation(row) ? [row, ...(Array.isArray(row.history?.items) ? row.history.items : [])] : [row]);
  const valid = [...new Map(delivered.filter(relation).filter(r => r.from_work_id !== r.to_work_id).map(r => [r.id, r])).values()];
  const byId = new Map(valid.map(r => [r.id, r]));
  const superseded = new Set<string>();
  let incomplete = delivered.some(row => !relation(row) || row.from_work_id === row.to_work_id) || rows.some(row => relation(row) && row.history?.complete === false);
  for (const row of valid) {
    if (!row.supersedes) continue;
    const predecessor = byId.get(row.supersedes);
    // Never suppress another source's edge on a malformed historical claim.
    if (!predecessor || predecessor.from_work_id !== row.from_work_id) {
      incomplete = true;
      continue;
    }
    const visited = new Set([row.id]);
    let current: Relation | undefined = predecessor;
    let cycle = false;
    while (current) {
      if (visited.has(current.id)) { cycle = true; break; }
      visited.add(current.id);
      current = current.supersedes ? byId.get(current.supersedes) : undefined;
    }
    if (cycle) { incomplete = true; continue; }
    superseded.add(predecessor.id);
  }
  const outgoing = new Map<string, JsonObject>();
  const incoming = new Map<string, JsonObject>();
  for (const row of valid) {
    if (superseded.has(row.id) || row.state === 'withdrawn') continue;
    const isOutgoing = row.from_work_id === workId;
    if (!isOutgoing && row.to_work_id !== workId) continue;
    const otherId = isOutgoing ? row.to_work_id : row.from_work_id;
    const group = isOutgoing ? outgoing : incoming;
    let link = group.get(otherId);
    if (!link) {
      link = { work_item_id: otherId, direction: isOutgoing ? 'cites' : 'cited_by', citations: [] };
      const projectId = isOutgoing ? row.to_project_id : row.from_project_id;
      const shortNo = isOutgoing ? row.to_short_no : row.from_short_no;
      if (projectId) {
        link['project_id'] = projectId;
        link['read'] = {tool: 'v8.work.read', arguments: {project_id: projectId, work_item_id: otherId}};
      }
      if (shortNo !== undefined) link['short_no'] = shortNo;
      group.set(otherId, link);
    }
    // Multiple real citations between the same pair remain distinct evidence.
    const citations = link['citations'] as JsonObject[];
    if (!citations.some(c => c['relation_id'] === row.id))
      citations.push({ relation_id: row.id, basis: row.basis, state: row.state, supersedes: row.supersedes,
        ...(row.history ? {history: row.history} : {}) });
  }
  const coverage = object(sourceCoverage) ? sourceCoverage : {};
  return {
    outgoing: [...outgoing.values()], incoming: [...incoming.values()],
    semantics: 'direct_citations_only', authority: 'existing_authorized_work_relations',
    coverage: { complete: coverage['complete'] === true && !incomplete,
      source_coverage: coverage, incomplete_history: incomplete,
      scope: 'returned_current_authorized_relations', automatic_transitivity: false },
  };
}

export function attachRelationProperties(result: JsonObject): JsonObject {
  const work = result['work_item'];
  if (result['state'] !== 'read' || !object(work) || typeof work['id'] !== 'string'
    || !Array.isArray(result['relations'])) return result;
  return { ...result, work_item: { ...work, properties: {
    relations: relationProperties(work['id'], result['relations'], result['coverage']),
  } } };
}
