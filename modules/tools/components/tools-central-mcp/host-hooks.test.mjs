import test from 'node:test';
import assert from 'node:assert/strict';
import {createToolsHooks} from './host-hooks.mjs';

test('host hooks preserve current request identity and MCP result/error envelopes',async()=>{
 const expected={authorization:'Bearer synthetic-fixture-only',actorId:'fixture'},request={fixture:true};
 const hooks=createToolsHooks({getCaller:async r=>{assert.equal(r,request);return expected;},adapter:{prefix:'tools.api.',catalog:async c=>{assert.equal(c,expected);return{tools:[{name:'tools.api.fixture'}]};},invoke:async(c,name,args)=>{assert.equal(c,expected);assert.equal(name,'tools.api.fixture');assert.equal(args.owner,'untrusted-model-value');return{value:{state:'failed',error_code:'fixture_rejected'},isError:true};}}});
 assert.equal((await hooks.listTools(request))[0].name,'tools.api.fixture');
 const result=await hooks.callTool(request,'tools.api.fixture',{owner:'untrusted-model-value'});
 assert.equal(result.isError,true);assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
});
test('host hook requires explicit authenticated caller extraction',()=>{
 assert.throws(()=>createToolsHooks(),/host_authenticated_caller_extractor_required/);
});
