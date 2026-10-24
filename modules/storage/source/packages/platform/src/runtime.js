import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createLeasedDatabasePool } from '../../database-leases/src/rotating-pool.js';
import { createSecretClient, SecretClientError } from '../../secrets/src/index.js';
/** Deployment reads only its own KV. Direct environment remains available to isolated tests. */
export async function loadRuntime(domain) {
    const bootstrap = process.env['HUB_BAO_BOOTSTRAP_FILE'];
    const ca = process.env['HUB_BAO_CA_FILE'];
    const reference = process.env['HUB_RUNTIME_SECRET_REF'];
    let client;
    let data = {};
    if (bootstrap || ca || reference) {
        if (!bootstrap || !ca || !reference)
            throw new Error('runtime_secret_configuration_incomplete');
        client = createSecretClient({ bootstrap_file: bootstrap, ca_file: ca,
            ...(process.env['HUB_BAO_URL'] ? { base_url: process.env['HUB_BAO_URL'] } : {}),
            on_state: status => process.stderr.write(JSON.stringify({ service: domain, dependency: 'bao', ...status }) + '\n') });
        try {
            await client.start();
            const secret = await client.readKV(reference);
            data = secret.data;
            process.stderr.write(JSON.stringify({ service: domain, state: 'runtime_loaded', secret_version: secret.metadata.version }) + '\n');
        }
        catch (error) {
            await client.close();
            throw new Error(error instanceof SecretClientError ? error.code : 'runtime_secret_unavailable');
        }
    }
    const optional = (key, legacyEnvironment) => {
        const aliases = { mem_service_key: 'mem', v8_service_key: 'v8', worker_service_key: 'worker' };
        const internal = data['internal_service_keys'];
        const value = client ? data[key] ?? (key === 'service_key' ? data['hufu_service_key'] : aliases[key] && internal && typeof internal === 'object' && !Array.isArray(internal) ? internal[aliases[key]] : undefined) : legacyEnvironment ? process.env[legacyEnvironment] : undefined;
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    const databasePools = [];
    return {
        async databasePool(legacyEnvironment, options = {}) {
            let pool;
            const ref = data['database_credentials_ref'], endpoint = data['database_endpoint'];
            if (client && typeof ref === 'string') {
                if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint))
                    throw new Error('database_endpoint_missing');
                const e = endpoint;
                if (typeof e['host'] !== 'string' || typeof e['database'] !== 'string' || typeof e['port'] !== 'number')
                    throw new Error('database_endpoint_invalid');
                const ca = typeof e['ca_file'] === 'string' ? await readFile(e['ca_file'], 'utf8') : undefined;
                pool = await createLeasedDatabasePool({ client, reference: ref, pool: { ...options, host: e['host'], port: e['port'], database: e['database'], ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}), max: options.max ?? 6, connectionTimeoutMillis: 5000, statement_timeout: 10000 }, on_state: state => process.stderr.write(JSON.stringify({ service: domain, dependency: 'database', ...state }) + '\n') });
            }
            else {
                const url = optional('database_url', legacyEnvironment);
                if (!url)
                    throw new Error('runtime_database_configuration_missing');
                pool = new pg.Pool({ ...options, connectionString: url, max: options.max ?? 6, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
            }
            pool.on('error', () => process.stderr.write('database_dependency_error\n'));
            databasePools.push(pool);
            return pool;
        },
        mode: client ? 'scoped_bao' : 'explicit_environment', optional,
        required(key, legacyEnvironment) {
            const value = optional(key, legacyEnvironment);
            if (!value)
                throw new Error('runtime_required_field_missing:' + key);
            return value;
        },
        async optionalSecret(ref) {
            if (!client)
                return undefined;
            try {
                return (await client.readKV(ref)).data;
            }
            catch (error) {
                if (error instanceof SecretClientError && error.code === 'secret_not_found')
                    return undefined;
                throw new Error(error instanceof SecretClientError ? error.code : 'runtime_secret_unavailable');
            }
        },
        async close() { await Promise.all(databasePools.map(pool => pool.end().catch(() => { }))); await client?.close(); },
    };
}
/** A missing object capability still permits metadata, drafts and recovery work. */
export async function objectStoreConfig(runtime, ref, environmentPrefix = 'S3') {
    const data = await runtime.optionalSecret(ref);
    const value = (key, suffix) => {
        const v = runtime.mode === 'scoped_bao' ? data?.[key] : process.env[environmentPrefix + '_' + suffix];
        return typeof v === 'string' && v.length > 0 ? v : undefined;
    };
    const endpoint = value('endpoint', 'ENDPOINT'), region = value('region', 'REGION'), bucket = value('bucket', 'BUCKET'), accessKeyId = value('access_key_id', 'ACCESS_KEY_ID'), secretAccessKey = value('secret_access_key', 'SECRET_ACCESS_KEY'), sessionToken = value('session_token', 'SESSION_TOKEN');
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey)
        return undefined;
    const forcePathStyle = typeof data?.['force_path_style'] === 'boolean' ? data['force_path_style'] : !new URL(endpoint).hostname.endsWith('.myqcloud.com');
    const credentialProvider = runtime.mode === 'scoped_bao' ? async () => {
        const latest = await runtime.optionalSecret(ref);
        if (!latest)
            throw new Error('object_credentials_configuration_required');
        if (latest['endpoint'] !== endpoint || latest['region'] !== region || latest['bucket'] !== bucket)
            throw new Error('object_credentials_target_changed');
        const id = latest['access_key_id'], secret = latest['secret_access_key'], token = latest['session_token'];
        if (typeof id !== 'string' || !id || typeof secret !== 'string' || !secret)
            throw new Error('object_credentials_invalid');
        const expires = latest['expires_at'] ?? latest['expiration'] ?? latest['credential_expires_at'];
        const expiration = typeof expires === 'number' ? new Date(expires * 1000) : typeof expires === 'string' ? new Date(expires) : undefined;
        if (expiration && (!Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()))
            throw new Error('object_credentials_expired');
        return { accessKeyId: id, secretAccessKey: secret, ...(typeof token === 'string' && token ? { sessionToken: token } : {}), ...(expiration ? { expiration } : {}) };
    } : undefined;
    return { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle, ...(sessionToken ? { sessionToken } : {}), ...(credentialProvider ? { credentialProvider } : {}) };
}
//# sourceMappingURL=runtime.js.map