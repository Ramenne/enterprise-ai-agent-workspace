import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import ts from 'typescript';import {computed,ref,reactive,watch,effectScope,nextTick} from 'vue';
const turn=async()=>{await nextTick();await new Promise(r=>setImmediate(r));};
function fixture(){
 const props=reactive({actor:'peer',name:'Peer',size:40,preview:false}),chat=reactive({members:[{username:'peer',avatar_version:'v1'}]}),session=reactive({user:{username:'self'},displayName:'Self'}),calls=[];const resolvers=[];
 const deps={computed,ref,watch,onDeactivated:()=>{},useRouter:()=>({push(){}}),useChatStore:()=>chat,useSessionStore:()=>session,withDefaults:x=>x,defineProps:()=>props,initial:n=>n.slice(0,1),avatarUrl:(actor,v)=>{calls.push([actor,v]);return new Promise(resolve=>resolvers.push(resolve));}};
 const source=readFileSync(new URL('../src/ui/components/MemberAvatar.vue',import.meta.url),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/^import.*\n/gm,'').replace(/^export \{\};?\n/gm,'');
 const scope=effectScope();const model=scope.run(()=>new Function(...Object.keys(deps),code+';return {url};')(...Object.values(deps)));
 return {props,chat,session,calls,resolvers,model,close:()=>scope.stop()};
}
test('unchanged member directory replacement does not clear or fetch the avatar again',async()=>{
 const f=fixture();try{f.resolvers[0]('photo-v1');await turn();for(let n=0;n<10;n++){f.chat.members=[{username:'peer',avatar_version:'v1'}];await turn();assert.equal(f.model.url.value,'photo-v1');}assert.equal(f.calls.length,1);}finally{f.close();}
});
test('new version loads without flashing the current photo, old-account result is discarded',async()=>{
 const f=fixture();try{f.resolvers[0]('photo-v1');await turn();f.chat.members[0].avatar_version='v2';await turn();assert.equal(f.model.url.value,'photo-v1');f.session.user.username='other';await turn();assert.equal(f.model.url.value,'');f.resolvers[1]('late-self-photo');await turn();assert.equal(f.model.url.value,'');f.resolvers[2]('other-photo');await turn();assert.equal(f.model.url.value,'other-photo');}finally{f.close();}
});
