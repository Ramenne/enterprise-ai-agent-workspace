package com.workspace.employeeclient;

/** Local presentation only; does not change read state; transport is owned by the foreground service. */
final class NotificationPresentation {
    static boolean shouldAlert(boolean catchup, long createdAt, long sessionStartedAt, long now) {
        if (!catchup) return true;
        // Messages created during this service session remain eligible after a long outage.
        // Cold-start history and unknown/future timestamps stay quiet; the persistent
        // presentation journal in the receiver prevents replay of already shown messages.
        return sessionStartedAt > 0 && createdAt >= sessionStartedAt && createdAt <= now;
    }

    static boolean allowBurstAlert(long now,long previous) {
        return previous<=0 || now<previous || now-previous>=3000;
    }

    static String channel(boolean headsUp, boolean sound, boolean urgent) {
        if (!headsUp) return "employeeclient_work_silent";
        if (!sound) return "employeeclient_work_quiet_heads_up";
        return urgent ? "employeeclient_work_urgent" : "employeeclient_work";
    }
}
