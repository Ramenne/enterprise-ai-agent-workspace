package com.workspace.employeeclient;

/** JSON decodes small JS integers as Integer, not Long. Keep byte counts exact. */
final class AttachmentInteger {
    static long read(Object value, long fallback) {
        if (!(value instanceof Number)) return fallback;
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || Math.rint(number) != number || Math.abs(number) > 9007199254740991d) return fallback;
        return ((Number) value).longValue();
    }
}
