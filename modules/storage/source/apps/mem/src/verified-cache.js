import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, lstat, stat, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareVerifiedRead } from './objects.js';
/** Cached bytes have no access authority. Every caller must authorize independently before delivery. */
export class VerifiedByteCache {
    adapter;
    maxBytes;
    ttlMs;
    budget;
    entries = new Map();
    pending = new Map();
    directory;
    constructor(adapter, maxBytes = 1280 * 1024 * 1024, ttlMs = 15 * 60 * 1000, budget) {
        this.adapter = adapter;
        this.maxBytes = maxBytes;
        this.ttlMs = ttlMs;
        this.budget = budget;
        let pruning=false;
        this.pruneTimer=setInterval(()=>{if(pruning)return;pruning=true;void this.prune().catch(()=>{}).finally(()=>{pruning=false;});},Math.min(60000,Math.max(10,ttlMs)));
        this.pruneTimer.unref();
    }
    root() { return this.directory ??= mkdtemp(join(tmpdir(), 'hub2-verified-byte-cache-')); }
    key(object, expected) {
        return createHash('sha256').update(JSON.stringify([object.provider, object.bucket, object.key, object.versionId, expected.sha256, expected.size])).digest('hex');
    }
    async valid(entry) {
        try {
            const info = await lstat(entry.path);
            return (!entry.lease || !entry.lease.signal.aborted) && info.isFile() && !info.isSymbolicLink() && info.size === entry.size && info.ino === entry.ino && info.mtimeMs === entry.mtimeMs && (info.mode & 0o077) === 0;
        }
        catch {
            return false;
        }
    }
    async prune(required = 0) {
        let used = [...this.entries.values()].reduce((sum, e) => sum + e.size, 0);
        for (const [key, entry] of [...this.entries].sort((a, b) => a[1].lastUse - b[1].lastUse)) {
            if (entry.readers)
                continue;
            if (Date.now() - entry.lastUse <= this.ttlMs && used + required <= this.maxBytes && this.entries.size < 16)
                continue;
            this.entries.delete(key);
            await rm(entry.path, { force: true });
            await entry.lease?.release();
            used -= entry.size;
        }
    }
    async acquire(object, expected, beforeRead) {
        // Oversize objects use the original bounded-memory path; they do not evict active readers.
        if (expected.size > this.maxBytes) {
            const temp = await prepareVerifiedRead(this.adapter, object, expected, this.budget, beforeRead);
            await temp.lease?.phase('retained');
            return { ...temp, cache_hit: false };
        }
        const key = this.key(object, expected);
        let entry = this.entries.get(key);
        let cacheHit = !!entry;
        if (entry && (!await this.valid(entry) || this.entries.get(key)!==entry)) {
            this.entries.delete(key);
            if (!entry.readers) {
                await rm(entry.path, { force: true });
                await entry.lease?.release();
            }
            entry = undefined;
            cacheHit = false;
        }
        if (!entry) {
            let load = this.pending.get(key);
            if (!load) {
                load = (async () => {
                    await this.prune(expected.size);
                    const temporary = await prepareVerifiedRead(this.adapter, object, expected, this.budget, beforeRead);
                    const path = join(await this.root(), key + '-' + randomUUID() + '.bytes');
                    try {
                        await rename(temporary.path, path);
                        const info = await stat(path);
                        await temporary.lease?.phase('retained');
                        const created = { path, size: info.size, ino: info.ino, mtimeMs: info.mtimeMs, lastUse: Date.now(), readers: 0, ...(temporary.lease ? { lease: temporary.lease } : {}) };
                        this.entries.set(key, created);
                        return created;
                    }
                    catch (e) {
                        await temporary.cleanup();
                        throw e;
                    }
                    finally {
                        await temporary.cleanup(true);
                    }
                })();
                this.pending.set(key, load);
                load.finally(() => this.pending.delete(key)).catch(() => undefined);
            }
            else
                cacheHit = true;
            entry = await load;
        }
        entry.readers++;
        entry.lastUse = Date.now();
        let released = false;
        return { path: entry.path, cache_hit: cacheHit, cleanup: async () => { if (released)
                return; released = true; entry.readers--; entry.lastUse = Date.now(); if (!entry.readers && this.entries.get(key) !== entry) {
                const info = await lstat(entry.path).catch(() => null);
                if (info?.ino === entry.ino)
                    await rm(entry.path, { force: true });
                await entry.lease?.release();
            } await this.prune(); } };
    }
    async close() {
        clearInterval(this.pruneTimer);
        for (const [key, entry] of this.entries) {
            if (entry.readers)
                continue;
            await rm(entry.path, { force: true });
            await entry.lease?.release();
            this.entries.delete(key);
        }
        if (!this.entries.size && this.directory) {
            await rm(await this.directory, { recursive: true, force: true });
            this.directory = undefined;
        }
    }
}
const caches = new WeakMap();
export function cacheFor(adapter, budget) { let cache = caches.get(adapter); if (!cache) {
    cache = new VerifiedByteCache(adapter, 1280 * 1024 * 1024, 15 * 60 * 1000, budget);
    caches.set(adapter, cache);
} return cache; }
//# sourceMappingURL=verified-cache.js.map