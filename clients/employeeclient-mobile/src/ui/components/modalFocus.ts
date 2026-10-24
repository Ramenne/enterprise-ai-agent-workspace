import { onMounted, onBeforeUnmount, nextTick, watch, type Ref } from 'vue';

const stack: symbol[] = [];
const closers=new Map<symbol,()=>void>();
export function closeTopModal(){const id=stack.at(-1);if(!id)return false;closers.get(id)?.();return true;}
// Selection is an in-page mode: share the return stack without trapping focus
// away from the message list or locking its scroll.
export function useModeBack(active:Ref<boolean>,close:()=>void){
  const id=Symbol('page-mode');
  const remove=()=>{const index=stack.indexOf(id);if(index>=0)stack.splice(index,1);closers.delete(id);};
  watch(active,value=>{remove();if(value){stack.push(id);closers.set(id,close);}},{flush:'sync'});
  const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&stack.at(-1)===id){event.preventDefault();event.stopPropagation();close();}};
  document.addEventListener('keydown',keydown);
  onBeforeUnmount(()=>{remove();document.removeEventListener('keydown',keydown);});
}
let savedOverflow = '';
let scrollLocks = 0;
const selector = 'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
export function useModalFocus(element: Ref<HTMLElement | null>, close: () => void) {
  const id = Symbol('modal');
  let previous: HTMLElement | null = null;
  let mounted = false;
  const top = () => stack[stack.length - 1] === id;
  const focusable = () => Array.from(element.value?.querySelectorAll<HTMLElement>(selector) || []).filter(node => node.getClientRects().length > 0);
  function keydown(event: KeyboardEvent) {
    if (!top() || event.defaultPrevented) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== 'Tab') return;
    const nodes = focusable();
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (!first) { event.preventDefault(); element.value?.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === element.value || !element.value?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element.value || !element.value?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  onMounted(async () => {
    mounted = true; previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (scrollLocks++ === 0) { savedOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
    stack.push(id); closers.set(id,close); document.addEventListener('keydown', keydown);
    await nextTick();
    if (mounted && top() && !element.value?.contains(document.activeElement)) element.value?.focus({ preventScroll: true });
  });
  onBeforeUnmount(() => {
    const restore = top(), wasMounted = mounted; mounted = false;
    const index = stack.indexOf(id); if (index >= 0) stack.splice(index, 1);
    if (wasMounted && --scrollLocks === 0) document.body.style.overflow = savedOverflow;
    document.removeEventListener('keydown', keydown); closers.delete(id);
    if (restore && previous?.isConnected) previous.focus({ preventScroll: true });
  });
}
