import {nextTick,onMounted,onBeforeUnmount,onActivated,ref,type Ref} from 'vue';
// Shared group-chat keyboard settling + Jiling Android ChatViewport reading anchors.
// Keep the latest message above the composer during keyboard animation; do not
// pull someone reading older content to the bottom on background updates.
export function useConversationViewport(stream:Ref<HTMLElement|null>,input:Ref<HTMLTextAreaElement|null>) {
  const atLatest=ref(true);let frame=0;let settle:ReturnType<typeof setTimeout>|undefined;
  let observer:ResizeObserver|undefined,mutations:MutationObserver|undefined;
  function bottom(){cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const e=stream.value;if(e&&atLatest.value)e.scrollTop=e.scrollHeight;});}
  function resize(){const e=input.value;if(e){const minimum=parseFloat(getComputedStyle(e).minHeight)||44;e.style.height=minimum+'px';e.style.height=Math.min(112,Math.max(minimum,e.scrollHeight+e.offsetHeight-e.clientHeight))+'px';}if(atLatest.value)bottom();}
  function viewport(){if(!atLatest.value)return;bottom();clearTimeout(settle);if(document.activeElement===input.value)settle=setTimeout(()=>{if(atLatest.value)bottom();},180);}
  // A width change can wrap an unchanged restored draft onto more lines.
  // Window layout updates must resize the input even while reading history.
  function layout(){resize();viewport();}
  onActivated(()=>{void nextTick(resize);});
  function focus(){atLatest.value=true;void nextTick(()=>{resize();viewport();});}
  function scroll(){const e=stream.value;if(e)atLatest.value=e.scrollHeight-e.scrollTop-e.clientHeight<80;}
  onMounted(()=>{window.addEventListener('resize',layout);window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);observer=new ResizeObserver(viewport);mutations=new MutationObserver(()=>{observe();viewport();});if(stream.value){mutations.observe(stream.value,{childList:true,subtree:true});observe();}});
  function capture(force=false){
    const e=stream.value;if(!e||atLatest.value&&!force)return null;
    const top=e.getBoundingClientRect().top;
    const row=[...e.querySelectorAll<HTMLElement>('[data-reading-id]')].find(r=>r.getBoundingClientRect().bottom>top);
    return {id:row?.dataset.readingId,y:e.scrollTop,offset:(row?.getBoundingClientRect().top??top)-top};
  }
  function restore(anchor:ReturnType<typeof capture>){
    if(atLatest.value){bottom();return;}
    const e=stream.value;if(!e||!anchor)return;
    const row=[...e.querySelectorAll<HTMLElement>('[data-reading-id]')].find(r=>r.dataset.readingId===anchor.id);
    e.scrollTop=row?e.scrollTop+row.getBoundingClientRect().top-e.getBoundingClientRect().top-anchor.offset:anchor.y;
  }
  function observe(){observer?.disconnect();if(stream.value){observer?.observe(stream.value);for(const child of stream.value.children)observer?.observe(child);}}
  onBeforeUnmount(()=>{observer?.disconnect();mutations?.disconnect();cancelAnimationFrame(frame);clearTimeout(settle);window.removeEventListener('resize',layout);window.visualViewport?.removeEventListener('resize',viewport);window.visualViewport?.removeEventListener('scroll',viewport);});
  return {atLatest,bottom,focus,scroll,resize,observe,capture,restore};
}
