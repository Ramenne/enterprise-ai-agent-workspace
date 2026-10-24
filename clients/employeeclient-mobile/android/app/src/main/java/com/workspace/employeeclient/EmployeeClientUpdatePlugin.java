package com.workspace.employeeclient;

import android.content.Intent;
import android.content.ClipData;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import org.json.JSONException;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** Android-only update transport. V8 business data, Web Push and PWA are untouched. */
@CapacitorPlugin(name = "EmployeeClientUpdate")
public class EmployeeClientUpdatePlugin extends Plugin {
    private static final String ORIGIN = "https://employeeclient.example.invalid/";
    private static final String MANIFEST_URL = ORIGIN + "/updates/android/latest.json";
    private static final long MAX_APK = 250L * 1024 * 1024;
    private static final int MAX_MANIFEST = 16 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloading = new AtomicBoolean(false);
    private volatile boolean cancelled;
    private volatile HttpURLConnection connection;
    private volatile Release latest;

    private static class Release {
        int code;
        String name, notes, url, sha, signer;
        long size;
        JSObject json() {
            JSObject x = new JSObject();
            x.put("versionCode", code); x.put("versionName", name);
            x.put("notes", notes); x.put("size", size);
            x.put("signerSha256", signer);
            return x;
        }
    }

    @PluginMethod public void current(PluginCall call) {
        try { call.resolve(installed()); }
        catch (Exception e) { call.reject("installed_package_unavailable", "installed_package_unavailable"); }
    }

    @PluginMethod public void check(PluginCall call) {
        io.execute(() -> {
            try {
                JSObject old = installed();
                Release r = fetchManifest();
                latest = r;
                JSObject result = r.json();
                result.put("currentVersionCode", old.getInteger("versionCode"));
                result.put("currentVersionName", old.getString("versionName"));
                result.put("available", r.code > old.getInteger("versionCode"));
                result.put("downloaded", r.code > old.getInteger("versionCode") && verifiedCached(r));
                call.resolve(result);
            } catch (Exception e) { call.reject(code(e), code(e)); }
        });
    }

    @PluginMethod public void download(PluginCall call) {
        if (!downloading.compareAndSet(false, true)) { call.reject("update_download_busy", "update_download_busy"); return; }
        cancelled = false;
        io.execute(() -> {
            try {
                Release r = latest;
                if (r == null || r.code <= installed().getInteger("versionCode")) throw new Exception("update_not_available");
                File file = verifiedCached(r) ? apk(r) : fetchApk(r);
                if (cancelled) throw new Exception("update_cancelled");
                verifyApk(file, r);
                JSObject result = r.json(); result.put("downloaded", true); call.resolve(result);
            } catch (Exception e) {
                String reason = cancelled ? "update_cancelled" : code(e);
                call.reject(reason, reason);
            }
            finally { downloading.set(false); cancelled = false; connection = null; }
        });
    }

    @PluginMethod public void cancel(PluginCall call) {
        cancelled = true;
        HttpURLConnection c = connection;
        if (c != null) c.disconnect();
        call.resolve();
    }

