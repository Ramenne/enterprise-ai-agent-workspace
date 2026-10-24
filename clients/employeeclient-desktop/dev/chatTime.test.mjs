import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/chat/time.ts'],bundle:true,write:false,format:'esm'});
const {chatTime,chatTimeMarkers}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const stamp=(y,m,d,h=0,min=0)=>new Date(y,m-1,d,h,min).getTime();
test('local chat time retains exact minutes, yesterday and year boundaries',()=>{
 const now=stamp(2026,1,1,15);
 assert.equal(chatTime(stamp(2026,1,1,9,5),now),'09:05');
 assert.equal(chatTime(stamp(2025,12,31,22,8),now),'昨天 22:08');
 assert.equal(chatTime(stamp(2025,12,30,8,3),now),'2025年12月30日 08:03');
 assert.equal(chatTime(stamp(2026,9,15,8,3),stamp(2026,9,17)),'9月15日 08:03');
 assert.equal(chatTime(stamp(2024,2,29,23,59),stamp(2024,3,1)),'昨天 23:59');
});
test('timeline groups five minute windows and always separates local midnight',()=>{
 const rows=[stamp(2026,9,16,23,59),stamp(2026,9,17,0,0),stamp(2026,9,17,0,2),stamp(2026,9,17,0,5)].map(created_at=>({created_at}));
 assert.deepEqual(chatTimeMarkers(rows),[true,true,false,true]);assert.deepEqual(chatTimeMarkers([]),[]);
});
