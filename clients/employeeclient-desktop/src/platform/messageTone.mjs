// Foreground fallback only. OS notifications own background sound.
let audio,users=0;
function unlock(){
 try{const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)return;audio ||= new Audio();if(audio.state==='suspended')void audio.resume().catch(()=>{});}catch{}
}
export function prepareMessageTone(){
 if(++users===1){document.addEventListener('pointerdown',unlock,{passive:true});document.addEventListener('keydown',unlock);}
 return ()=>{if(--users===0){document.removeEventListener('pointerdown',unlock);document.removeEventListener('keydown',unlock);const old=audio;audio=undefined;void old?.close().catch(()=>{});}};
}
export function playMessageTone(){
 if(document.visibilityState!=='visible'||!audio||audio.state!=='running')return false;
 try{
  const oscillator=audio.createOscillator(),gain=audio.createGain(),now=audio.currentTime;
  oscillator.type='sine';oscillator.frequency.setValueAtTime(880,now);oscillator.frequency.setValueAtTime(1174.66,now+.085);
  gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(.12,now+.01);gain.gain.exponentialRampToValueAtTime(.001,now+.2);
  oscillator.connect(gain);gain.connect(audio.destination);oscillator.start(now);oscillator.stop(now+.21);
  oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};return true;
 }catch{return false;}
}
