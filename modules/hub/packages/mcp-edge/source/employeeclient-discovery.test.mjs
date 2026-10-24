import test from 'node:test';import assert from 'node:assert/strict';
import {employeeclientTool} from './employeeclient-tool.mjs';import {catalogue,defaultNames} from './disclosure.mjs';import {resolveIntent,employeeclientIntentScore} from './intent-resolution.mjs';
const other=[{name:'v8.work.search',description:'查询工作与项目任务'},{name:'hub.work.find',description:'按编号查找工作'},{name:'hub.cooperation.submit',description:'Submit project cooperation using work and project'}];
const all=[...other,employeeclientTool];
test('normal connection exposes one EmployeeClient tool and its action schema without Skills',()=>{
 const visible=all.filter(t=>defaultNames.has(t.name));assert.equal(visible.filter(x=>x.name==='employeeclient').length,1);
 assert.ok(visible.find(x=>x.name==='employeeclient').inputSchema.properties.action.enum.includes('send'));
});
test('group discovery directly locates EmployeeClient; unrelated catalogs stay separated',()=>{
 const groups=catalogue(all);assert.equal(groups.groups.find(x=>x.id==='employeeclient').tools_count,1);
 assert.deepEqual(catalogue(all,{group:'employeeclient'}).items.map(x=>x.name),['employeeclient']);
 assert.ok(!catalogue(all,{group:'work'}).items.some(x=>x.name==='employeeclient'));
});
test('Chinese and English send/read intents select EmployeeClient instead of work records',()=>{
 for(const intent of ['把整理结果发到员工客户端工作群','把这个发到员工客户端','发到工作群','查看员工客户端消息','把菜单整理好发送到公司工作群','传给文件传输助手','Send this summary to EmployeeClient','read EmployeeClient messages']){
  const r=resolveIntent(all,{intent,limit:1});assert.equal(r.candidates[0]?.name,'employeeclient',intent);assert.equal(r.arguments,undefined);assert.equal(r.mode,'read');
 }
});
test('routing remains catalog-bounded and does not turn source maintenance into sending',()=>{
 assert.equal(resolveIntent(other,{intent:'发到员工客户端',limit:1}).candidates.some(x=>x.name==='employeeclient'),false);
 assert.equal(employeeclientIntentScore('修复员工客户端登录页面布局'),0);assert.equal(employeeclientIntentScore('查询项目工作记录'),0);
 assert.equal(resolveIntent(all,{intent:'查询工作',limit:1}).candidates[0].name,'v8.work.search');
});
