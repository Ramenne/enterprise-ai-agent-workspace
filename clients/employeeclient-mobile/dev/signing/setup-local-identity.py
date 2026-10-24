"""Create one local signing identity; private material goes directly to Keychain.

Developer tool only: requires cryptography. No private key/P12/password files,
no global trust changes. Trust, when requested separately, is code-signing only.
The identity is reused across releases; never regenerate it as part of a build.
"""
import ctypes as C, datetime as D, hashlib, json, os, secrets, subprocess, tempfile
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
S=C.CDLL('/System/Library/Frameworks/Security.framework/Security');F=C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
P=C.c_void_p
F.CFStringCreateWithCString.argtypes=[P,C.c_char_p,C.c_uint32];F.CFStringCreateWithCString.restype=P
F.CFDataCreate.argtypes=[P,C.c_void_p,C.c_long];F.CFDataCreate.restype=P
F.CFDictionaryCreate.argtypes=[P,P,P,C.c_long,P,P];F.CFDictionaryCreate.restype=P
F.CFArrayCreate.argtypes=[P,P,C.c_long,P];F.CFArrayCreate.restype=P
S.SecKeychainCreate.argtypes=[C.c_char_p,C.c_uint32,P,C.c_bool,P,C.POINTER(P)]
S.SecKeychainDelete.argtypes=[P]
S.SecPKCS12Import.argtypes=[P,P,C.POINTER(P)]
S.SecTrustedApplicationCreateFromPath.argtypes=[C.c_char_p,C.POINTER(P)]
S.SecAccessCreate.argtypes=[P,P,C.POINTER(P)]
def text(s):return F.CFStringCreateWithCString(None,s.encode(),0x08000100)
def symbol(name):return P.in_dll(S,name).value
def check(status):
 if status:raise RuntimeError('Security status '+str(status))
def run(args):
 r=subprocess.run(args,capture_output=True,text=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr or r.stdout)
 return r

LABEL='EmployeeClient Local Release Signing'
root=Path.home()/'Library/Application Support/EmployeeClientConnector/signing'
root.mkdir(parents=True,exist_ok=True,mode=0o700)
public=root/'identity.cer'
if public.exists():
    cert=x509.load_der_x509_certificate(public.read_bytes())
    print(json.dumps({'identity':cert.fingerprint(hashes.SHA1()).hex().upper(),'certificate':str(public),'existing':True}))
    raise SystemExit(0)
existing=subprocess.run(['/usr/bin/security','find-certificate','-c',LABEL],capture_output=True)
if existing.returncode==0:raise SystemExit('Signing certificate already exists: recover its public certificate instead of replacing the key.')
S.SecKeychainOpen.argtypes=[C.c_char_p,C.POINTER(P)]
kc=P();check(S.SecKeychainOpen(os.fsencode(Path.home()/'Library/Keychains/login.keychain-db'),C.byref(kc)))
key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,LABEL)])
now=D.datetime.now(D.timezone.utc)
cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-D.timedelta(minutes=5)).not_valid_after(now+D.timedelta(days=3650)).add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True).add_extension(x509.KeyUsage(digital_signature=True,key_encipherment=False,content_commitment=False,data_encipherment=False,key_agreement=False,key_cert_sign=True,crl_sign=False,encipher_only=None,decipher_only=None),critical=True).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CODE_SIGNING]),critical=False).sign(key,hashes.SHA256()))
pfxpass=secrets.token_urlsafe(32)
enc=(serialization.PrivateFormat.PKCS12.encryption_builder().kdf_rounds(2048).key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC).hmac_hash(hashes.SHA1()).build(pfxpass.encode()))
pfx=pkcs12.serialize_key_and_certificates(LABEL.encode(),key,cert,None,enc)
trusted=P();check(S.SecTrustedApplicationCreateFromPath(b'/usr/bin/codesign',C.byref(trusted)))
arr=F.CFArrayCreate(None,(P*1)(trusted),1,None);access=P();check(S.SecAccessCreate(text(LABEL),arr,C.byref(access)))
keys=(P*3)(symbol('kSecImportExportPassphrase'),symbol('kSecImportExportKeychain'),symbol('kSecImportExportAccess'))
values=(P*3)(text(pfxpass),kc,access)
opts=F.CFDictionaryCreate(None,keys,values,3,None,None);items=P()
check(S.SecPKCS12Import(F.CFDataCreate(None,pfx,len(pfx)),opts,C.byref(items)))
public.write_bytes(cert.public_bytes(serialization.Encoding.DER));public.chmod(0o600)
print(json.dumps({'identity':cert.fingerprint(hashes.SHA1()).hex().upper(),'certificate':str(public),'existing':False}))
