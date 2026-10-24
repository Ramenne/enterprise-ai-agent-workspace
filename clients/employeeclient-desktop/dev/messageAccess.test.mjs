import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFileSync} from 'node:fs';
const source=ts.transpileModule(readFileSync(new URL('../src/platform/messageAccess.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
function fixture({active=true,unrestricted=false,native=true}={}){
 const calls=[],values=new Map();let allowed=true;
 const deps={isAndroidNative:()=>native,App:{getState:async()=>({isActive:active})},requestLocalNotifyPermission:async()=>{calls.push('notifications');return true;},BackgroundSettings:{status:async()=>({batteryUnrestricted:unrestricted}),open:async({target})=>{calls.push(target);}},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}};
 const request=new Function(...Object.keys(deps),source+';return requestMessageAccess;')(...Object.values(deps));return {request:()=>request(()=>allowed),calls,values,invalidate:()=>allowed=false};
}
test('foreground Android directly requests notifications then native battery prompt once, without claiming granted',async()=>{const f=fixture();await Promise.all([f.request(),f.request()]);assert.deepEqual(f.calls,['notifications','battery']);assert.equal([...f.values.values()][0],'shown');await f.request();assert.deepEqual(f.calls,['notifications','battery','notifications']);});
test('background, invalid identity and non-Android never open permission dialogs',async()=>{for(const opts of [{active:false},{native:false}]){const f=fixture(opts);await f.request();assert.deepEqual(f.calls,[]);}const f=fixture();f.invalidate();await f.request();assert.deepEqual(f.calls,[]);});
test('existing battery permission is not requested again',async()=>{const f=fixture({unrestricted:true});await f.request();assert.deepEqual(f.calls,['notifications']);assert.equal(f.values.size,0);});
