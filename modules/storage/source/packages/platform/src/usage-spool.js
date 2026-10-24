import { open, lstat, opendir, unlink, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const digest = (s) => createHash('sha256').update(s).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const filePattern = /^[a-f0-9]{64}(?:\.group)?\.json$/;
const batchSQL = `SELECT evidence.record_usage_scoped(x.request,x.action,x.schema_version,x.traffic,x.success,x.coverage,x.result_count,x.duration_ms,x.paths,x.handles)
 FROM jsonb_to_recordset($1::jsonb) AS x(request uuid,action text,schema_version text,traffic text,success boolean,coverage text,result_count bigint,duration_ms double precision,paths jsonb,handles uuid[])`;
function record(input) {
    if (!input || !uuid.test(input.request) || typeof input.action !== 'string' || input.action.length > 240 || typeof input.schema_version !== 'string' || input.schema_version.length > 100 || !['work', 'batch', 'monitor'].includes(input.traffic) || typeof input.success !== 'boolean' || typeof input.coverage !== 'string' || input.coverage.length > 240 || !Number.isFinite(input.duration_ms) || input.duration_ms < 0 || (input.result_count !== null && (!Number.isSafeInteger(input.result_count) || input.result_count < 0)) || !Array.isArray(input.paths) || input.paths.length > 200 || input.paths.some(p => !p || typeof p.path !== 'string' || p.path.length > 240 || !['filter', 'sort', 'return', 'write'].includes(p.purpose)) || !Array.isArray(input.handles) || input.handles.length > 200 || input.handles.some(h => !uuid.test(h)))
        throw Error('usage_record_invalid');
    const value = { request: input.request, action: input.action, schema_version: input.schema_version, traffic: input.traffic, success: input.success, coverage: input.coverage, result_count: input.result_count, duration_ms: input.duration_ms, paths: input.paths.map(p => ({ path: p.path, purpose: p.purpose })), handles: [...input.handles] };
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 262144)
        throw Error('usage_record_budget');
    return { id: digest(text), value, text };
}
/** Asynchronous statistics only. No business admission, response gate, sync fallback or unbounded enqueue promise chain. */
export class UsageSpool {
    pool;
    capacity;
    maxFiles;
    retryMs;
    options;
    directory;
    physical = new Map();
    activeTemps = new Set();
    reservedDiskBytes = 0;
    diskEpoch = 0;
    scanChanges;
    inventoryUnsafe = false;
    artifactFiles = 0;
    unknownFiles = 0;
    buffer = [];
    catalog = new Map();
    accepting = true;
    available = false;
    publisher;
    delivery;
    maintenance;
    timer;
    commitTimer;
    cursor = 0;
    inFlightRecords = 0;
    inFlightBytes = 0;
    lastError = null;
    m = { delivered: 0, errors: 0, unpersisted: 0, accepted: 0, groups_written: 0, file_syncs: 0, directory_syncs: 0, batch_SQL_calls: 0, single_SQL_calls: 0, poison_groups: 0, poison_records: 0, SQL_ms: 0, persist_ms: 0, persist_queue_peak: 0, queue_overflow_unpersisted: 0, disk_budget_unpersisted: 0 };
    constructor(pool, directory, capacity = 128, maxFiles = 4096, retryMs = 1000, options = {}) {
        this.pool = pool;
        this.capacity = capacity;
        this.maxFiles = maxFiles;
        this.retryMs = retryMs;
        this.options = options;
        this.directory = resolve(directory);
        if (capacity < 1 || maxFiles < capacity || this.groupRecords < 1 || this.groupRecords > capacity || this.groupBytes < 262400)
            throw Error('usage_queue_budget_invalid');
    }
    get groupRecords() { return this.options.groupRecords ?? Math.min(32, this.capacity); }
    get groupBytes() { return this.options.groupBytes ?? 1048576; }
    get diskBytes() { return this.options.diskBytes ?? 134217728; }
    get counts() { let records = 0, bytes = 0; for (const e of this.catalog.values()) {
        records += e.count;
    } for (const n of this.physical.values())
        bytes += n; return { records, bytes }; }
    status() { const n = this.counts; const volatile = this.buffer.length + this.inFlightRecords; return { state: this.m.unpersisted || this.lastError || this.artifactFiles || this.unknownFiles || this.inventoryUnsafe ? 'degraded' : 'ready', coverage: this.m.unpersisted ? 'unpersisted_observations_present' : this.artifactFiles || this.unknownFiles || this.inventoryUnsafe ? 'recovery_artifacts_present;coverage_unknown' : volatile ? 'volatile_pending_observations' : n.records ? 'durable_pending_observations' : 'delivered_observations', prior_process_volatile_loss: 'unknown', queue_length: this.buffer.length, queue_capacity: this.capacity, persisting_count: volatile, persisting_capacity: this.capacity, active_writer: this.delivery ? 1 : 0, active_group_publisher: this.publisher ? 1 : 0, spool_pending_files: this.catalog.size, spool_pending_records: n.records, spool_file_budget: this.maxFiles, spool_disk_bytes: n.bytes, physical_objects: this.physical.size, physical_write_reserved_bytes: this.reservedDiskBytes, recovery_artifact_files: this.artifactFiles, unknown_objects: this.unknownFiles, physical_inventory_unsafe: this.inventoryUnsafe, active_temporary_files: this.activeTemps.size, spool_disk_byte_budget: this.diskBytes, synchronous_spool_fallbacks: 0, memory_queue_overflow_spooled: 0, last_error: this.lastError, ...this.m, pool: { total_count: this.pool.totalCount, idle_count: this.pool.idleCount, waiting_count: this.pool.waitingCount, max: this.pool.options.max } }; }
    code(error) { const code = error.code; return /^[0-9A-Z]{5}$/.test(code ?? '') ? code : 'usage_delivery_pending'; }
    loss(v, code) { this.m.unpersisted++; this.lastError = code; process.stderr.write(JSON.stringify({ error_code: code, request_id: v.value.request, route: v.value.action, coverage: 'governance_observation_incomplete' }) + '\n'); }
    async start() { if (!this.timer) {
        this.timer = setInterval(() => { void this.maintain(); }, this.retryMs);
        this.timer.unref();
    } await this.maintain(); }
    async checkDirectory() { const s = await lstat(this.directory); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700)
        throw Error('usage_spool_private_directory_required'); }
    maintain() {
        if (this.maintenance)
            return this.maintenance;
        this.maintenance = (async () => {
            try {
                await this.checkDirectory();
                this.scanChanges = new Set();
                const inventory = new Map();
                const dir = await opendir(this.directory);
                let seen = 0, unsafe = false, artifacts = 0, unknown = 0;
                for await (const f of dir) {
                    if (++seen > this.maxFiles * 3 + 4) {
                        unsafe = true;
                        break;
                    }
                    const st = await lstat(join(this.directory, f.name)).catch(e => { if (e.code === 'ENOENT')
                        return null; throw e; });
                    if (!st)
                        continue;
                    inventory.set(f.name, st.size);
                    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1) {
                        unsafe = true;
                        unknown++;
                        continue;
                    }
                    if (filePattern.test(f.name)) {
                        if (this.catalog.has(f.name))
                            continue;
                        try {
                            const loaded = await this.load(f.name);
                            this.catalog.set(f.name, { count: loaded.records.length, bytes: loaded.bytes, retryAt: 0 });
                        }
                        catch (error) {
                            if (error.code === 'ENOENT')
                                continue;
                            this.catalog.set(f.name, { count: this.groupRecords, bytes: st.size, retryAt: Date.now() + this.retryMs });
                            this.m.errors++;
                            this.lastError = 'usage_spool_record_invalid';
                        }
                    }
                    else if (/^[a-f0-9]{64}(?:\.group)?\.json\.ack$/.test(f.name)) {
                        const base = f.name.slice(0, -4);
                        if (!(await lstat(join(this.directory, base)).catch(() => null)))
                            artifacts++;
                    }
                    else if (/^[a-f0-9]{64}(?:\.group)?\.json(?:\.ack)?\.tmp-[a-f0-9-]{36}$/.test(f.name)) {
                        if (!this.activeTemps.has(f.name))
                            artifacts++;
                    }
                    else
                        unknown++;
                }
                // Merge external/unknown objects even during publishing, without restoring concurrently deleted or replacing newly published entries.
                const changed = this.scanChanges;
                for (const [name, size] of inventory)
                    if (!changed.has(name))
                        this.physical.set(name, size);
                if (!unsafe)
                    for (const name of this.physical.keys())
                        if (!inventory.has(name) && !changed.has(name))
                            this.physical.delete(name);
                this.scanChanges = undefined;
                this.inventoryUnsafe = unsafe;
                this.artifactFiles = artifacts;
                this.unknownFiles = unknown;
                this.available = true;
                // Residual temporary/orphan ACK objects remain private and budgeted. Ownership alone cannot prove an absent writer or recreate missing data.
                if (artifacts || unknown || unsafe)
                    this.lastError = 'usage_recovery_artifacts_retained';
                this.kickDelivery();
            }
            catch {
                this.available = false;
                this.m.errors++;
                this.lastError = 'usage_spool_unavailable';
            }
        })().finally(() => { this.scanChanges = undefined; this.maintenance = undefined; });
        return this.maintenance;
    }
    changed(name, bytes) { this.scanChanges?.add(name); if (bytes === undefined)
        this.physical.delete(name);
    else
        this.physical.set(name, bytes); this.diskEpoch++; }
    async syncDirectory() { const dir = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try {
        await dir.sync();
        this.m.directory_syncs++;
    }
    finally {
        await dir.close();
    } }
    async enqueue(input) { let v; try {
        v = record(input);
    }
    catch {
        this.m.errors++;
        this.m.unpersisted++;
        this.lastError = 'usage_record_invalid';
        throw Error('usage_record_invalid');
    } const n = this.counts; if (!this.accepting || !this.available || this.inventoryUnsafe) {
        this.loss(v, 'usage_spool_unavailable');
        return;
    } if (this.buffer.length + this.inFlightRecords >= this.capacity) {
        this.m.queue_overflow_unpersisted++;
        this.loss(v, 'usage_memory_budget');
        return;
    } if (n.records + this.buffer.length + this.inFlightRecords >= this.maxFiles || n.bytes + this.inFlightBytes + Buffer.byteLength(v.text) > this.diskBytes) {
        this.m.disk_budget_unpersisted++;
        this.loss(v, 'usage_disk_budget');
        return;
    } this.buffer.push(v); this.m.accepted++; this.m.persist_queue_peak = Math.max(this.m.persist_queue_peak, this.buffer.length + this.inFlightRecords); if (!this.commitTimer && !this.publisher) {
        this.commitTimer = setTimeout(() => { this.commitTimer = undefined; this.kickPublisher(); }, this.buffer.length >= this.groupRecords ? 0 : this.options.flushMs ?? 4);
        this.commitTimer.unref();
    } }
    kickPublisher() { if (this.publisher || !this.buffer.length)
        return; this.publisher = this.publish().finally(() => { this.publisher = undefined; if (this.buffer.length)
        this.kickPublisher(); this.kickDelivery(); }); }
    async writeAtomic(name, text) { const reserve = Buffer.byteLength(text) + 1; if (this.counts.bytes + this.reservedDiskBytes + reserve > this.diskBytes)
        throw Error('usage_disk_budget'); this.reservedDiskBytes += reserve; let held = true; const tempName = name + '.tmp-' + randomUUID(), tmp = join(this.directory, tempName); let f; this.activeTemps.add(tempName); try {
        f = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        this.changed(tempName, 0);
        await f.writeFile(text + '\n');
        this.changed(tempName, Buffer.byteLength(text) + 1);
        this.reservedDiskBytes -= reserve;
        held = false;
        await f.sync();
        this.m.file_syncs++;
        await f.close();
        f = undefined;
        await rename(tmp, join(this.directory, name));
        this.changed(tempName);
        this.changed(name, Buffer.byteLength(text) + 1);
        await this.syncDirectory();
    }
    finally {
        if (held)
            this.reservedDiskBytes -= reserve;
        await f?.close().catch(() => { });
        await unlink(tmp).then(async () => { this.changed(tempName); await this.syncDirectory(); }).catch(async (e) => { if (e.code !== 'ENOENT') {
            const st = await lstat(tmp).catch(() => null);
            if (st)
                this.changed(tempName, st.size);
            this.lastError = 'usage_temp_cleanup_pending';
        } });
        this.activeTemps.delete(tempName);
    } }
    async publish() { while (this.buffer.length) {
        const group = [];
        let bytes = 100;
        while (this.buffer.length && group.length < this.groupRecords) {
            const v = this.buffer[0];
            const size = Buffer.byteLength(v.text) + 100;
            if (group.length && bytes + size > this.groupBytes)
                break;
            group.push(this.buffer.shift());
            bytes += size;
        }
        this.inFlightRecords = group.length;
        this.inFlightBytes = bytes;
        const start = performance.now();
        try {
            const text = JSON.stringify({ v: 1, nonce: randomUUID(), records: group.map(v => ({ id: v.id, value: v.value })) }), name = digest(text) + '.group.json';
            const n = this.counts;
            if (this.inventoryUnsafe)
                throw Error('usage_inventory_unknown');
            if (n.records + group.length > this.maxFiles || n.bytes + Buffer.byteLength(text) > this.diskBytes)
                throw Error('usage_disk_budget');
            await this.writeAtomic(name, text);
            this.catalog.set(name, { count: group.length, bytes: Buffer.byteLength(text) + 1, retryAt: 0 });
            this.m.groups_written++;
        }
        catch {
            this.m.errors++;
            for (const v of group)
                this.loss(v, 'usage_group_not_persisted');
        }
        finally {
            this.inFlightRecords = 0;
            this.inFlightBytes = 0;
            this.m.persist_ms += performance.now() - start;
        }
    } }
    async readPrivate(name, max) { const f = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW); try {
        const s = await f.stat();
        if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > max)
            throw Error('usage_spool_record_invalid');
        return { text: (await f.readFile('utf8')).trimEnd(), bytes: s.size };
    }
    finally {
        await f.close();
    } }
    async load(name) { const data = await this.readPrivate(name, this.groupBytes); let records; if (name.endsWith('.group.json')) {
        if (digest(data.text) + '.group.json' !== name)
            throw Error('usage_group_hash_invalid');
        const b = JSON.parse(data.text);
        if (b.v !== 1 || !Array.isArray(b.records) || !b.records.length || b.records.length > this.groupRecords)
            throw Error('usage_group_invalid');
        records = b.records.map(r => { const v = record(r.value); if (v.id !== r.id)
            throw Error('usage_record_hash_invalid'); return v; });
    }
    else {
        if (digest(data.text) + '.json' !== name)
            throw Error('usage_legacy_hash_invalid');
        records = [record(JSON.parse(data.text))];
    } let ackBytes = 0; try {
        const ack = await this.readPrivate(name + '.ack', 65536);
        ackBytes = ack.bytes;
        const a = JSON.parse(ack.text);
        if (a.group !== name || !Array.isArray(a.ids) || a.hash !== digest(JSON.stringify({ group: a.group, ids: a.ids })) || a.ids.some(id => !records.some(v => v.id === id)))
            throw Error('usage_ack_invalid');
        records = records.filter(v => !a.ids.includes(v.id));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    } return { records, bytes: data.bytes + ackBytes, groupBytes: data.bytes, ackBytes }; }
    kickDelivery() { if (this.delivery || !this.available)
        return; this.delivery = this.drain().finally(() => { this.delivery = undefined; }); }
    async SQL(values) { const start = performance.now(); try {
        this.m.batch_SQL_calls++;
        await this.pool.query(batchSQL, [JSON.stringify(values.map(v => v.value))]);
    }
    finally {
        this.m.SQL_ms += performance.now() - start;
    } }
    async remove(name) {
        // ACK removal is durable before group removal. Any crash replay still refers only to already committed original IDs.
        await unlink(join(this.directory, name + '.ack')).then(() => this.changed(name + '.ack')).catch(e => { if (e.code !== 'ENOENT')
            throw e; });
        await this.syncDirectory();
        await unlink(join(this.directory, name));
        this.changed(name);
        await this.syncDirectory();
        this.catalog.delete(name);
    }
    async drain() { const names = [...this.catalog.keys()]; if (!names.length)
        return; const ordered = [...names.slice(this.cursor), ...names.slice(0, this.cursor)]; let visits = 0; for (const name of ordered) {
        if (visits++ >= 16)
            break;
        const entry = this.catalog.get(name);
        this.cursor = (names.indexOf(name) + 1) % names.length;
        if (!entry || entry.retryAt > Date.now())
            continue;
        try {
            const loaded = await this.load(name), rows = loaded.records;
            if (!rows.length) {
                await this.remove(name);
                continue;
            }
            try {
                await this.SQL(rows);
                this.m.delivered += rows.length;
                await this.remove(name);
            }
            catch (error) {
                const code = this.code(error);
                if (!/^(22|23|42|P0)/.test(code))
                    throw error;
                this.m.poison_groups++;
                const committed = [];
                for (const v of rows) {
                    try {
                        this.m.single_SQL_calls++;
                        await this.SQL([v]);
                        this.m.delivered++;
                        committed.push(v.id);
                    }
                    catch (e) {
                        if (!/^(22|23|42|P0)/.test(this.code(e)))
                            throw e;
                        this.m.poison_records++;
                    }
                }
                if (committed.length === rows.length) {
                    await this.remove(name);
                }
                else if (committed.length) {
                    let prior = [];
                    try {
                        const a = JSON.parse((await this.readPrivate(name + '.ack', 65536)).text);
                        prior = a.ids;
                    }
                    catch (e) {
                        if (e.code !== 'ENOENT')
                            throw e;
                    }
                    const body = { group: name, ids: [...new Set([...prior, ...committed])] };
                    const text = JSON.stringify({ ...body, hash: digest(JSON.stringify(body)) });
                    await this.writeAtomic(name + '.ack', text);
                    this.catalog.set(name, { count: rows.length - committed.length, bytes: loaded.groupBytes + Buffer.byteLength(text) + 1, retryAt: Date.now() + this.retryMs });
                }
                else {
                    entry.retryAt = Date.now() + this.retryMs;
                }
                this.m.errors++;
                this.lastError = code;
            }
        }
        catch (error) {
            this.m.errors++;
            this.lastError = this.code(error);
            entry.retryAt = Date.now() + this.retryMs;
        }
    } if (!this.catalog.size && !this.m.unpersisted && !this.artifactFiles && !this.unknownFiles && !this.inventoryUnsafe)
        this.lastError = null; }
    async flush() { if (this.commitTimer) {
        clearTimeout(this.commitTimer);
        this.commitTimer = undefined;
    } this.kickPublisher(); await this.publisher; await this.delivery; this.kickDelivery(); await this.delivery; }
    async close() { this.accepting = false; if (this.timer)
        clearInterval(this.timer); await this.maintenance; await this.flush(); }
}
//# sourceMappingURL=usage-spool.js.map