/** UI grace period. Repeated attempts never reset a continuous outage. */
export function createConnectionNotice(publish,{graceMs=30000,clock=Date.now,timer=setTimeout,cancel=clearTimeout}={}){
 let began=null,handle,latest;
 function clear(){cancel(handle);handle=undefined;began=null;publish('');}
 function show(){handle=undefined;if(!latest?.active||latest.foreground===false||latest.healthy)return;publish(latest.offline?'当前无网络':'消息连接暂时中断，正在恢复');}
 return {update(state){
  latest=state;if(!state.active||state.foreground===false||state.healthy){clear();return;}
  if(began===null)began=clock();
  const remaining=graceMs-(clock()-began);
  if(remaining<=0){cancel(handle);show();}
  else if(!handle)handle=timer(show,remaining);
 },dispose:clear};
}
