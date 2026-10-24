// pg-boss 12.35.1 strips this @internal export while public .d.ts files reference it.
// Exact fields from https://github.com/timgit/pg-boss/blob/12.35.1/src/types.ts .
import 'pg-boss/dist/types.js';
declare module 'pg-boss/dist/types.js' {
 export interface ResolvedConstructorOptions extends ConstructorOptions {
  schema: string; clock: Clock;
  monitorIntervalSeconds: number; cronMonitorIntervalSeconds: number;
  maintenanceIntervalSeconds: number; bamIntervalSeconds: number;
  flowIntervalSeconds: number; reindexIntervalSeconds: number;
  noSkipLocked?: boolean; noMultiMutationCte?: boolean; noTablePartitioning?: boolean;
  noDeferrableConstraints?: boolean; noAdvisoryLocks?: boolean; noCoveringIndexes?: boolean;
  inlineTableIndexes?: boolean; noAddColumnBackfill?: boolean; noListenNotify?: boolean;
  noIndexProgressView?: boolean; noMonitorVacuum?: boolean; noReindex?: boolean; noTransactionalHeartbeat?: boolean;
 }
}
