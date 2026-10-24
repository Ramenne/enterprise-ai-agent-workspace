from pathlib import Path
import subprocess,tempfile,uuid,json,hashlib,sys
helper=Path(sys.argv[1])/'Contents/Helpers/EmployeeClientKeychain'
source=r'''
#import <Foundation/Foundation.h>
int main(int argc,const char**argv){@autoreleasepool{
NSDictionary *request=@{@"operation":@(argv[2]),@"service":@"com.workspace.employeeclient.connector.selftest",@"account":@(argv[3]),@"value":@{@"proof":@YES}};
NSTask *task=[NSTask new];task.executableURL=[NSURL fileURLWithPath:@(argv[1])];NSPipe *input=[NSPipe pipe],*output=[NSPipe pipe];task.standardInput=input;task.standardOutput=output;
if(![task launchAndReturnError:NULL])return 1;[input.fileHandleForWriting writeData:[NSJSONSerialization dataWithJSONObject:request options:0 error:NULL]];[input.fileHandleForWriting closeFile];NSData*raw=[output.fileHandleForReading readDataToEndOfFile];[task waitUntilExit];if(task.terminationStatus)return 2;
NSDictionary*r=[NSJSONSerialization JSONObjectWithData:raw options:0 error:NULL];if(!r||[r[@"status"] intValue])return 3;if([@(argv[2]) isEqual:@"load"]&&![r[@"value"] isEqual:@{@"proof":@YES}])return 4;puts("OK");return 0;}}
'''
with tempfile.TemporaryDirectory(prefix='qn59-owner-proof-') as d:
 root=Path(d);account=uuid.uuid4().hex;rows=[]
 for version in (1,2):
  src=root/'main.m';src.write_text('const char*build="'+str(version)+'";\n'+source);exe=root/str(version)
  subprocess.run(['/usr/bin/clang','-fobjc-arc',str(src),'-framework','Foundation','-o',str(exe)],check=True,capture_output=True)
  subprocess.run(['/usr/bin/codesign','--force','--sign','F2A1B2CA31E59F451B17E2120BF23516BF3A99BD','--identifier','com.workspace.employeeclient.connector',str(exe)],check=True,capture_output=True)
  operation='save' if version==1 else 'load'
  r=subprocess.run([str(exe),str(helper),operation,account],capture_output=True,text=True,timeout=10);assert r.returncode==0,(r.returncode,r.stdout,r.stderr)
  rows.append({'build':version,'sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'operation':operation,'result':r.stdout.strip()})
 assert rows[0]['sha256']!=rows[1]['sha256']
 subprocess.run([str(exe),str(helper),'delete',account],check=True,capture_output=True,timeout=10)
 out={'location':'system login Keychain','production_pairing_accessed':False,'rows':rows}
 print(json.dumps(out))
