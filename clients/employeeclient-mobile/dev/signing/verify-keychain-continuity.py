"""Use the established signing identity to test two builds against isolated Keychain data.
No production pairing access; second read forbids UI and must work without consent.
"""
import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"connector-mac"))
from signing import IDENTITY
S=C.CDLL('/System/Library/Frameworks/Security.framework/Security')
P=C.c_void_p
S.SecKeychainCreate.argtypes=[C.c_char_p,C.c_uint32,P,C.c_bool,P,C.POINTER(P)]
S.SecKeychainDelete.argtypes=[P]
def check(status):
 if status:raise RuntimeError('Security status '+str(status))
def run(args):
 r=subprocess.run(args,capture_output=True,text=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr or r.stdout)
 return r

root=Path(tempfile.mkdtemp(prefix='qn-identity-probe-'));os.chmod(root,0o700)
kc=P();password=secrets.token_bytes(32)
check(S.SecKeychainCreate(os.fsencode(root/'test.keychain-db'),len(password),password,False,None,C.byref(kc)))
try:
 source=r'''
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
int main(int argc,char**argv){SecKeychainRef kc=NULL;OSStatus s=SecKeychainOpen(argv[1],&kc);if(s)return 2;SecKeychainSetUserInteractionAllowed(false);
const char*service="qn-continuity-isolated";const char*account="test";
if(!strcmp(argv[2],"add")){const char*value="non-secret-test-value";s=SecKeychainAddGenericPassword(kc,strlen(service),service,strlen(account),account,strlen(value),value,NULL);}
else {UInt32 n=0;void*p=NULL;s=SecKeychainFindGenericPassword(kc,strlen(service),service,strlen(account),account,&n,&p,NULL);if(!s){if(n!=21||memcmp(p,"non-secret-test-value",n))return 3;SecKeychainItemFreeContent(NULL,p);}}
printf("%d\n",(int)s);return s?1:0;}
'''
 (root/'probe.c').write_text(source)
 requirements=[];hashes=[]
 for version in (1,2):
  src=source.replace('int main(',f'const char*build="{version}";\nint main(')
  (root/'probe.c').write_text(src)
  binary=root/f'v{version}'
  run(['/usr/bin/clang','-Wno-deprecated-declarations',str(root/'probe.c'),'-framework','Security','-framework','CoreFoundation','-o',str(binary)])
  run(['/usr/bin/codesign','--force','--sign',IDENTITY,'--identifier','com.workspace.employeeclient.continuity-test','--timestamp=none',str(binary)])
  inspection=run(['/usr/bin/codesign','-d','-r-',str(binary)])
  requirement=next((x for x in (inspection.stdout+'\n'+inspection.stderr).splitlines() if 'designated =>' in x),'')
  assert 'certificate' in requirement and 'cdhash' not in requirement,requirement
  requirements.append(requirement)
  hashes.append(hashlib.sha256(binary.read_bytes()).hexdigest())
  run(['/usr/bin/codesign','--verify','--strict','-R','=identifier "com.workspace.employeeclient.continuity-test" and certificate leaf = H"'+IDENTITY+'"',str(binary)])
  result=run([str(binary),str(root/'test.keychain-db'),'add' if version==1 else 'read'])
  print(json.dumps({'version':version,'keychain_operation':'created' if version==1 else 'read_after_update','interaction_allowed':False,'status':result.stdout.strip()}),flush=True)
 assert requirements[0]==requirements[1],requirements
 assert hashes[0]!=hashes[1],'test builds must contain different code'
 # A different identity with the same name must not obtain the credential.
 run(['/usr/bin/codesign','--force','--sign','-','--identifier','com.workspace.employeeclient.continuity-test',str(root/'v2')])
 denied=subprocess.run([str(root/'v2'),str(root/'test.keychain-db'),'read'],capture_output=True,text=True,timeout=10)
 assert denied.returncode==1 and denied.stdout.strip() in ('-25308','-25293'),('expected denied Keychain access',denied.returncode,denied.stdout,denied.stderr)
 print(json.dumps({'same_requirement':True,'different_identity_denied':True,'different_identity_status':denied.stdout.strip(),'test_directory':str(root)}),flush=True)
finally:

 check(S.SecKeychainDelete(kc))
