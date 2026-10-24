import {readPushIdentity} from './webPushState';
import type {MessageBadgeSnapshot} from '@/api/types';
let flight:Promise<void>|null=null,wanted:{account:string;snapshot:MessageBadgeSnapshot|null}|null=null;
/** No badge API is called by the page, so an old page write cannot race Worker push. */
export function syncPwaBadge(account:string,snapshot:MessageBadgeSnapshot|null){
 wanted={account,snapshot:snapshot?{count:snapshot.count,version:snapshot.version,computed_at:snapshot.computed_at}:null};if(flight)return flight;
 const work=(async()=>{while(wanted){const item=wanted;wanted=null;const identity=await readPushIdentity();if(item.account&&identity?.account!==item.account)continue;
  const reg=await navigator.serviceWorker?.getRegistration(),worker=navigator.serviceWorker?.controller||reg?.active;
  worker?.postMessage({type:'qn-message-badge',...(identity&&item.snapshot?{identity,snapshot:item.snapshot}:{})});
 }})();flight=work;void work.catch(()=>{}).finally(()=>{if(flight===work)flight=null;});return work;
}
