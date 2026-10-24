import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/ui/useConversationViewport.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.replace(/^import[^\n]+\n/gm,'').replace('export function','function'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function fixture(){
 const listeners=new Map(),viewportListeners=new Map();let mounted,activated,cleanup,raf=0;const frames=new Map();
 const field={style:{height:'40px'},scrollHeight:40,offsetHeight:40,clientHeight:38};
 const scroller={scrollTop:123,scrollHeight:1000,clientHeight:500},input={value:field},stream={value:scroller};
 const deps={nextTick:fn=>Promise.resolve().then(fn),onMounted:fn=>mounted=fn,onBeforeUnmount:fn=>cleanup=fn,onActivated:fn=>activated=fn,ref:value=>({value}),getComputedStyle:()=>({minHeight:'40px'}),requestAnimationFrame:fn=>{frames.set(++raf,fn);return raf;},cancelAnimationFrame:id=>frames.delete(id),ResizeObserver:class{observe(){}disconnect(){}},window:{addEventListener:(k,fn)=>listeners.set(k,fn),removeEventListener:(k,fn)=>{if(listeners.get(k)===fn)listeners.delete(k);},visualViewport:{addEventListener:(k,fn)=>viewportListeners.set(k,fn),removeEventListener:()=>{}}},document:{activeElement:null}};
 const use=new Function(...Object.keys(deps),code+';return useConversationViewport;')(...Object.values(deps));const api=use(stream,input);mounted();
 return {api,field,scroller,listeners,activated:()=>activated(),flush:()=>{for(const [id,fn] of frames){frames.delete(id);fn();}},cleanup};
}
test('layout resize grows unchanged wrapped input including border box',()=>{
 const f=fixture();f.field.scrollHeight=64;f.listeners.get('resize')();assert.equal(f.field.style.height,'66px');f.flush();assert.equal(f.scroller.scrollTop,1000);f.cleanup();assert.equal(f.listeners.has('resize'),false);
});
test('resize while reading old messages changes input height without jumping to latest',()=>{
 const f=fixture();f.api.atLatest.value=false;f.field.scrollHeight=90;f.listeners.get('resize')();f.flush();assert.equal(f.field.style.height,'92px');assert.equal(f.scroller.scrollTop,123);f.cleanup();
});
test('short text shrinks and long text stops at existing 112px limit',()=>{
 const f=fixture();f.field.scrollHeight=300;f.api.resize();assert.equal(f.field.style.height,'112px');f.field.scrollHeight=40;f.api.resize();assert.equal(f.field.style.height,'42px');f.cleanup();
});
test('returning to a kept conversation recomputes restored input height',async()=>{
 const f=fixture();f.field.scrollHeight=64;f.activated();await Promise.resolve();assert.equal(f.field.style.height,'66px');f.cleanup();
});
