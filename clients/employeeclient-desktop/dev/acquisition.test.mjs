import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFile} from 'node:fs/promises';
async function fixture(){let reads=0,loads=0,disposed=0;const events=[];const a={id:'file',version:'1',size:3},c={account:'a',computer:'cloud',provider:'company',thread:'group'};
 const ports={find:async()=>undefined,load:async()=>({cached:true,uploadSource:{size:3},dispose:()=>disposed++})};
 const deps={sourceIdentity:(a,c)=>[c.account,a.id,a.version],findAttachment:(...args)=>{reads++;return ports.find(...args)},loadAttachment:(...args)=>{loads++;return ports.load(...args)},window:{dispatchEvent:e=>events.push(e.detail)},CustomEvent:class{constructor(_name,opts){this.detail=opts.detail;}}};
 const source=await readFile(new URL('../src/files/acquisition.ts',import.meta.url),'utf8'),code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');const m=new Function(...Object.keys(deps),code+';return {startAcquisition,getAcquisition,clearAcquisitions};')(...Object.values(deps));
 return {m,a,c,ports,events,counts:()=>({reads,loads,disposed})};
}
test('simultaneous file callers join one acquisition and one cache/source load',async()=>{
 const {m,a,c,ports,counts}=await fixture();let release;ports.load=async()=>{await new Promise(r=>release=r);return {cached:true,uploadSource:{size:3},dispose(){}}};const first=m.startAcquisition(a,c,async()=>a),second=m.startAcquisition(a,c,async()=>{throw Error('duplicate source')});assert.equal(first,second);await new Promise(r=>setImmediate(r));release();await first.promise;assert.equal(first.state,'complete');assert.equal(counts().loads,1);
});
test('cancel while cache lookup is held stops source resolution and remote load',async()=>{
 const {m,a,c,ports,counts}=await fixture();let release,sources=0;ports.find=async()=>{await new Promise(r=>release=r);return undefined};const job=m.startAcquisition(a,c,async()=>{sources++;return a}),failed=assert.rejects(job.promise,e=>e.name==='AbortError');job.cancel();release();await failed;assert.equal(job.state,'cancelled');assert.equal(sources,0);assert.equal(counts().loads,0);
});
test('clear while cache alias is held prevents a late complete receipt and disposes media',async()=>{
 const {m,a,c,ports}=await fixture();let release,dispose=0;ports.find=async()=>({cached:true,uploadSource:{size:3},cacheAs:async()=>{await new Promise(r=>release=r)},dispose:()=>dispose++});const job=m.startAcquisition(a,c,async()=>a),failed=assert.rejects(job.promise,e=>e.name==='AbortError');await new Promise(r=>setImmediate(r));m.clearAcquisitions('a');release();await failed;assert.equal(job.state,'cancelled');assert.equal(m.getAcquisition(a,c),undefined);assert.equal(dispose,1);
});
test('uncached bytes cannot produce complete; retry owns a new acquisition',async()=>{
 const {m,a,c,ports}=await fixture();ports.load=async()=>({cached:false,uploadSource:{size:3},dispose(){}});const first=m.startAcquisition(a,c,async()=>a);await assert.rejects(first.promise,/未能写入应用缓存/);assert.equal(first.state,'error');ports.load=async()=>({cached:true,uploadSource:{size:3},dispose(){}});const second=m.startAcquisition(a,c,async()=>a);assert.notEqual(first,second);await second.promise;assert.equal(second.state,'complete');
});
