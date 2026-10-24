"""Inject user-provided signing backup in a private temporary directory only."""
import argparse,os,re,subprocess,tempfile,zipfile
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('backup',type=Path);args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
with zipfile.ZipFile(args.backup) as archive:
 instructions=archive.read(next(n for n in archive.namelist() if n.endswith('.txt'))).decode('utf-8')
 alias=re.search(r'别名\s*[:：]\s*(\S+)',instructions).group(1)
 password=re.search(r'密钥库密码及密钥密码\s*[:：]\s*`?([^\s`（(，,。；;]+)',instructions).group(1).strip('"“”')
 line=re.search(r'密钥库密码及密钥密码\s*[:：]\s*(.*)',instructions).group(1)
 defaults=alias=='androiddebugkey' and 'Android' in line and '默认' in line
 key=archive.read('employeeclient-v35.keystore')
with tempfile.TemporaryDirectory(prefix='qn-signing-') as tmp:
 folder=Path(tmp);folder.chmod(0o700)
 store=folder/'release.keystore';store.write_bytes(key);store.chmod(0o600)
 props=folder/'keystore.properties'
 assert not any(x in password+alias for x in '\r\n\\'), 'Unsupported properties encoding'
 settings=f'storeFile={store}\nkeyAlias={alias}\n'
 settings+='useAndroidDebugDefaults=true\n' if defaults else f'storePassword={password}\nkeyPassword={password}\n'
 props.write_text(settings);props.chmod(0o600)
 env={**os.environ,'JAVA_HOME':'/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
      'ANDROID_HOME':'/opt/homebrew/share/android-commandlinetools','QN_SIGNING_PROPERTIES':str(props)}
 if not defaults:
  checked=subprocess.run([env['JAVA_HOME']+'/bin/keytool','-list','-keystore',str(store),'-storepass:env','QN_TEST_STOREPASS'],env={**env,'QN_TEST_STOREPASS':password},capture_output=True)
  if checked.returncode:raise SystemExit('Backup password could not be parsed/validated; no build attempted, no credentials printed')
 subprocess.run(['npm','run','build'],cwd=root,env=env,check=True)
 subprocess.run(['npx','cap','sync','android'],cwd=root,env=env,check=True)
 subprocess.run(['sh','gradlew','assembleRelease','--no-daemon'],cwd=root/'android',env=env,check=True)
 signer=subprocess.check_output(['/opt/homebrew/share/android-commandlinetools/build-tools/34.0.0/apksigner','verify','--print-certs',str(root/'android/app/build/outputs/apk/release/app-release.apk')],env=env,text=True)
 assert '3c0be8778f5af6538297e0ca8c43d5597109d388715b624711bfdb31b79b15e3' in signer
 print('PASS candidate built with original EmployeeClient signer; temporary signing materials removed on exit')
