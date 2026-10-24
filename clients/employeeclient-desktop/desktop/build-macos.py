from pathlib import Path
import plistlib,shutil,subprocess,hashlib,json,sys
base=Path(__file__).resolve().parent.parent
architecture=sys.argv[1] if len(sys.argv)>1 else 'arm64'
if architecture not in ['arm64','x64']:raise SystemExit('Use arm64 or x64')
version=json.loads((base/'desktop/package.json').read_text())['version']
runtime=base.parent/('runtime/electron-'+architecture+'/Electron.app')
out=base.parent/('delivery/.builds.noindex/'+version+'-'+architecture);out.mkdir(parents=True,exist_ok=True)
app=out/'员工客户端.app'
if app.exists():shutil.rmtree(app)
shutil.copytree(runtime,app,symlinks=True)
# Our packaged app replaces Electron's unused example application. Removing it
# also lets already-installed 0.2.3/0.2.4 updaters clean this release safely.
(app/'Contents/Resources/default_app.asar').unlink(missing_ok=True)
info=app/'Contents/Info.plist'
v=plistlib.loads(info.read_bytes());v.update(CFBundleIdentifier='com.workspace.employeeclient.desktop',CFBundleName='员工客户端',CFBundleDisplayName='员工客户端',CFBundleShortVersionString=version,CFBundleVersion='7',NSMicrophoneUsageDescription='用于你主动发起的语音录制。');info.write_bytes(plistlib.dumps(v))
# Package the existing EmployeeClient artwork, preserving the product's own identity.
iconset=out/'employeeclient.iconset';iconset.mkdir(exist_ok=True)
for size in [16,32,128,256,512]:
 for scale in [1,2]:
  name='icon_'+str(size)+'x'+str(size)+('@2x'if scale==2 else '')+'.png'
  subprocess.run(['sips','-z',str(size*scale),str(size*scale),str(base/'desktop/assets/app-icon.png'),'--out',str(iconset/name)],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(app/'Contents/Resources/employeeclient.icns')],check=True)
v['CFBundleIconFile']='employeeclient.icns';info.write_bytes(plistlib.dumps(v))
resource=app/'Contents/Resources/app';resource.mkdir()
shutil.copy2(base/'desktop/assets/app-icon.png',resource/'icon.png')
for n in ['package.json','main.cjs','preload.cjs','clipboard.cjs','save.cjs','files.cjs','updates.cjs']:shutil.copy2(base/'desktop'/n,resource/n)
shutil.copytree(base/'dist',resource/'web')
subprocess.run(['codesign','--force','--deep','--sign','-','--entitlements',str(base/'desktop/entitlements.plist'),str(app)],check=True)
subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
result={'state':'local_candidate','app':str(app),'version':version,'architecture':architecture,'signature':'ad_hoc_not_Developer_ID_not_notarized','electron':'44.9.0','web_entry_sha256':hashlib.sha256((base/'dist/index.html').read_bytes()).hexdigest()}
(out/'build-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
