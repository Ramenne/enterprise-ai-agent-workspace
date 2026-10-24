<script setup lang="ts">
import {isDesktopNative} from '@/platform/desktop';
import {userError} from '@/domain/userError.mjs';
import {hasAppUpdate} from '@/platform/updateAvailability';
import {computed,ref} from 'vue';import PersonalTasksSection from '@/ui/components/PersonalTasksSection.vue';import MyProjectsSection from '@/ui/components/MyProjectsSection.vue';import {useRouter} from 'vue-router';import PageHeading from '@/ui/components/PageHeading.vue';import AppIcon from '@/ui/components/AppIcon.vue';import MemberAvatar from '@/ui/components/MemberAvatar.vue';
import {useSessionStore} from '@/session/store';import {useChatStore} from '@/store/chat';import {useUiStore} from '@/store/ui';import {captureApiLease,apiRequest,newIdempotencyKey} from '@/api/client';import {metaSet} from '@/session/db';import {normalizeAvatar} from '@/chat/avatar';import {isAndroidNative} from '@/session/installation';
defineOptions({name:'ProfileView'});
const router=useRouter();
const session=useSessionStore(),chat=useChatStore(),ui=useUiStore(),picker=ref<HTMLInputElement|null>(null),saving=ref(false),error=ref('');
async function selected(e:Event){const input=e.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file||saving.value)return;const lease=captureApiLease();saving.value=true;error.value='';try{const picture=await normalizeAvatar(file);if(!lease.valid())return;const r=await apiRequest<{actor_id:string;avatar_version:string}>('POST','/business/v1/profile/avatar',{body:{mime:picture.mime,bytes_base64:picture.bytes_base64},idempotencyKey:newIdempotencyKey('avatar')});if(!lease.valid())return;if(r.actor_id!==lease.account)throw Error('头像回执与账号不一致');await metaSet(lease.account,'avatar:'+r.actor_id+':'+r.avatar_version,picture.preview,lease.valid).catch(()=>{});chat.applyAvatar(r.actor_id,r.avatar_version);ui.toast('头像已更新');}catch(e){if(lease.valid())error.value=userError(e,'头像未更新，请重试');}finally{saving.value=false;}}
const rows=computed(()=>[
 {icon:'doc',title:'个人灵感记录',sub:'语音、文字与参考图片',open:()=>router.push({name:'inspiration'})},
 {icon:'bell',title:'通知与连接',sub:'系统通知、声音和当前设备状态',open:()=>ui.openOverlay('notificationSettings')},
 {icon:'bird',title:'关于员工客户端',sub:isAndroidNative()||isDesktopNative()?'版本信息与客户端更新':'版本信息',update:hasAppUpdate.value,open:()=>ui.openOverlay('about')},
 {icon:'message',title:'意见反馈',sub:'描述问题并附上截图',open:()=>router.push({name:'feedback'})}
]);
</script>
<template><div class="profile-page"><PageHeading title="我的账号"/><section class="profile-hero">
 <button class="avatar-edit" aria-label="更换头像" :disabled="saving" @click="picker?.click()"><MemberAvatar :name="session.displayName" :size="56"/><span class="camera-mark"><AppIcon name="camera"/></span></button>
 <div class="profile-name"><h2>{{session.displayName||'我的账号'}}</h2><span v-if="saving">{{saving?'正在更新头像…':''}}</span></div><input ref="picker" hidden type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" @change="selected"></section>
 <p v-if="error" class="error-text" role="alert">{{error}}</p><PersonalTasksSection/><MyProjectsSection/><section class="card"><button v-for="r in rows" :key="r.title" class="settings-row" :aria-label="r.update?r.title+'，有新版本':undefined" @click="r.open"><AppIcon :name="r.icon"/><span class="text"><strong>{{r.title}}</strong></span><i v-if="r.update" class="update-dot" aria-hidden="true"/><AppIcon name="chevron"/></button></section></div></template>
<style scoped>.profile-page .profile-hero{display:flex;align-items:center;gap:14px;padding:18px;margin:8px 0 18px;min-height:0}.profile-name h2{font-size:18px;font-weight:600;line-height:1.4;margin:0 0 4px}.profile-name>span{font-size:12px;color:var(--muted)}.avatar-edit{position:relative;border:0;background:none;padding:0;flex:none;border-radius:8px;width:56px;height:56px;color:var(--green)}.avatar-edit :deep(.member-avatar){border-radius:8px}.camera-mark{position:absolute;right:-4px;bottom:-3px;display:grid;place-items:center;border:2px solid var(--paper);border-radius:50%;width:22px;height:22px;background:var(--green);color:#fff}.camera-mark .icon{width:12px;height:12px}.avatar-edit:disabled{opacity:.65}.profile-page .settings-row{min-height:56px;padding:12px 16px}.profile-page .settings-row strong{font-size:15px}.profile-page .card{padding:0;overflow:hidden}</style>
