import {isRetryableFailure,userError} from './userError.mjs';
/** Read feedback belongs to one view/operation, never to the whole connection.
 * Owns display deadlines only. It performs no requests and never retries writes.
 */
export function createReadFeedback({publish,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,graceMs=30000,emptyGraceMs=1500}){
 let failure,started=null,hasContent=false,active=true,handle,disposed=false;
 const cancel=()=>{if(handle!==undefined)clearTimer(handle);handle=undefined;};
 const render=()=>{
  cancel();if(disposed||!active||!failure){publish('');return;}
  const text=userError(failure.error,failure.fallback);
  if(!text){publish('');return;}
  const delay=isRetryableFailure(failure.error)?Math.max(0,(hasContent?graceMs:emptyGraceMs)-(now()-started)):0;
  if(delay){publish('');handle=setTimer(render,delay);}else publish(text);
 };
 return {
  begin(content=false){hasContent=content;},
  failed(error,fallback){if(disposed)return;failure={error,fallback};started??=now();render();},
  succeeded(){failure=undefined;started=null;cancel();publish('');},
  active(value){if(value&&!active&&failure)started=now();active=value;render();},
  dispose(){disposed=true;failure=undefined;cancel();publish('');}
 };
}
