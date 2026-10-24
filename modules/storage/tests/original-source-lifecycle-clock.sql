BEGIN;
SET LOCAL ROLE hub2_mem_owner;
DO $$
DECLARE t timestamptz:=timestamptz '2026-10-19 12:00:00+00'; a timestamptz;
BEGIN
 a:=mem.storage_lifecycle_last_activity(t,t-interval '60 days',t-interval '30 days',NULL,NULL,true);
 IF a IS DISTINCT FROM t-interval '30 days' OR mem.storage_lifecycle_target('standard',a,0,false,NULL,t) IS DISTINCT FROM 'archive' THEN RAISE EXCEPTION 'migration_reset_source_clock';END IF;
 a:=mem.storage_lifecycle_last_activity(t,t-interval '60 days',t-interval '30 days',t-interval '1 day',NULL,true);
 IF a IS DISTINCT FROM t-interval '1 day' OR mem.storage_lifecycle_target('standard',a,0,false,NULL,t) IS NOT NULL THEN RAISE EXCEPTION 'recent_use_ignored';END IF;
 a:=mem.storage_lifecycle_last_activity(t,NULL,NULL,NULL,NULL,false);
 IF a IS DISTINCT FROM t OR mem.storage_lifecycle_target('standard',a,0,false,NULL,t) IS NOT NULL THEN RAISE EXCEPTION 'native_creation_not_retained';END IF;
 a:=mem.storage_lifecycle_last_activity(t,NULL,NULL,NULL,NULL,true);
 IF a IS NOT NULL OR mem.storage_lifecycle_target('standard',a,0,false,NULL,t) IS NOT NULL THEN RAISE EXCEPTION 'unknown_import_clock_fabricated';END IF;
 a:=mem.storage_lifecycle_last_activity(t,t-interval '60 days',NULL,NULL,NULL,true);
 IF a IS DISTINCT FROM t-interval '60 days' THEN RAISE EXCEPTION 'original_creation_fallback_ignored';END IF;
 a:=mem.storage_lifecycle_last_activity(t,t-interval '60 days',t-interval '30 days',NULL,t-interval '1 day',true);
 IF a IS DISTINCT FROM t-interval '1 day' THEN RAISE EXCEPTION 'warm_cooldown_ignored';END IF;
 IF mem.storage_lifecycle_target('standard',t-interval '30 days',0,true,NULL,t) IS NOT NULL THEN RAISE EXCEPTION 'pin_ignored';END IF;
 IF mem.storage_source_epoch('1790000000000') IS DISTINCT FROM mem.storage_source_epoch('1790000000') OR mem.storage_source_epoch('not_a_timestamp') IS NOT NULL OR mem.storage_source_epoch('0') IS NOT NULL THEN RAISE EXCEPTION 'invalid_source_epoch';END IF;
END $$;
SELECT jsonb_build_object('state','passed','cases',8);
ROLLBACK;
