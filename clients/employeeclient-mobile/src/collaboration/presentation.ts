import type {Attachment} from './media';
import MarkdownIt from 'markdown-it';
export type VisibleMessage = {created_at?:number;started_at?:number;completed_at?:number;attachments?:Attachment[];id:string; client_id?:string; original_id?:string; offset?:number; revision?:string; total_length?:number; role:string; text:string; phase?:string; sequence?:number; truncated?:boolean; missingPrefix?:boolean};
export type VisibleTurn = {id:string; started_at?:number; completed_at?:number; messages:VisibleMessage[]};
export function mergeMessages(history:VisibleTurn[], live:VisibleTurn[]):VisibleMessage[] {
  const turns = new Map<string,{started:number; messages:Map<string,VisibleMessage>}>();
  for(const t of [...history,...live]) {
    if(!turns.has(t.id))turns.set(t.id,{started:t.started_at || 0,messages:new Map()});
    const target=turns.get(t.id)!;
    if(t.started_at)target.started=t.started_at;
    for(const m of t.messages){
      const original=m.original_id||m.id;
      for(const [id,old] of target.messages){
        if((old.original_id||old.id)===original&&m.revision&&old.revision!==m.revision)target.messages.delete(id);
      }
      target.messages.set(m.id,{...m,started_at:m.started_at||t.started_at,completed_at:m.completed_at||t.completed_at});
    }
  }
  return [...turns.values()].sort((a,b)=>a.started-b.started).flatMap(t=>{
    const groups=new Map<string,VisibleMessage[]>();
    for(const m of t.messages.values()) {
      const id=m.original_id || m.id;
      if(!groups.has(id))groups.set(id,[]);
      groups.get(id)!.push(m);
    }
    return [...groups.entries()].map(([id,parts])=>{
      const latest=parts[parts.length-1];
      parts=parts.filter(m=>!latest.revision || m.revision===latest.revision);
      parts.sort((a,b)=>(a.offset||0)-(b.offset||0));
      return {...parts[0],id,attachments:[...new Map(parts.flatMap(m=>m.attachments||[]).map(a=>[a.id,a])).values()],sequence:latest.sequence,text:parts.map(m=>m.text).join(''),missingPrefix:(parts.find(p=>p.text)?.offset||0)>0};
    }).sort((a,b)=>{
      // Summary history can arrive before the full live turn. Final answers must
      // follow progress regardless of insertion order or the summary's index.
      const final=(m:VisibleMessage)=>m.phase==='final_answer'||m.phase==='final';
      if(final(a)!==final(b))return final(a)?1:-1;
      return (a.sequence??0)-(b.sequence??0);
    });
  });
}
const md=new MarkdownIt({html:false,breaks:true,linkify:false});
const originalLink=md.renderer.rules.link_open || ((tokens,idx,options,_env,self)=>self.renderToken(tokens,idx,options));
md.renderer.rules.link_open=(tokens,idx,options,env,self)=>{
  if(!/^https?:\/\//i.test(tokens[idx].attrGet('href')||''))tokens[idx].attrSet('href','#');
  tokens[idx].attrSet('target','_blank');tokens[idx].attrSet('rel','noopener noreferrer');
  return originalLink(tokens,idx,options,env,self);
};
// Do not load arbitrary remote images merely by opening a conversation.
md.renderer.rules.image=(tokens,idx,_options,env)=>{
  if(env?.attachments)return '';
  const token=tokens[idx],src=token.attrGet('src') || '';
  const label=md.utils.escapeHtml(token.content || '图片');
  if(!/^https?:\/\//i.test(src))return '<span class="local-media">'+label+'（本机附件）</span>';
  return '<a target="_blank" rel="noopener noreferrer" href="'+md.utils.escapeHtml(src)+'">'+label+'</a>';
};
const validateLink=md.validateLink;
md.validateLink=(url:string)=>/^file:\/\//i.test(url)||url.startsWith('/Users/')||url.startsWith('/home/')||validateLink(url);
md.core.ruler.after('inline','local-attachment-labels',state=>{
  for(const block of state.tokens){
    const children=block.children||[];const stack:number[]=[];
    children.forEach((token,index)=>{
      if(token.type==='link_open')stack.push(index);
      if(token.type==='link_close'){
        const start=stack.pop();if(start===undefined)return;
        const open=children[start],href=open.attrGet('href')||'';
        if(/^(?:file:\/\/|\/Users\/|\/home\/)/i.test(href)){
          open.type='html_inline';open.content='<span class="local-file">';
          token.type='html_inline';token.content='</span>';
        }
      }
    });
  }
});
export function renderMessage(text:string,attachments=false):string {return md.render(text,{attachments});}

export function mergeTurns(history:VisibleTurn[],incoming:VisibleTurn[]):VisibleTurn[]{
  const map=new Map<string,VisibleTurn>();
  for(const t of [...history,...incoming]){
    const old=map.get(t.id);const items=new Map((old?.messages||[]).map(m=>[m.id,m]));
    for(const m of t.messages){
      for(const [id,prev] of items)if((prev.original_id||prev.id)===(m.original_id||m.id)&&m.revision&&prev.revision!==m.revision)items.delete(id);
      items.set(m.id,m);
    }
    map.set(t.id,{...old,...t,messages:[...items.values()]});
  }
  return [...map.values()].sort((a,b)=>(a.started_at||0)-(b.started_at||0));
}
