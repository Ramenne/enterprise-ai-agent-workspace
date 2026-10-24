package com.workspace.employeeclient;

import android.app.Activity;
import android.content.Intent;
import android.content.ContentValues;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Disk-backed attachment transfer. No broad storage permission; explicit system open/share choosers. */
@CapacitorPlugin(name="EmployeeClientAttachment")
public class EmployeeClientAttachmentPlugin extends Plugin {
 private final ExecutorService io=Executors.newSingleThreadExecutor();
 // A network transfer must not block lookup/open/save of unrelated cached files.
 private final ExecutorService networkIo=Executors.newFixedThreadPool(2);
 private final Map<String,Transfer> transfers=new ConcurrentHashMap<>();
 private String saving;
 private static class Transfer {File file;String name,mime,key="",savedUri="",location="",sha="";volatile boolean complete,verified,cancelled;final AtomicBoolean fetching=new AtomicBoolean();volatile java.net.HttpURLConnection connection; Transfer(File f,String n,String m){file=f;name=n;mime=m;}}
 private File directory(){File d=new File(getContext().getFilesDir(),"attachment-library");d.mkdirs();return d;}
 private void persist(String id,Transfer t)throws Exception{
  org.json.JSONObject o=new org.json.JSONObject();o.put("id",id);o.put("name",t.name);o.put("mime",t.mime);o.put("key",t.key);o.put("size",t.file.length());o.put("savedUri",t.savedUri);o.put("location",t.location);o.put("sha",t.sha);
  File next=new File(t.file.getParentFile().getParentFile(),"index.json.next"),index=new File(t.file.getParentFile().getParentFile(),"index.json");
  try(FileOutputStream out=new FileOutputStream(next)){out.write(o.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));out.getFD().sync();}
  if(!next.renameTo(index))throw new IOException();
 }
 @Override public void load(){io.execute(()->{File[] folders=directory().listFiles();if(folders==null)return;for(File folder:folders){try{
  org.json.JSONObject o=new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(new File(folder,"index.json").toPath()),java.nio.charset.StandardCharsets.UTF_8));
  String name=o.getString("name");if(name.contains("/")||name.contains("\\"))continue;
  File file=new File(new File(folder,"content"),name);if(!file.isFile()||file.length()!=o.getLong("size"))continue;
  Transfer t=new Transfer(file,name,o.getString("mime"));t.key=o.getString("key");t.savedUri=o.optString("savedUri");t.location=o.optString("location");t.sha=o.optString("sha");t.complete=true;transfers.put(folder.getName(),t);
 }catch(Exception ignored){}}});}
 private boolean savedExists(Transfer t){if(t.savedUri.isEmpty())return false;try(android.content.res.AssetFileDescriptor f=getContext().getContentResolver().openAssetFileDescriptor(Uri.parse(t.savedUri),"r")){return f!=null&&(f.getLength()<0||f.getLength()==t.file.length());}catch(Exception e){return false;}}
 @PluginMethod public void lookup(PluginCall call){io.execute(()->{try{
  String key=call.getString("key","");String expected=call.getString("sha256","");JSObject out=new JSObject();out.put("found",false);
  for(Map.Entry<String,Transfer> e:transfers.entrySet()){Transfer t=e.getValue();if(!key.isEmpty()&&key.equals(t.key)&&t.complete&&t.file.isFile()){
   if(!t.verified){try{
    if(t.sha.isEmpty()){
     // Older provider downloads may have no source digest. Fingerprint the
     // complete local bytes once instead of discarding a valid cache entry.
     try(InputStream in=new FileInputStream(t.file)){t.sha=VerifiedAttachmentSave.inspect(in).sha256;}
     persist(e.getKey(),t);
    }else try(InputStream in=new FileInputStream(t.file)){VerifiedAttachmentSave.verify(in,new VerifiedAttachmentSave.Receipt(t.file.length(),t.sha));}
    t.verified=true;
   }catch(IOException corrupt){removeTransfer(e.getKey());continue;}catch(Exception unavailable){call.reject("无法确认本机附件缓存");return;}}
   if(!expected.isEmpty()&&!expected.equals(t.sha)){removeTransfer(e.getKey());continue;}
   out.put("found",true);out.put("name",t.name);out.put("id",e.getKey());out.put("url",Uri.fromFile(t.file).toString());out.put("size",t.file.length());out.put("saved",savedExists(t));out.put("location",t.location);break;
  }}call.resolve(out);
 }catch(Exception e){call.reject("无法读取本地附件");}});}
 // Duration is a property of the cached original, not of a WebView URL or
 // playback. Scan audio timestamps so fragmented recordings without a valid
 // container duration also work before the user presses Play.
 @PluginMethod public void audioDuration(PluginCall call){io.execute(()->{
  android.media.MediaExtractor extractor=new android.media.MediaExtractor();
  try{
   Transfer t=find(call);if(!t.complete||t.cancelled)throw new IOException();
   extractor.setDataSource(t.file.getAbsolutePath());
   int track=-1;long declared=0;
   for(int i=0;i<extractor.getTrackCount();i++){
    android.media.MediaFormat format=extractor.getTrackFormat(i);
    if(format.getString(android.media.MediaFormat.KEY_MIME).startsWith("audio/")){
     track=i;if(format.containsKey(android.media.MediaFormat.KEY_DURATION))declared=format.getLong(android.media.MediaFormat.KEY_DURATION);break;
    }
   }
   if(track<0)throw new IOException();extractor.selectTrack(track);
   long first=-1,last=-1,step=0,deadline=android.os.SystemClock.elapsedRealtime()+15000;
   do{
    if(t.cancelled||android.os.SystemClock.elapsedRealtime()>deadline)throw new IOException();
    long stamp=extractor.getSampleTime();if(stamp<0)break;
    if(first<0)first=stamp;
    if(last>=0&&stamp>last)step=stamp-last;
    last=stamp;
   }while(extractor.advance());
   long micros=Math.max(declared,last<0?0:last-first+step);
   if(micros<=0)throw new IOException();
   JSObject out=new JSObject();out.put("seconds",micros/1000000.0);call.resolve(out);
  }catch(Exception e){call.reject("无法读取录音时长");}finally{extractor.release();}
 });}
 @PluginMethod public void readPart(PluginCall call){io.execute(()->{try{
  Transfer t=find(call);long offset=AttachmentInteger.read(call.getData().opt("offset"),-1L);int length=call.getInt("length",-1);long size=t.file.length();
  if(!t.complete||t.cancelled||offset<0||length<1||length>524288||offset>size-length)throw new IOException();
  byte[] bytes=new byte[length];try(RandomAccessFile in=new RandomAccessFile(t.file,"r")){in.seek(offset);in.readFully(bytes);}
  JSObject out=new JSObject();out.put("size",size);out.put("data",Base64.encodeToString(bytes,Base64.NO_WRAP));call.resolve(out);
 }catch(Exception e){call.reject("本机文件无法读取，请重新下载后重试");}});}
 @PluginMethod public void rename(PluginCall call){io.execute(()->{try{
  Transfer t=find(call);String name=call.getString("name","").trim();
  if(!t.complete||t.cancelled||saving!=null||name.isEmpty()||name.length()>160||name.matches(".*[\\\\/\\p{Cntrl}].*")||name.equals(".")||name.equals(".."))throw new IOException();
  String oldExt=t.name.lastIndexOf('.')>0?t.name.substring(t.name.lastIndexOf('.')):"",newExt=name.lastIndexOf('.')>0?name.substring(name.lastIndexOf('.')):"";
  if(!oldExt.equalsIgnoreCase(newExt)){call.reject("请保留原文件扩展名");return;}
  if(name.equals(t.name)){JSObject out=new JSObject();out.put("name",name);out.put("url",Uri.fromFile(t.file).toString());call.resolve(out);return;}
  File target=new File(t.file.getParentFile(),name);if(target.exists())throw new IOException();
  if(savedExists(t)){
   Uri uri=Uri.parse(t.savedUri);
   if(android.provider.DocumentsContract.isDocumentUri(getContext(),uri)){Uri renamed=android.provider.DocumentsContract.renameDocument(getContext().getContentResolver(),uri,name);if(renamed==null)throw new IOException();t.savedUri=renamed.toString();}
   else{ContentValues values=new ContentValues();values.put(MediaStore.MediaColumns.DISPLAY_NAME,name);if(getContext().getContentResolver().update(uri,values,null,null)!=1)throw new IOException();}
  }
  if(!t.file.renameTo(target))throw new IOException();t.file=target;t.name=name;persist(call.getString("id"),t);
  JSObject out=new JSObject();out.put("name",name);out.put("url",Uri.fromFile(target).toString());call.resolve(out);
 }catch(Exception e){call.reject("无法重命名本机文件，请检查文件是否正被使用");}});}
 @PluginMethod public void clearAccount(PluginCall call){
  String prefix=call.getString("prefix","");if(!prefix.matches("[a-f0-9]{64}:")){call.reject("无效账号缓存");return;}
  for(Transfer t:transfers.values())if(t.key.startsWith(prefix)){t.cancelled=true;if(t.connection!=null)t.connection.disconnect();}
  io.execute(()->{for(String id:new ArrayList<>(transfers.keySet())){Transfer t=transfers.get(id);if(t!=null&&t.key.startsWith(prefix)){if(id.equals(saving))pendingRemoval.add(id);else removeTransfer(id);}}call.resolve();});
 }
 @PluginMethod public void release(PluginCall call){call.resolve();}
 @PluginMethod public void share(PluginCall call){io.execute(()->{try{Transfer t=find(call);if(!t.complete)throw new IOException();Uri uri=FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",t.file);
  getActivity().runOnUiThread(()->{try{Intent i=new Intent(Intent.ACTION_SEND).setType(t.mime).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);i.setClipData(android.content.ClipData.newRawUri(t.name,uri));getActivity().startActivity(Intent.createChooser(i,"发送文件"));call.resolve();}catch(Exception e){call.reject("无法打开分享方式");}});
 }catch(Exception e){call.reject("本地文件不可用");}});}
 private Transfer find(PluginCall c)throws IOException{Transfer t=transfers.get(c.getString("id",""));if(t==null||!t.file.isFile())throw new IOException();return t;}
 @PluginMethod public void begin(PluginCall call){io.execute(()->{try{
  String id=UUID.randomUUID().toString();String name=call.getString("name","附件").replaceAll("[\\\\/\\p{Cntrl}]","_");
  if(name.isEmpty())name="附件";if(name.length()>180)name=name.substring(name.length()-180);
  File folder=new File(directory(),id);folder.mkdirs();new File(folder,"content").mkdirs();File file=new File(new File(folder,"content"),name);if(!file.createNewFile())throw new IOException();
  Transfer t=new Transfer(file,name,call.getString("mime","application/octet-stream"));t.key=call.getString("key","");transfers.put(id,t);
  JSObject out=new JSObject();out.put("id",id);call.resolve(out);
 }catch(Exception e){call.reject("无法创建附件缓存，请检查可用空间");}});}
 @PluginMethod public void append(PluginCall call){io.execute(()->{try{
  Transfer t=find(call);String encoded=call.getString("data","");long offset=AttachmentInteger.read(call.getData().opt("offset"),-1L);
  if(t.complete||offset!=t.file.length()||encoded.length()>710000)throw new IOException();
  byte[] bytes=Base64.decode(encoded,Base64.NO_WRAP);if(bytes.length>524288)throw new IOException();
  try(FileOutputStream out=new FileOutputStream(t.file,true)){out.write(bytes);}call.resolve();
 }catch(Exception e){call.reject("附件写入失败，请检查可用空间后重试");}});}
 @PluginMethod public void fetch(PluginCall call){networkIo.execute(()->{Transfer t=null;long expected=AttachmentInteger.read(call.getData().opt("expectedSize"),-1L),received=0;int status=0;try{
  t=find(call);if(!t.fetching.compareAndSet(false,true)){call.reject("文件正在获取，请等待当前进度","ATTACHMENT_ALREADY_FETCHING");return;}
  if(t.complete||t.file.length()!=0||expected==0||expected>100L*1024*1024*1024)throw new IOException();
  java.net.URL source=new java.net.URL(call.getString("url",""));
  boolean nativeFile="https".equals(source.getProtocol())&&"service.example.invalid".equals(source.getHost())&&(source.getPort()==-1||source.getPort()==443)&&("/native/file".equals(source.getPath())||source.getPath().matches("/business/v1/private-attachments/[a-f0-9-]{36}/file"))&&source.getUserInfo()==null;
  for(int attempt=0;attempt<3;attempt++){
   if(t.cancelled)throw new IOException();
   java.net.URL url=source;long offset=t.file.length();boolean connected=false;
   try{
    received=0;
    for(int hop=0;;hop++){
     if(!"https".equals(url.getProtocol())||url.getUserInfo()!=null)throw new IOException("unsafe URL");
     t.connection=(java.net.HttpURLConnection)url.openConnection();t.connection.setConnectTimeout(15000);t.connection.setReadTimeout(20000);t.connection.setInstanceFollowRedirects(false);
     if(nativeFile){
      if(!source.toExternalForm().equals(url.toExternalForm()))throw new IOException("native redirect denied");
      String cookie=android.webkit.CookieManager.getInstance().getCookie(source.toExternalForm());
      if(cookie==null||cookie.isEmpty())throw new IOException("native session unavailable");
      EmployeeClientTransportCookies.apply(t.connection,cookie);t.connection.setRequestProperty("Origin","https://localhost");
      // The official authenticated stream does not advertise Range support.
      // Restart an interrupted transfer, rather than invent partial-read success.
      if(offset>0){new FileOutputStream(t.file,false).close();offset=0;}
     }
     if(offset>0)t.connection.setRequestProperty("Range","bytes="+offset+"-");
     int code=t.connection.getResponseCode();status=code;
     if(code>=300&&code<400){if(nativeFile)throw new IOException("native redirect denied");String next=t.connection.getHeaderField("Location");t.connection.disconnect();if(hop>=5||next==null)throw new IOException("redirect");url=new java.net.URL(url,next);continue;}
     if(code==401||code==403||code==404){call.reject("文件下载地址已失效，请重新打开后重试","ATTACHMENT_SOURCE_EXPIRED");return;}
     if(offset==0&&code!=200 || offset>0&&code!=206){call.reject(offset>0?"文件服务不支持续传，请重试下载":"文件服务暂不可用（HTTP "+code+"）",offset>0?"ATTACHMENT_RESUME_UNSUPPORTED":"ATTACHMENT_HTTP_FAILED");return;}
     if(offset>0){String range=t.connection.getHeaderField("Content-Range");if(range==null||!range.startsWith("bytes "+offset+"-")){call.reject("文件续传范围不符，请重试下载","ATTACHMENT_RESUME_MISMATCH");return;}}
     long length=t.connection.getContentLengthLong();
     if(offset==0&&length>=0){if(expected>=0&&expected!=length){call.reject("文件长度与云端记录不符","ATTACHMENT_SIZE_MISMATCH");return;}expected=length;}
     if(offset>0&&length>=0&&expected>=0&&offset+length!=expected){call.reject("文件续传长度不符，请重试下载","ATTACHMENT_RESUME_MISMATCH");return;}
     connected=true;break;
    }
    if(!connected)throw new IOException();
    long last=0;
    try(InputStream in=t.connection.getInputStream();FileOutputStream out=new FileOutputStream(t.file,offset>0)){
     byte[] buffer=new byte[65536];int n;
     while((n=in.read(buffer))!=-1){if(t.cancelled)throw new IOException("cancelled");
      try{out.write(buffer,0,n);}catch(IOException disk){call.reject("附件缓存写入失败，请检查设备空间","ATTACHMENT_CACHE_WRITE_FAILED");return;}
      received+=n;
      if(System.currentTimeMillis()-last>150){JSObject update=new JSObject();update.put("id",call.getString("id"));update.put("loaded",offset+received);if(expected>=0)update.put("total",expected);notifyListeners("progress",update);last=System.currentTimeMillis();}
     }
    }
    received=t.file.length();
    if(expected<0||received==expected){JSObject result=new JSObject();result.put("size",received);call.resolve(result);return;}
    if(received>expected){call.reject("文件传输超过原件长度","ATTACHMENT_SIZE_MISMATCH");return;}
   }catch(IOException transientError){if(t.cancelled)throw transientError;if(attempt==2)throw transientError;}
   finally{if(t.connection!=null){t.connection.disconnect();t.connection=null;}}
  }
  throw new IOException("incomplete");
 }catch(Exception e){if(t!=null&&t.cancelled)call.reject("已取消下载","ATTACHMENT_CANCELLED");else if(expected>=0&&t!=null&&t.file.length()<expected)call.reject("文件传输中断：已接收 "+t.file.length()+" / "+expected+" 字节","ATTACHMENT_TRANSFER_TRUNCATED");else call.reject(status==0?"无法连接文件服务，请检查网络后重试":"文件接收中断，请重试下载",status==0?"ATTACHMENT_NETWORK_FAILED":"ATTACHMENT_TRANSFER_FAILED");}finally{if(t!=null){if(t.connection!=null){t.connection.disconnect();t.connection=null;}t.fetching.set(false);}}});}
 @PluginMethod public void finish(PluginCall call){io.execute(()->{try{
  Transfer t=find(call);long actual=t.file.length(),size=AttachmentInteger.read(call.getData().opt("size"),-1L);
  if(actual!=size){call.reject("附件长度不符，请重试下载","ATTACHMENT_SIZE_MISMATCH");return;}
  String expected=call.getString("sha256","");
  if(!expected.isEmpty()){
   if(!expected.matches("[a-f0-9]{64}")){call.reject("附件摘要无效，请刷新后重试","ATTACHMENT_DIGEST_INVALID");return;}
   try(InputStream in=new FileInputStream(t.file)){VerifiedAttachmentSave.verify(in,new VerifiedAttachmentSave.Receipt(actual,expected));}
   catch(IOException mismatch){call.reject("附件内容校验失败，请重试下载","ATTACHMENT_DIGEST_MISMATCH");return;}
  }
  if(expected.isEmpty())try(InputStream in=new FileInputStream(t.file)){t.sha=VerifiedAttachmentSave.inspect(in).sha256;}
  else t.sha=expected;
  try{persist(call.getString("id"),t);}catch(Exception storage){call.reject("附件缓存写入失败，请检查设备空间","ATTACHMENT_CACHE_COMMIT_FAILED");return;}
  t.complete=true;t.verified=true;
  JSObject out=new JSObject();out.put("url",Uri.fromFile(t.file).toString());call.resolve(out);
 }catch(Exception e){call.reject("附件缓存不可用，请重试","ATTACHMENT_CACHE_UNAVAILABLE");}});}
 @PluginMethod public void open(PluginCall call){io.execute(()->{try{
  Transfer t=find(call);if(!t.complete)throw new IOException();
  Uri uri=FileProvider.getUriForFile(getContext(),getContext().getPackageName()+".fileprovider",t.file);
  getActivity().runOnUiThread(()->{try{Intent intent=new Intent(Intent.ACTION_VIEW).setDataAndType(uri,t.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);getActivity().startActivity(Intent.createChooser(intent,"打开方式"));call.resolve();}catch(Exception e){call.reject("没有可打开此格式的应用，可先下载保存");}});
 }catch(Exception e){call.reject("附件尚不可打开");}});}
 private VerifiedAttachmentSave.Receipt writeSaved(Transfer t,Uri uri)throws IOException{
  VerifiedAttachmentSave.Receipt receipt;
  try(InputStream in=new FileInputStream(t.file);OutputStream out=getContext().getContentResolver().openOutputStream(uri,"wt")){
   if(out==null)throw new IOException("无法写入保存位置");receipt=VerifiedAttachmentSave.copy(in,out);
  }
  if(receipt.size!=t.file.length())throw new IOException("文件长度变化");
  try(InputStream saved=getContext().getContentResolver().openInputStream(uri)){
   if(saved==null)throw new IOException("无法核对保存结果");VerifiedAttachmentSave.verify(saved,receipt);
  }
  return receipt;
 }
 // The system may disambiguate a duplicate name or let the user edit it.
 static String savedName(android.content.ContentResolver resolver,Uri uri,String fallback){
  try(android.database.Cursor cursor=resolver.query(uri,new String[]{android.provider.OpenableColumns.DISPLAY_NAME},null,null,null)){
   if(cursor!=null&&cursor.moveToFirst()){String name=cursor.getString(0);if(name!=null&&!name.trim().isEmpty())return name;}
  }catch(Exception ignored){}
  return fallback;
 }
 private void resolveSaved(PluginCall call,Transfer t,VerifiedAttachmentSave.Receipt receipt,String location){
  JSObject out=new JSObject();out.put("saved",true);out.put("name",savedName(getContext().getContentResolver(),Uri.parse(t.savedUri),call.getString("name",t.name)));out.put("location",location);out.put("size",receipt.size);out.put("sha256",receipt.sha256);call.resolve(out);
 }
 @PluginMethod public void save(PluginCall call){io.execute(()->{try{
  Transfer t=find(call);if(!t.complete||t.cancelled||saving!=null)throw new IOException();
  String saveName=call.getString("name",t.name).trim();
  if(saveName.isEmpty()||saveName.length()>180||saveName.matches(".*[\\\\/\\p{Cntrl}].*")||saveName.equals(".")||saveName.equals(".."))throw new IOException("invalid save name");
  if(savedExists(t)&&!Boolean.TRUE.equals(call.getBoolean("repeat",false))&&saveName.equals(t.name)){JSObject out=new JSObject();out.put("saved",true);out.put("name",savedName(getContext().getContentResolver(),Uri.parse(t.savedUri),t.name));out.put("location",t.location);out.put("size",t.file.length());out.put("sha256",t.sha);call.resolve(out);return;}
  saving=call.getString("id");
  if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.Q){
   Uri uri=null;
   try{
    ContentValues values=new ContentValues();values.put(MediaStore.Downloads.DISPLAY_NAME,saveName);values.put(MediaStore.Downloads.MIME_TYPE,t.mime);
    values.put(MediaStore.Downloads.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS+"/员工客户端");values.put(MediaStore.Downloads.IS_PENDING,1);
    uri=getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,values);if(uri==null)throw new IOException();
    VerifiedAttachmentSave.Receipt receipt=writeSaved(t,uri);
    ContentValues ready=new ContentValues();ready.put(MediaStore.Downloads.IS_PENDING,0);
    if(getContext().getContentResolver().update(uri,ready,null,null)!=1)throw new IOException();
    t.savedUri=uri.toString();t.location="下载/员工客户端";t.sha=receipt.sha256;persist(saving,t);resolveSaved(call,t,receipt,t.location);
   }catch(Exception e){if(uri!=null)try{getContext().getContentResolver().delete(uri,null,null);}catch(Exception ignored){}call.reject("保存失败，请检查设备存储空间后重试");}
   finally{finishSaving();}
   return;
  }
  // Android 9: the system picker grants access only to the chosen document.
  Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(t.mime).putExtra(Intent.EXTRA_TITLE,saveName);
  getActivity().runOnUiThread(()->{try{startActivityForResult(call,intent,"saved");}catch(Exception e){io.execute(this::finishSaving);call.reject("无法打开保存位置");}});
 }catch(Exception e){call.reject("附件尚不可保存，或已有保存窗口打开");}});}
 @ActivityCallback private void saved(PluginCall call,ActivityResult result){if(call==null){io.execute(this::finishSaving);return;}io.execute(()->{try{
  Transfer t=transfers.get(saving);if(t==null)throw new IOException();
  if(result.getResultCode()!=Activity.RESULT_OK){call.reject("已取消保存","SAVE_CANCELLED");return;}
  Uri uri=result.getData()==null?null:result.getData().getData();if(uri==null)throw new IOException();
  try{VerifiedAttachmentSave.Receipt receipt=writeSaved(t,uri);t.savedUri=uri.toString();t.location="所选位置";t.sha=receipt.sha256;
    try{getContext().getContentResolver().takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION);}catch(Exception ignored){}
    persist(saving,t);resolveSaved(call,t,receipt,t.location);}
  catch(Exception e){try{android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(),uri);}catch(Exception ignored){}throw e;}
 }catch(Exception e){call.reject("保存失败，请选择其他位置重试");}finally{finishSaving();}});}
 private void finishSaving(){String id=saving;saving=null;if(id!=null&&pendingRemoval.remove(id))removeTransfer(id);}
 private final Set<String> pendingRemoval=new HashSet<>();
 private void removeTransfer(String id){Transfer t=transfers.remove(id);if(t!=null){t.file.delete();new File(t.file.getParentFile().getParentFile(),"index.json").delete();t.file.getParentFile().delete();t.file.getParentFile().getParentFile().delete();}}
 @PluginMethod public void remove(PluginCall call){String id=call.getString("id","");Transfer active=transfers.get(id);if(active!=null){active.cancelled=true;if(active.connection!=null)active.connection.disconnect();}io.execute(()->{if(id.equals(saving))pendingRemoval.add(id);else removeTransfer(id);call.resolve();});}
 @Override protected void handleOnDestroy(){for(Transfer t:transfers.values())if(!t.complete){t.cancelled=true;if(t.connection!=null)t.connection.disconnect();}networkIo.shutdown();io.execute(()->{for(String id:new ArrayList<>(transfers.keySet()))if(!transfers.get(id).complete)removeTransfer(id);});io.shutdown();}
}
