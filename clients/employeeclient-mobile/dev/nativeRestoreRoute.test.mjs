import test from 'node:test';import assert from 'node:assert/strict';
import {restoredRoute} from '../src/app/restore-route.mjs';
test('restore preserves chat and fixed project/deep links without opening a foreign destination',()=>{
 for(const path of ['/chat','/files?project=actual-project','/notifications?focus=n'])assert.equal(restoredRoute(path),path);
 for(const value of [undefined,'','/connect','/connect?redirect=/chat','https://foreign.test','//foreign.test',['/files']])assert.equal(restoredRoute(value),'/messages');
});
