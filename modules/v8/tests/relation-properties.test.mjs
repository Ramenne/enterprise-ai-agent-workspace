import test from 'node:test';
import assert from 'node:assert/strict';
const {relationProperties, attachRelationProperties, normalizeRelationProperties} =
  await import(process.env.RELATION_MODULE ?? '../apps/v8/src/relation-properties.ts');
const edge = (id, from, to, extra = {}) => ({id, from_work_id: from, to_work_id: to,
  basis: {explanation: `Used ${to}`, refs: []}, state: 'active', supersedes: null, ...extra});
const parse = value => Array.isArray(value) ? value : undefined;

test('cross-project links carry exact read parameters in both directions', () => {
  const row = edge('ab', 'A', 'B', {from_project_id:'PA',to_project_id:'PB',from_short_no:1,to_short_no:2});
  const a=relationProperties('A',[row],{complete:true}).outgoing[0];
  assert.deepEqual(a.read.arguments,{project_id:'PB',work_item_id:'B'});
  const b=relationProperties('B',[row],{complete:true}).incoming[0];
  assert.deepEqual(b.read.arguments,{project_id:'PA',work_item_id:'A'});
  assert.equal(b.short_no,1);
  assert.equal(Object.hasOwn(relationProperties('A',[edge('ab','A','B')],{complete:true}).outgoing[0],'read'),false);
});

test('authorized predecessor delivery closes corrected history without resurrecting old edges', () => {
  const old=edge('old','A','B');
  const corrected=edge('new','A','B',{state:'corrected',supersedes:'old',history:{items:[old],complete:true}});
  const original=structuredClone(corrected);
  const a=relationProperties('A',[corrected],{complete:true});
  assert.equal(a.outgoing.length,1);assert.deepEqual(a.outgoing[0].citations.map(x=>x.relation_id),['new']);
  assert.equal(a.coverage.complete,true);assert.equal(a.coverage.incomplete_history,false);
  assert.deepEqual(corrected,original);
});

test('bounded or denied history remains explicitly incomplete while current edge is usable', () => {
  const current=edge('new','A','B',{state:'corrected',supersedes:'missing',history:{items:[],complete:false}});
  const a=relationProperties('A',[current],{complete:true});
  assert.equal(a.outgoing.length,1);assert.equal(a.coverage.complete,false);assert.equal(a.coverage.incomplete_history,true);
});

test('direct forward and reverse links do not infer transitive citations', () => {
  const rows = [edge('ab', 'A', 'B'), edge('bc', 'B', 'C'), edge('da', 'D', 'A')];
  const a = relationProperties('A', rows, {complete: true});
  assert.deepEqual(a.outgoing.map(x => x.work_item_id), ['B']);
  assert.deepEqual(a.incoming.map(x => x.work_item_id), ['D']);
  const b = relationProperties('B', rows, {complete: true});
  assert.deepEqual(b.incoming.map(x => x.work_item_id), ['A']);
  assert.equal(a.coverage.automatic_transitivity, false);
});

test('one pair is grouped without losing distinct reasons or fixed file versions', () => {
  const one = edge('ab1', 'A', 'B', {basis: {explanation: 'Used decision', refs: [
    {fixed_ref: {material_id: 'file', version_id: 'v1', sha256: 'a'.repeat(64)}}]}});
  const two = edge('ab2', 'A', 'B', {basis: {explanation: 'Corrected result', refs: []}});
  const attrs = relationProperties('A', [one, two, one], {complete: true});
  assert.equal(attrs.outgoing.length, 1);
  assert.equal(attrs.outgoing[0].citations.length, 2);
  assert.equal(attrs.outgoing[0].citations[0].basis.refs[0].fixed_ref.version_id, 'v1');
});

