import {jsonSnapshot} from '../session/jsonSnapshot.mjs';
import {filterAttributes,metadataMatches} from './attribute-query.mjs';

const signature=/^[a-f0-9]{64}$/;
const rowId=r=>r.work_item_id||r.material_id;
const rowKey=r=>r.type+':'+rowId(r);
function conditions(selected={}){
 return Object.fromEntries(Object.entries(selected).filter(([,v])=>v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>{
  const value=JSON.parse(v);if(value!==null&&!['string','number','boolean'].includes(typeof value))throw Error('invalid_attribute_value');return [k,value];
 }));
}
export function queryIdentity(project,mode,q='',selected={}){return JSON.stringify([project,mode,q.trim(),conditions(selected)]);}
export function orderQueryRows(rows){return [...rows].sort((a,b)=>{
 if(a.type!==b.type)return a.type==='work'?-1:1;
 if(a.type==='work'){const rank=s=>['active','in_progress'].includes(s)?0:s==='completed'?1:2;const n=rank(a.state)-rank(b.state);if(n)return n;}
 return (Date.parse(b.updated_at||b.version_created_at||'')||0)-(Date.parse(a.updated_at||a.version_created_at||'')||0)||String(rowId(a)).localeCompare(String(rowId(b)));
});}
/** One account/project/query cache. Each loaded identity carries its authorized display signature.
 * A refresh validates only loaded identities plus changed identities, and reads
 * the loaded window conditionally. It never walks the project's revision inventory.
 */
