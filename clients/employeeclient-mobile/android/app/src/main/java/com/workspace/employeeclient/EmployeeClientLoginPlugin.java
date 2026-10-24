package com.workspace.employeeclient;
import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.webkit.CookieManager;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device credential stays native: no token enters JS, logs, or Android backup. */
@CapacitorPlugin(name="EmployeeClientLogin")
public class EmployeeClientLoginPlugin extends Plugin {
 private static final String HOST="https://employeeclient.example.invalid/", NAME="qn_member_device", ALIAS="employeeclient-member-login-v1";
 private static final Object VAULT_LOCK=new Object();
 private File file(){return new File(getContext().getNoBackupFilesDir(),"member-login.sealed");}
 private static SecretKey key(boolean create) throws Exception {
  KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
  if(!store.containsAlias(ALIAS)){
   if(!create)throw new Exception("device_key_missing");
   KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
   generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());generator.generateKey();
  }
  return (SecretKey)store.getKey(ALIAS,null);
 }
 private String current(){return cookieValue(CookieManager.getInstance().getCookie(HOST));}
 private static String cookieValue(String cookie){
  if(cookie==null)return null;
  String found=null;
  for(String part:cookie.split(";")){
   String item=part.trim();if(!item.startsWith(NAME+"="))continue;
   if(found!=null)return null;found=item.substring(NAME.length()+1);
  }
  return found!=null&&found.matches("[A-Za-z0-9_-]{20,4096}")?found:null;
 }
 // Successful identity readback may adopt the first cookie, never replace an
 // existing durable identity. Explicit new sign-in clears the previous vault.
 static void saveVerifiedCookie(Context context) throws Exception {
  synchronized(VAULT_LOCK){
   String token=cookieValue(CookieManager.getInstance().getCookie(HOST));
   if(token==null)throw new Exception("cookie_not_retained");
   String saved;try{saved=sealedCookie(context);}catch(Exception unreadable){saved=null;}
   if(saved!=null){if(!saved.equals(NAME+"="+token))throw new Exception("credential_projection_changed");CookieManager.getInstance().flush();return;}
   Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key(true));
   cipher.updateAAD(HOST.getBytes(StandardCharsets.UTF_8));
   byte[] iv=cipher.getIV(),body=cipher.doFinal(token.getBytes(StandardCharsets.UTF_8)),sealed=new byte[iv.length+body.length];
   System.arraycopy(iv,0,sealed,0,iv.length);System.arraycopy(body,0,sealed,iv.length,body.length);
   android.util.AtomicFile output=new android.util.AtomicFile(new File(context.getNoBackupFilesDir(),"member-login.sealed"));java.io.FileOutputStream stream=null;
   try{stream=output.startWrite();stream.write(sealed);output.finishWrite(stream);}catch(Exception e){if(stream!=null)output.failWrite(stream);throw e;}
   CookieManager.getInstance().flush();
  }
 }
 @PluginMethod public void save(PluginCall call){getActivity().runOnUiThread(()->{
  try{saveVerifiedCookie(getContext());call.resolve();}catch(Exception e){call.reject("device_login_save_failed");}
 });}
 // The sealed credential is durable authority; CookieManager is only its HTTP projection.
 // Existing installs without a vault may use their cookie until verified migration.
 static String transportCookie(Context context,String current) throws Exception {
  try{String saved=sealedCookie(context);return saved==null?current:saved;}
  catch(Exception unreadable){if(cookieValue(current)!=null)return current;throw unreadable;}
 }
 private static String sealedCookie(Context context) throws Exception {
  synchronized(VAULT_LOCK){
   File file=new File(context.getNoBackupFilesDir(),"member-login.sealed");if(!file.exists())return null;
   if(file.length()<29||file.length()>8192)throw new Exception("invalid_snapshot");
   byte[] sealed=new android.util.AtomicFile(file).readFully();
   Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(false),new GCMParameterSpec(128,Arrays.copyOfRange(sealed,0,12)));
   cipher.updateAAD(HOST.getBytes(StandardCharsets.UTF_8));
   String token=new String(cipher.doFinal(Arrays.copyOfRange(sealed,12,sealed.length)),StandardCharsets.UTF_8);
   if(!token.matches("[A-Za-z0-9_-]{20,4096}"))throw new Exception("invalid_snapshot");
   return NAME+"="+token;
  }
 }
 static String prepareTransportCookie(Context context,String base,Object lock,java.util.function.BooleanSupplier valid)throws Exception{
  synchronized(lock){if(!valid.getAsBoolean())throw new Exception("session_generation_changed");}
  recoverTransportCookie(context,base,lock,valid);
  synchronized(lock){if(!valid.getAsBoolean())throw new Exception("session_generation_changed");return transportCookie(context,CookieManager.getInstance().getCookie(base));}
 }
 static boolean recoverTransportCookie(Context context,String base) throws Exception {
  return recoverTransportCookie(context,base,context,()->true);
 }
 static boolean recoverTransportCookie(Context context,String base,Object lock,java.util.function.BooleanSupplier valid) throws Exception {
  if(android.os.Looper.myLooper()==android.os.Looper.getMainLooper())throw new Exception("credential_restore_requires_worker");
  CookieManager manager=CookieManager.getInstance();String current=manager.getCookie(base),sealed;
  try{sealed=sealedCookie(context);}catch(Exception unreadable){if(cookieValue(current)!=null)return false;throw unreadable;}
  if(sealed==null)return false;
  if(current!=null&&java.util.Arrays.asList(current.split(";\\s*")).contains(sealed))return false;
  java.util.concurrent.CountDownLatch done=new java.util.concurrent.CountDownLatch(1);
  java.util.concurrent.atomic.AtomicBoolean accepted=new java.util.concurrent.atomic.AtomicBoolean(false),attempted=new java.util.concurrent.atomic.AtomicBoolean(false),pending=new java.util.concurrent.atomic.AtomicBoolean(true);
  // Cookie callbacks require a Looper. The transport executor has none.
  new android.os.Handler(android.os.Looper.getMainLooper()).post(()->{
   synchronized(lock){
    if(!pending.get()||!valid.getAsBoolean()||!java.util.Objects.equals(current,manager.getCookie(base))){done.countDown();return;}
    try{attempted.set(true);manager.setCookie(base,sealed+"; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=34560000",ok->{accepted.set(ok);manager.flush();done.countDown();});}
    catch(Exception ignored){done.countDown();}
   }
  });
  boolean completed=done.await(5,java.util.concurrent.TimeUnit.SECONDS);pending.set(false);
  if(!completed)throw new Exception("device_login_restore_failed");
  synchronized(lock){if(!valid.getAsBoolean())return false;}
  if(attempted.get()&&!accepted.get())throw new Exception("device_login_restore_failed");
  return accepted.get();
 }
 @PluginMethod public void restore(PluginCall call){getActivity().runOnUiThread(()->{
  try{
   CookieManager manager=CookieManager.getInstance();manager.setAcceptCookie(true);
   manager.setAcceptThirdPartyCookies(bridge.getWebView(),true);
   String saved;try{saved=sealedCookie(getContext());}catch(Exception unreadable){if(current()!=null){call.resolve();return;}throw unreadable;}
   if(saved==null||saved.equals(NAME+"="+current())){call.resolve();return;}
   String token=saved.substring(NAME.length()+1);
   manager.setCookie(HOST,NAME+"="+token+"; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=34560000",accepted->{
    if(!accepted){call.reject("device_login_restore_failed");return;}manager.flush();call.resolve();
   });
  }catch(Exception e){call.reject("device_login_restore_failed");}
 });}
 @PluginMethod public void clear(PluginCall call){getActivity().runOnUiThread(()->{
  try{synchronized(VAULT_LOCK){new android.util.AtomicFile(file()).delete();}CookieManager.getInstance().flush();call.resolve();}catch(Exception e){call.reject("device_login_clear_failed");}
 });}
}
