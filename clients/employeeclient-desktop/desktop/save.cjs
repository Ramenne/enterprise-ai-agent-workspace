// The renderer receives only an opaque capability; paths come from the OS dialog.
const {ipcMain,dialog,app}=require('electron');
const fs=require('node:fs/promises');const {createHash,randomUUID}=require('node:crypto');const {basename,dirname,join}=require('node:path');
function installSaveBridge(allowed,getWindow){
 const saves=new Map(),owners=new Set();let choosing=false;
 const drop=async(id,entry)=>{if(saves.get(id)!==entry)return;saves.delete(id);await entry.file.close().catch(()=>{});await fs.unlink(entry.temp).catch(()=>{});};
 const owned=(event,id)=>{if(!allowed(event))throw Error('save_source_rejected');const entry=saves.get(id);if(!entry||entry.owner!==event.sender.id||entry.busy)throw Error('save_handle_rejected');return entry;};
 ipcMain.handle('employeeclient:save-begin',async(event,name)=>{
  if(!allowed(event)||typeof name!=='string'||!name||name.length>160||/[\\/\0]/.test(name))throw Error('save_name_rejected');
  if(choosing||saves.size>=4)throw Error('请先完成当前保存');choosing=true;
  try{
   const result=await dialog.showSaveDialog(getWindow(),{title:'保存文件',defaultPath:join(app.getPath('downloads'),basename(name)),buttonLabel:'保存',properties:['createDirectory']});
   if(result.canceled||!result.filePath)return null;if(!allowed(event))return null;
   const id=randomUUID(),target=result.filePath,temp=join(dirname(target),'.employeeclient-'+id+'.part');
   const file=await fs.open(temp,'wx+',0o600);const entry={owner:event.sender.id,file,temp,target,name:basename(target),bytes:0,busy:false,hash:createHash('sha256')};saves.set(id,entry);
   if(!owners.has(event.sender.id)){owners.add(event.sender.id);const owner=event.sender.id;event.sender.once('destroyed',()=>{owners.delete(owner);for(const [key,value]of saves)if(value.owner===owner)void drop(key,value);});}return id;
  }finally{choosing=false;}
 });
 ipcMain.handle('employeeclient:save-part',async(event,id,offset,data)=>{
  const entry=owned(event,id);if(!Number.isSafeInteger(offset)||offset!==entry.bytes||!(data instanceof Uint8Array)||data.byteLength>8*1024**2||entry.bytes+data.byteLength>100*1024**3)throw Error('save_part_rejected');
  entry.busy=true;
  try{const bytes=Buffer.from(data);let written=0;while(written<bytes.length){const result=await entry.file.write(bytes,written,bytes.length-written,offset+written);if(!result.bytesWritten)throw Error('文件写入未完成');written+=result.bytesWritten;}entry.hash.update(bytes);entry.bytes+=bytes.length;return entry.bytes;}
  catch(error){await drop(id,entry);throw error;}finally{entry.busy=false;}
 });
 ipcMain.handle('employeeclient:save-finish',async(event,id,size,sha256)=>{
  const entry=owned(event,id);entry.busy=true;
  try{
   if(!Number.isSafeInteger(size)||size!==entry.bytes||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256)||entry.hash.digest('hex')!==sha256)throw Error('保存内容校验失败');
   await entry.file.sync();const hash=createHash('sha256');let count=0;
   for await(const chunk of entry.file.createReadStream({autoClose:false,start:0})){count+=chunk.length;hash.update(chunk);}
   if(count!==size||hash.digest('hex')!==sha256)throw Error('本机文件校验失败');
   await entry.file.close();await fs.rename(entry.temp,entry.target);saves.delete(id);return {state:'saved',message:'已保存 '+entry.name};
  }catch(error){await drop(id,entry);throw error;}finally{entry.busy=false;}
 });
 ipcMain.handle('employeeclient:save-cancel',async(event,id)=>{if(!allowed(event))return;const entry=saves.get(id);if(entry&&entry.owner===event.sender.id)await drop(id,entry);});
}
module.exports={installSaveBridge};
