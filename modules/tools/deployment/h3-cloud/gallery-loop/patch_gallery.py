from pathlib import Path

def patch_index(s):
 if "from './gallery-loop.mjs'" not in s:s="import {createGalleryLoop} from './gallery-loop.mjs';\n"+s
 anchor=" const generation=createGeneration({db,galleryTools,...(comfyBase?{base:comfyBase}:{})});"
 if 'const galleryLoop=' not in s:
  assert s.count(anchor)==1;s=s.replace(anchor,anchor+"\n const galleryLoop=createGalleryLoop({db,galleryTools,generation,library});")
 anchor="  if(path.startsWith('/api/generation/')){"
 if "path.startsWith('/api/loop/')" not in s:
  assert s.count(anchor)==1;s=s.replace(anchor,"""  if(path.startsWith('/api/loop/')&&req.method==='POST'){
   let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>200000)throw fail(413,'请求过大');chunks.push(c)}
   let args;try{args=JSON.parse(Buffer.concat(chunks).toString())}catch{throw fail(400,'无效JSON')}
   return reply(200,await galleryLoop.invoke(decodeURIComponent(path.slice('/api/loop/'.length)),args,me,callerTokens.get(me)));
  }
"""+anchor)
 return s

def patch_generation(s):
 s=s.replace("process.env.COMFY_API_BASE||'http://127.0.0.1:18292/api/h3-cloud/krea2'", "process.env.COMFY_API_BASE||'http://127.0.0.1:18292/api/h3-cloud/unified/krea2'")
 s=s.replace("args.prompt.length>20000","args.prompt.length>10000").replace('请填写20000字以内','请填写10000字以内').replace('v%8)','v%16)').replace('之间的8倍数','之间的16倍数')
 s=s.replace("if(!Number.isSafeInteger(seed)||seed<0)","if(!Number.isSafeInteger(seed)||seed<0||seed>4294967295)").replace('种子须为非负安全整数','种子须为0至4294967295的整数')
 anchor=" const width=args.width??1024,height=args.height??1024,seed=args.seed??42424242;"
 if '统一生成通路要求单行' not in s:
  assert s.count(anchor)==1;s=s.replace(anchor," if(/[\\r\\n]/.test(args.prompt)||args.prompt.includes('--')||args.prompt.startsWith('-'))throw fail(400,'统一生成通路要求单行纯提示词');\n"+anchor)
 s=s.replace("lora_supported:!!d.lora_import};", "lora_supported:!!d.lora_import,execution_entry:d.provider==='unified-visual'?'visual_unified':'legacy_cloud',...(d.routing?{routing:d.routing,autodl:d.autodl}:{})};")
 s=s.replace("parameters:r.parameters,model:'Krea 2'", "parameters:r.parameters,...(r.route?{route:r.route}:{}),model:'Krea 2'")
 s=s.replace("provider_job_id:r.provider_job_id||null", "provider_job_id:r.provider_job_id||null,provider:r.provider||'comfy_cloud'")
 s=s.replace("reference_images_used:false},note:'由网页经Comfy Cloud生成；尚未人工验图。'", "reference_images_used:false,provider:j.provider||'comfy_cloud'},note:'由中枢统一生成通路生成；尚未人工验图。'")
 return s
if __name__=='__main__':
 root=Path('sites/visual-lab-server/server');out=Path('deploy/visual-feedback-mcp')
 for name,patch in [('index.mjs',patch_index),('generation.mjs',patch_generation)]:
  p=root/name;before=p.read_text();(out/('before-'+name)).write_text(before);p.write_text(patch(before));(out/name).write_text(p.read_text())
 for name in ['gallery-loop.mjs','gallery-loop-contract.mjs']:(root/name).write_text((out/name).read_text())
