import test from'node:test';import assert from'node:assert/strict';
import{createVaultService,originalValueDelivery}from'./service.mjs';
test('Repeated approved delivery reads exactly the stored value and never issues a rotation',async()=>{
 const calls=[];let reads=0;
 const service=createVaultService({pool:{async query(sql,args){calls.push(sql);const b=JSON.parse(args[1]);return{rows:[{result:sql.includes('reveal_prepare')?{state:'authorized_prepare',entry_id:'synthetic',ticket_id:'synthetic-ticket',secret_ref:'bao:hub2/hufu/vault2/entries/synthetic',value_field:'value'}:{state:'authorized_release'}}]};}},secretRuntime:{async optionalSecret(){reads++;return{value:'SYNTHETIC-ASR-EXTERNAL-KEY'};}}});
 for(let i=0;i<2;i++){const r=await service.reveal('SYNTHETIC-CALLER',{key:'synthetic'});assert.equal(r.value,'SYNTHETIC-ASR-EXTERNAL-KEY');assert.equal(r.value_delivery.automatic_rotation,false);assert.equal(r.value_delivery.proxy_required,false);}
 assert.equal(reads,2);assert.equal(calls.length,4);assert.ok(calls.every(x=>x.includes('reveal_prepare')||x.includes('reveal_finish')));
});
test('Revocation between lookup and final release prevents plaintext delivery',async()=>{
 const service=createVaultService({pool:{async query(sql){return{rows:[{result:sql.includes('reveal_prepare')?{state:'authorized_prepare',ticket_id:'synthetic-ticket',secret_ref:'bao:hub2/hufu/vault2/entries/synthetic',value_field:'value'}:{state:'revoked'}}]};}},secretRuntime:{async optionalSecret(){return{value:'SYNTHETIC-REVOKED'};}}});
 await assert.rejects(service.reveal('SYNTHETIC-CALLER',{key:'synthetic'}),e=>e.code==='current_vault_release_required');
});
test('Registered execution-channel mode remains distinct and never reads the secret',async()=>{
 const service=createVaultService({pool:{async query(){return{rows:[{result:{state:'use_execution_channel',plaintext_returned:false}}]};}},secretRuntime:{async optionalSecret(){assert.fail('should not fetch a secret');}}});
 assert.equal((await service.reveal('SYNTHETIC-CALLER',{key:'synthetic'})).plaintext_returned,false);
 assert.equal(originalValueDelivery.rotation,'separate_explicit_operation');
});
