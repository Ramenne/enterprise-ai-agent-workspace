#!/usr/bin/env python3
"""Build the desktop channel with a canonical legacy path and immutable COS URL."""
import argparse,hashlib,json,re
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--delivery',type=Path,required=True);p.add_argument('--notes',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
v=json.loads((Path(__file__).parent/'package.json').read_text())['version']
assert re.fullmatch(r'\d{1,4}\.\d{1,4}\.\d{1,4}',v) and len(a.notes)<=4000
files=[]
for arch in ['arm64','x64']:
 name=f'employeeclient-macos-{arch}-{v}.zip';f=a.delivery/name
 if not f.exists():continue
 h=hashlib.sha256()
 with f.open('rb') as stream:
  for b in iter(lambda:stream.read(1024*1024),b''):h.update(b)
 files.append({'file':name,'architecture':arch,'bytes':f.stat().st_size,'sha256':h.hexdigest(),'path':f'/updates/macos/{v}/{name}','downloadUrl':f'https://dwdsh-backup-1316920087.cos.ap-shanghai.myqcloud.com/public/employeeclient/releases/macos/{v}/{name}'})
assert files,'No ZIP installers found for the current desktop version'
a.output.write_text(json.dumps({'schema':'employeeclient.desktop-update.v1','version':v,'notes':a.notes,'files':files},ensure_ascii=False,indent=2))
print(json.dumps({'version':v,'architectures':[f['architecture'] for f in files],'directCOS':True}))
