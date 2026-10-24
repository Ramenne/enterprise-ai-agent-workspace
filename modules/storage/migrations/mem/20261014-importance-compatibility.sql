BEGIN;
SET LOCAL ROLE hub2_mem_owner;
-- Recover already-declared levels; this is format compatibility, not new semantic classification.
DO $patch$
DECLARE s text;
BEGIN
 s:=pg_get_functiondef('mem.sync_material_core780()'::regprocedure);
 IF position('level_text:=NEW.properties#>>''{governance,importance_level}'';' IN s)=0 THEN RAISE EXCEPTION 'importance_sync_location_changed';END IF;
 s:=replace(s,'level_text:=NEW.properties#>>''{governance,importance_level}'';',
 'level_text:=coalesce(NEW.properties#>>''{governance,importance_level}'',NEW.properties->>''importance_level'');');EXECUTE s;
END $patch$;
UPDATE mem.materials SET
 properties=jsonb_set(properties,'{governance}',coalesce(properties->'governance','{}'::jsonb)||jsonb_build_object('importance_level',(properties->>'importance_level')::integer,
 'legacy_importance_recovery',jsonb_build_object('source','properties.importance_level','semantic_reassessment',false,'recovered_at',statement_timestamp())),true),
 metadata_revision=metadata_revision+1,event_revision=event_revision+1
WHERE importance_level IS NULL AND properties->>'importance_level' IN('1','2','3') AND properties#>>'{governance,importance_level}' IS NULL;
RESET ROLE;
COMMIT;
