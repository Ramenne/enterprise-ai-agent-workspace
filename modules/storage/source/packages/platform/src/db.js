import pg from 'pg';
import { recordSuccessfulCapability } from './observed-scope.js';
export function database(connectionString, max = 6) {
    if (!connectionString)
        throw new Error('database URL required');
    const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
        statement_timeout: 10000, application_name: process.env['HUB_SERVICE'] ?? 'hub2' });
    pool.on('error', () => process.stderr.write('hub2 database pool connection error\n'));
    return pool;
}
export async function transaction(pool, work) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'");
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    }
    catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    }
    finally {
        client.release();
    }
}
export async function sqlFunction(pool, name, args) {
    if (!/^(authz|mem|v8|coord|evidence)\.[a-z_]+$/.test(name))
        throw new Error('invalid SQL capability');
    const result = await pool.query('SELECT ' + name + '(' + args.map((_, i) => '$' + (i + 1)).join(',') + ') AS result', args);
    recordSuccessfulCapability(args);
    return result.rows[0]?.['result'];
}
//# sourceMappingURL=db.js.map