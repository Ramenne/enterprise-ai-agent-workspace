import { onMounted, onUnmounted, ref } from 'vue';

// The visible viewport shrinks for the iOS keyboard even when the layout viewport does not.
export function useChatViewport() {
  const height = ref(window.visualViewport?.height || window.innerHeight);
  const top = ref(0);
  const keyboard = ref(false);
  let restingHeight = height.value;
  const update = () => {
    const viewport = window.visualViewport;
    height.value = viewport?.height || window.innerHeight;
    top.value = viewport?.offsetTop || 0;
    const editing = document.activeElement?.matches('textarea, input, [contenteditable="true"]') || false;
    if (!editing) restingHeight = Math.max(height.value, window.innerHeight);
    keyboard.value = editing && restingHeight - height.value > 120;
    document.documentElement.style.setProperty('--qn-visual-viewport-height', `${height.value}px`);
    document.documentElement.style.setProperty('--qn-visual-viewport-top', `${top.value}px`);
  };
  onMounted(() => {
    update();
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
  });
  onUnmounted(() => {
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', update);
    document.documentElement.style.removeProperty('--qn-visual-viewport-height');
    document.documentElement.style.removeProperty('--qn-visual-viewport-top');
  });
  return { height, top, keyboard };
}
