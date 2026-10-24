BEGIN;
SET ROLE hub2_mem_owner;
ALTER TABLE mem.storage_tier_copies DROP CONSTRAINT storage_tier_copies_tier_check;
ALTER TABLE mem.storage_tier_copies ADD CONSTRAINT storage_tier_copies_tier_check CHECK(tier IN('infrequent','archive','deep_archive'));
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.storage_tier_command(uuid,text,text)'::regprocedure);
 s:=replace(s,'NOT IN(''archive'',''deep_archive'')','NOT IN(''infrequent'',''archive'',''deep_archive'')');
 s:=replace(s,'CASE r.tier WHEN ''archive''THEN ''ARCHIVE''ELSE ''DEEP_ARCHIVE''END','CASE r.tier WHEN ''archive''THEN ''ARCHIVE'' WHEN ''infrequent'' THEN ''STANDARD_IA'' ELSE ''DEEP_ARCHIVE''END');EXECUTE s;
 s:=pg_get_functiondef('mem.storage_tier_retirement(uuid,text,text)'::regprocedure);
 s:=replace(s,'CASE t.tier WHEN ''archive''THEN ''ARCHIVE''ELSE ''DEEP_ARCHIVE''END','CASE t.tier WHEN ''archive''THEN ''ARCHIVE'' WHEN ''infrequent'' THEN ''STANDARD_IA'' ELSE ''DEEP_ARCHIVE''END');EXECUTE s;
END $patch$;
UPDATE mem.gc_reference_contracts SET shape_hash=mem.gc_relation_shape(format('%I.%I',schema_name,table_name)::regclass)WHERE schema_name='mem'AND table_name IN('materials','storage_tier_copies','material_use_events','storage_warm_operations');
RESET ROLE;
COMMIT;
