package com.workspace.employeeclient;

import org.junit.Test;
import static org.junit.Assert.*;

public class NotificationPresentationTest {
    @Test public void liveBackgroundMessageKeepsHeadsUpWithSoundOff() {
        assertTrue(NotificationPresentation.shouldAlert(false, 0, 0, 1_000_000));
        assertEquals("employeeclient_work_quiet_heads_up", NotificationPresentation.channel(true, false, false));
    }
    @Test public void longReconnectDoesNotSilenceUnpresentedSessionMessage() {
        assertTrue(NotificationPresentation.shouldAlert(true, 950_000, 900_000, 1_000_000));
        assertTrue(NotificationPresentation.shouldAlert(true, 880_000, 800_000, 1_000_000));
        assertTrue(NotificationPresentation.shouldAlert(true, 879_999, 800_000, 1_000_000));
    }
    @Test public void coldStartAndUnknownTimestampsRemainQuiet() {
        assertFalse(NotificationPresentation.shouldAlert(true, 950_000, 1_000_000, 1_000_000));
        assertFalse(NotificationPresentation.shouldAlert(true, 1, 2, 64_800_001));
        assertFalse(NotificationPresentation.shouldAlert(true, 0, 0, 1_000_000));
        assertFalse(NotificationPresentation.shouldAlert(true, 1_000_001, 900_000, 1_000_000));
        assertEquals("employeeclient_work_silent", NotificationPresentation.channel(false, true, true));
    }
    @Test public void ordinaryAndUrgentKeepExistingChannels() {
        assertEquals("employeeclient_work", NotificationPresentation.channel(true, true, false));
        assertEquals("employeeclient_work_urgent", NotificationPresentation.channel(true, true, true));
    }
}
