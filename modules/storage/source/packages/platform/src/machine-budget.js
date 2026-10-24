import net from 'node:net';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from './http.js';
function profile(value, service) { if (typeof value['socket'] !== 'string' || !isAbsolute(value['socket']) || !Number.isSafeInteger(value['socket_uid']) || Number(value['socket_uid']) < 0 || value['service'] !== service || typeof value['key'] !== 'string' || value['key'].length < 32)
    throw Error('capacity_private_profile_invalid'); return value; }
class Session {
    p;
    signal;
    deadline;
    socket;
    pending = new Map();
    buffer = '';
    closed = false;
    failure = new AbortController();
    constructor(p, signal, deadline = Infinity) {
        this.p = p;
        this.signal = signal;
        this.deadline = deadline;
    }
    async start() {
        const dir = await lstat(dirname(this.p.socket)), file = await lstat(this.p.socket);
        if (!dir.isDirectory() || dir.isSymbolicLink() || ![0, this.p.socket_uid].includes(dir.uid) || (dir.mode & 0o022) || !file.isSocket() || file.isSymbolicLink() || file.uid !== this.p.socket_uid || (file.mode & 0o007))
            throw Error('capacity_socket_identity_invalid');
        const socket = net.createConnection(this.p.socket);
        this.socket = socket;
        await new Promise((resolve, reject) => { const timer = setTimeout(() => { socket.destroy(); reject(Error('capacity_connect_timeout')); }, Math.min(3000, this.remaining())); socket.once('connect', () => { clearTimeout(timer); resolve(); }); socket.once('error', () => { clearTimeout(timer); reject(Error('capacity_connect_unknown')); }); });
        socket.on('error', () => this.stop());
        socket.on('close', () => this.stop());
        socket.on('data', part => { this.buffer += part.toString(); if (this.buffer.length > 8192) {
            this.stop();
            return;
        } while (this.buffer.includes('\n')) {
            const i = this.buffer.indexOf('\n'), line = this.buffer.slice(0, i);
            this.buffer = this.buffer.slice(i + 1);
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                this.stop();
                return;
            }
            const p = this.pending.get(String(msg['id']));
            if (!p)
                continue;
            this.pending.delete(String(msg['id']));
            clearTimeout(p.timer);
            if (msg['ok'] === true)
                p.resolve(msg['result']);
            else
                p.reject(Error('capacity_busy'));
        } });
        this.signal?.addEventListener('abort', () => this.stop(), { once: true });
        this.signal?.throwIfAborted();
        await this.call({ op: 'auth', service: this.p.service, key: this.p.key });
    }
    remaining() { const n = Math.min(15000, this.deadline - Date.now()); if (n <= 0 || this.signal?.aborted)
        throw Error('capacity_original_deadline_expired'); return n; }
    call(body) { return new Promise((resolve, reject) => { if (this.closed || !this.socket || this.pending.size >= 2) {
        reject(Error('capacity_dependency_unknown'));
        return;
    } const id = randomUUID(); let wait; try {
        wait = this.remaining();
    }
    catch {
        reject(Error('capacity_original_deadline_expired'));
        return;
    } const timer = setTimeout(() => { this.stop(); reject(Error('capacity_dependency_unknown')); }, wait); this.pending.set(id, { resolve, reject, timer }); this.socket.write(JSON.stringify({ ...body, id }) + '\n'); }); }
    stop() { if (this.closed)
        return; this.closed = true; this.failure.abort(); this.socket?.destroy(); for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error('capacity_dependency_unknown'));
    } this.pending.clear(); }
}
export class MachineBudget {
    p;
    configured = true;
    sessions = new Set();
    closed = false;
    observed = 0;
    constructor(p) {
        this.p = p;
    }
    async acquire(kind, temporaryBytes, options = {}) {
        if (this.closed)
            throw new DomainError('capacity_stopped_no_provider_send', 503, true);
        const s = new Session(this.p, options.signal, options.deadline);
        this.sessions.add(s);
        let id;
        try {
            await s.start();
            id = String((await s.call({ op: 'acquire', kind, temporary_bytes: temporaryBytes }))['lease']);
        }
        catch {
            this.sessions.delete(s);
            s.stop();
            throw new DomainError('capacity_busy_or_unavailable_no_provider_send', 503, true);
        }
        let released = false;
        s.deadline = Infinity;
        const lease = { signal: s.failure.signal, limitUntil: deadline => { s.deadline = Math.min(s.deadline, deadline); }, phase: async (kind) => { await s.call({ op: 'transition', lease: id, kind }); }, meter: async (input, releaseOnEnd = false) => { const owner = this; const destroy = () => { const stream = input; stream.destroy?.(Error('capacity_dependency_unknown')); }; s.failure.signal.addEventListener('abort', destroy, { once: true }); return (async function* () { try {
                for await (const raw of input) {
                    for (let i = 0; i < raw.byteLength; i += 65536) {
                        s.failure.signal.throwIfAborted();
                        options.signal?.throwIfAborted();
                        const part = raw.subarray(i, Math.min(i + 65536, raw.byteLength));
                        await s.call({ op: 'take', lease: id, bytes: part.byteLength });
                        yield part;
                        await s.call({ op: 'observe', lease: id, bytes: part.byteLength });
                        owner.observed += part.byteLength;
                    }
                }
            }
            finally {
                s.failure.signal.removeEventListener('abort', destroy);
                if (releaseOnEnd)
                    await lease.release();
            } })(); }, release: async () => { if (released)
                return; released = true; try {
                await s.call({ op: 'release', lease: id });
            }
            catch {
                process.stderr.write('{"component":"capacity","state":"release_unknown_domain_outcome_preserved"}\n');
            }
            finally {
                s.stop();
                this.sessions.delete(s);
            } } };
        return lease;
    }
    async metrics() { const s = new Session(this.p); try {
        await s.start();
        return await s.call({ op: 'status' });
    }
    finally {
        s.stop();
    } }
    async close() { this.closed = true; for (const s of this.sessions)
        s.stop(); this.sessions.clear(); }
    status() { return { state: this.closed ? 'closed' : 'registered', active_local_sessions: this.sessions.size, observed_application_bytes: this.observed, byte_coverage: 'application_observed_not_HTTP_finish_or_provider_invoice', persistence: 'not_yet_durable_cost_ledger' }; }
}
export class UnregisteredBudget {
    configured = false;
    async acquire() { throw new DomainError('capacity_unregistered_no_provider_send', 503, true); }
    async close() { }
    status() { return { state: 'capacity_unregistered', heavy_IO: 'unavailable', control: 'unchanged' }; }
}
export async function loadBudget(runtime, service) { try {
    const ref = runtime?.optional('capacity_budget_profile_ref');
    if (ref) {
        const data = await runtime.optionalSecret(ref);
        if (!data)
            throw Error('capacity_profile_unavailable');
        return new MachineBudget(profile(data, service));
    }
    const file = process.env['HUB_CAPACITY_PROFILE_FILE'];
    if (file) {
        const st = await lstat(file);
        if (!st.isFile() || st.isSymbolicLink() || ![0, process.geteuid?.()].includes(st.uid) || (st.mode & 0o077))
            throw Error('capacity_private_profile_required');
        return new MachineBudget(profile(JSON.parse(await readFile(file, 'utf8')), service));
    }
    return new UnregisteredBudget();
}
catch {
    process.stderr.write('{"component":"capacity","state":"profile_unavailable_heavy_IO_only"}\n');
    return new UnregisteredBudget();
} }
//# sourceMappingURL=machine-budget.js.map