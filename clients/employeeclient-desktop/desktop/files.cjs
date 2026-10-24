// Verified, private file copies for user-initiated OS open/share/drag. No arbitrary path IPC.
const {ipcMain,app,shell,ShareMenu,nativeImage}=require('electron');
const fs=require('node:fs/promises');const {join,basename}=require('node:path');const {createHash,randomUUID}=require('node:crypto');
function installFileBridge(allowed,getWindow,{root=join(app.getPath('userData'),'native-file-handoff')}={}){
 const entries=new Map(),sources=new Map();let currentAccount='',epoch=0;
 const ready=fs.rm(root,{recursive:true,force:true}).then(()=>fs.mkdir(root,{recursive:true,mode:0o700}));
 const drop=async(id,e)=>{if(entries.get(id)!==e)return;entries.delete(id);const wc=getWindow()?.webContents;if(wc&&!wc.isDestroyed?.())wc.send('employeeclient:file-invalid',id);if(sources.get(e.key)===id)sources.delete(e.key);await e.file?.close().catch(()=>{});await fs.rm(e.dir,{recursive:true,force:true}).catch(()=>{});};
 const valid=event=>{if(!allowed(event))throw Error('file_source_rejected');};
 const owned=(event,id)=>{valid(event);const e=entries.get(id);if(!e||e.owner!==event.sender.id||e.account!==currentAccount||e.busy)throw Error('file_handle_rejected');return e;};
 async function verify(e){const stat=await fs.lstat(e.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==e.size)throw Error('文件副本已变化，请重新获取');const h=createHash('sha256');for await(const b of (await fs.open(e.path,'r')).createReadStream())h.update(b);if(h.digest('hex')!==e.sha256)throw Error('文件副本已变化，请重新获取');e.verified={size:stat.size,mtimeMs:stat.mtimeMs,ino:stat.ino};}
 ipcMain.handle('employeeclient:file-account',async(event,account)=>{valid(event);if(typeof account!=='string'||account.length>160)throw Error('file_account_rejected');if(account!==currentAccount){currentAccount=account;epoch++;await Promise.all([...entries].map(([id,e])=>drop(id,e)));}return true;});
 ipcMain.handle('employeeclient:file-begin',async(event,meta)=>{
  valid(event);await ready;
  if(!meta||Object.keys(meta).some(k=>!['account','key','name','size','sha256'].includes(k))||!currentAccount||meta.account!==currentAccount||typeof meta.key!=='string'||meta.key.length>4096||typeof meta.name!=='string'||!meta.name||meta.name.length>160||/[\\/\x00-\x1f]/.test(meta.name)||!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>100*1024**3||!/^[a-f0-9]{64}$/.test(meta.sha256))throw Error('file_metadata_rejected');
  const key=JSON.stringify([currentAccount,meta.key,meta.name,meta.size,meta.sha256]),previous=sources.get(key),old=entries.get(previous);
  if(old?.complete){try{await verify(old);valid(event);if(old.account!==currentAccount)throw Error('file_account_changed');return {id:previous,complete:true};}catch{await drop(previous,old);}}
  if(old&&!old.complete)throw Error('文件正在准备，请稍候');
  if([...entries.values()].filter(e=>!e.complete).length>=4)throw Error('请先完成当前文件准备');
  while(entries.size>=24){const victim=[...entries].find(([,e])=>e.complete&&!e.busy);if(!victim)throw Error('文件准备繁忙');await drop(...victim);}
  const turn=epoch,id=randomUUID(),dir=join(root,id);await fs.mkdir(dir,{mode:0o700});const path=join(dir,basename(meta.name));let file;
  try{file=await fs.open(path+'.part','wx+',0o600);valid(event);if(turn!==epoch||meta.account!==currentAccount)throw Error('file_account_changed');const e={...meta,key,id,dir,path,file,owner:event.sender.id,bytes:0,hash:createHash('sha256'),busy:false,complete:false};entries.set(id,e);sources.set(key,id);return {id,complete:false};}
  catch(error){await file?.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});throw error;}
 });
 ipcMain.handle('employeeclient:file-part',async(event,id,offset,data)=>{const e=owned(event,id);if(e.complete||offset!==e.bytes||!Number.isSafeInteger(offset)||!(data instanceof Uint8Array)||!data.byteLength||data.byteLength>8*1024**2||offset+data.byteLength>e.size)throw Error('file_part_rejected');e.busy=true;try{const b=Buffer.from(data);let n=0;while(n<b.length){const r=await e.file.write(b,n,b.length-n,offset+n);if(!r.bytesWritten)throw Error('文件写入未完成');n+=r.bytesWritten;}e.hash.update(b);e.bytes+=b.length;return e.bytes;}catch(error){await drop(id,e);throw error;}finally{e.busy=false;}});
 ipcMain.handle('employeeclient:file-finish',async(event,id)=>{const e=owned(event,id);e.busy=true;try{if(e.complete)return {id};if(e.bytes!==e.size||e.hash.digest('hex')!==e.sha256)throw Error('文件副本校验失败');await e.file.sync();await e.file.close();e.file=null;await fs.rename(e.path+'.part',e.path);await verify(e);valid(event);if(e.account!==currentAccount||entries.get(id)!==e)throw Error('file_account_changed');e.complete=true;return {id};}catch(error){await drop(id,e);throw error;}finally{e.busy=false;}});
 ipcMain.handle('employeeclient:file-cancel',async(event,id)=>{valid(event);const e=entries.get(id);if(e&&e.owner===event.sender.id)await drop(id,e);});
 async function action(event,id,kind){const e=owned(event,id);if(!e.complete)throw Error('file_not_ready');e.busy=true;try{await verify(e);valid(event);if(e.account!==currentAccount||entries.get(id)!==e)throw Error('file_account_changed');if(kind==='open'){const error=await shell.openPath(e.path);if(error)throw Error('系统未能打开此文件，请选择其他应用或另存为');return {state:'handed_off',message:'已交给系统打开'};}const menu=new ShareMenu({filePaths:[e.path]});menu.popup({window:getWindow()});return {state:'handed_off',message:'已打开系统分享菜单'};}finally{e.busy=false;}}
 ipcMain.handle('employeeclient:file-open',(event,id)=>action(event,id,'open'));ipcMain.handle('employeeclient:file-share',(event,id)=>action(event,id,'share'));
 // Electron requires startDrag in the drag gesture. The renderer prepares and
 // verifies bytes before enabling dragging; here only an already-ready path is accepted.
 ipcMain.on('employeeclient:file-drag',(event,id)=>{try{const e=owned(event,id);if(!e.complete)return;const s=require('node:fs').lstatSync(e.path);if(!s.isFile()||s.isSymbolicLink()||s.size!==e.verified?.size||s.mtimeMs!==e.verified?.mtimeMs||s.ino!==e.verified?.ino){void drop(id,e);return;}event.sender.startDrag({file:e.path,icon:nativeImage.createFromPath(join(__dirname,'icon.png')).resize({width:48,height:48})});}catch{/* Source UI exposes preparation failures before the drag gesture. */}});
 return {clear:async()=>{epoch++;currentAccount='';await Promise.all([...entries].map(([id,e])=>drop(id,e)));}};
}
module.exports={installFileBridge};
