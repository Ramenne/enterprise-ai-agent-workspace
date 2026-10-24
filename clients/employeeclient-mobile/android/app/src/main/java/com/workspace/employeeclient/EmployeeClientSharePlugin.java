package com.workspace.employeeclient;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Explicit Android share import. Bytes stay in private cache until the user confirms upload. */
@CapacitorPlugin(name = "EmployeeClientShare")
public class EmployeeClientSharePlugin extends Plugin {
    private static final long MAX_FILE = 100L * 1024 * 1024 * 1024;
    private static final long MAX_BATCH = 600L * 1024 * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Intent incoming;
    private JSArray pending = new JSArray();

    @Override public void load() { incoming = getActivity().getIntent(); }
    @Override protected synchronized void handleOnNewIntent(Intent intent) {
        if (isShare(intent)) { incoming = intent; notifyListeners("incomingShare", new JSObject()); }
    }
    private boolean isShare(Intent i) {
        return i != null && (Intent.ACTION_SEND.equals(i.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(i.getAction()));
    }
    private File directory() {
        File d = new File(getContext().getCacheDir(), "employeeclient-share"); d.mkdirs(); return d;
    }
    private void cleanup(long age) {
        File[] files = directory().listFiles(); if (files == null) return;
        for (File f : files) if (System.currentTimeMillis() - f.lastModified() >= age) f.delete();
    }
    @PluginMethod public void peek(PluginCall call) {
        io.execute(() -> {
            synchronized (this) {
                try {
                    cleanup(60L * 60 * 1000);
                    if (isShare(incoming)) {
                        if (pending.length() > 0) { call.reject("请先处理上一次分享"); return; }
                        ArrayList<Uri> uris = new ArrayList<>();
                        if (Intent.ACTION_SEND_MULTIPLE.equals(incoming.getAction())) {
                            ArrayList<Uri> list = incoming.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                            if (list != null) uris.addAll(list);
                        } else {
                            Uri uri = incoming.getParcelableExtra(Intent.EXTRA_STREAM); if (uri != null) uris.add(uri);
                        }
                        if (uris.size() > 6) throw new IllegalArgumentException();
                        JSArray next = new JSArray(); long total = 0;
                        for (Uri uri : uris) {
                            if (!"content".equals(uri.getScheme())) throw new IllegalArgumentException();
                            String name = "分享文件"; long declared = -1;
                            try (Cursor c = getContext().getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                                if (c != null && c.moveToFirst()) { name = c.getString(0); if (!c.isNull(1)) declared = c.getLong(1); }
                            }
                            if (declared > MAX_FILE) throw new IllegalArgumentException();
                            if (name == null || name.isEmpty()) name = "分享文件";
                            name = name.replaceAll("[\\\\/\\p{Cntrl}]", "_");
                            if (name.length() > 160) name = name.substring(name.length() - 160);
                            File target = new File(directory(), UUID.randomUUID().toString());
                            long size = 0;
                            try (InputStream in = getContext().getContentResolver().openInputStream(uri); FileOutputStream out = new FileOutputStream(target)) {
                                if (in == null) throw new IllegalArgumentException();
                                byte[] buffer = new byte[32768]; int n;
                                while ((n = in.read(buffer)) != -1) {
                                    size += n; total += n;
                                    if (size > MAX_FILE || total > MAX_BATCH) throw new IllegalArgumentException();
                                    out.write(buffer, 0, n);
                                }
                            }
                            if (size == 0) throw new IllegalArgumentException();
                            JSObject f = new JSObject(); f.put("id", target.getName()); f.put("name", name); f.put("size", size);
                            f.put("mime", getContext().getContentResolver().getType(uri)); f.put("path", target.getAbsolutePath()); next.put(f);
                        }
                        pending = next; incoming = null;
                    }
                    JSObject r = new JSObject(); r.put("files", pending); call.resolve(r);
                } catch (Exception e) { incoming = null; pending = new JSArray(); cleanup(0); call.reject("无法导入分享文件：每项最多100GB、每次最多6项，请检查可用空间，请重新分享"); }
            }
        });
    }
    @PluginMethod public void readPart(PluginCall call){io.execute(()->{synchronized(this){try{
        String id=call.getString("id","");long offset=AttachmentInteger.read(call.getData().opt("offset"),-1L);int size=call.getInt("size",0);
        boolean known=false;for(int i=0;i<pending.length();i++)if(id.equals(pending.getJSONObject(i).getString("id")))known=true;
        if(!known||!id.matches("[a-f0-9-]{36}")||offset<0||size<1||size>524288)throw new java.io.IOException();
        File file=new File(directory(),id);try(java.io.RandomAccessFile in=new java.io.RandomAccessFile(file,"r")){
            if(offset>in.length()-size)throw new java.io.IOException();byte[] bytes=new byte[size];in.seek(offset);in.readFully(bytes);
            JSObject out=new JSObject();out.put("data",android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP));out.put("size",in.length());call.resolve(out);
        }
    }catch(Exception e){call.reject("分享文件读取失败，请重新分享");}}});}
    @PluginMethod public void acknowledge(PluginCall call) {
        String id = call.getString("id", "");
        io.execute(() -> { synchronized(this) {
            try {
                JSArray retained = new JSArray();
                for (int i = 0; i < pending.length(); i++) {
                    org.json.JSONObject item = pending.getJSONObject(i);
                    if (id.equals(item.getString("id"))) new File(directory(), item.getString("id")).delete();
                    else retained.put(item);
                }
                pending = retained; call.resolve();
            } catch(Exception e) { call.reject("无法清理分享缓存"); }
        } });
    }
    @PluginMethod public void clear(PluginCall call) {
        io.execute(() -> { synchronized(this) { pending = new JSArray(); cleanup(0); call.resolve(); } });
    }
    @Override protected void handleOnDestroy() { io.shutdown(); }
}
