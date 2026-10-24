-- Import only the seven approved nonsecret provider seed history revision1.
-- This is a newly recorded transport bootstrap, not a fabricated original
-- semantic judgment, user action, or execution authority. Original actor is unknown.
-- Run by the existing controlled migration identity; no roles/grants changed.
INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload)
 SELECT 'hufu',c.id,1,'provider.capabilities.bootstrap_import',c.project_id,
  jsonb_build_object('provider_id',c.provider_id,'revision',1,'area_id',(h.snapshot->>'area_id')::uuid,
   'bootstrap_source','610-provider-capability-catalog.sql:seed_history_revision1',
   'original_recorded_at',h.recorded_at,'original_actor_id',NULL,'actor_attribution','unknown_original_migration_seed',
   'semantic_judgment','not_inferred','execution_permission_granted',false)
 FROM authz.provider_capabilities62 c JOIN authz.provider_capability_history62 h ON h.capability_id=c.id AND h.revision=1
 WHERE c.project_id='ab817207-5829-4429-a165-bf1159ae4de0'::uuid
 AND c.provider_id IN('cos-management-parent','cos-resource-prefix','cos-gc-prefix','registered-postgresql','registered-forced-ssh','bailian-beijing-asr','tencent-ses-email')
 AND h.snapshot->>'id'=c.id::text AND h.snapshot->>'project_id'=c.project_id::text
 AND h.snapshot->>'provider_id'=c.provider_id AND h.snapshot->>'revision'='1'
 AND h.snapshot->'actor_id'='null'::jsonb AND h.snapshot->'client_id'='null'::jsonb
 AND NOT EXISTS(SELECT FROM evidence.outbox e WHERE e.domain='hufu'AND e.aggregate_id=c.id AND e.aggregate_revision=1)
 ON CONFLICT(domain,aggregate_id,aggregate_revision,group_index)DO NOTHING;
