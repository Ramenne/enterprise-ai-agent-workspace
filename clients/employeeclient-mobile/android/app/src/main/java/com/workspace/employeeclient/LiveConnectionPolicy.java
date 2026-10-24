package com.workspace.employeeclient;

/** Network replacement invalidates the socket even when its last frame was recent. */
final class LiveConnectionPolicy {
    static boolean shouldRebuild(boolean connected,long now,long lastFrame,boolean networkChanged) {
        return networkChanged || !connected || now < lastFrame || now - lastFrame >= 45000;
    }
}
