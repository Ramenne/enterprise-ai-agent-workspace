// Offline migration command: temporary migration identity only. Never run in runtime start.
import pg from 'pg';
import { getConstructionPlans, PgBoss } from 'pg-boss';
export async function installQueue(connection: string | pg.PoolConfig): Promise<void> {
 const pool = new pg.Pool(typeof connection === 'string' ? { connectionString: connection, max: 1 } : { ...connection, ...(connection.password !== undefined ? { password: connection.password } : {}), max: 1 });
 try {
  const client = await pool.connect();
  try {
   await client.query('BEGIN');
   const installed = (await client.query("SELECT to_regclass('worker_queue.version') installed")).rows[0]?.['installed'];
   if (!installed) {
    await client.query('CREATE SCHEMA IF NOT EXISTS worker_queue AUTHORIZATION hub2_evidence_owner');
    await client.query('SET LOCAL ROLE hub2_evidence_owner');
    await client.query(getConstructionPlans('worker_queue', { createSchema: false }));
   }
   await client.query('COMMIT');
   await client.query('RESET ROLE');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const boss = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) }, schema: 'worker_queue', migrate: false, createSchema: false, supervise: false, schedule: false, max: 1 });
  try {
   await boss.start();
   await boss.createQueue('hub2-dead', { retryLimit: 0 });
   await boss.createQueue('hub2-work', { retryLimit: 5, retryDelay: 2, retryBackoff: true, expireInSeconds: 120, deadLetter: 'hub2-dead', retentionSeconds: 604800, deleteAfterSeconds: 604800 });
   await pool.query('GRANT USAGE ON SCHEMA worker_queue TO hub2_worker');
   await pool.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA worker_queue TO hub2_worker');
   await pool.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA worker_queue TO hub2_worker');
   await pool.query('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA worker_queue FROM PUBLIC');
   await pool.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA worker_queue TO hub2_worker');
  } finally { await boss.stop(); }
 } finally { await pool.end(); }
}
if (process.argv[1]?.endsWith('queue-migrate.js')) {
 const url = process.env['HUB_MIGRATION_DATABASE_URL']; if (!url) throw new Error('HUB_MIGRATION_DATABASE_URL required');
 await installQueue(url);
}
