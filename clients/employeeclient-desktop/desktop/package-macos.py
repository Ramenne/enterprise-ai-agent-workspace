"""Package from excluded build storage; remove the DMG staging app after use."""
from pathlib import Path
import subprocess,tempfile,json,hashlib,sys
base=Path(__file__).resolve().parent.parent
D=base.parent/'delivery';version=json.loads((base/'desktop/package.json').read_text())['version'];arch=sys.argv[1] if len(sys.argv)>1 else 'arm64'
assert arch in ['arm64','x64']
app=D/f'.builds.noindex/{version}-{arch}/员工客户端.app';assert app.is_dir()
with tempfile.TemporaryDirectory(prefix='dmg-',dir=D/'.builds.noindex') as tmp:
 stage=Path(tmp);subprocess.run(['ditto',str(app),str(stage/'员工客户端.app')],check=True)
 (stage/'Applications').symlink_to('/Applications')
 (stage/'安装说明.txt').write_text('双击员工客户端，点击“安装并打开”，自动放入应用程序并打开。已有运行实例时请先退出。聊天记录和草稿保留。\n')
 z=D/f'employeeclient-macos-{arch}-{version}.zip';z.unlink(missing_ok=True)
 subprocess.run(['ditto','-c','-k','--sequesterRsrc','--keepParent',str(app),str(z)],check=True)
 subprocess.run(['hdiutil','create','-volname','员工客户端','-srcfolder',tmp,'-ov','-format','UDZO',str(z.with_suffix('.dmg'))],check=True,stdout=subprocess.DEVNULL)
files=[]
for ext in ['zip','dmg']:
 p=D/f'employeeclient-macos-{arch}-{version}.{ext}'
 files.append({'file':p.name,'architecture':arch,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'path':f'/updates/macos/{version}/{p.name}','downloadUrl':f'https://dwdsh-backup-1316920087.cos.ap-shanghai.myqcloud.com/public/employeeclient/releases/macos/{version}/{p.name}'})
(D/f'macos-{version}-release.json').write_text(json.dumps({'version':version,'files':files},ensure_ascii=False,indent=2))
(D/f'macos-latest-{version}.json').write_text(json.dumps({'schema':'employeeclient.desktop-update.v1','version':version,'notes':'统一新版发现与更新红点；关于页直接更新，去除重复检查；隔离打包副本，避免重复应用入口。','files':[files[0]]},ensure_ascii=False,indent=2))
print(json.dumps({'version':version,'stage_removed':True,'files':files}))
