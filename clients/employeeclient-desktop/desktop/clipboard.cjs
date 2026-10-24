const {clipboard,ipcMain}=require('electron');const {fileURLToPath}=require('node:url');const {randomUUID}=require('node:crypto');const fs=require('node:fs/promises');const {execFileSync}=require('node:child_process');const {basename}=require('node:path');
function installClipboardBridge(allowed){
 const handles=new Map();
 ipcMain.on('employeeclient:clipboard-release',(event,id)=>{if(allowed(event)&&typeof id==='string')handles.delete(id);});
 ipcMain.handle('employeeclient:clipboard-files',async event=>{
  if(!allowed(event))throw Error('clipboard_source_rejected');let paths=[];const raw=new Map();
  for(const item of await clipboard.read())for(const type of item.types){const match=/^electron application\/osclipboard;format="([^"]+)"$/.exec(type);const format=match?.[1]||type;if(!['NSFilenamesPboardType','public.file-url','text/uri-list'].includes(format))continue;const blob=await item.getType(type);if(blob instanceof Blob&&blob.size<=65536)raw.set(format,Buffer.from(await blob.arrayBuffer()));}
  if(raw.has('NSFilenamesPboardType'))try{const parsed=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:raw.get('NSFilenamesPboardType'),timeout:2000,maxBuffer:65536}).toString());if(Array.isArray(parsed))paths=parsed.filter(x=>typeof x==='string');}catch{}
  if(!paths.length)for(const format of ['public.file-url','text/uri-list']){if(!raw.has(format))continue;for(const line of raw.get(format).toString('utf8').replace(/\0/g,'').split(/\r?\n/)){if(line.startsWith('file://'))try{paths.push(fileURLToPath(line));}catch{}}}
  paths=[...new Set(paths)];if(paths.length>6)throw Error('最多粘贴6个文件');if(handles.size+paths.length>64)throw Error('本次打开的文件较多，请重新打开员工客户端后继续');
  const checked=[];for(const path of paths){const st=await fs.stat(path);if(!st.isFile())throw Error('暂不支持粘贴文件夹，请选择其中的文件');if(!st.size||st.size>100*1024**3)throw Error('请选择非空且不超过100GB的文件');checked.push({path,size:st.size,mtime:st.mtimeMs});}
  return checked.map(item=>{const id=randomUUID();handles.set(id,item);return {id,name:basename(item.path),size:item.size,lastModified:item.mtime};});
 });
 ipcMain.handle('employeeclient:clipboard-part',async(event,id,start,length)=>{
  if(!allowed(event)||typeof id!=='string'||!handles.has(id)||!Number.isSafeInteger(start)||!Number.isSafeInteger(length)||start<0||length<0||length>8*1024*1024)throw Error('file_part_rejected');const item=handles.get(id);if(start+length>item.size)throw Error('file_part_range_rejected');const st=await fs.stat(item.path);if(st.size!==item.size||st.mtimeMs!==item.mtime)throw Error('原文件已经变化，请重新粘贴');const file=await fs.open(item.path,'r');try{const buffer=Buffer.alloc(length);let offset=0;while(offset<length){const {bytesRead}=await file.read(buffer,offset,length-offset,start+offset);if(!bytesRead)throw Error('file_part_truncated');offset+=bytesRead;}return new Uint8Array(buffer);}finally{await file.close();}
 });
}
module.exports={installClipboardBridge};
