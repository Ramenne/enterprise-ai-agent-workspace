package com.workspace.employeeclient;

import java.net.URI;

/** Public installer transport only. Never accepts general attachment URLs or redirects. */
final class UpdateDownloadSource {
    static String select(String canonical, String direct, int code) throws Exception {
        URI u;
        try { u = URI.create(canonical); }
        catch (IllegalArgumentException e) { throw new Exception("update_source_invalid", e); }
        if (!"https".equals(u.getScheme()) || !"service.example.invalid".equals(u.getHost()) ||
            u.getPort() != -1 || u.getRawUserInfo() != null || u.getRawQuery() != null ||
            u.getRawFragment() != null || u.getRawPath() == null ||
            !u.getRawPath().matches("/updates/android/[A-Za-z0-9._-]+\\.apk"))
            throw new Exception("update_source_invalid");
        if (direct == null) return canonical;
        String expected = "https://employeeclient-download.example.invalid/public/employeeclient/releases/android/"
            + code + "/employeeclient-v" + code + ".apk";
        if (!direct.equals(expected)) throw new Exception("update_source_invalid");
        return direct;
    }
}
