import {ref,onMounted,onBeforeUnmount} from 'vue';
export function useDesktop(){
 const wide=ref(false);let media:MediaQueryList|undefined;
 const update=()=>{wide.value=!!media?.matches;};
 onMounted(()=>{media=window.matchMedia('(min-width: 760px) and (pointer: fine)');update();media.addEventListener('change',update);});
 onBeforeUnmount(()=>media?.removeEventListener('change',update));return wide;
}
