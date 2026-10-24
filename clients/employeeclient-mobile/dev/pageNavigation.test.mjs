import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter,createMemoryHistory} from 'vue-router';
import {installPageNavigation,safePageReturn} from '../src/app/page-navigation.mjs';
const paths={conversations:'/messages',work:'/work',profile:'/profile',chat:'/chat',member:'/member/:actor','work-detail':'/work/:id','material-detail':'/material/:id',search:'/search',files:'/files',notifications:'/notifications',inspiration:'/inspiration',feedback:'/feedback','group-files':'/group-files',announcements:'/announcements/:id?',connect:'/connect'};
function setup(){const history=createMemoryHistory(),router=createRouter({history,routes:Object.entries(paths).map(([name,path])=>({name,path,component:{}}))}),nav=installPageNavigation(router,history);return {router,nav,history};}
async function pop(router,history){await new Promise(resolve=>{const done=router.afterEach(()=>{done();resolve();});history.go(-1);});}
test('continuous primary navigation, filters and repeated detail returns end at the selected primary page',async()=>{
 const {router:r,nav:n}=setup();await r.push('/messages');await r.push('/work');
 for(let i=0;i<6;i++)await r.push('/work?project=p'+i);
 assert.equal(n.parent(),null);
 for(let i=0;i<3;i++){const source=r.currentRoute.value.fullPath;await r.push({name:'work-detail',params:{id:'w'},query:{project:'p5',returnTo:source}});assert.equal(n.parent(),source);await n.back();assert.equal(r.currentRoute.value.fullPath,source);assert.equal(await n.back(),false);}
 await r.push('/profile');await r.push('/feedback');await n.back();assert.equal(r.currentRoute.value.path,'/profile');assert.equal(await n.back(),false);
});
test('chat → contextual work → work detail → fixed material returns one actual page at a time',async()=>{
 const {router:r,nav:n}=setup();await r.push('/messages');await r.push('/chat?peer=member-a');const chat=r.currentRoute.value.fullPath;
 await r.push({name:'work',query:{project:'p',returnTo:chat}});const list=r.currentRoute.value.fullPath;
 await r.push({name:'work-detail',params:{id:'w'},query:{project:'p',returnTo:list}});const work=r.currentRoute.value.fullPath;
 await r.push({name:'material-detail',params:{id:'f'},query:{project:'p',version:'v1',returnTo:work}});
 for(const expected of [work,list,chat,'/messages']){assert.equal(await n.back(),true);assert.equal(r.currentRoute.value.fullPath,expected);}
 assert.equal(await n.back(),false);
});
test('browser back closes the surface first, ignores old same-page actions, and cannot replay a primary switch',async()=>{
 const {router:r,nav:n,history:h}=setup();await r.push('/messages');await r.push('/chat');await r.push('/chat?message=one');await r.push('/chat?message=two');
 let surface=true;n.setSurfaceCloser(()=>{if(!surface)return false;surface=false;return true;});await pop(r,h);assert.equal(r.currentRoute.value.fullPath,'/chat?message=two');
 await pop(r,h);assert.equal(r.currentRoute.value.path,'/messages');
 // Retain a real older browser entry, as an upgraded page may already have.
 await r.push('/chat');await r.push('/profile');assert.equal(n.parent(),null);await pop(r,h);assert.equal(r.currentRoute.value.path,'/profile');
});
test('explicit return source and direct-link parents survive a missing in-memory trail; external returns are rejected',async()=>{
 const {router:r,nav:n}=setup();await r.push({name:'material-detail',params:{id:'f'},query:{project:'p',returnTo:'/work/w?project=p&returnTo=%2Fsearch'}});assert.equal(n.parent(),'/work/w?project=p&returnTo=%2Fsearch');await n.back();assert.equal(n.parent(),'/search');await n.back();assert.equal(r.currentRoute.value.path,'/search');
 await r.replace('/feedback');n.reset();assert.equal(n.parent(),'/profile');
 for(const input of ['https://example.com','//example.com','/\\evil','/connect','/missing'])assert.equal(safePageReturn(r,input),null);
});
test('a back press consumes one current mode without creating history entries',async()=>{
 const {router:r,nav:n}=setup();await r.push('/messages');await r.push('/chat');const stack=['search','selection','modal'];n.setSurfaceCloser(()=>!!stack.pop());
 for(let i=0;i<3;i++){assert.equal(await n.back(),true);assert.equal(r.currentRoute.value.path,'/chat');}
 await n.back();assert.equal(r.currentRoute.value.path,'/messages');assert.equal(await n.back(),false);
});
