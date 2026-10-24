import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeChatMessages,applyChatChanges} from '../src/chat/projection.ts';
const original=(change_version=1,extra={})=>({id:'original',seq:1,body:'original bytes',change_version,reply_to:null,...extra});
const reply=(quote=original())=>({id:'reply',seq:100,body:'reply body',change_version:2,reply_to:quote});
test('off-window recall updates a quoted snapshot without inserting a history prefix',()=>{
 const rows=applyChatChanges([reply()],[original(10,{body:'',recalled:true,attachments:[]})]);assert.equal(rows.length,1);assert.equal(rows[0].id,'reply');assert.equal(rows[0].body,'reply body');assert.equal(rows[0].reply_to.body,'');assert.equal(rows[0].reply_to.recalled,true);
});
test('off-window personal hide downgrades quotes independently of author recall',()=>{
 const rows=applyChatChanges([reply()],[original(8,{body:'',hidden:true})]);assert.equal(rows[0].reply_to.hidden,true);assert.equal(rows[0].reply_to.body,'');assert.equal(rows[0].reply_to.recalled,undefined);
});
test('late old parent pages cannot restore a recalled quoted original',()=>{
 const updated=applyChatChanges([reply()],[original(10,{body:'',recalled:true})]);const rows=mergeChatMessages([...updated,reply()]);assert.equal(rows[0].reply_to.change_version,10);assert.equal(rows[0].reply_to.body,'');assert.equal(rows[0].reply_to.recalled,true);
});
test('newer quote snapshots also suppress stale loaded originals',()=>{
 const rows=mergeChatMessages([original(),reply(original(10,{body:'',recalled:true}))]);assert.equal(rows.length,2);assert.equal(rows[0].recalled,true);assert.equal(rows[0].body,'');assert.equal(rows[1].reply_to.recalled,true);
});
test('a recalled parent cannot recover its own nested quote from a stale projection',()=>{
 const hidden={...reply(),recalled:true,body:'',reply_to:null,change_version:12};const rows=mergeChatMessages([hidden,reply()]);assert.equal(rows[0].body,'');assert.equal(rows[0].reply_to,null);
});
