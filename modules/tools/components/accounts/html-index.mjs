// Derived Dream-storage directory only; no HTML contents or credentials.
import {createHash,createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
export const credentialFingerprint=member=>createHash('sha256').update(member.owner+'\0'+member.token).digest('hex');
const ownerKey=owner=>createHash('sha256').update('html-directory-v1\0'+owner).digest('hex');
const encryptionKey=()=>{const bytes=Buffer.from(process.env.XIANYU_KEY||'','base64');if(bytes.length!==32)throw Error('目录加密尚未配置');return hkdfSync('sha256',bytes,Buffer.alloc(0),'html-directory-index-v1',32)};
export function createHtmlIndexStore(db){
 db.exec('CREATE TABLE IF NOT EXISTS html_cloud_directory(owner_key TEXT PRIMARY KEY,encrypted_index TEXT NOT NULL,updated_at TEXT NOT NULL)');
 const store={
  load(owner){const row=db.prepare('SELECT encrypted_index FROM html_cloud_directory WHERE owner_key=?').get(ownerKey(owner));if(!row)return null;try{const b=Buffer.from(row.encrypted_index,'base64'),d=createDecipheriv('aes-256-gcm',encryptionKey(),b.subarray(0,12));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(12,-16)),d.final()]).toString())}catch{return null}},
  save(owner,data){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',encryptionKey(),iv),bytes=Buffer.concat([c.update(JSON.stringify(data)),c.final()]);db.prepare('INSERT INTO html_cloud_directory VALUES(?,?,?) ON CONFLICT(owner_key) DO UPDATE SET encrypted_index=excluded.encrypted_index,updated_at=excluded.updated_at').run(ownerKey(owner),Buffer.concat([iv,bytes,c.getAuthTag()]).toString('base64'),data.lastSyncedAt)}
 };
 return {...store,loadShared(){return store.load('shared-html-library-v1')},saveShared(data){return store.save('shared-html-library-v1',data)}};
}
