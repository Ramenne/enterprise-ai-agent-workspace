"""Read binary Android manifest and application label, not filenames or JS assets."""
import os,re,shutil,subprocess
from pathlib import Path

def apk_identity(apk):
    candidates=[]
    for key in ('ANDROID_HOME','ANDROID_SDK_ROOT'):
        if os.environ.get(key):candidates.extend(Path(os.environ[key]).glob('build-tools/*/aapt'))
    for root in ('/opt/homebrew/share/android-commandlinetools','/usr/local/share/android-commandlinetools'):
        candidates.extend(Path(root).glob('build-tools/*/aapt'))
    found=shutil.which('aapt')
    if found:candidates.append(Path(found))
    candidates=[p for p in candidates if p.exists()]
    if not candidates:raise RuntimeError('aapt is required to verify the binary APK identity')
    proc=subprocess.run([str(sorted(candidates)[-1]),'dump','badging',str(apk)],capture_output=True,text=True)
    if proc.returncode:raise RuntimeError('APK binary manifest could not be read')
    package=re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'",proc.stdout,re.M)
    label=re.search(r"^application-label:'([^']*)'",proc.stdout,re.M)
    if not package or not label:raise RuntimeError('APK package/version/application label missing')
    return {'packageName':package[1],'versionCode':int(package[2]),'versionName':package[3],'appName':label[1]}

def require_apk_identity(apk,package,code,name):
    actual=apk_identity(apk)
    if actual!={'packageName':package,'versionCode':code,'versionName':name,'appName':'员工客户端'}:
        raise RuntimeError('APK identity mismatch: '+str(actual))
    return actual
