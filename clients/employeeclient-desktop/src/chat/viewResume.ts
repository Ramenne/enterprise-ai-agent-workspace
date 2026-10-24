import type {ChatFilter,ChatMessage} from '@/api/types';
import {mergeChatMessages} from './projection';
export type ViewAnchor={id:string|undefined;y:number;offset:number};
export type ViewRange={oldest:number;newest:number;count:number};
export type ViewPoint={anchor:ViewAnchor|null;latest:boolean;unread:number};
export type ChatViewResume={schema:1;peer:string;filter:ChatFilter;searchText:string;searchOpen:boolean;historyDate:string;historyNote:string;point:ViewPoint;queryRange:ViewRange|null;context:null|{target:string;range:ViewRange;origin:ViewPoint}};
export const viewResumeKey=(peer:string)=>'chat_view_resume:'+peer;
export function viewRange(rows:ChatMessage[]):ViewRange|null{if(!rows.length)return null;return {oldest:rows[0].seq,newest:rows.at(-1)!.seq,count:rows.length};}
const text=(v:unknown,max=4000)=>typeof v==='string'&&v.length<=max;
function range(v:any):boolean{return v===null||!!v&&Number.isSafeInteger(v.oldest)&&v.oldest>0&&Number.isSafeInteger(v.newest)&&v.newest>=v.oldest&&v.newest<Number.MAX_SAFE_INTEGER&&Number.isSafeInteger(v.count)&&v.count>0&&v.count<=10000;}
function point(v:any):boolean{return !!v&&typeof v.latest==='boolean'&&Number.isSafeInteger(v.unread)&&v.unread>=0&&(v.anchor===null||!!v.anchor&&(v.anchor.id===undefined||text(v.anchor.id,128))&&Number.isFinite(v.anchor.y)&&v.anchor.y>=0&&Number.isFinite(v.anchor.offset)&&Math.abs(v.anchor.offset)<100000);}
export function readViewResume(value:unknown,peer:string):ChatViewResume|null{
 if(value==null)return null;const v=value as ChatViewResume,f=v.filter;
 const allowed=['kind','author','peer','created_from','created_until','project_id','work_item_id','related','q'];
 if(v.schema!==1||v.peer!==peer||!f||typeof f!=='object'||Object.keys(f).some(k=>!allowed.includes(k))||f.peer!==undefined&&f.peer!==peer||!text(v.searchText)||typeof v.searchOpen!=='boolean'||!text(v.historyDate,20)||!text(v.historyNote,200)||!point(v.point)||!range(v.queryRange)||v.context!==null&&(!v.context||!text(v.context.target,128)||!v.context.target||!v.context.range||!range(v.context.range)||!point(v.context.origin)))throw Error('上次阅读记录无法读取，请返回最新消息重新开始');
 for(const key of ['author','project_id','work_item_id','q'] as const)if(f[key]!==undefined&&!text(f[key],key==='q'?4000:128))throw Error('上次查找条件无法读取');
 for(const key of ['created_from','created_until'] as const)if(f[key]!==undefined&&(!Number.isSafeInteger(f[key])||f[key]!<0))throw Error('上次查找日期无法读取');
 if(f.created_from!==undefined&&f.created_until!==undefined&&f.created_until<=f.created_from)throw Error('上次查找日期范围无效');
 if(f.kind!==undefined&&!['media','files','links','voice'].includes(f.kind)||f.related!==undefined&&!['mentions','replies'].includes(f.related))throw Error('上次查找条件无法读取');
 return JSON.parse(JSON.stringify({...v,filter:{...f,...(peer?{peer}:{})}}));
}
// Recover only the previously loaded interval, not all intervening/new history.
// Two extra requests cover boundary verification; the prior row count bounds paging.
export async function restoreViewWindow(source:{messages:(q:any,signal?:AbortSignal)=>Promise<any>},filter:ChatFilter,saved:ViewRange,signal:AbortSignal){
 if(!range(saved)||!saved)throw Error('上次阅读窗口无效');
 const rows:ChatMessage[]=[],budget=Math.ceil(saved.count/100)+1;let before=saved.newest+1,more=false,cursor=Number.MAX_SAFE_INTEGER,covered=false;
 for(let page=0;page<budget;page++){
  signal.throwIfAborted();const r=await source.messages({...filter,before,limit:100},signal);signal.throwIfAborted();
  if(!Array.isArray(r.messages)||r.messages.some((m:ChatMessage)=>(m.conversation_peer||'')!==(filter.peer||'')||!Number.isSafeInteger(m.seq)||m.seq>=before))throw Error('恢复消息窗口返回范围不一致');
  if(!Number.isSafeInteger(r.sync_cursor)||r.sync_cursor<0)throw Error('恢复消息窗口缺少变更游标');cursor=Math.min(cursor,r.sync_cursor);
  rows.push(...r.messages.filter((m:ChatMessage)=>m.seq>=saved.oldest));more=!!r.has_more_old||r.messages.some((m:ChatMessage)=>m.seq<saved.oldest);
  const next=r.oldest_cursor;
  if(r.has_more_old&&(!r.messages.length||!Number.isSafeInteger(next)||next>=before))throw Error('恢复消息窗口分页未推进');
  if(!r.has_more_old||!r.messages.length||next<=saved.oldest){covered=true;break;}
  if(!Number.isSafeInteger(next)||next>=before)throw Error('恢复消息窗口分页未推进');before=next;
 }
 if(!covered)throw Error('上次阅读窗口未完整恢复，请重试');
 const newer=await source.messages({...filter,after:saved.newest,limit:1},signal);signal.throwIfAborted();
 if(!Array.isArray(newer.messages)||newer.messages.some((m:ChatMessage)=>(m.conversation_peer||'')!==(filter.peer||'')||!Number.isSafeInteger(m.seq)||m.seq<=saved.newest)||!Number.isSafeInteger(newer.sync_cursor)||newer.sync_cursor<0)throw Error('恢复消息窗口后续范围无效');
 return {messages:mergeChatMessages(rows),hasOlder:more,hasNewer:!!newer.messages.length,cursor:Math.min(cursor,newer.sync_cursor)};
}
