import {effectiveKind} from './file-type.mjs';
import {isVoiceMessage} from './chat-media-purpose.mjs';
export const MESSAGE_KINDS=['media','files','links','voice'];
export function attachmentSearchKind(a){
 if(isVoiceMessage(a))return 'voice';
 const type=effectiveKind(a?.name||'',a?.mime);
 return type==='image'||type==='video'?'media':'files';
}
// Only explicit HTTP(S) and www links; keep HTML and unsupported schemes text.
export function messageTextParts(text,query=''){
 const chunks=[];let end=0;
 const mark=value=>{
  if(!query)return [{text:value,match:false}];
  const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),regex=new RegExp(escaped,'gi');let cursor=0;const parts=[];
  for(const found of value.matchAll(regex)){if(found.index>cursor)parts.push({text:value.slice(cursor,found.index),match:false});parts.push({text:found[0],match:true});cursor=found.index+found[0].length;}
  if(cursor<value.length)parts.push({text:value.slice(cursor),match:false});return parts;
 };
 for(const found of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"\x00-\x20，。！？；：、【】（）]+/gi)){
  const raw=found[0].replace(/[.,!?;:]+$/g,''),start=found.index;let url;
  try{url=new URL(/^www\./i.test(raw)?'https://'+raw:raw);}catch{continue;}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password)continue;
  if(start>end)chunks.push({text:text.slice(end,start),parts:mark(text.slice(end,start))});
  chunks.push({text:raw,href:url.href,parts:mark(raw)});end=start+raw.length;
 }
 if(end<text.length)chunks.push({text:text.slice(end),parts:mark(text.slice(end))});return chunks;
}
export function hasMessageLink(text){return messageTextParts(text).some(p=>p.href);}
