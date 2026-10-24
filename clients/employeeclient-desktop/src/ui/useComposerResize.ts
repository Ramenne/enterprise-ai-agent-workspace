import {ref,onMounted,onBeforeUnmount,type Ref} from 'vue';

export function useComposerResize(desktop:Ref<boolean>){
 const chatPanel=ref<HTMLElement|null>(null),composerHeight=ref(190);
 let stop:(()=>void)|undefined,observer:ResizeObserver|undefined;
 const clamp=(value:number)=>Math.max(140,Math.min(value,Math.max(140,(chatPanel.value?.clientHeight||600)-200)));
 const set=(value:number)=>{composerHeight.value=clamp(value);};
 const save=()=>{try{localStorage.setItem('qn.desktop.composer-height',String(composerHeight.value));}catch{}};
 function resizeComposer(event:PointerEvent){
  if(!desktop.value||event.button!==0)return;
  event.preventDefault();stop?.();
  const startY=event.clientY,startHeight=composerHeight.value;
  const move=(e:PointerEvent)=>{if(e.pointerId===event.pointerId)set(startHeight+startY-e.clientY);};
  const end=(e:PointerEvent)=>{if(e.pointerId===event.pointerId){stop?.();save();}};
  stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);stop=undefined;};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
 }
 function resizeComposerKey(event:KeyboardEvent){
  if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();set(event.key==='Home'?140:event.key==='End'?Infinity:composerHeight.value+(event.key==='ArrowUp'?20:-20));save();
 }
 onMounted(()=>{let saved=0;try{saved=Number(localStorage.getItem('qn.desktop.composer-height'));}catch{}set(Number.isFinite(saved)&&saved>=140?saved:190);observer=new ResizeObserver(()=>set(composerHeight.value));if(chatPanel.value)observer.observe(chatPanel.value);});
 onBeforeUnmount(()=>{stop?.();observer?.disconnect();});
 return {chatPanel,composerHeight,resizeComposer,resizeComposerKey};
}
