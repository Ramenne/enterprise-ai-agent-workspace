import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createConnectionNotice} from '../src/platform/connectionNotice.mjs';
import {ref,computed,reactive,watch,nextTick,effectScope} from 'vue';
function script(path){const s=readFileSync(new URL(path,import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];return ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import .*;\r?\n/gm,'');}
function execute(path,deps,suffix=''){const bindings={createConnectionNotice,onMounted(){},onBeforeUnmount(){},...deps};return new Function(...Object.keys(bindings),script(path)+suffix)(...Object.values(bindings));}
test('navigation dismisses the old announcement and cannot interpret a work ID as an announcement',async()=>{
 const scope=effectScope(),route=reactive({name:'announcements',fullPath:'/announcements/a1',params:{id:'a1'},query:{}}),events=[];
 const ui={overlay:null,confirmVisible:false,closeOverlay(){this.overlay=null;events.push('close');},openOverlay(kind,props){this.overlay={kind,props};events.push(kind);},resolveConfirm(){this.confirmVisible=false;events.push('cancel');}};
 const router={resolve:()=>({query:{}})};
 scope.run(()=>{
  execute('../src/ui/layout/AppShell.vue',{ref,computed,watch,provide(){},useRoute:()=>route,useRouter:()=>router,useUiStore:()=>ui,useSessionStore:()=>({}),useDataStore:()=>({}),useChatViewport:()=>({height:ref(844),top:ref(0),keyboard:ref(false)})});
  execute('../src/ui/views/AnnouncementsView.vue',{computed,watch,onMounted(){},useRoute:()=>route,useUiStore:()=>ui,useSessionStore:()=>({}),useDataStore:()=>({}),useChatStore:()=>({})});
 });
 assert.deepEqual(ui.overlay,{kind:'announcement',props:{announcementId:'a1'}});
 Object.assign(route,{name:'work-detail',params:{id:'work-2'},fullPath:'/work/work-2'});await nextTick();assert.equal(ui.overlay,null);
 // Returning to a different deep-linked announcement uses the new ID only.
 Object.assign(route,{name:'announcements',params:{id:'a2'},fullPath:'/announcements/a2'});await nextTick();assert.deepEqual(ui.overlay,{kind:'announcement',props:{announcementId:'a2'}});
 ui.confirmVisible=true;Object.assign(route,{name:'chat',params:{},fullPath:'/chat'});await nextTick();assert.equal(ui.overlay,null);assert.equal(ui.confirmVisible,false);
 Object.assign(route,{name:'notifications',fullPath:'/notifications'});await nextTick();assert.equal(ui.overlay,null);
 scope.stop();
});
test('explicit return-to-search restores search after clearing the previous surface',async()=>{
 const scope=effectScope(),route=reactive({name:'work-detail',fullPath:'/work/w1'}),events=[];
 const ui={closeOverlay(){events.push('close');},openOverlay(kind){events.push(kind);}};
 scope.run(()=>execute('../src/ui/layout/AppShell.vue',{ref,computed,watch,provide(){},useRoute:()=>route,useRouter:()=>({resolve:()=>({query:{returnSearch:'1',returnTo:'/search'}})}),useUiStore:()=>ui,useSessionStore:()=>({}),useDataStore:()=>({}),useChatViewport:()=>({height:ref(844),top:ref(0),keyboard:ref(false)})}));
 Object.assign(route,{name:'search',fullPath:'/search'});await nextTick();assert.deepEqual(events,['close','search']);scope.stop();
});
test('native Back closes modal, keyboard and page before minimizing the selected root',async()=>{
 const {createRouter,createMemoryHistory}=await import('vue-router');const {installPageNavigation}=await import('../src/app/page-navigation.mjs');
 const history=createMemoryHistory(),router=createRouter({history,routes:[['conversations','/messages'],['chat','/chat'],['work','/work']].map(([name,path])=>({name,path,component:{}}))}),nav=installPageNavigation(router,history);
 await router.push('/messages');await router.push('/chat');let nativeBack,mounted,unmounted,minimized=0,modal=true,blurred=0;
 class Input{blur(){blurred++;doc.activeElement=null;}}const doc={activeElement:null,addEventListener(){},removeEventListener(){}};
 const scope=effectScope(),ui={overlay:null,confirmVisible:false,closeOverlay(){this.overlay=null;},resolveConfirm(){this.confirmVisible=false;}};
 scope.run(()=>execute('../src/ui/layout/AppShell.vue',{ref,computed,watch,provide(){},onMounted(fn){mounted=fn;},onBeforeUnmount(fn){unmounted=fn;},useRoute:()=>router.currentRoute.value,useRouter:()=>router,useUiStore:()=>ui,useSessionStore:()=>({}),useDataStore:()=>({}),useChatViewport:()=>({height:ref(844),top:ref(0),keyboard:ref(false)}),pageNavigation:nav,document:doc,HTMLInputElement:Input,HTMLTextAreaElement:class{},closeTopModal(){if(!modal)return false;modal=false;return true;},Capacitor:{isNativePlatform:()=>true},App:{addListener:async(_event,fn)=>{nativeBack=fn;return {remove(){}};},minimizeApp:async()=>{minimized++;}}}));
 mounted();await nativeBack();assert.equal(router.currentRoute.value.path,'/chat');assert.equal(minimized,0);
 doc.activeElement=new Input();await nativeBack();assert.equal(blurred,1);assert.equal(router.currentRoute.value.path,'/chat');
 await nativeBack();assert.equal(router.currentRoute.value.path,'/messages');await router.push('/work');await nativeBack();assert.equal(router.currentRoute.value.path,'/work');assert.equal(minimized,1);unmounted();scope.stop();
});

test('shell suppresses short reconnects and clears the delayed warning when live',async()=>{
 const scope=effectScope(),session=reactive({isAuthenticated:true,status:'online',link:{networkUp:true,state:'live'}}),data=reactive({syncError:'',account:'a'}),route=reactive({name:'work',fullPath:'/work'});
 let now=0;const tasks=new Map();let seq=0;
 const factory=publish=>createConnectionNotice(publish,{graceMs:15000,clock:()=>now,timer:(fn,ms)=>{tasks.set(++seq,{fn,at:now+ms});return seq;},cancel:id=>tasks.delete(id)});
 const model=scope.run(()=>execute('../src/ui/layout/AppShell.vue',{createConnectionNotice:factory,ref,computed,watch,provide(){},useRoute:()=>route,useRouter:()=>({}),useUiStore:()=>({}),useSessionStore:()=>session,useDataStore:()=>data,useChatViewport:()=>({height:ref(844),top:ref(0),keyboard:ref(false)})},';return {connectionHint};'));
 assert.equal(model.connectionHint.value,'');data.syncError='timeout';await nextTick();assert.equal(tasks.size,0);
 session.link.state='backoff';await nextTick();now=8000;session.link.state='connecting';await nextTick();assert.equal(model.connectionHint.value,'');assert.equal(tasks.size,1);
 now=15000;for(const [id,t] of tasks)if(t.at<=now){tasks.delete(id);t.fn();}assert.match(model.connectionHint.value,/正在恢复/);
 session.status='offline';session.link.networkUp=false;await nextTick();assert.equal(model.connectionHint.value,'当前无网络');
 session.status='online';session.link.networkUp=true;session.link.state='live';await nextTick();assert.equal(model.connectionHint.value,'');
 const source=readFileSync(new URL('../src/ui/layout/AppShell.vue',import.meta.url),'utf8');assert.match(source,/v-if="connectionHint" class="offline-hint"/);assert.match(source,/aria-hidden="true">!<\/span>/);scope.stop();
});
