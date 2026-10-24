<script setup lang="ts">
import {ref,watch} from 'vue';
import {useSessionStore} from '@/session/store';
import type {ChatContext} from '@/api/types';
import ModalSheet from './ModalSheet.vue';
import HubBrowser from './HubBrowser.vue';
const props=defineProps<{workOnly?:boolean;selected?:ChatContext|null}>();
const emit=defineEmits<{(e:'close'):void;(e:'choose',value:ChatContext|null):void}>();
const session=useSessionStore(),owner=session.user?.username,project=ref<any>(null);
function chooseWork(work:any,p:any){if(session.user?.username===owner)emit('choose',{project_id:p.project_id,project_title:p.title,work_item_id:work.work_item_id,work_title:work.goal,short_no:work.short_no});}
function chooseProject(){const p=project.value;if(p&&session.user?.username===owner)emit('choose',{project_id:p.project_id,project_title:p.title,work_item_id:null,work_title:null});}
watch(()=>session.user?.username,()=>emit('close'));
</script>
<template><Teleport to="body"><ModalSheet :title="props.workOnly?'选择所属工作':'关联项目或工作'" @close="emit('close')">
<button v-if="project&&!props.workOnly" class="btn soft" :aria-pressed="selected?.project_id===project.project_id&&!selected?.work_item_id" @click="chooseProject">只关联{{project.title}}项目</button>
<HubBrowser :selected-work-id="selected?.work_item_id||undefined" mode="work" selectable only-project="ad44cc0e-159e-4e0f-a5ca-73d3920240d9" @ready="project=$event" @select="chooseWork"/>
<template #footer><button v-if="!props.workOnly" class="btn ghost" @click="emit('choose',null)">移除关联</button><button class="btn" @click="emit('close')">取消</button></template>
</ModalSheet></Teleport></template>
