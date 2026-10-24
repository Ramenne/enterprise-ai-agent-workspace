/** Event-driven retry window. Owns deadlines, not data or account authority.
 * A demand may join a pending retry, never bring its deadline forward.
 * Cooldown is lazy: no timer/request is created until another demand arrives.
 */
export function createRecoveryGate({wake,base=2000,max=60000,now=Date.now,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}){
 let timer,notBefore=0,failures=0;
 const arm=ms=>{if(timer!==undefined)return;timer=setTimer(()=>{timer=undefined;notBefore=0;wake();},ms);};
 const clear=()=>{clearTimer(timer);timer=undefined;};
 return {
  ready(){if(timer!==undefined)return false;const remaining=notBefore-now();if(remaining>0){arm(remaining);return false;}return true;},
  failed(){failures++;const ms=Math.min(max,base*2**Math.min(failures-1,10));notBefore=now()+ms;clear();arm(ms);},
  defer(ms){if(timer!==undefined)return;notBefore=Math.max(notBefore,now()+ms);arm(Math.max(0,notBefore-now()));},
  completed(cooldown=0){clear();failures=0;notBefore=now()+cooldown;},
  cancel(){clear();notBefore=0;failures=0;},
  get waiting(){return timer!==undefined;}
 };
}
