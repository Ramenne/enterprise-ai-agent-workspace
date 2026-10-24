import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompatibilityObservation} from '../packages/mcp-edge/source/compatibility-observation.mjs';
import {legacyAliasNames,legacyToolName} from '../packages/mcp-edge/source/tool-compatibility.mjs';
import {createMaterialWorkspace} from '../packages/portal/source/material-workspace-api.mjs';
test('only registered dependency names and caller classes leave the adapter',()=>{
 const events=[],o=createCompatibilityObservation(e=>events.push(e)),req={body:'synthetic-private-body',headers:{authorization:'synthetic-private-token'}};
 o.tool('unknown-synthetic-private-name','native_member_principal',req);o.observe('identity:legacy_bridge','untrusted-value',req);
 o.tool('v8_work_read','native_member_principal',req);
 assert.deepEqual(events,[{event:'hub_compatibility_use',schema:1,route:'tool:v8_work_read',caller_class:'native_member_principal'}]);
 assert.equal(JSON.stringify(events).includes('synthetic-private'),false);
});
test('nested alias resolution counts one entry per request, with independent future requests',()=>{
 const events=[],o=createCompatibilityObservation(e=>events.push(e)),r={};
 for(const name of legacyAliasNames){assert.notEqual(legacyToolName(name),name);o.tool(name,'native_member_principal',r);o.tool(name,'native_member_principal',r);}
 assert.equal(events.length,legacyAliasNames.length);
 o.tool('v8_work_read','native_member_principal',{});assert.equal(events.length,legacyAliasNames.length+1);
 o.observe('identity:legacy_bridge','legacy_credential');o.observe('identity:legacy_bridge','legacy_credential');assert.equal(events.length,legacyAliasNames.length+3);
});
test('logging failure cannot change business control flow',()=>{
 const o=createCompatibilityObservation(()=>{throw Error('synthetic-log-unavailable');});
 assert.doesNotThrow(()=>{o.started();o.tool('mengchu_get','native_member_principal',{});o.observe('identity:legacy_bridge','legacy_credential');});
});
test('legacy inventory records its entry once and remains usable if observation fails',async()=>{
 let hits=0;
 const workspace=createMaterialWorkspace({pageToken:async()=> 'synthetic-page-token',call:async()=>({items:[]}),observeInventory:()=>{hits++;throw Error('synthetic-log-unavailable');}});
 const result=await workspace.handle({},'inventory');assert.equal(result.state,'loaded');assert.equal(hits,1);
 await workspace.handle({},'list');assert.equal(hits,1);
});
