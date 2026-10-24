// Unsent drafts and delivery projections, isolated by signed-in account.
// Only a fresh native control response may dispatch a queued item. Unknown
// receipts are never replayed, including after navigation or an app restart.
export type Outgoing = {
  id:string; computer:string; provider:string; thread:string; text:string;
  model?:string; effort?:string; createdAt:number; state:'queued'|'sending'|'accepted'|'guiding'|'unknown'|'failed';
  error?:string; delivery?:'queued'|'submitted'; previousIds:string[];
};
const key=(account:string)=>'employeeclient:collaboration:outbox:'+account;
export function readOutbox(account:string):Outgoing[]{
  const raw=JSON.parse(localStorage.getItem(key(account))||'[]');
  if(!Array.isArray(raw)||raw.some(r=>!r||!['id','computer','provider','thread','text'].every(k=>typeof r[k]==='string')||['model','effort'].some(k=>r[k]!==undefined&&typeof r[k]!=='string')||!['queued','submitted'].includes(r.delivery??'submitted')||!['queued','sending','accepted','guiding','unknown','failed'].includes(r.state)||!Number.isFinite(r.createdAt)||!Array.isArray(r.previousIds)||r.previousIds.some((id:unknown)=>typeof id!=='string')))throw Error('待发消息读取失败');
  return raw.map(r=>({...r,state:r.state==='sending'?'unknown':r.state}));
}
export function writeOutbox(account:string,rows:Outgoing[]){
  if(!account)throw Error('账号未确认');
  localStorage.setItem(key(account),JSON.stringify(rows));
}
