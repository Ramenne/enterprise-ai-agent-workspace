package com.workspace.employeeclient;

import java.io.*;
import java.security.*;

/** Verify the persistent destination, not only the temporary download cache. */
final class VerifiedAttachmentSave {
 static final class Receipt {final long size;final String sha256;Receipt(long size,String sha256){this.size=size;this.sha256=sha256;}}
 private static MessageDigest digest(){try{return MessageDigest.getInstance("SHA-256");}catch(NoSuchAlgorithmException e){throw new IllegalStateException(e);}}
 static Receipt copy(InputStream in,OutputStream out)throws IOException {
  MessageDigest hash=digest();long size=0;byte[] buffer=new byte[65536];int n;
  while((n=in.read(buffer))!=-1){if(n==0)continue;out.write(buffer,0,n);hash.update(buffer,0,n);size+=n;}
  out.flush();return new Receipt(size,hex(hash.digest()));
 }
 static void verify(InputStream in,Receipt expected)throws IOException {
  Receipt actual=inspect(in);
  if(actual.size!=expected.size||!actual.sha256.equals(expected.sha256))throw new IOException("保存结果不完整");
 }
 static Receipt inspect(InputStream in)throws IOException {
  MessageDigest hash=digest();long size=0;byte[] buffer=new byte[65536];int n;
  while((n=in.read(buffer))!=-1){if(n==0)continue;hash.update(buffer,0,n);size+=n;}
  return new Receipt(size,hex(hash.digest()));
 }
 private static String hex(byte[] data){StringBuilder out=new StringBuilder();for(byte value:data)out.append(String.format("%02x",value&255));return out.toString();}
}
