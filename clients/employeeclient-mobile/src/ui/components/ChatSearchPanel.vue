<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import type { ChatFilter } from '@/api/types';
import AppIcon from './AppIcon.vue';
const props=defineProps<{value:string;direct?:boolean;filter:ChatFilter;autofocus?:boolean}>();
type Choice='all'|'members'|'date'|'media'|'files'|'links'|'voice'|'mentions'|'replies';
const emit=defineEmits<{(e:'close'):void;(e:'input',value:string):void;(e:'search',value:string):void;(e:'choose',value:Choice,text:string):void}>();
const text=ref(props.value),input=ref<HTMLInputElement|null>(null);
watch(()=>props.value,value=>{text.value=value;});
onMounted(()=>{if(props.autofocus!==false)input.value?.focus();});
const categories:Array<{value:Choice;label:string}>=[{value:'all',label:'全部'},{value:'media',label:'图片与视频'},{value:'files',label:'文件'},{value:'links',label:'链接'},{value:'voice',label:'语音'},{value:'date',label:'日期'}];
function selected(value:Choice){return value==='all'?!Object.entries(props.filter).some(([key,value])=>key!=='peer'&&key!=='q'&&!!value):value==='date'?!!props.filter.created_from:value===props.filter.kind||value===props.filter.related;}
function search(){emit('search',text.value.trim());input.value?.blur();}
</script>
<template>
  <section class="chat-search-panel" aria-label="查找聊天记录">
    <form class="history-search-bar" @submit.prevent="search">
      <label class="history-search-input"><AppIcon name="search"/><input ref="input" v-model="text" @input="emit('input',text)" type="search" inputmode="search" enterkeyhint="search" aria-label="搜索聊天记录" placeholder="搜索当前聊天记录" maxlength="200"></label>
      <button type="submit">查找</button><button type="button" @click="emit('close')">取消</button>
    </form>
    <div class="history-search-categories" aria-label="聊天查找条件">
      <button v-for="item in categories" :key="item.value" :aria-pressed="selected(item.value)" @click="emit('choose',item.value,text)">{{item.label}}</button>
      <template v-if="!direct"><button :aria-pressed="!!filter.author" @click="emit('choose','members',text)">群成员</button><button :aria-pressed="filter.related==='mentions'" @click="emit('choose','mentions',text)">@我的</button><button :aria-pressed="filter.related==='replies'" @click="emit('choose','replies',text)">回复我的</button></template>
    </div>
  </section>
</template>
<style scoped>
.chat-search-panel{flex:none;background:var(--bg);border-bottom:1px solid var(--line)}
.history-search-bar{display:flex;align-items:center;gap:10px;padding:8px 12px}
.history-search-input{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:38px;padding:0 10px;background:var(--paper);border-radius:8px;color:var(--muted)}
.history-search-input input{width:100%;min-width:0;border:0;outline:0;padding:7px 0;background:transparent;color:var(--ink);font-size:16px}
.history-search-input .icon{width:18px;height:18px;flex:none}
.history-search-bar>button{padding:0;min-height:44px;border:0;background:transparent;color:#4c6485;font-size:14px;flex:none}
.history-search-categories{display:flex;gap:4px 8px;overflow-x:auto;padding:0 12px 7px;align-items:center}
.history-search-categories button{flex:none;min-height:40px;border:0;border-bottom:2px solid transparent;background:transparent;padding:6px;color:var(--muted);font-size:13px;white-space:nowrap}
.history-search-categories button[aria-pressed=true]{color:var(--green-dark);border-bottom-color:var(--green)}
</style>
