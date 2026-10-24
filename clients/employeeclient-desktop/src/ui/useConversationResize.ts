import {ref,onMounted,onBeforeUnmount} from 'vue';

export function useConversationResize(){
 const desktopShell=ref<HTMLElement|null>(null),conversationWidth=ref(300);
 let stop:(()=>void)|undefined,observer:ResizeObserver|undefined;
 const clamp=(width:number)=>Math.max(200,Math.min(width,460,Math.max(200,(desktopShell.value?.clientWidth||1000)-380)));
 const set=(width:number)=>{conversationWidth.value=clamp(width);};
 const save=()=>{try{localStorage.setItem('qn.desktop.conversation-width',String(conversationWidth.value));}catch{}};
 function resizeConversations(event:PointerEvent){
  if(event.button!==0)return;event.preventDefault();stop?.();
  const x=event.clientX,width=conversationWidth.value;
  const move=(e:PointerEvent)=>{if(e.pointerId===event.pointerId)set(width+e.clientX-x);};
  const end=(e:PointerEvent)=>{if(e.pointerId===event.pointerId){stop?.();save();}};
  stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);stop=undefined;};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);
 }
 function resizeConversationsKey(event:KeyboardEvent){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();set(event.key==='Home'?200:event.key==='End'?Infinity:conversationWidth.value+(event.key==='ArrowRight'?20:-20));save();
 }
 onMounted(()=>{let saved=0;try{saved=Number(localStorage.getItem('qn.desktop.conversation-width'));}catch{}set(Number.isFinite(saved)&&saved>=200?saved:300);observer=new ResizeObserver(()=>set(conversationWidth.value));if(desktopShell.value)observer.observe(desktopShell.value);});
 onBeforeUnmount(()=>{stop?.();observer?.disconnect();});
 return {desktopShell,conversationWidth,resizeConversations,resizeConversationsKey};
}
