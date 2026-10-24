package com.workspace.employeeclient;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.*;
import java.util.*;
public class VerifiedAttachmentSaveTest {
 @Test public void verifiesPersistentBytesIncludingMultipleChunks()throws Exception {
  byte[] bytes=new byte[1100123];new Random(10).nextBytes(bytes);ByteArrayOutputStream out=new ByteArrayOutputStream();
  VerifiedAttachmentSave.Receipt receipt=VerifiedAttachmentSave.copy(new ByteArrayInputStream(bytes),out);
  assertEquals(bytes.length,receipt.size);assertArrayEquals(bytes,out.toByteArray());
  VerifiedAttachmentSave.verify(new ByteArrayInputStream(out.toByteArray()),receipt);
  byte[] changed=out.toByteArray();changed[700000]^=1;
  try{VerifiedAttachmentSave.verify(new ByteArrayInputStream(changed),receipt);fail("modified destination accepted");}catch(IOException expected){}
  try{VerifiedAttachmentSave.verify(new ByteArrayInputStream(Arrays.copyOf(bytes,bytes.length-1)),receipt);fail("truncated destination accepted");}catch(IOException expected){}
 }
 @Test public void zeroByteFilesAreValid()throws Exception {
  VerifiedAttachmentSave.Receipt receipt=VerifiedAttachmentSave.copy(new ByteArrayInputStream(new byte[0]),new ByteArrayOutputStream());
  assertEquals(0,receipt.size);VerifiedAttachmentSave.verify(new ByteArrayInputStream(new byte[0]),receipt);
 }
 @Test public void fingerprintsFilesWithoutProviderDigestForLaterCacheLookup()throws Exception {
  byte[] bytes="without provider digest".getBytes(java.nio.charset.StandardCharsets.UTF_8);
  VerifiedAttachmentSave.Receipt receipt=VerifiedAttachmentSave.inspect(new ByteArrayInputStream(bytes));
  assertEquals(bytes.length,receipt.size);
  VerifiedAttachmentSave.verify(new ByteArrayInputStream(bytes),receipt);
 }
 @Test public void failedWritesCannotProduceReceipt()throws Exception {
  try{VerifiedAttachmentSave.copy(new ByteArrayInputStream(new byte[]{1}),new OutputStream(){public void write(int value)throws IOException{throw new IOException("disk full");}});fail("write failure accepted");}catch(IOException expected){}
 }
}
