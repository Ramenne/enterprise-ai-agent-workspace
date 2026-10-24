import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWorkJudgment,attachWorkJudgment,assessWorkJudgment,expandCurrentWorkJudgment} from '../dist/apps/v8/src/work-judgment.js';
const current='8662ae87-2e86-405e-aa76-c2b6e807b0b1';
const other='29c081d9-ff48-41c9-adbf-31b0b19c36b4';
const body=(decision,reason,more={})=>({work_item_id:current,related:[],properties:{kept:'value',work_judgment:{decision,reason,compared_work_ids:[]}},...more});
test('missing boundary assessment stays usable but is never claimed assessed',()=>{
 const input={work_item_id:current,properties:{note:'retained'},related:[]};const before=JSON.stringify(input);
 const r=normalizeWorkJudgment(input);const a=assessWorkJudgment(r);
 assert.equal(JSON.stringify(r),before);assert.equal(a.decision,'undetermined');assert.ok(a.warnings.includes('work_boundary_not_assessed'));
});
test('writing iteration can continue the same work without creating a relation',()=>{
 const r=normalizeWorkJudgment(body('continuation','Same writing objective; this is a revised draft',{goal:'Reworded article title'}));
 assert.equal(r.work_item_id,current);assert.equal(r.properties.work_judgment.decision,'continuation');assert.deepEqual(r.related,[]);
});
test('a new work declaration cannot append to the same reviewed old candidate',()=>{
 assert.throws(()=>normalizeWorkJudgment({work_item_id:current,properties:{work_judgment:{decision:'new_work',reason:'Independent output',compared_work_ids:[current]}}}),/new_work_target_is_existing_candidate/);
});
test('a newly opened distinct work can declare new_work and separately cite reviewed work',()=>{
 const links=[{work_item_id:other,basis:{explanation:'Its conclusion directly changed the current outline'}}];
 const r=normalizeWorkJudgment({work_item_id:current,related:links,properties:{work_judgment:{decision:'new_work',reason:'Independent deliverable',compared_work_ids:[other]}}});
 assert.equal(r.properties.work_judgment.decision,'new_work');assert.deepEqual(r.related,links);
});
test('same-work continuation and an actual citation can coexist',()=>{
 const links=[{work_item_id:other,basis:{explanation:'Actually used its argument in this revision'}}];
 const r=normalizeWorkJudgment(body('continuation','Same article',{related:links}));assert.deepEqual(r.related,links);
});
test('unsupported decisions are rejected without silently changing work identity',()=>{
 assert.throws(()=>normalizeWorkJudgment(body('same_project','No goal comparison')),/invalid_work_judgment_decision/);
 assert.throws(()=>normalizeWorkJudgment(body(['continuation'],'No string decision')),/invalid_work_judgment_decision/);
});
test('missing reasoning is explicitly pending rather than blocking work preservation',()=>{
 const r=assessWorkJudgment(body('continuation',' '));assert.equal(r.decision,'undetermined');assert.equal(r.declared_decision,'continuation');
});
test('incomplete basis is flagged pending without rewriting the original declaration/idempotency input',()=>{
 const r=normalizeWorkJudgment(body('continuation','Same output',{related:[{work_item_id:other,basis:{refs:[]}}],related_assessment:'assessed'}));
 assert.equal(r.related_assessment,'assessed');assert.equal(r.related.length,1);const a=assessWorkJudgment(r);assert.equal(a.relationship_basis_status,'pending');assert.ok(a.warnings.includes('relationship_basis_pending'));
});
test('legacy top-level self-relation is rejected just as the property alias is',()=>{
 assert.throws(()=>normalizeWorkJudgment(body('continuation','Same output',{related:[{work_item_id:current,basis:{explanation:'self'}}]})),/self_relation_not_allowed/);
});
test('read uses only the current authorized stage, never an older stage to pretend current assessment',()=>{
 const result={state:'read',work_item:{id:current,revision:3},updates:[{work_revision:2,statement:{properties:{work_judgment:{decision:'continuation',reason:'Old'}}}}]};
 const r=attachWorkJudgment(result,'work_read');assert.equal(r.work_judgment.decision,'undetermined');assert.equal(r.work_item.properties.work_judgment.evidence,'not_returned_use_work_read_or_assess');
});
test('read and continuation view preserve actual relationships independently of boundary judgment',()=>{
 const result={state:'read',work_item:{id:current,revision:3,properties:{relations:{outgoing:[{work_item_id:other}]}}},updates:[{work_revision:3,statement:{properties:{work_judgment:{decision:'continuation',reason:'Same article'}}}}]};
 const r=attachWorkJudgment(result,'work_read');assert.equal(r.work_judgment.decision,'continuation');assert.equal(r.work_item.properties.relations.outgoing[0].work_item_id,other);
});
test('CAS refusal is not exposed as a saved work judgment',()=>{
 const r=attachWorkJudgment({state:'conflict'},'work_save',normalizeWorkJudgment(body('continuation','Same output')));assert.equal(r.work_judgment.evidence,'not_confirmed_saved');
});

test('large report descriptor reads a bounded judgment instead of report bytes',async()=>{
 const raw={state:'read',work_item:{id:current,project_id:other,revision:4},updates:[{statement_id:other,sha256:'abc',work_revision:4,size:500000}]};
 const expanded=await expandCurrentWorkJudgment(raw,async b=>{assert.equal(b.expected_revision,4);assert.equal(b.limit,undefined);return {state:'read',work_item_id:current,work_revision:4,statement_id:other,statement_sha256:'abc',judgment:{decision:'continuation',reason:'Same delivery'},reason_truncated:false}});
 const r=attachWorkJudgment(raw,'work_read',undefined,expanded);assert.equal(r.work_judgment.decision,'continuation');assert.equal(r.work_judgment.source_work_revision,4);assert.equal(raw.updates[0].statement,undefined);
});
test('restricted or mismatched projections never become current declared judgment',async()=>{
 const raw={state:'read',work_item:{id:current,project_id:other,revision:4},updates:[{statement_id:other,sha256:'abc',work_revision:4}]};
 const good={state:'read',work_item_id:current,work_revision:4,statement_id:other,statement_sha256:'abc',judgment:{decision:'continuation',reason:'Same'}};
 for(const bad of [{...good,state:'pending'},{...good,work_revision:5},{...good,statement_sha256:'wrong'},{...good,work_item_id:other}])assert.equal(await expandCurrentWorkJudgment(raw,async()=>bad),raw);
});
