BEGIN;
SET LOCAL ROLE hub2_mem_owner;
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.storage_lifecycle_target(text,timestamptz,bigint,boolean,text,timestamptz)'::regprocedure);
 s:=replace(s,'uses>=3','uses>=(mem.storage_lifecycle_policy()->>''warm_uses'')::bigint');
 s:=replace(s,'at_time-interval ''14 days''','at_time-(mem.storage_lifecycle_policy()->>''idle_days'')::integer*interval ''1 day''');
 EXECUTE s;
 s:=pg_get_functiondef('mem.storage_lifecycle_archive_due(uuid)'::regprocedure);
 s:=replace(s,'statement_timestamp()-interval ''14 days''','statement_timestamp()-(mem.storage_lifecycle_policy()->>''idle_days'')::integer*interval ''1 day''');EXECUTE s;
END $patch$;
RESET ROLE;
COMMIT;