    @PluginMethod public void install(PluginCall call) {
        io.execute(() -> {
            try {
                Release r = latest;
                if (r == null || r.code <= installed().getInteger("versionCode")) throw new Exception("update_not_available");
                if (!verifiedCached(r)) throw new Exception("update_package_missing");
                if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    getActivity().runOnUiThread(() -> {
                        try {
                            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getContext().getPackageName()));
                            getActivity().startActivity(settings);
                            JSObject out = new JSObject(); out.put("status", "permission_required"); call.resolve(out);
                        } catch (Exception e) { call.reject("install_permission_screen_unavailable", "install_permission_screen_unavailable"); }
                    });
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk(r));
                getActivity().runOnUiThread(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                        intent.setDataAndType(uri, "application/vnd.android.package-archive");
                        intent.setClipData(ClipData.newRawUri("employeeclient-update", uri));
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(intent);
                        JSObject out = new JSObject(); out.put("status", "installer_opened"); call.resolve(out);
                    } catch (Exception e) { call.reject("installer_unavailable", "installer_unavailable"); }
                });
            } catch (Exception e) { call.reject(code(e), code(e)); }
        });
    }

    private JSObject installed() throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo p = pm.getPackageInfo(getContext().getPackageName(), flags);
        JSObject x = new JSObject();
        x.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
        x.put("versionName", p.versionName == null ? "" : p.versionName);
        x.put("packageName", p.packageName);
        x.put("signerSha256", signer(p));
        return x;
    }

    private static String signer(PackageInfo p) throws Exception {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
            ? (p.signingInfo == null ? null : p.signingInfo.getApkContentsSigners()) : p.signatures;
        if (signatures == null || signatures.length != 1) throw new Exception("update_signer_unavailable");
        return hex(MessageDigest.getInstance("SHA-256").digest(signatures[0].toByteArray()));
    }

    private Release fetchManifest() throws Exception {
        HttpURLConnection c = open(MANIFEST_URL);
        c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache, no-store");
        try {
            if (c.getResponseCode() != 200) throw new Exception("update_channel_unavailable");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[4096]; int n;
                while ((n = in.read(buf)) != -1) {
                    if (bytes.size() + n > MAX_MANIFEST) throw new Exception("update_manifest_too_large");
                    bytes.write(buf, 0, n);
                }
            }
            JSONObject j;
            try {
                j = new JSONObject(bytes.toString(StandardCharsets.UTF_8.name()));
            } catch (JSONException e) {
                throw new Exception("update_manifest_invalid", e);
            }
            Release r = new Release();
            try {
                r.code = j.getInt("versionCode"); r.name = requiredString(j, "versionName");
                r.notes = j.optString("notes", ""); r.size = j.getLong("size");
                r.url = requiredString(j, "apkUrl");
                r.sha = requiredString(j, "sha256").toLowerCase(Locale.ROOT);
                r.signer = requiredString(j, "signerSha256").replace(":", "").toLowerCase(Locale.ROOT);
                if (!getContext().getPackageName().equals(requiredString(j, "packageName"))) throw new Exception("update_package_mismatch");
            } catch (JSONException e) {
                throw new Exception("update_manifest_invalid", e);
            }
            if (r.code < 1 || r.name.length() > 80 || r.notes.length() > 2000 ||
                r.size < 1 || r.size > MAX_APK || !r.sha.matches("[0-9a-f]{64}") ||
                !r.signer.matches("[0-9a-f]{64}")) throw new Exception("update_manifest_invalid");
            r.url = UpdateDownloadSource.select(r.url,
                j.has("downloadUrl") ? requiredString(j, "downloadUrl") : null, r.code);
            if (!r.signer.equals(installed().getString("signerSha256"))) throw new Exception("update_signature_mismatch");
            return r;
        } finally { c.disconnect(); }
    }

    private static String requiredString(JSONObject object, String key) throws JSONException {
        if (!object.has(key) || object.isNull(key)) throw new JSONException("missing " + key);
        String value = object.getString(key);
        if (value.length() == 0) throw new JSONException("empty " + key);
        return value;
    }

    private HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(10000); c.setReadTimeout(20000);
        c.setRequestProperty("Accept", "application/json, application/vnd.android.package-archive");
        return c;
    }

    private File dir() throws Exception {
        File d = new File(getContext().getFilesDir(), "updates");
        if (!d.isDirectory() && !d.mkdirs()) throw new Exception("update_storage_unavailable");
        return d;
    }
    private File apk(Release r) throws Exception { return new File(dir(), r.sha + ".apk"); }

    private boolean verifiedCached(Release r) throws Exception {
        File f = apk(r);
        if (!f.isFile()) return false;
        try { verifyApk(f, r); return true; }
        catch (Exception bad) { if (!f.delete()) throw new Exception("update_storage_unavailable"); return false; }
    }

    private File fetchApk(Release r) throws Exception {
        File target = apk(r), part = new File(dir(), r.sha + ".part.apk");
        if (part.exists() && !part.delete()) throw new Exception("update_storage_unavailable");
        HttpURLConnection c = open(r.url); connection = c;
        try {
            if (c.getResponseCode() != 200) throw new Exception("update_download_failed");
            long declared = c.getContentLengthLong();
            if (declared > 0 && declared != r.size) throw new Exception("update_size_mismatch");
            MessageDigest digest = MessageDigest.getInstance("SHA-256"); long received = 0;
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[32768]; int n;
                while ((n = in.read(buf)) != -1) {
                    if (cancelled) throw new Exception("update_cancelled");
                    received += n;
                    if (received > r.size) throw new Exception("update_size_mismatch");
                    digest.update(buf, 0, n); out.write(buf, 0, n);
                    JSObject event = new JSObject(); event.put("received", received); event.put("total", r.size);
                    notifyListeners("progress", event);
                }
                out.getFD().sync();
            }
            if (cancelled) throw new Exception("update_cancelled");
            if (received != r.size) throw new Exception("update_size_mismatch");
            if (!r.sha.equals(hex(digest.digest()))) throw new Exception("update_hash_mismatch");
            verifyApk(part, r);
            if (!part.renameTo(target)) throw new Exception("update_storage_unavailable");
            return target;
        } finally {
            c.disconnect(); connection = null;
            if (part.exists()) part.delete();
        }
    }

    private void verifyApk(File file, Release r) throws Exception {
        if (!file.isFile() || file.length() != r.size) throw new Exception("update_size_mismatch");
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buf = new byte[32768]; int n;
            while ((n = in.read(buf)) != -1) hash.update(buf, 0, n);
        }
        if (!r.sha.equals(hex(hash.digest()))) throw new Exception("update_hash_mismatch");
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo p = getContext().getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), flags);
        if (p == null || !getContext().getPackageName().equals(p.packageName) ||
            (Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode) != r.code)
            throw new Exception("update_package_mismatch");
        if (!r.signer.equals(signer(p)) || !r.signer.equals(installed().getString("signerSha256")))
            throw new Exception("update_signature_mismatch");
    }

    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 0xff));
        return out.toString();
    }
    private static String code(Exception e) {
        String s = e.getMessage();
        return s != null && s.startsWith("update_") ? s : "update_failed";
    }
}
