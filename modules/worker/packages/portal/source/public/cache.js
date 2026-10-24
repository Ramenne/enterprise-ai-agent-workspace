'use strict';
(() => {
 const prefix='workspace-page-cache-v1:',memory=new Map(),pending=new Map();let scope='',revision=0;
 const stable=x=>x&&typeof x==='object'?Array.isArray(x)?'['+x.map(stable).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}':JSON.stringify(x);
 const clone=x=>typeof structuredClone==='function'?structuredClone(x):JSON.parse(JSON.stringify(x));
 const storage=()=>{try{return sessionStorage;}catch{return null;}};
 function clear(){revision++;memory.clear();pending.clear();const s=storage();if(s)try{for(let i=s.length-1;i>=0;i--){const k=s.key(i);if(k?.startsWith(prefix))s.removeItem(k);}}catch{}}
 function setScope(value){value=String(value||'');if(scope===value)return;const s=storage();let previous=scope;try{previous||=s?.getItem(prefix+'active-scope')||'';}catch{}
  if(previous&&previous!==value)clear();else{revision++;memory.clear();pending.clear();}scope=value;try{s?.setItem(prefix+'active-scope',scope);}catch{}
 }
 function get(key){let item=memory.get(key);if(!item&&scope){try{item=JSON.parse(storage()?.getItem(prefix+scope+':'+key)||'null');}catch{}}
  if(!item||item.scope!==scope||item.expires<=Date.now()){memory.delete(key);try{storage()?.removeItem(prefix+scope+':'+key);}catch{}return null;}memory.set(key,item);return clone(item.value);
 }
 async function read(key,load,{ttl=30000,persist=false,publicRead=false}={}){
  if(!scope&&!publicRead)return load();key=(publicRead?'public:':'member:')+key;
  const hit=get(key);if(hit!==null)return hit;
  if(pending.has(key))return clone(await pending.get(key));
  const start=revision,ownScope=scope;
  const job=(async()=>{const value=await load();if(start===revision&&scope===ownScope){const item={value:clone(value),scope,expires:Date.now()+ttl};memory.set(key,item);if(memory.size>80)memory.delete(memory.keys().next().value);
    if(persist&&scope)try{const data=JSON.stringify(item);if(data.length<3000000)storage()?.setItem(prefix+scope+':'+key,data);}catch{}
   }return value;})();pending.set(key,job);try{return clone(await job);}finally{if(pending.get(key)===job)pending.delete(key);}
 }
 const policy=(path,args)=>{
  if(args===undefined&&path==='status')return{ttl:15000};
  if(args===undefined&&(path==='docs'||path.startsWith('docs/')))return{ttl:60000};
  if(args===undefined&&path==='materials/inventory')return{ttl:30000,persist:true};
  if(['v8/projects','v8/works'].includes(path))return{ttl:30000,persist:true};
  if(['v8/read','v8/fields'].includes(path))return{ttl:15000};
  if(path==='rpc'&&args?.name==='mengchu_search')return{ttl:30000};
  return null;
 };
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('workspace-portal-cache'):null;
 channel?.addEventListener('message',e=>{clear();if(e.data?.kind==='logout')location.reload();});
 window.hubPageCache={read,clear,setScope,scopeId:()=>scope,policy,key:(path,args)=>path+':'+stable(args),invalidateAll:()=>{clear();channel?.postMessage({kind:'invalidate'});},logout:()=>{clear();scope='';channel?.postMessage({kind:'logout'});}};
})();
