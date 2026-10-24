import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/ui/views/ChatView.vue',import.meta.url),'utf8');
const start=source.indexOf(' viewResumeScope={account,peer:target};');
const end=source.indexOf(' entryUnread.value=',start);
assert.ok(start>=0&&end>start,'conversation entry block exists');
const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
// User contract: ordinary entry opens latest, rather than replaying a prior filter/anchor.
test('conversation entry discards stale recovery preference and error without a cache request',()=>{
 const enter=new Function('account','target',`let viewResumeScope=null,pendingViewResume={peer:'old'},viewResumeReady=false;const viewResumeError={value:'old cache failure'};${code};return {viewResumeScope,pendingViewResume,viewResumeReady,error:viewResumeError.value};`);
 assert.deepEqual(enter('a','new'),{viewResumeScope:{account:'a',peer:'new'},pendingViewResume:null,viewResumeReady:true,error:''});
});
