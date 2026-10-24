import {inflateRawSync} from 'node:zlib';
import {parseDocument} from 'yaml';
import {createHash} from 'node:crypto';

export const MAX_PACKAGE_BYTES=5*1024*1024;
const MAX_EXPANDED=10*1024*1024,MAX_FILES=300;
export const fail=(status,message)=>Object.assign(new Error(message),{status});
const decoder=new TextDecoder('utf-8',{fatal:true});
const utf8=bytes=>{try{return decoder.decode(bytes)}catch{throw fail(400,'文件名和 SKILL.md 必须使用 UTF-8 编码')}};
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0});
export const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0};
const safePath=name=>{
 if(!name||name.length>500||/[\\\u0000-\u001f\u007f:]/.test(name)||name.startsWith('/')||name.split('/').some(x=>!x||x==='.'||x==='..'))throw fail(400,'ZIP 含有无效路径');
 return name.normalize('NFC');
};
export function unpackZip(bytes){
 try{
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break}
  if(end<0)throw fail(400,'ZIP 文件损坏');
  const count=bytes.readUInt16LE(end+10),offset=bytes.readUInt32LE(end+16),length=bytes.readUInt32LE(end+12);
  if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count||count>MAX_FILES||!count||offset+length!==end)throw fail(400,'ZIP 最多 300 项，不支持分卷或 ZIP64');
  const files=[],names=new Set();let pos=offset,total=0;
  for(let i=0;i<count;i++){
   if(pos+46>end||bytes.readUInt32LE(pos)!==0x02014b50)throw fail(400,'ZIP 目录损坏');
   const flags=bytes.readUInt16LE(pos+8),method=bytes.readUInt16LE(pos+10),crc=bytes.readUInt32LE(pos+16),packed=bytes.readUInt32LE(pos+20),size=bytes.readUInt32LE(pos+24),nl=bytes.readUInt16LE(pos+28),el=bytes.readUInt16LE(pos+30),cl=bytes.readUInt16LE(pos+32),mode=bytes.readUInt32LE(pos+38)>>>16,local=bytes.readUInt32LE(pos+42);
   if(pos+46+nl+el+cl>end||bytes.readUInt16LE(pos+34)||flags&1||![0,8].includes(method)||local+30>offset||bytes.readUInt32LE(local)!==0x04034b50)throw fail(400,'ZIP 不支持加密、分卷或此压缩方式');
   const rawName=bytes.subarray(pos+46,pos+46+nl),raw=utf8(rawName),directory=raw.endsWith('/'),name=safePath(directory?raw.slice(0,-1):raw);
   if((mode&0xf000)===0xa000||((mode&0xf000)&&![0x8000,0x4000].includes(mode&0xf000)))throw fail(400,'ZIP 不支持符号链接和特殊文件');
   if(names.has(name))throw fail(400,'ZIP 含有重复路径');names.add(name);
   const lnl=bytes.readUInt16LE(local+26),lel=bytes.readUInt16LE(local+28),start=local+30+lnl+lel;
   if(bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||!bytes.subarray(local+30,local+30+lnl).equals(rawName)||start+packed>offset)throw fail(400,'ZIP 文件信息不一致');
   total+=size;if(size>MAX_EXPANDED||total>MAX_EXPANDED)throw fail(413,'ZIP 解压后总大小最多 10 MB');
   const compressed=bytes.subarray(start,start+packed);
   const data=method===0?compressed:inflateRawSync(compressed,{maxOutputLength:Math.max(1,size)});
   if(data.length!==size||crc32(data)!==crc)throw fail(400,'ZIP 内容校验失败');
   if(directory){if(size)throw fail(400,'ZIP 目录内容无效')}else if(!name.startsWith('__MACOSX/')&&!name.split('/').includes('.DS_Store'))files.push({path:name,bytes:data});
   pos+=46+nl+el+cl;
  }
  if(pos!==end)throw fail(400,'ZIP 目录损坏');
  const instructions=files.filter(x=>x.path==='SKILL.md'||x.path.endsWith('/SKILL.md'));
  if(instructions.length!==1)throw fail(400,'每次请导入一个 Skill，ZIP 中须包含唯一的 SKILL.md');
  const prefix=instructions[0].path.slice(0,-8);
  if(prefix&&files.some(x=>!x.path.startsWith(prefix)))throw fail(400,'配套文件须放在 SKILL.md 所在目录中');
  return files.map(x=>({...x,path:x.path.slice(prefix.length)}));
 }catch(error){if(error.status)throw error;throw fail(400,'ZIP 文件损坏或解压大小超限')}
}
export function inspectPackage(filename,bytes){
 if(typeof filename!=='string'||filename.length>200||/[\\/\u0000-\u001f]/.test(filename))throw fail(400,'文件名无效');
 if(!bytes.length||bytes.length>MAX_PACKAGE_BYTES)throw fail(413,'上传文件最大 5 MB');
 const format=/\.zip$/i.test(filename)?'zip':filename==='SKILL.md'?'md':null;
 if(!format)throw fail(400,'请选择 SKILL.md 或 ZIP');
 const files=format==='zip'?unpackZip(bytes):[{path:'SKILL.md',bytes}];
 const skill=files.find(x=>x.path==='SKILL.md');if(skill.bytes.length>1024*1024)throw fail(413,'SKILL.md 最大 1 MB');
 const content=utf8(skill.bytes).replace(/^\uFEFF/,'');if(content.includes('\0'))throw fail(400,'SKILL.md 内容无效');
 const front=content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
 if(!front)throw fail(400,'SKILL.md 开头须包含 YAML 格式的 name 和 description');
 const doc=parseDocument(front[1],{uniqueKeys:true});
 if(doc.errors.length)throw fail(400,'SKILL.md 的 YAML 格式无效');
 let meta;try{meta=doc.toJS({maxAliasCount:20})}catch{throw fail(400,'SKILL.md 的 YAML 格式无效')}
 if(!meta||typeof meta.name!=='string'||!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(meta.name)||meta.name.length>64)throw fail(400,'name 须为最多 64 字符的字母、数字和连字符');
 if(typeof meta.description!=='string'||!meta.description.trim()||meta.description.length>2000)throw fail(400,'description 须为 1–2000 字符的说明');
 const body=content.slice(front[0].length).trim();if(!body)throw fail(400,'SKILL.md 须包含使用说明正文');
 const versionLabel=['string','number'].includes(typeof meta.version)?String(meta.version).slice(0,100):'';
 return {name:meta.name,description:meta.description.trim(),content,format,files,versionLabel,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
}
export function previewPackage(body){
 const pkg=packageFromBody(body);
 return {name:pkg.name,description:pkg.description,filename:body.filename,format:pkg.format,size:pkg.size,expandedSize:pkg.files.reduce((total,file)=>total+file.bytes.length,0),versionLabel:pkg.versionLabel,files:pkg.files.map(file=>({path:file.path,size:file.bytes.length}))};
}
export function packageFromBody(body){
 if(typeof body?.packageBase64!=='string'||body.packageBase64.length>Math.ceil(MAX_PACKAGE_BYTES/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.packageBase64))throw fail(400,'上传内容无效或超过 5 MB');
 const bytes=Buffer.from(body.packageBase64,'base64');return {bytes,...inspectPackage(body.filename,bytes)};
}
