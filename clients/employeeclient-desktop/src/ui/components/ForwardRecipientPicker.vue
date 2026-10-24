<script setup lang="ts">
import {computed,ref} from 'vue';
import type {AssigneeOption} from '@/api/types';
import MemberAvatar from './MemberAvatar.vue';
import AppIcon from './AppIcon.vue';
const props=defineProps<{account:string;members:AssigneeOption[];modelValue:string|null}>();
const emit=defineEmits<{'update:modelValue':[peer:string]}>();
const search=ref('');
const targets=computed(()=>[{peer:'',name:'公司工作群',icon:'users'},{peer:props.account,name:'文件传输助手',icon:'folder'},...props.members.filter(m=>m.username!==props.account).map(m=>({peer:m.username,name:m.nickname||m.username,icon:''}))].filter(t=>!search.value.trim()||t.name.includes(search.value.trim())));
</script>
<template><input v-model="search" class="input" type="search" aria-label="搜索转发联系人" placeholder="搜索联系人"><div class="forward-targets"><button v-for="target in targets" :key="target.peer" :aria-label="target.name" :aria-pressed="modelValue===target.peer" @click="emit('update:modelValue',target.peer)"><span v-if="target.icon" class="forward-target-icon"><AppIcon :name="target.icon"/></span><MemberAvatar v-else :actor="target.peer" :name="target.name" :size="36"/><span>{{target.name}}</span><AppIcon v-if="modelValue===target.peer" name="check"/></button><p v-if="!targets.length" class="field-help">没有匹配的联系人</p></div></template>
<style scoped>
.forward-targets{display:grid;max-height:32vh;overflow:auto;margin:10px 0}.forward-targets>button{display:flex;align-items:center;gap:12px;min-height:54px;padding:8px 2px;border:0;border-bottom:1px solid var(--line-soft);background:transparent;color:var(--ink);font-size:15px;text-align:left}.forward-targets>button>span:not(.forward-target-icon){min-width:0;flex:1;overflow-wrap:anywhere}.forward-targets>button>.icon{color:var(--green);flex:none}.forward-target-icon{display:grid;place-items:center;flex:none;width:36px;height:36px;border-radius:5px;background:var(--green);color:white}
</style>
