// One update state for lifecycle discovery, About and settings. No polling.
export function desktopHasUpdate(state){
 const parse=v=>typeof v==='string'&&/^\d+\.\d+\.\d+$/.test(v)?v.split('.').map(Number):null;
 const a=parse(state?.release?.version),b=parse(state?.current);if(!a||!b)return false;
 for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;
}
export function createDesktopUpdateNotice({bridge,onChange,now=Date.now,minInterval=30*60*1000}){
 let state=null,flight=null,lastSuccess=null,revision=0,stop=null;
 const accept=value=>{if(!value)return;revision++;state=value;onChange(value);};
 function start(){if(!stop)stop=bridge.onUpdateState?.(accept)||(()=>{});}
 async function run(force){
  const before=revision,restored=await bridge.updateState();
  if(revision===before)accept(restored);
  if(['checking','downloading','ready','preparing','installing'].includes(state?.phase))return state;
  if(!force&&lastSuccess!==null&&now()-lastSuccess<minInterval)return state;
  const value=await bridge.checkUpdate();accept(value);
  if(!value.error)lastSuccess=now();return state;
 }
 function check(force=false){start();if(flight)return flight;flight=run(force).finally(()=>{flight=null;});return flight;}
 return {start,check,dispose(){stop?.();stop=null;}};
}
