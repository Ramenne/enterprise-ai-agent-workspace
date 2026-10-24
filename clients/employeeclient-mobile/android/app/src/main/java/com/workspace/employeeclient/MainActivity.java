package com.workspace.employeeclient;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

/**
 * 员工客户端 Android 薄壳入口：只做 WebView 承载，不含任何业务逻辑（业务在共用的 Vue 构建产物里）。
 *
 * EmployeeClientLivePlugin 只承载前台服务桥接、恢复和通知点击，不承载业务账本。
 * 阿里云／厂商推送插件及自定义 Application 已删除，不保留备用实现。
 * 现用的 Capacitor 官方插件（app / network / local-notifications）由 capacitor.build.gradle 与
 * 插件清单自动装载，无需在此手动注册。
 */
public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EmployeeClientLoginPlugin.class);
        registerPlugin(EmployeeClientLivePlugin.class);
        registerPlugin(EmployeeClientBackgroundPlugin.class);
        registerPlugin(EmployeeClientUpdatePlugin.class);
        registerPlugin(EmployeeClientSharePlugin.class);
        registerPlugin(EmployeeClientFileViewerPlugin.class);
        registerPlugin(EmployeeClientAttachmentPlugin.class);
        super.onCreate(savedInstanceState);
        android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(bridge.getWebView(),true);
        bridge.getWebView().getSettings().setSupportZoom(false);
        bridge.getWebView().getSettings().setBuiltInZoomControls(false);
        bridge.getWebView().getSettings().setDisplayZoomControls(false);
    }
    @Override public void onPause(){
        android.webkit.CookieManager.getInstance().flush();
        super.onPause();
    }
}
