import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const script=ts.transpileModule(await readFile(new URL('../src/platform/deeplink.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'');
const {routeFromTarget}=new Function(script+';return {routeFromTarget};')();
const project='ad44cc0e-159e-4e0f-a5ca-73d3920240d9',work='57545c27-4b64-433b-aee3-60d9ea32b7a1';
test('native work notice opens exact authorized project/work detail; missing or retired IDs are not guessed',()=>{
 const expected={name:'work-detail',params:{id:work},query:{project,returnTo:'/notifications'}};
 assert.deepEqual(routeFromTarget({object_type:'work_item',object_id:work,snapshot:{project_id:project}}),expected);
 assert.deepEqual(routeFromTarget({kind:'hub_update',snapshot:{project_id:project,work_item_id:work}}),expected);
 assert.equal(routeFromTarget({object_type:'work_item',object_id:work}),null);
 assert.equal(routeFromTarget({object_type:'task',object_id:work}),null);
});
