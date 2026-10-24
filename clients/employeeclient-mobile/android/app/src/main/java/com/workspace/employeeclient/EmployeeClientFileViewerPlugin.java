package com.workspace.employeeclient;

import android.net.Uri;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** View authenticated file pages in a browser-owned tab. No share intent or injected credentials. */
@CapacitorPlugin(name = "EmployeeClientFileViewer")
public class EmployeeClientFileViewerPlugin extends Plugin {
    @PluginMethod public void open(PluginCall call) {
        String raw = call.getString("url", "");
        Uri uri = Uri.parse(raw);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null) {
            call.reject("文件地址无效"); return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                String provider = CustomTabsClient.getPackageName(getContext(), null);
                if (provider == null) { call.reject("当前设备没有可用的文件浏览组件，请启用支持应用内浏览的浏览器"); return; }
                CustomTabsIntent tab = new CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                    .build();
                tab.intent.setPackage(provider);
                tab.launchUrl(getActivity(), uri);
                call.resolve();
            } catch (Exception error) {
                call.reject("文件页面暂时无法打开，请重试");
            }
        });
    }
}
