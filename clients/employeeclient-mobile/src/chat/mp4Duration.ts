// MediaRecorder on Android writes fragmented MP4 with a zero movie duration.
// Read the audio fragments' decode timestamps instead of treating mvhd as final.
type Box={type:string;data:number;end:number};
const read32=(b:Uint8Array,i:number)=>((b[i]*0x1000000+b[i+1]*0x10000+b[i+2]*0x100+b[i+3])>>>0);
const read64=(b:Uint8Array,i:number)=>read32(b,i)*0x100000000+read32(b,i+4);
function boxes(b:Uint8Array,start:number,end:number):Box[]{
 const result:Box[]=[];
 for(let i=start;i+8<=end;){let size=read32(b,i),data=i+8;
  const type=String.fromCharCode(b[i+4],b[i+5],b[i+6],b[i+7]);
  if(size===1){if(i+16>end)break;size=read64(b,i+8);data=i+16;}
  else if(size===0)size=end-i;
  if(!Number.isSafeInteger(size)||size<data-i||i+size>end)break;
  result.push({type,data,end:i+size});i+=size;
 }
 return result;
}
function child(b:Uint8Array,box:Box,type:string){return boxes(b,box.data,box.end).find(x=>x.type===type);}
function track(b:Uint8Array,box:Box){
 const tkhd=child(b,box,'tkhd'),mdia=child(b,box,'mdia');if(!tkhd||!mdia)return;
 const mdhd=child(b,mdia,'mdhd'),hdlr=child(b,mdia,'hdlr');if(!mdhd||!hdlr||tkhd.data+24>tkhd.end||mdhd.data+24>mdhd.end||hdlr.data+12>hdlr.end)return;
 const id=read32(b,tkhd.data+(b[tkhd.data]===1?20:12));
 const timescale=read32(b,mdhd.data+(b[mdhd.data]===1?20:12));
 const audio=String.fromCharCode(...b.slice(hdlr.data+8,hdlr.data+12))==='soun';
 return id&&timescale?{id,timescale,audio}:undefined;
}
export function fragmentedMp4Duration(bytes:Uint8Array):number{
 if(bytes.length<32)return 0;
 const root=boxes(bytes,0,bytes.length),moov=root.find(x=>x.type==='moov');if(!moov)return 0;
 const tracks=boxes(bytes,moov.data,moov.end).filter(x=>x.type==='trak').map(x=>track(bytes,x)).filter((x):x is NonNullable<typeof x>=>!!x?.audio);
 if(!tracks.length)return 0;
 const selected=tracks[0]!;let endTick=0;
 for(const moof of root.filter(x=>x.type==='moof'))for(const traf of boxes(bytes,moof.data,moof.end).filter(x=>x.type==='traf')){
  const tfhd=child(bytes,traf,'tfhd'),tfdt=child(bytes,traf,'tfdt');if(!tfhd||!tfdt||tfhd.data+8>tfhd.end||tfdt.data+8>tfdt.end)continue;
  const flags=read32(bytes,tfhd.data)&0xffffff,id=read32(bytes,tfhd.data+4);if(id!==selected.id)continue;
  let at=tfhd.data+8;if(flags&1)at+=8;if(flags&2)at+=4;
  const defaultDuration=flags&8&&at+4<=tfhd.end?read32(bytes,at):0;
  const base=tfdt.data+4,decodeTime=bytes[tfdt.data]===1&&base+8<=tfdt.end?read64(bytes,base):base+4<=tfdt.end?read32(bytes,base):NaN;
  if(!Number.isFinite(decodeTime))continue;
  let samples=0;
  for(const trun of boxes(bytes,traf.data,traf.end).filter(x=>x.type==='trun')){
   if(trun.data+8>trun.end)continue;
   const options=read32(bytes,trun.data)&0xffffff,count=read32(bytes,trun.data+4);
   if(count>1000000)continue;
   let pos=trun.data+8;if(options&1)pos+=4;if(options&4)pos+=4;
   for(let n=0;n<count;n++){
    let duration=defaultDuration;
    if(options&0x100){if(pos+4>trun.end){duration=0;break;}duration=read32(bytes,pos);pos+=4;}
    if(options&0x200)pos+=4;if(options&0x400)pos+=4;if(options&0x800)pos+=4;
    if(pos>trun.end||!duration){samples=0;break;}samples+=duration;
   }
  }
  if(samples>0)endTick=Math.max(endTick,decodeTime+samples);
 }
 const seconds=endTick/selected.timescale;
 return Number.isFinite(seconds)&&seconds>0&&seconds<24*60*60?seconds:0;
}
