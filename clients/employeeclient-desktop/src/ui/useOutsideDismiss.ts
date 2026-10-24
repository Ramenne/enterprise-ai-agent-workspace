import { onMounted, onBeforeUnmount, type Ref } from 'vue';

// Non-modal popovers: opening trigger and content are one interaction region.
// ModalSheet owns its own backdrop/focus handling; do not dismiss a layer beneath it.
export function useOutsideDismiss(open: Readonly<Ref<boolean>>, region: string, close: () => void) {
  function click(event: MouseEvent) {
    if (!open.value || !(event.target instanceof Element)) return;
    if (event.target.closest(region) || event.target.closest('[role="dialog"],[data-page-back]')) return;
    // Wait until click dispatch: collapsing on pointerdown can move the target
    // between press and release, swallowing the user's intended action.
    close();
  }
  function key(event: KeyboardEvent) {
    if (!open.value || event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
    close(); event.preventDefault();
  }
  onMounted(() => { document.addEventListener('click', click, true); document.addEventListener('keydown', key); });
  onBeforeUnmount(() => { document.removeEventListener('click', click, true); document.removeEventListener('keydown', key); });
}
