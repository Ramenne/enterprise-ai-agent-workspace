<script setup lang="ts">
// Persistent unread announcements occupy a compact row in the shell layout.
// Opening details never acknowledges reading; that remains an explicit action.
import {computed} from 'vue';
import {useRouter} from 'vue-router';
import {useDataStore} from '@/store/data';
import {useUiStore} from '@/store/ui';
import AppIcon from './AppIcon.vue';
const data=useDataStore(),ui=useUiStore(),router=useRouter();
const queue=computed(()=>data.floatingNotices.filter(n=>n.kind==='announcement').sort((a,b)=>a.created_at-b.created_at));
function open(){const first=queue.value[0];if(first?.object_id)ui.openOverlay('announcement',{announcementId:first.object_id});else void router.push({name:'announcements'});}
</script>
<template><aside v-if="queue.length" class="notice-strip" aria-label="重要未读提醒">
 <button class="notice-open" @click="open"><AppIcon name="bell"/><span>公告</span><strong>{{queue[0].title}}</strong><span class="notice-count">{{queue.length}} 条未读</span><AppIcon name="chevron"/></button>
</aside></template>
<style scoped>
.notice-strip{flex:none;position:sticky;top:calc(64px + env(safe-area-inset-top));z-index:3;padding:0 12px;background:var(--paper)}
.notice-open{display:flex;align-items:center;gap:8px;min-height:44px;width:100%;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);font:inherit;font-size:13px;text-align:left}
.notice-open>.icon{width:16px;height:16px;flex:none;color:var(--green)}.notice-open strong{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notice-count{flex:none;color:var(--muted);font-size:12px}
:global(.shell-chat .notice-strip){position:static;padding-top:env(safe-area-inset-top)}
</style>
