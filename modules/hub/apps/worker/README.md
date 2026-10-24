# Shared worker and public change-feed convergence

## Candidate, not deployed — 2026-10-19

The public durable feed missed a real saved work update. The production cause is
still unconfirmed: evidence/jobs diagnostics and the actual worker runtime target
have not been delivered. Do not describe source tests as production repair.

The previous dispatch-priority-only candidate is superseded by this coherent
failure-isolation candidate. Do not publish that intermediate change separately.

## Data and failure boundaries

| Stage | Authority / behavior | Current evidence |
| --- | --- | --- |
| Work update | Existing V8 transaction writes work revision and outbox event through v8.emit | Source reviewed; no newly confirmed writer defect |
| Durable outbox | Committed database facts; no cursor reset or event deletion | Production trace unavailable |
| Delivery | Existing evidence.dispatch_batch(100), service guard and atomic counter | SQL preserved; isolated service tests |
| Maintenance / tasks | Existing PgBoss, task IDs, leases, fences, handlers and final transactions | Source-level failure/recovery tests |
| Public read | Current project-bound opaque cursor and final authorization | Source reviewed; missing-return reproduction retained |
| EmployeeClient | Work/material hints and bounded cache checks are separate from this public durable feed | No client change in this candidate |
| Ordinary chat | EmployeeClient message/notification outbox | Independent path; this candidate proves no chat-notification fix |

## Runtime isolation

The production entrypoint uses WorkerService with two independent single-flight
loops and independent runtime-leased database pools: delivery max 1, tasks max 2.
This increases the configured total bound from 2 to 3 connections. Both retain
existing service credentials, database timeouts and authority checks.

Event delivery starts without awaiting object-store/budget setup or PgBoss start.
Task initialization, queue start, maintenance errors, and slow handlers cannot
consume its reserved connection or block its next iteration. Event-dispatch
failure does not prevent task execution. Existing direct DeterministicWorker
callers retain inline dispatch; the production entrypoint explicitly selects
externalDispatch, so a task tick does not also dispatch.

Each lane waits 1 second between normal ticks, matching the prior dispatcher
cadence. Consecutive failures back off 1/2/4/8/16/30 seconds, capped at 30 seconds,
and success resets the delay. There is no new client, identity or chat polling.
No lane overlaps its own previous operation, even when a database call is slow.

Queue startup is single-flight. Failed startup cleans partial broker resources
before retry; stop joins this cleanup. Task preparation, heartbeat, attempt/fence
validation and final effect transaction remain unchanged.

Shutdown stops admission, aborts task attempts, cancels retry waits and joins
initialization plus actual delivery/task operations before closing pools and
the runtime secret client. An incomplete join reports failure rather than
acknowledging clean shutdown or racing pool closure. Abrupt process death still
relies on existing database transaction and task-lease recovery.

## Diagnostics

Logs distinguish task_initialize, queue_start, task_tick and event_dispatch,
without logging raw dependency exceptions or argument contents. The loopback
/ready endpoint reports 503 until both lanes have succeeded, on a lane failure,
and when delivery success has become stale. Healthy long task execution is not
mistaken for event-delivery progress.

## Validation

Run:

~~~sh
node --test tests/worker-dispatch-priority.test.mjs tests/worker-event-lanes.test.mjs tests/worker-entrypoint.test.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target es2023 --module nodenext --moduleResolution nodenext --skipLibCheck apps/worker/src/service.ts apps/worker/src/start.ts
~~~

The tests import the actual source and exercise maintenance failures, bidirectional
lane isolation, queue startup failure/hang, task dependency initialization failure,
slow work, retry bounds, concurrent starts, recovery and joined shutdown.
The subprocess tests run the actual start.ts, real loopback HTTP readiness and
SIGTERM lifecycle with synthetic database/PgBoss adapters. They establish startup
wiring and resource closure, not real SQL, service authority, provider delivery or
production end-to-end behavior.

## Release gate and remaining work

Obtain the registered hub2-worker.service runtime, its logs, and authorized
evidence/jobs diagnostics. Correlate a real work receipt with its committed outbox
row, delivery sequence and caller-visible public event. Check deployed SQL against
the reviewed source and validate failure recovery before one combined deployment,
public readback and real-data acceptance. Do not deploy hub2-hufu.service as a
substitute or reset cursors to manufacture a passing result.
