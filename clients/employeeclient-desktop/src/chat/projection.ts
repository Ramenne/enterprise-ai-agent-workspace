import type {ChatMessage} from '@/api/types';
type Quote=NonNullable<ChatMessage['reply_to']>;

// Quotes carry independent versions: a late parent projection must never
// resurrect an original already hidden/recalled in a newer change receipt.
export function mergeChatMessages(rows:ChatMessage[]):ChatMessage[]{
 const roots=new Map<string,ChatMessage>(),facts=new Map<string,Quote>();
 const newer=(old:Quote|undefined,row:Quote)=>!old||(old.change_version||0)<(row.change_version||0)||
  (old.change_version||0)===(row.change_version||0)&&(!(old.hidden||old.recalled)||!!(row.hidden||row.recalled));
 for(const row of rows){
  if(newer(roots.get(row.id),row))roots.set(row.id,row);
  for(const fact of [row,...(row.reply_to?[row.reply_to]:[])])if(newer(facts.get(fact.id),fact))facts.set(fact.id,fact);
 }
 return [...roots.values()].map(row=>{
  const fact=facts.get(row.id)!;
  let result=fact===row?row:{...row,...fact,reply_to:fact.hidden||fact.recalled?null:row.reply_to};
  if(result.hidden||result.recalled)return {...result,body:'',attachments:[],mention_usernames:[],context:null,project_id:null,work_item_id:null,reply_to:null};
  if(result.reply_to){const quote=facts.get(result.reply_to.id)!;const {reply_to:_nested,...snapshot}=quote as Quote&{reply_to?:unknown};result={...result,reply_to:snapshot};}
  return result;
 }).sort((a,b)=>a.seq-b.seq);
}
export function applyChatChanges(current:ChatMessage[],changes:ChatMessage[]):ChatMessage[]{
 const loaded=new Set(current.map(row=>row.id));
 // Apply references before dropping unrequested roots, preserving the loaded
 // history window rather than inserting a disconnected old message prefix.
 return mergeChatMessages([...current,...changes]).filter(row=>loaded.has(row.id));
}
