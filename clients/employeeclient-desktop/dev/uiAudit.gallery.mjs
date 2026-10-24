// QA contact sheets only; original screenshots remain unmodified.
import {readdirSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const sharp=require('/Users/developer/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const dir='/tmp/employeeclient-full-ui-audit',output=dir+'/contact';mkdirSync(output,{recursive:true});
for(const group of ['mobile-pages','desktop-pages','mobile-overlays','desktop-overlays']){
 const mobile=group.startsWith('mobile'),overlay=group.endsWith('overlays');
 const files=readdirSync(dir).filter(f=>f.endsWith(mobile?'-390.png':'-1440.png')&&(overlay?f.startsWith('overlay-'):f.startsWith('_'))).sort();
 for(let i=0;i<files.length;i+=4){const set=files.slice(i,i+4),width=mobile?390:700,height=mobile?1280:650,layers=[];
  for(let j=0;j<set.length;j++){
   const img=await sharp(dir+'/'+set[j]).resize({width,height:height-30,fit:'inside',withoutEnlargement:true}).png().toBuffer();
   const left=(j%2)*width,top=Math.floor(j/2)*height;
   layers.push({input:img,left,top:top+30});
   layers.push({input:Buffer.from(`<svg width="${width}" height="30"><rect width="100%" height="100%" fill="#152f32"/><text x="8" y="20" fill="white" font-size="13">${set[j]}</text></svg>`),left,top});
  }
  await sharp({create:{width:width*2,height:height*Math.ceil(set.length/2),channels:4,background:'#e0e6e4'}}).composite(layers).png().toFile(`${output}/${group}-${i/4+1}.png`);
 }
}
console.log(output);
