import pg from 'pg';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const fingerprint = (s) => createHash('sha256').update(s).digest('hex');
/** Stable real pg.Pool facade. New generations probe before switch; no SQL mutation is retried. */
export async function createLeasedDatabasePool(config) {
    if (config.pool.connectionString || config.pool.user || config.pool.password)
        throw new Error('database_dynamic_target_must_not_include_credentials');
    if (config.rotate_after_ms !== undefined && (!Number.isFinite(config.rotate_after_ms) || config.rotate_after_ms <= 0))
        throw new Error('database_rotation_interval_invalid');
    const target = new pg.Pool({ ...config.pool, allowExitOnIdle: true });
    const retiring = new Set();
    const pendingRevokes = new Map();
    let revokeTimer, revokeFlight, verifiedRetirements = 0;
    let current, flight, timer, closed = false, closing, generation = 0, renewals = 0, rotations = 0, lastError = null;
    const remaining = () => current ? Math.max(0, current.deadline - performance.now()) : 0;
    const status = () => ({ state: closed ? 'closed' : lastError ? 'degraded' : 'ready', generation, lease_hash: current ? fingerprint(current.lease.lease_id) : null, remaining_ms: Math.floor(remaining()), renewals, rotations, retiring_generations: pendingRevokes.size, verified_retirements: verifiedRetirements, error_code: lastError });
    const publish = (error = null) => { lastError = error ?? (pendingRevokes.size ? 'database_old_revoke_pending' : null); try {
        config.on_state?.(status());
    }
    catch { } };
    const margin = () => current ? Math.max(100, Math.min(30_000, current.duration * 0.2)) : 100;
    function schedule(failed = false) { if (timer)
        clearTimeout(timer); if (closed)
        return; const wait = failed ? 250 : current ? Math.max(50, Math.min(current.duration * 0.45, remaining() - margin())) : 50; timer = setTimeout(() => { timer = undefined; void refresh(true).catch(() => { }); }, wait); timer.unref(); }
    function listen(pool) { pool.on('error', () => { if (target.listenerCount('error'))
        target.emit('error', new Error('database_pool_dependency_error')); }); }
    async function verifyRevoke(old) {
        await config.client.revokeSecretLease(old.lease.lease_id);
        const probe = new pg.Client({ ...config.pool, user: old.lease.username, password: old.lease.password, connectionTimeoutMillis: config.pool.connectionTimeoutMillis ?? 5000 });
        probe.on('error', () => { });
        let denied = false;
        try {
            await probe.connect();
        }
        catch (error) {
            denied = ['28P01', '28000'].includes(error.code ?? '');
        }
        finally {
            await probe.end().catch(() => { });
        }
        if (!denied)
            throw new Error('database_old_credential_not_verified_rejected');
        pendingRevokes.delete(old.lease.lease_id);
        verifiedRetirements++;
        publish();
    }
    function retryRevokes() { if (closed || revokeTimer || revokeFlight || !pendingRevokes.size)
        return; revokeTimer = setTimeout(() => { revokeTimer = undefined; revokeFlight = (async () => { for (const p of pendingRevokes.values())
        if (p.drained)
            await verifyRevoke(p.old).catch(() => publish('database_old_revoke_pending')); })().finally(() => { revokeFlight = undefined; retryRevokes(); }); }, 1000); revokeTimer.unref(); }
    async function retire(old) { pendingRevokes.set(old.lease.lease_id, { old, drained: false }); let done; done = (async () => { await old.pool.end(); const p = pendingRevokes.get(old.lease.lease_id); if (p)
        p.drained = true; await verifyRevoke(old).catch(() => publish('database_old_revoke_pending')); })().finally(() => { retiring.delete(done); retryRevokes(); }); retiring.add(done); await done; }
    async function issue() {
        const started = performance.now(), lease = await config.client.issueDatabaseCredentials(config.reference), duration = lease.lease_duration * 1000;
        const pool = new pg.Pool({ ...config.pool, user: lease.username, password: lease.password, connectionTimeoutMillis: config.pool.connectionTimeoutMillis ?? 5000, statement_timeout: config.pool.statement_timeout ?? 10000 });
        listen(pool);
        try {
            const probe = await pool.query('SELECT authz.runtime_role() AS runtime_role');
            if (config.expected_runtime_role && probe.rows[0]?.runtime_role !== config.expected_runtime_role)
                throw new Error('database_runtime_scope_mismatch');
            if (closed || started + duration <= performance.now())
                throw new Error('database_candidate_expired');
        }
        catch {
            await pool.end();
            await config.client.revokeSecretLease(lease.lease_id).catch(() => { });
            throw new Error('database_candidate_probe_failed');
        }
        const next = { pool, lease, deadline: started + duration, duration, created: started, authGeneration: config.client.status().login_generation, number: ++generation };
        const old = current;
        current = next;
        if (old) {
            rotations++;
            void retire(old).catch(() => publish('database_old_revoke_pending'));
        }
        publish();
        schedule();
    }
    async function refresh(renew = false, force = false) {
        if (closed)
            throw new Error('database_pool_closed');
        if (flight)
            return flight;
        if (!renew && !force && current && remaining() > margin() && current.authGeneration === config.client.status().login_generation)
            return;
        flight = (async () => {
            if (force || !current || remaining() <= margin() || current.authGeneration !== config.client.status().login_generation || (config.rotate_after_ms !== undefined && performance.now() - current.created >= config.rotate_after_ms)) {
                await issue();
                return;
            }
            const old = current, started = performance.now();
            if (!old.lease.renewable) {
                await issue();
                return;
            }
            try {
                const result = await config.client.renewSecretLease(old.lease.lease_id, Math.ceil(old.duration / 1000));
                if (result.lease_duration * 1000 < old.duration * 0.75 || old.authGeneration !== config.client.status().login_generation) {
                    await issue();
                    return;
                }
                old.deadline = started + result.lease_duration * 1000;
                old.lease = { ...old.lease, ...result };
                renewals++;
                publish();
                schedule();
            }
            catch (error) {
                const code = error.code;
                if (code === 'secret_not_found' || code === 'secret_lease_unavailable') {
                    await issue();
                    return;
                }
                throw error;
            }
        })().catch(() => { publish('database_lease_dependency_unavailable'); schedule(true); throw new Error('database_lease_dependency_unavailable'); }).finally(() => { flight = undefined; });
        return flight;
    }
    async function active() { await refresh(); if (closed || !current || remaining() <= 0)
        throw new Error('database_lease_expired'); return current.pool; }
    function operation(name, args) {
        const cb = typeof args.at(-1) === 'function' ? args.at(-1) : undefined;
        if (cb) {
            void active().then(pool => { const method = pool[name]; method.apply(pool, args); }, () => cb(new Error('database_lease_dependency_unavailable')));
            return;
        }
        return active().then(pool => { const method = pool[name]; return method.apply(pool, args); });
    }
    async function close() { if (closing)
        return closing; closed = true; if (timer)
        clearTimeout(timer); if (revokeTimer)
        clearTimeout(revokeTimer); closing = (async () => { await flight?.catch(() => { }); const old = current; current = undefined; if (old)
        await retire(old); await Promise.all(retiring); await revokeFlight?.catch(() => { }); await target.end(); publish(); })(); return closing; }
    const facade = new Proxy(target, { get(_target, key) {
            if (key === 'query' || key === 'connect')
                return (...args) => operation(key, args);
            if (key === 'end')
                return close;
            if (key === 'leaseStatus')
                return status;
            if (key === 'rotateCredentials')
                return () => refresh(false, true);
            if (key === 'options')
                return current?.pool.options ?? config.pool;
            if (key === 'ending' || key === 'ended')
                return closed;
            if (key === 'totalCount' || key === 'idleCount' || key === 'waitingCount')
                return current?.pool[key] ?? 0;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    try {
        await issue();
        return facade;
    }
    catch {
        await close();
        throw new Error('database_startup_dependency_unavailable');
    }
}
//# sourceMappingURL=rotating-pool.js.map