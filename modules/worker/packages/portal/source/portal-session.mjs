import{createCipheriv,createDecipheriv,randomBytes}from'node:crypto';
/** Encrypted browser handoff, scoped to the existing member session and exact host.
 * Every request still validates the central session; no identity or authority is minted here. */
export function portalSession(key){
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('portal_session_key_required');
 const aad=Buffer.from('workspace-existing-portal-session-v1');
 const baizeRemembered=s=>s.kind==='baize_remembered'&&s.until_revoked===true&&s.host==='service.example.invalid'&&s.application==='baize'&&s.target==='baize_hufu2'&&typeof s.token==='string'&&typeof s.credential_id==='string'&&typeof s.actor_id==='string';
 const remembered=s=>baizeRemembered(s)||(s.kind==='taskhall_remembered'&&s.until_revoked===true&&s.host==='service.example.invalid'&&s.application==='taskhall'&&s.target==='taskhall_hufu2'&&typeof s.token==='string'&&typeof s.credential_id==='string'&&typeof s.actor_id==='string');
 return{
  seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);const payload={...value,expires:remembered(value)?null:Math.min(value.expires,Date.now()+28800000)};return Buffer.concat([iv,cipher.update(JSON.stringify(payload),'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64url');},
  open(value){try{if(typeof value!=='string'||value.length>6000)return null;const bytes=Buffer.from(value,'base64url');if(bytes.length<29)return null;const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(aad);decipher.setAuthTag(bytes.subarray(-16));const clear=Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);const s=JSON.parse(clear.toString('utf8'));if(remembered(s)&&s.expires===null)return s;return typeof s.cookie==='string'&&typeof s.host==='string'&&Number.isFinite(s.expires)&&s.expires>Date.now()?s:null;}catch{return null;}}
 };
}
