/** Liveness stays separate from usable database connectivity and capability coverage. */
export function installDatabaseReadiness(app, pool, capabilities = {}, observations) {
    app.get('/ready', async (_request, reply) => {
        const poolStatus = () => ({ total_count: pool.totalCount, idle_count: pool.idleCount,
            waiting_count: pool.waitingCount, max: pool.options.max });
        try {
            await pool.query('SELECT 1');
            return { state: 'ready', database: 'connected', capabilities, pool: poolStatus(), ...observations?.() };
        }
        catch {
            return reply.code(503).send({ state: 'degraded', error_code: 'database_unavailable', retryable: true,
                capabilities, pool: poolStatus(), ...observations?.() });
        }
    });
}
//# sourceMappingURL=readiness.js.map