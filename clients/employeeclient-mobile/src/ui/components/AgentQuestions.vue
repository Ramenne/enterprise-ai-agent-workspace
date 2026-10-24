<script setup lang="ts">
import {computed,ref} from 'vue';
import MessageInput from './MessageInput.vue';
const props=defineProps<{questions:{id:string;question:string;options?:{label:string;description?:string}[]}[];disabled:boolean;readonly?:boolean;allowSkip?:boolean}>();
const emit=defineEmits<{answer:[answers:Record<string,string>];skip:[]}>();
const selected=ref<Record<string,string>>({});
const custom=ref<Record<string,string>>({});
const CUSTOM='__custom__';
function isCustom(label:string){return /^(other|其他|自定义回答|其他答案)$/i.test(label.trim());}
function valueFor(id:string){const q=props.questions.find(item=>item.id===id);return (!q?.options?.length||selected.value[id]===CUSTOM)?custom.value[id]?.trim()||'':selected.value[id]?.trim()||'';}
const complete=computed(()=>props.questions.length>0&&props.questions.every(q=>valueFor(q.id)));
function choose(id:string,label:string){selected.value[id]=isCustom(label)?CUSTOM:label;}
function submit(){if(props.disabled||props.readonly||!complete.value)return;emit('answer',Object.fromEntries(props.questions.map(q=>[q.id,valueFor(q.id)])));}
</script>
<template>
  <form class="agent-questions" @submit.prevent="submit">
    <fieldset v-for="q in questions" :key="q.id" :disabled="disabled && !readonly">
      <legend>{{ q.question }}</legend>
      <div v-if="q.options?.length" class="question-options" role="group" :aria-label="q.question">
        <div v-for="o in readonly ? q.options : []" :key="o.label" class="question-option-readonly">
          <span>{{ o.label }}</span><small v-if="o.description">{{ o.description }}</small>
        </div>
        <div v-if="readonly && !q.options.some(o=>isCustom(o.label))" class="question-option-readonly">自定义回答</div>
        <button v-for="o in readonly ? [] : q.options" :key="o.label" type="button" :aria-pressed="selected[q.id]===(isCustom(o.label)?CUSTOM:o.label)" @click="choose(q.id,o.label)">
          <span>{{ o.label }}</span><small v-if="o.description">{{ o.description }}</small>
        </button>
        <button v-if="!readonly && !q.options.some(o=>isCustom(o.label))" type="button" :aria-pressed="selected[q.id]===CUSTOM" @click="choose(q.id,CUSTOM)">自定义回答</button>
      </div>
      <MessageInput v-if="!readonly && (!q.options?.length || selected[q.id]===CUSTOM)" v-model="custom[q.id]" :aria-label="q.question+'：自定义回答'" placeholder="输入你的回答" maxlength="3000" />
    </fieldset>
    <div v-if="!readonly" class="question-actions">
      <button v-if="allowSkip" class="btn" type="button" :disabled="disabled" @click="emit('skip')">跳过</button>
      <button class="btn primary" type="submit" :disabled="disabled||!complete">提交回答</button>
    </div>
  </form>
</template>
<style scoped>
.agent-questions{display:grid;gap:18px;min-width:0}.agent-questions fieldset{display:grid;gap:10px;margin:0;padding:0;border:0;min-width:0}.agent-questions legend{margin-bottom:10px;line-height:1.5;font-size:14px;font-weight:600}.question-options{display:grid;gap:8px}.question-options button,.question-option-readonly{display:grid;gap:4px;padding:12px;text-align:left;border:1px solid var(--control-line);border-radius:8px;background:var(--paper);color:var(--ink);font:inherit;line-height:1.5}.question-options button[aria-pressed=true]{border-color:#aeb8c3;background:var(--surface-soft,#f1f3f5)}.question-option-readonly{background:var(--paper-soft);color:var(--muted)}.question-options small{font-size:13px;color:var(--muted);line-height:1.5}.question-options button:focus-visible{outline:2px solid #aeb8c3;outline-offset:2px}.agent-questions .message-input{width:100%;min-height:68px}
.question-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
</style>
