<script setup lang="ts">
import {ref,computed,onMounted,onBeforeUnmount,nextTick} from 'vue';
import AppIcon from './AppIcon.vue';
import {useModalFocus} from './modalFocus';
import {createImageGesture} from '@/chat/imageGesture.mjs';
defineProps<{url:string;name:string}>();
const emit=defineEmits<{close:[];actions:[];save:[]}>();
const panel=ref<HTMLElement|null>(null),stage=ref<HTMLElement|null>(null),image=ref<HTMLImageElement|null>(null);
const size=ref({width:1,height:1}),view=ref({scale:1,x:0,y:0}),viewport=ref({height:window.visualViewport?.height||innerHeight,top:window.visualViewport?.offsetTop||0}),failed=ref(false);
const gesture=createImageGesture(),points=new Map<number,{x:number;y:number}>();
let press:ReturnType<typeof setTimeout>|undefined,start:{x:number;y:number;time:number}|undefined,multi=false,lastTap:{x:number;y:number;time:number}|undefined;
const imageStyle=computed(()=>({width:size.value.width+'px',height:size.value.height+'px',transform:`translate3d(${view.value.x}px,${view.value.y}px,0) scale(${view.value.scale})`}));
function clearPress(){clearTimeout(press);press=undefined;}
function configure(){const img=image.value,r=stage.value?.getBoundingClientRect();if(!img?.naturalWidth||!r?.width||!r.height)return;const fit=Math.min(1,r.width/img.naturalWidth,r.height/img.naturalHeight);size.value={width:img.naturalWidth*fit,height:img.naturalHeight*fit};view.value=gesture.configure({...size.value,viewportWidth:r.width,viewportHeight:r.height});}
function resize(){viewport.value={height:window.visualViewport?.height||innerHeight,top:window.visualViewport?.offsetTop||0};void nextTick(configure);}
function point(e:PointerEvent){const r=stage.value!.getBoundingClientRect();return {x:e.clientX-r.left-r.width/2,y:e.clientY-r.top-r.height/2};}
function begin(e:PointerEvent){e.preventDefault();if(e.pointerType==='mouse'&&e.button!==0)return;const p=point(e);points.set(e.pointerId,p);view.value=gesture.begin(e.pointerId,p);try{stage.value?.setPointerCapture(e.pointerId);}catch{/* Synthetic/local preview pointers may not have a native capture. */}clearPress();if(points.size===1){multi=false;start={...p,time:Date.now()};if(e.target===image.value)press=setTimeout(()=>{start=undefined;emit('actions');},500);}else{multi=true;start=undefined;}}
function move(e:PointerEvent){if(!points.has(e.pointerId))return;const p=point(e);points.set(e.pointerId,p);if(start&&Math.hypot(p.x-start.x,p.y-start.y)>8){clearPress();start=undefined;}view.value=gesture.move(e.pointerId,p);}
function end(e:PointerEvent){clearPress();const p=point(e),tap=start;points.delete(e.pointerId);view.value=gesture.end(e.pointerId);if(!multi&&tap&&Date.now()-tap.time<450&&Math.hypot(p.x-tap.x,p.y-tap.y)<8){const now=Date.now();if(lastTap&&now-lastTap.time<280&&Math.hypot(p.x-lastTap.x,p.y-lastTap.y)<20){view.value=gesture.zoomTo(view.value.scale>1?1:2.5,p);lastTap=undefined;}else lastTap={...p,time:now};}start=undefined;}
function cancel(e:PointerEvent){clearPress();start=undefined;points.delete(e.pointerId);view.value=gesture.end(e.pointerId);}
function toggleZoom(){view.value=view.value.scale>1?gesture.reset():gesture.zoomTo(2.5);}
function zoomOut(){view.value=gesture.zoomTo(view.value.scale/1.5);}
useModalFocus(panel,()=>emit('close'));
onMounted(()=>{window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);window.visualViewport?.addEventListener('scroll',resize);});
onBeforeUnmount(()=>{clearPress();window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('scroll',resize);gesture.reset();points.clear();});
</script>
<template><section ref="panel" class="chat-image-viewer" :style="{height:viewport.height+'px',top:viewport.top+'px'}" role="dialog" aria-modal="true" aria-label="图片查看" tabindex="-1">
 <header><button aria-label="关闭图片" @click="emit('close')"><AppIcon name="back"/></button><button aria-label="缩小图片" :disabled="view.scale<=0.25" @click="zoomOut">−</button><button :aria-label="view.scale>1?'还原图片':'放大图片'" @click="toggleZoom"><AppIcon name="search"/></button><button aria-label="图片保存或分享" @click="emit('actions')"><AppIcon name="more"/></button></header>
 <div ref="stage" class="image-stage" data-image-stage :data-image-scale="view.scale" :data-image-x="view.x" :data-image-y="view.y" @pointerdown="begin" @pointermove="move" @pointerup="end" @pointercancel="cancel" @contextmenu.prevent="emit('actions')">
  <img ref="image" :src="url" :alt="name" :style="imageStyle" draggable="false" @load="configure" @error="failed=true" @dragstart.prevent>
  <p v-if="failed" role="alert">图片暂时无法显示，请返回后重试</p>
 </div>
 <footer class="viewer-actions"><button aria-label="保存图片" @click="emit('save')"><AppIcon name="download"/></button><button aria-label="图片更多操作" @click="emit('actions')"><AppIcon name="more"/></button></footer>
</section></template>
<style scoped>
.chat-image-viewer{position:fixed;inset:0;bottom:auto;z-index:112;background:#111;color:#fff;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);outline:none}.chat-image-viewer header{display:flex;align-items:center;gap:4px;padding:4px 8px;flex:none}.chat-image-viewer header button{display:grid;place-items:center;width:44px;height:44px;border:0;border-radius:6px;background:transparent;color:#fff;padding:0}.chat-image-viewer header button:first-child{margin-right:auto}.chat-image-viewer header button:active{background:#333}.chat-image-viewer header .icon{width:22px;height:22px}.image-stage{position:relative;display:grid;place-items:center;flex:1;min-height:0;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}.image-stage img{display:block;max-width:none;max-height:none;object-fit:contain;transform-origin:center;user-select:none;-webkit-user-drag:none}.viewer-actions{position:absolute;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));display:flex;gap:10px;z-index:1}.viewer-actions button{width:44px;height:44px;padding:10px;border:0;border-radius:50%;background:#ffffff28;color:#fff;display:grid;place-items:center}.viewer-actions button:active{background:#ffffff48}.viewer-actions .icon{width:22px;height:22px}.image-stage p{position:absolute;font-size:14px;color:#ddd}
</style>
