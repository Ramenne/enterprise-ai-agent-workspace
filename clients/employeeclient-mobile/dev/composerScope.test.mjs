import test from 'node:test';import assert from 'node:assert/strict';import {sameComposerScope} from '../src/chat/composerScope.mjs';
test('late busy/capture/active events from an old assistant, group or account cannot lock the new composer',()=>{
 assert.equal(sameComposerScope({account:'a',peer:'a'},'a','b'),false);assert.equal(sameComposerScope({account:'a',peer:''},'a','a'),false);assert.equal(sameComposerScope({account:'old',peer:'b'},'new','b'),false);assert.equal(sameComposerScope({account:'a',peer:'b'},'a','b'),true);assert.equal(sameComposerScope({account:'a',peer:''},'a',''),true);assert.equal(sameComposerScope({account:'',peer:''},'',''),false);
});