export function createQueryProjection({get,put,remove,rpc}){
 const flights=new Map();
 return {async read(lease,project,options={}){
  const {mode='work',query='',selected={},more=false,onSnapshot=()=>{},signal}=options;
  const identity=queryIdentity(project.project_id,mode,query,selected),key='query-projection-v2:'+identity;
  const flightKey=JSON.stringify([lease.account,lease.epoch,identity]);
  const check=()=>{if(!lease.valid())throw Object.assign(Error('session_changed'),{code:'session_changed',status:401});signal?.throwIfAborted();};
  const call=async(name,args)=>{check();const result=await rpc(name,{project_id:project.project_id,...args},signal);check();return result;};
  const streams=mode==='search'?['work','file']:[mode==='files'?'file':'work'];
  const value=s=>({rows:orderQueryRows(s.rows).map(r=>({...r,projectProperties:s.projectProperties||project.properties||{}})),complete:true,hasMore:streams.some(k=>!s.pages[k]?.complete),queryIdentity:identity});
  check();let saved=await get(lease.account,key).catch(()=>null);check();
  if(saved?.schema!==2||saved.identity!==identity||!Array.isArray(saved.rows)||!saved.pages)saved=null;
  let legacy=[];
  if(!saved){
   const prior=await get(lease.account,mode==='work'?'work-projection-v1:'+project.project_id:'hub3:catalog:'+mode+':'+project.project_id).catch(()=>null);check();
   const records=mode==='work'?prior?.rows:prior?.value?.rows;
   if(prior?.schema===1&&Array.isArray(records))legacy=orderQueryRows(filterAttributes(records.map(r=>({...r,type:r.type||(mode==='work'?'work':'file'),project_id:project.project_id,projectProperties:project.properties||{}})).filter(r=>metadataMatches(r,query)),selected)).slice(0,40);
   if(legacy.length)onSnapshot({rows:legacy,complete:true,hasMore:true,queryIdentity:identity});
  }
  if(saved)onSnapshot(value(saved));
  if(lease.networkReady?.()===false){if(saved)return value(saved);if(legacy.length)return {rows:legacy,complete:true,hasMore:true,queryIdentity:identity};throw Object.assign(Error('session_recovering'),{code:'session_recovering'});}
  if(flights.has(flightKey)){const active=flights.get(flightKey);await active.promise;check();if(more!==active.more)return this.read(lease,project,options);const latest=await get(lease.account,key);check();onSnapshot(value(latest));return value(latest);}
  const run=(async()=>{
   let next=saved?jsonSnapshot(saved):{schema:2,identity,rows:legacy,pages:{}};
   delete next.cursor;
   const map=new Map(next.rows.map(r=>[rowKey(r),r]));
   const attrs=conditions(selected),q=query.trim();
   const normalize=(r,kind)=>kind==='work'?{...r,type:'work',project_id:project.project_id}:{...r,type:'file',project_id:project.project_id,logical_path:r.path||r.logical_path||r.placements?.[0]?.logical_path||'',file_format:r.file_format||r.path?.split('.').at(-1)||''};
   const apply=(page,kind,requested)=>{
    if(page.project_attributes&&typeof page.project_attributes==='object'&&!Array.isArray(page.project_attributes))next.projectProperties={attributes:page.project_attributes};
    if(!Array.isArray(page.items)||!Array.isArray(page.unchanged_ids||[]))throw Error('query_page_incomplete');
    const present=new Set(page.unchanged_ids||[]);for(const id of present)if(!map.has(kind+':'+id)||requested&&!requested.includes(id))throw Error('query_unchanged_scope_mismatch');
    for(const raw of page.items){const r=normalize(raw,kind),id=rowId(r);if(typeof id!=='string'||!signature.test(r.projection_revision||'')||requested&&!requested.includes(id))throw Error('query_page_scope_mismatch');present.add(id);if(r.properties?.employeeclient?.internal_encrypted===true)map.delete(kind+':'+id);else map.set(rowKey(r),r);}
    if(requested)for(const id of requested)if(!present.has(id))map.delete(kind+':'+id);
   };
   const known=(kind,offset=0)=>Object.fromEntries(orderQueryRows([...map.values()].filter(r=>r.type===kind&&signature.test(r.projection_revision||''))).slice(Math.max(0,offset-20),offset+80).map(r=>[rowId(r),r.projection_revision]));
   const pageRead=async(kind,after,offset=0)=>{
    const result=await call(kind==='work'?'v8.work.catalog':'mem.workspace.query',{...(kind==='work'?{page_mode:true}:{mode:'page',sort:'recent'}),q,attributes:attrs,limit:40,known:known(kind,offset),...(after?{after}:{})});
    if(kind==='work'&&(typeof result.coverage?.complete!=='boolean'||!result.coverage.complete&&!result.next_scan_cursor)||kind==='file'&&(typeof result.scan_complete!=='boolean'||!result.scan_complete&&!result.next_scan_cursor))throw Error('query_page_incomplete');
    apply(result,kind);return {after:result.next_scan_cursor||null,complete:!result.next_scan_cursor,offset:offset+result.items.length+(result.unchanged_ids?.length||0)};
   };
   const hydrate=async(kind,ids)=>{
    for(let i=0;i<ids.length;i+=40){const batch=ids.slice(i,i+40),versions=Object.fromEntries(batch.map(id=>[id,map.get(kind+':'+id)?.projection_revision]).filter(([,v])=>signature.test(v||'')));
     const result=await call(kind==='work'?'v8.work.catalog':'mem.workspace.query',{...(kind==='work'?{page_mode:true,work_item_ids:batch}:{mode:'rows',sort:'recent',material_ids:batch}),q,attributes:attrs,known:versions,limit:40});
     if(kind==='work'&&result.coverage?.complete!==true||kind==='file'&&result.scan_complete!==true)throw Error('query_rows_incomplete');apply(result,kind,batch);
    }
   };
   try{
    if(!saved){for(const kind of streams){next.pages[kind]=await pageRead(kind);const remaining=[...map.values()].filter(r=>r.type===kind&&!signature.test(r.projection_revision||'')).map(rowId);if(remaining.length)await hydrate(kind,remaining);}}
    else if(more){
     for(const kind of streams)if(!next.pages[kind]?.complete){
      try{next.pages[kind]=await pageRead(kind,next.pages[kind]?.after,next.pages[kind]?.offset||0);}
      catch(e){if(e?.code!=='workspace_cursor_invalid_refresh')throw e;
       // Rebuild the loaded window, not the whole project, after a traversal
       // expires/restarts. Keep its old visible rows until this finishes.
       const ids=[...map.values()].filter(r=>r.type===kind).map(rowId);await hydrate(kind,ids);
       const budget=Math.max(1,Math.ceil(ids.length/40)+1);let after,offset=0;
       for(let i=0;i<budget;i++){const state=await pageRead(kind,after,offset);next.pages[kind]=state;after=state.after;offset=state.offset;if(state.complete)break;}
       // Missing later pages are not treated as deletions. The individually
       // re-authorized loaded rows remain while traversal catches up.
      }
     }
    }else{
     // The displayed window is the reconciliation boundary. Current authorized
     // per-row signatures are the version vector; a broken/lagging event feed
     // cannot skip updates or removals. Unchanged bodies stay off the wire.
     for(const kind of streams){
      const ids=[...map.values()].filter(r=>r.type===kind).map(rowId);await hydrate(kind,ids);
      const budget=Math.max(1,Math.ceil(saved.rows.filter(r=>r.type===kind).length/40));let after,offset=0;
      for(let i=0;i<budget;i++){const state=await pageRead(kind,after,offset);next.pages[kind]=state;after=state.after;offset=state.offset;if(state.complete)break;}
     }
    }
    next.rows=[...map.values()];check();await put(lease.account,key,jsonSnapshot(next),()=>lease.valid()&&!signal?.aborted);check();onSnapshot(value(next));return value(next);
   }catch(e){if(lease.valid()&&[401,403,404].includes(e?.status)){await remove(lease.account,key,lease.valid);onSnapshot({rows:[],complete:true,hasMore:false,queryIdentity:identity});}throw e;}
   finally{flights.delete(flightKey);}
  })();flights.set(flightKey,{promise:run,more});return run;
 }};
}