test('withdrawal and replacement change current view, never mutate history', () => {
  const rows = [edge('old', 'A', 'B'), edge('withdraw', 'A', 'B', {state: 'withdrawn', supersedes: 'old'}),
    edge('new', 'A', 'C', {state: 'corrected', supersedes: 'withdraw'})];
  const before = structuredClone(rows);
  const attrs = relationProperties('A', rows, {complete: true});
  assert.deepEqual(attrs.outgoing.map(x => x.work_item_id), ['C']);
  assert.deepEqual(rows, before);
  assert.equal(relationProperties('B', rows, {complete: true}).incoming.length, 0);
});

test('unknown and truncated source coverage remains incomplete', () => {
  for (const coverage of [undefined, {complete: false}, {complete: false, authorization_complete: true}]) {
    assert.equal(relationProperties('A', [], coverage).coverage.complete, false);
  }
  const attrs = relationProperties('A', [edge('new', 'A', 'B', {supersedes: 'missing'})], {complete: true});
  assert.equal(attrs.coverage.complete, false);
  assert.equal(attrs.coverage.incomplete_history, true);
});

test('a malformed supersedes cannot hide a different sources valid citation', () => {
  const rows = [edge('first', 'A', 'B'), edge('bad', 'C', 'A', {supersedes: 'first'})];
  const attrs = relationProperties('A', rows, {complete: true});
  assert.equal(attrs.outgoing.length, 1);
  assert.equal(attrs.coverage.complete, false);
});

test('property input uses the original related ledger, retaining other properties and caller inputs', () => {
  const input = {work_item_id: 'A', expected_revision: 4, related: [], properties: {
    owner_note: 'retain', relations: [{work_item_id: 'B', basis: {explanation: 'Continued its decision', refs: []}}]},
    related_assessment: 'partial'};
  const original = structuredClone(input);
  const normalized = normalizeRelationProperties(input, parse);
  assert.deepEqual(normalized.related, input.properties.relations);
  assert.deepEqual(normalized.properties, {owner_note: 'retain'});
  assert.equal(normalized.expected_revision, 4);
  assert.equal(normalized.related_assessment, 'partial');
  assert.deepEqual(input, original);
});

test('new property rejects conflicting inputs, missing purposes, invalid arrays and self citations', () => {
  const alias = {properties: {relations: [{work_item_id: 'B', basis: {explanation: 'used'}}]}};
  assert.throws(() => normalizeRelationProperties({...alias, related: [{}]}, parse), /conflicting_relation_inputs/);
  assert.throws(() => normalizeRelationProperties({properties: {relations: {}}}, parse), /invalid_relation_properties/);
  for (const explanation of ['', '  ', null, {}, [], true]) {
    assert.throws(() => normalizeRelationProperties({properties: {relations: [{work_item_id: 'B', basis: {explanation}}]}}, parse), /relation_explanation_required/);
  }
  assert.throws(() => normalizeRelationProperties({work_item_id: 'B', ...alias}, parse), /self_relation_not_allowed/);
});

test('empty assessment is permitted; old related callers are not retroactively constrained', () => {
  const old = {related: [{work_item_id: 'B', basis: {refs: []}}]};
  assert.equal(normalizeRelationProperties(old, parse), old);
  const empty = normalizeRelationProperties({properties: {relations: []}, related_assessment: 'assessed'}, parse);
  assert.deepEqual(empty.related, []);
  assert.equal(empty.related_assessment, 'assessed');
  assert.equal(Object.hasOwn(empty, 'properties'), false);
});

test('property projection uses only delivered rows and does not invent inaccessible relations', () => {
  const delivered = {state: 'read', work_item: {id: 'A', short_no: 79},
    relations: [edge('ab', 'A', 'B')], coverage: {complete: false, authorization_complete: false}};
  const view = attachRelationProperties(delivered);
  assert.equal(view.work_item.properties.relations.outgoing.length, 1);
  assert.equal(view.work_item.properties.relations.coverage.complete, false);
  assert.equal(view.relations, delivered.relations);
  for (const response of [{state: 'failed'}, {state: 'read', work_item: {id: 'A'}}, {state: 'read', work_item: {id: 'A'}, relations: null}])
    assert.equal(attachRelationProperties(response), response);
});
