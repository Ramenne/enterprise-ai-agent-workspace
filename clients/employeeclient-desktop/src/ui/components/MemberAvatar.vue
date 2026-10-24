<script setup lang="ts">
import {computed,ref,watch,onDeactivated} from 'vue';import {useRouter} from 'vue-router';
import ChatImageViewer from './ChatImageViewer.vue';import ModalSheet from './ModalSheet.vue';
import {reserveSave,saveVerified} from '@/native/save';import {isSaveCancelled} from '@/platform/saveFile';import {captureApiLease} from '@/api/client';import {sha256} from '@noble/hashes/sha2.js';import {bytesToHex} from '@noble/hashes/utils.js';
import {useChatStore} from '@/store/chat';import {useSessionStore} from '@/session/store';import {avatarUrl} from '@/chat/avatar-cache';import {initial} from '@/ui/format';
const props=withDefaults(defineProps<{actor?:string;name?:string;size?:number|string;preview?:boolean;profile?:boolean}>(),{size:40});const chat=useChatStore(),session=useSessionStore(),url=ref('');
const actor=computed(()=>props.actor||session.user?.username||''),version=computed(()=>chat.members.find(m=>m.username===actor.value)?.avatar_version||'');
const avatarSize=computed(()=>typeof props.size==='number'?props.size+'px':props.size);
const router=useRouter();
const expanded=ref(false),menu=ref(false),saving=ref(false),saveStatus=ref('');
const displayName=computed(()=>props.name||chat.members.find(m=>m.username===actor.value)?.nickname||session.displayName);
const previewUrl=computed(()=>url.value||'data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e5f2ed"/><text x="128" y="128" dy=".35em" text-anchor="middle" font-family="sans-serif" font-size="100" fill="#26746a">'+initial(displayName.value).replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!))+'</text></svg>'));
function openPreview(event:MouseEvent){if(props.preview){event.stopPropagation();if(actor.value===session.user?.username){void router.push({name:'profile'});return;}if(props.profile){void router.push({name:'member',params:{actor:actor.value}});return;}expanded.value=true;}}
function closePreview(){expanded.value=false;menu.value=false;saveStatus.value='';}
onDeactivated(closePreview);
async function save(){
 if(saving.value)return;const lease=captureApiLease(),source=previewUrl.value,id=actor.value,v=version.value;
 const name=(displayName.value.replace(/[\\/:*?"<>|]/g,'_').slice(0,60)||'成员')+'-头像'+(url.value?'.jpg':'.png');
 saving.value=true;menu.value=true;saveStatus.value='正在保存…';const targetPromise=reserveSave(name);let target;
 try{target=await targetPromise;if(!lease.valid()){target?.cancel();return;}
  let blob:Blob;
  if(source.startsWith('data:image/jpeg;base64,')){const bytes=Uint8Array.from(atob(source.split(',')[1]),c=>c.charCodeAt(0));blob=new Blob([bytes],{type:'image/jpeg'});}
  else{const img=new Image();img.src=source;await img.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d');if(!ctx)throw Error('当前设备无法保存头像');ctx.drawImage(img,0,0,256,256);blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('头像转换失败')),'image/png'));}
  const hash=bytesToHex(sha256(new Uint8Array(await blob.arrayBuffer())));
  const result=await saveVerified(blob,name,hash,[lease.account,'members','avatar',id,v||'default',hash],lease.valid,target);
  if(lease.valid())saveStatus.value=result.message;
 }catch(e){target?.cancel();if(lease.valid())saveStatus.value=isSaveCancelled(e)?'已取消保存':e instanceof Error?e.message:'保存失败，请重试';}
 finally{saving.value=false;}
}
let generation=0,displayOwner='',displayActor='';
watch([actor,version,()=>session.user?.username],async()=>{const n=++generation,id=actor.value,v=version.value,owner=session.user?.username||'';
 const changedOwner=owner!==displayOwner||id!==displayActor;displayOwner=owner;displayActor=id;
 if(changedOwner){closePreview();url.value='';}
 if(!owner||!id||!v){url.value='';return;}
 // Preserve the displayed photo while fetching a newer version of the same member.
 try{const value=await avatarUrl(id,v);if(n===generation&&value)url.value=value;}catch{/* Keep the same-owner photo on temporary fetch failure. */}
},{immediate:true});
</script>
<template><component :is="preview?'button':'span'" class="member-avatar" :type="preview?'button':undefined" :aria-label="preview?(actor===session.user?.username?'我的账号':(profile?'查看成员 ':'查看头像 ')+displayName):undefined" :style="{width:avatarSize,height:avatarSize,minWidth:avatarSize,maxWidth:avatarSize,flex:'0 0 '+avatarSize}" @click="openPreview"><img v-if="url" :src="url" :alt="displayName||'成员头像'"><span v-else>{{initial(displayName)}}</span>
<Teleport to="body"><ChatImageViewer v-if="expanded" :url="previewUrl" :name="displayName+'的头像'" @close="closePreview" @actions="menu=true" @save="save"/><ModalSheet v-if="expanded&&menu" :style="{zIndex:114}" :title="displayName+'的头像'" @close="menu=false"><button class="btn" :disabled="saving" @click="save">{{saving?'正在保存…':'保存头像'}}</button><p v-if="saveStatus" role="status">{{saveStatus}}</p></ModalSheet></Teleport>
</component></template>
<style scoped>.member-avatar{border:0;padding:0;font:inherit;display:inline-grid;place-items:center;flex:none;border-radius:5px;overflow:hidden;background:#e5f2ed;color:#26746a;vertical-align:middle}.member-avatar img{display:block;width:100%;height:100%;object-fit:cover}.member-avatar>span{font-size:inherit;line-height:1}</style>
