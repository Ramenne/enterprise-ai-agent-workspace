import { Transform } from 'node:stream';
import { DomainError } from '../../../packages/platform/src/http.js';
/** One current permission check per time boundary, including while backpressured.
 * Already emitted/transport-buffered bytes cannot be recalled. */
export class AuthorizedDownload extends Transform {
    options;
    timer;
    inflight;
    controller;
    nextAt = 0;
    expiresAt = 0;
    checks = 0;
    emitted = 0;
    state = 'active';
    reason = null;
    intervalMs;
    timeoutMs;
    constructor(options) {
        super();
        this.options = options;
        this.intervalMs = options.intervalMs ?? 1000;
        this.timeoutMs = options.timeoutMs ?? 3000;
        if (!Number.isSafeInteger(options.expectedBytes) || options.expectedBytes < 0 ||
            !Number.isSafeInteger(this.intervalMs) || this.intervalMs < 10 || this.intervalMs > 10000 ||
            !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 10000)
            throw new DomainError('invalid_stream_authorization_config');
    }
    async start() { await this.check(); }
    snapshot() {
        return { state: this.state, bytes_emitted: this.emitted, expected_bytes: this.options.expectedBytes,
            authorization_checks: this.checks, cancellation_reason: this.reason };
    }
    completeDelivery() {
        if (this.state !== 'active' || this.emitted !== this.options.expectedBytes)
            return false;
        this.state = 'finished';
        this.stopTimer();
        this.controller?.abort();
        return true;
    }
    cancel(reason) {
        if (this.state !== 'active')
            return;
        this.state = 'cancelled';
        this.reason = reason;
        this.stopTimer();
        this.controller?.abort();
        const status = ['download_authorization_timeout', 'download_authorization_unknown', 'download_integrity_mismatch', 'download_capacity_dependency_unknown'].includes(reason) ? 503 : 403;
        this.options.cancelSource();
        this.options.cancelTransport?.();
        this.destroy(new DomainError(reason, status));
    }
    stopTimer() { if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
    } }
    schedule() {
        this.stopTimer();
        if (this.state !== 'active')
            return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.check().catch(() => undefined); }, Math.max(1, this.nextAt - Date.now()));
    }
    check() {
        if (this.inflight)
            return this.inflight;
        if (this.state !== 'active')
            return Promise.reject(new DomainError('download_closed', 403));
        const controller = new AbortController();
        this.controller = controller;
        this.checks++;
        let timeout;
        const deadline = this.expiresAt > 0 ? Math.min(this.timeoutMs, Math.max(1, this.expiresAt - Date.now())) : this.timeoutMs;
        const work = Promise.race([
            Promise.resolve().then(() => this.options.authorize(controller.signal)),
            new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new DomainError('download_authorization_timeout', 503)); }, deadline); })
        ]).then(permission => {
            if (this.state !== 'active')
                throw new DomainError('download_closed', 403);
            if (!Number.isFinite(permission.expiresAt) || permission.expiresAt <= Date.now())
                throw new DomainError('download_permission_expired', 403);
            this.expiresAt = permission.expiresAt;
            this.nextAt = Math.min(Date.now() + this.intervalMs, this.expiresAt);
        }).catch(error => {
            const reason = error instanceof DomainError && error.message === 'download_authorization_timeout' ? 'download_authorization_timeout' :
                error instanceof DomainError && error.message === 'download_permission_expired' ? 'download_permission_expired' :
                    error instanceof DomainError && [401, 403, 409].includes(error.status) ? 'download_current_permission_denied' : 'download_authorization_unknown';
            this.cancel(reason);
            throw new DomainError(reason, ['download_authorization_timeout', 'download_authorization_unknown'].includes(reason) ? 503 : 403);
        }).finally(() => { clearTimeout(timeout); this.inflight = undefined; if (this.controller === controller)
            this.controller = undefined; this.schedule(); });
        this.inflight = work;
        return work;
    }
    _transform(chunk, _encoding, callback) {
        void (async () => {
            if (this.inflight || Date.now() >= this.nextAt)
                await this.check();
            if (this.state !== 'active' || Date.now() >= this.expiresAt)
                throw new DomainError('download_permission_expired', 403);
            if (this.emitted + chunk.length > this.options.expectedBytes)
                throw new DomainError('download_integrity_mismatch', 503);
            this.emitted += chunk.length;
            callback(null, chunk);
        })().catch(error => { this.cancel(error instanceof DomainError && error.message === 'download_integrity_mismatch' ? 'download_integrity_mismatch' : 'download_current_permission_denied'); callback(new DomainError('download_cancelled', 403)); });
    }
    _flush(callback) {
        if (this.emitted !== this.options.expectedBytes) {
            this.cancel('download_integrity_mismatch');
            callback(new DomainError('download_integrity_mismatch', 503));
        }
        else
            callback();
    }
    _destroy(error, callback) {
        // Normal EOF is not HTTP finish: transport may still be backpressured with
        // its last buffer. Keep permission/lease checks until finish or raw close.
        if (error || this.state !== 'active') {
            this.stopTimer();
            this.controller?.abort();
        }
        this.options.cancelSource();
        callback(error);
    }
}
//# sourceMappingURL=authorized-download.js.map