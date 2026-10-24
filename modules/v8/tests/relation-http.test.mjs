// Route/contract tests with explicitly synthetic authorization and SQL fixtures.
// Real permission/DB behavior is recorded separately, never inferred from these tests.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer} from '../dist/apps/v8/src/server.js';
const project = 'cfe3f0af-af84-4c63-a0d6-2d0677caaddd';
const work = '8662ae87-2e86-405e-aa76-c2b6e807b0b1';
const other = '29c081d9-ff48-41c9-adbf-31b0b19c36b4';
const handle = 'e42b7954-4934-4a5e-a23e-dcbc1ffd7b1f';
const calls = [];
const decisions = [];
let deny = false;
let conflict = false;
const identityFixture = httpServer(async (req, res) => {
  const bytes = [];
  for await (const chunk of req) bytes.push(chunk);
  decisions.push(JSON.parse(Buffer.concat(bytes).toString()));
  res.writeHead(deny ? 403 : 200, {'content-type': 'application/json'});
  res.end(JSON.stringify(deny ? {error_code: 'forbidden'} : {handle}));
});
await new Promise(resolve => identityFixture.listen(0, '127.0.0.1', resolve));
const poolFixture = {
  async query(sql, args) {
    if (sql.includes('evidence.record_usage_scoped')) return {rows: [{result: {state: 'recorded'}}]};
    calls.push({sql, args});
    if (sql.includes('v8.work_mark_read')) return {rows: [{result: {state: 'recorded'}}]};
    if (sql.includes('v8.work_read')) return {rows: [{result: {
      state: 'read', work_item: {id: work, short_no: 42, project_id: project, revision: 3},
      relations: [{id: handle, from_work_id: work, to_work_id: other, state: 'active', supersedes: null,
        basis: {explanation: 'Used its decision', refs: []}}], coverage: {complete: false},
    }}]};
    return {rows: [{result: conflict ? {state: 'conflict'} : {state: 'saved', short_no: 42}}]};
  },
};
const app = createServer({pool: poolFixture, databaseUrl: '',
  hufuUrl: `http://127.0.0.1:${identityFixture.address().port}`,
  serviceKey: 'synthetic-test-transport', audience: 'v8'});
await app.ready();
after(async () => {await app.close(); await new Promise(resolve => identityFixture.close(resolve));});
const headers = {authorization: 'Bearer synthetic-test-transport'};
const write = (properties, more = {}) => ({project_id: project, work_item_id: work,
  expected_revision: 3, idempotency_key: 'synthetic-property-test', properties, ...more});

test('HTTP property input is authorized and saved in exactly the existing related write path', async () => {
  calls.length = 0; decisions.length = 0;
  const citation = {work_item_id: other, basis: {explanation: 'Used its decision', refs: []}};
  const response = await app.inject({method: 'POST', url: '/v2/work-items/save', headers,
    payload: write({relations: [citation], note: 'kept'})});
  assert.equal(response.statusCode, 200);
  const call = calls.find(x => x.sql.includes('v8.work_save'));
  assert.ok(call);
  const saved = JSON.parse(call.args[2]);
  assert.equal(saved.related[0].work_item_id, other);
  assert.equal(saved.related[0].basis.explanation, 'Used its decision');
  assert.deepEqual(saved.properties, {note: 'kept'});
  assert.equal(saved.expected_revision, 3);
  assert.equal(decisions[0].action, 'v8.work.commit');
  assert.equal(decisions[0].request_digest, call.args[1]);
});

test('invalid new attributes are rejected before authorization or SQL effects', async () => {
  for (const relations of [{}, [{work_item_id: 'bad', basis: {explanation: 'used'}}],
    [{work_item_id: other, basis: {explanation: ' '}}],
    [{work_item_id: work, basis: {explanation: 'self'}}],
    [{work_item_id: other, basis: {explanation: 'used'}, unknown: true}]]) {
    calls.length = 0; decisions.length = 0;
    const response = await app.inject({method: 'POST', url: '/v2/work-items/save', headers,
      payload: write({relations})});
    assert.equal(response.statusCode, 400);
    assert.equal(calls.length, 0);
    assert.equal(decisions.length, 0);
  }
});

test('attribute writes keep authentication denial and CAS conflict behavior', async () => {
  deny = true; calls.length = 0;
  const response = await app.inject({method: 'POST', url: '/v2/work-items/save', headers,
    payload: write({relations: [{work_item_id: other, basis: {explanation: 'used'}}]})});
  assert.equal(response.statusCode, 403);
  assert.equal(calls.length, 0);
  deny = false; conflict = true;
  const clash = await app.inject({method: 'POST', url: '/v2/work-items/save', headers,
    payload: write({relations: []})});
  assert.equal(clash.statusCode, 409);
  conflict = false;
});

test('POST and GET work read both expose direct attributes and preserve incomplete coverage', async () => {
  for (const request of [{method: 'POST', url: '/v2/work-items/read', payload: {project_id: project, work_item_id: work}},
    {method: 'GET', url: `/v2/work-items/${work}?project_id=${project}`}]) {
    const response = await app.inject({...request, headers});
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.relations.length, 1);
    assert.equal(body.work_item.properties.relations.outgoing[0].work_item_id, other);
    assert.equal(body.work_item.properties.relations.incoming.length, 0);
    assert.equal(body.work_item.properties.relations.coverage.complete, false);
  }
});

test('legacy related requests retain their original route and can omit an explanation', async () => {
  calls.length = 0;
  const response = await app.inject({method: 'POST', url: '/v2/work-items/commit', headers,
    payload: write({note: 'kept'}, {related: [{work_item_id: other, basis: {refs: []}}]})});
  assert.equal(response.statusCode, 200);
  const call = calls.find(x => x.sql.includes('v8.work_commit'));
  assert.ok(call);
  assert.equal(JSON.parse(call.args[2]).related[0].work_item_id, other);
});

test('global v2 policy is identical in discovery, save, read and search responses', async () => {
  const discovery=await app.inject({method:'GET',url:'/v2/work-items/judgment-policy'});
  assert.equal(discovery.statusCode,200);
  const policy=discovery.json();
  assert.equal(policy.version,'v8-work-identity-v2');
  assert.equal(policy.granularity.automatic_scoring,false);
  assert.ok(policy.granularity.avoid_too_broad);
  assert.ok(policy.granularity.avoid_too_fine);
  assert.ok(policy.adoption);
  for(const [url,payload] of [
    ['/v2/work-items/save',write({work_judgment:{decision:'continuation',reason:'Same concrete result',compared_work_ids:[work]}})],
    ['/v2/work-items/read',{project_id:project,work_item_id:work}],
    ['/v2/work-items/search',{project_id:project,query:'result',limit:5}]
  ]) {
    const response=await app.inject({method:'POST',url,headers,payload});
    assert.equal(response.statusCode,200);
    assert.deepEqual(response.json().work_policy,policy);
  }
});
test('refined guidance does not synthesize links or rewrite legacy submitted judgment bytes', async () => {
  calls.length=0;
  const payload=write({work_judgment:{decision:'continuation',reason:'Fix a defect in the same result',compared_work_ids:[work]}});
  const response=await app.inject({method:'POST',url:'/v2/work-items/save',headers,payload});
  assert.equal(response.statusCode,200);
  const saved=JSON.parse(calls.find(x=>x.sql.includes('v8.work_save')).args[2]);
  assert.deepEqual(saved.related,[]);
  assert.deepEqual(saved.properties.work_judgment,payload.properties.work_judgment);
  assert.equal(saved.work_item_id,work);
});
