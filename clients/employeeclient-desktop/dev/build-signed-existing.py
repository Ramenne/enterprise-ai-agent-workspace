"""Use the existing encrypted signing store; credentials remain in child env only."""
import os,re,subprocess,zipfile
from pathlib import Path
root=Path(__file__).resolve().parents[1]
backup=Path('/Users/developer/Downloads/员工客户端签名本地备份-2026-09-21.zip')
store=Path('/Users/developer/Downloads/员工客户端签名本地备份-2026-09-21/employeeclient-v35.keystore')
with zipfile.ZipFile(backup) as archive:
 text=archive.read(next(n for n in archive.namelist() if n.endswith('.txt'))).decode('utf-8')
 alias=re.search(r'别名\s*[:：]\s*(\S+)',text).group(1)
 line=re.search(r'密钥库密码及密钥密码\s*[:：]\s*(.*)',text).group(1)
 password='android' if alias=='androiddebugkey' and '默认' in line and 'Android' in line else re.search(r'密钥库密码及密钥密码\s*[:：]\s*`?([^\s`（(，,。；;]+)',text).group(1).strip('"“”')
env={**os.environ,'JAVA_HOME':'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home','ANDROID_HOME':'/opt/homebrew/share/android-commandlinetools','QN_RELEASE_STORE':str(store),'QN_RELEASE_ALIAS':alias,'QN_RELEASE_STORE_PASSWORD':password,'QN_RELEASE_KEY_PASSWORD':password}
checked=subprocess.run([env['JAVA_HOME']+'/bin/keytool','-list','-keystore',str(store),'-storepass:env','QN_RELEASE_STORE_PASSWORD'],env=env,capture_output=True)
if checked.returncode:raise SystemExit('Existing signing store validation failed; no credentials printed')
subprocess.run(['npx','cap','sync','android'],cwd=root,env=env,check=True)
subprocess.run(['sh','gradlew','assembleRelease','--no-daemon'],cwd=root/'android',env=env,check=True)
result=subprocess.run(['/opt/homebrew/share/android-commandlinetools/build-tools/34.0.0/apksigner','verify','--print-certs',str(root/'android/app/build/outputs/apk/release/app-release.apk')],env=env,capture_output=True,text=True)
if result.returncode or '3c0be8778f5af6538297e0ca8c43d5597109d388715b624711bfdb31b79b15e3' not in result.stdout:raise SystemExit('Original signer verification failed')
print('Signed with existing EmployeeClient store; no credential files created')
