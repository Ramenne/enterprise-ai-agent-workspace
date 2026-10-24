BEGIN;
SET LOCAL ROLE hub2_mem_owner;
DO $$
DECLARE rowvalue jsonb; key text; keys text[]:=ARRAY['final/316b14a3-44f5-4d86-aa54-93129477ac91','tech/abc/v3','中文/文件','quote"key','line'||chr(10)||'key','123','true','{"x": "y"}'];
BEGIN
 FOREACH key IN ARRAY keys LOOP
  rowvalue:=jsonb_build_object('inputs',jsonb_build_array(jsonb_build_object('locator',jsonb_build_object('provider','cos','bucket','test-bucket','object_key',key,'provider_version_id','synthetic-version'))));
  IF NOT mem.storage_hot_reference_may_match(rowvalue,key) THEN RAISE EXCEPTION 'prefilter_dropped_explicit_hot_locator';END IF;
  IF NOT EXISTS(SELECT FROM mem.gc_reference_keys(rowvalue) k WHERE k LIKE 'locator:%')THEN RAISE EXCEPTION 'locator_fixture_not_recognized';END IF;
 END LOOP;
 IF mem.storage_hot_reference_may_match('{"fixed_refs":[]}', 'final/no-match') THEN RAISE EXCEPTION 'safe_nonmatch_not_filtered';END IF;
 IF NOT mem.storage_hot_reference_may_match('{"object_key":123}', '123') OR NOT mem.storage_hot_reference_may_match('{"object_key":true}', 'true') THEN RAISE EXCEPTION 'primitive_key_false_negative';END IF;
END $$;
SELECT jsonb_build_object('state','passed','check','conservative_hot_reference_prefilter','cases',11);
ROLLBACK;
