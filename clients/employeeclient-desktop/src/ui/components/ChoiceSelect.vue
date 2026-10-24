<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

interface Choice { value: string; label: string }
const props = defineProps<{ modelValue: string; options: Choice[]; label: string; id?: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const opened = ref(false);
const active = ref(0);
const selected = computed(() => props.options.find(o => o.value === props.modelValue));

function optionNodes(): HTMLElement[] { return [...(menu.value?.querySelectorAll<HTMLElement>('[role="option"]') || [])]; }
async function focusOption(index: number) {
  const count = props.options.length;
  if (!count) return;
  active.value = (index + count) % count;
  await nextTick();
  optionNodes()[active.value]?.focus();
}
async function openAt(index: number, focus = true) {
  if (props.disabled) return;
  opened.value = true;
  if (focus) await focusOption(index);
  else active.value = Math.max(0, index);
}
function close(restoreFocus = false) {
  opened.value = false;
  if (restoreFocus) void nextTick(() => trigger.value?.focus());
}
function choose(value: string, restoreFocus = false) { emit('update:modelValue', value); close(restoreFocus); }
function toggle() {
  if (props.disabled) return;
  if (opened.value) close();
  else void openAt(Math.max(0, props.options.findIndex(o => o.value === props.modelValue)), false);
}
function onTriggerKeydown(e: KeyboardEvent) {
  if (props.disabled) return;
  const selectedIndex = Math.max(0, props.options.findIndex(o => o.value === props.modelValue));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    void openAt(e.key === 'End' ? props.options.length - 1 : e.key === 'ArrowUp' ? selectedIndex - 1 : e.key === 'ArrowDown' ? selectedIndex + 1 : 0);
  } else if (e.key === 'Escape' && opened.value) { e.preventDefault(); close(true); }
}
function onOptionKeydown(e: KeyboardEvent, index: number) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    void focusOption(e.key === 'End' ? props.options.length - 1 : e.key === 'Home' ? 0 : index + (e.key === 'ArrowDown' ? 1 : -1));
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    choose(props.options[index].value, true);
  } else if (e.key === 'Escape') {
    e.preventDefault(); close(true);
  } else if (e.key === 'Tab') close();
}
function onDocumentPointer(e: PointerEvent) {
  if (opened.value && !root.value?.contains(e.target as Node)) close();
}
function onDocumentFocus(e: FocusEvent) {
  if (opened.value && !root.value?.contains(e.target as Node)) close();
}
document.addEventListener('pointerdown', onDocumentPointer, true);
document.addEventListener('focusin', onDocumentFocus, true);
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointer, true);
  document.removeEventListener('focusin', onDocumentFocus, true);
});
watch(() => props.options, () => {
  if (opened.value && !props.options.length) close(true);
  active.value = Math.max(0, props.options.findIndex(o => o.value === props.modelValue));
});
watch(() => props.disabled, disabled => { if (disabled && opened.value) close(); });
</script>

<template>
  <div ref="root" class="choice-select">
    <button ref="trigger" :id="id" type="button" class="choice-select-trigger" :disabled="disabled" :aria-label="label + '：' + (selected?.label || '请选择')"
      aria-haspopup="listbox" :aria-expanded="opened" @click="toggle" @keydown="onTriggerKeydown">
      <span>{{ selected?.label || '请选择' }}</span><span class="choice-caret" aria-hidden="true"></span>
    </button>
    <div v-if="opened" ref="menu" class="choice-select-menu" role="listbox" :aria-label="label">
      <div v-for="(option, index) in options" :key="option.value" role="option" class="choice-select-option"
        :class="{ selected: option.value === modelValue }" :aria-selected="option.value === modelValue"
        :tabindex="index === active ? 0 : -1" @click="choose(option.value)" @keydown="onOptionKeydown($event, index)">
        {{ option.label }}
      </div>
    </div>
  </div>
</template>
