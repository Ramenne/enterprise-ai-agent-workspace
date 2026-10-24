-- Governance remains an Agent judgment in extensible metadata.
-- Existing vectors remain stored for rollback; new vectors require explicit importance.
SET ROLE hub2_mem_owner;

DO $migration$
DECLARE definition text;
BEGIN
 definition:=pg_get_functiondef('mem.material_head(uuid,text,text)'::regprocedure);
 IF position('properties_at_current_metadata_revision' IN definition)=0 THEN
  definition:=replace(definition,
   'PERFORM authz.assert_effect(h);RETURN result;',
   'result:=result||jsonb_build_object(''properties'',m.properties,''properties_coverage'',''properties_at_current_metadata_revision''); PERFORM authz.assert_effect(h);RETURN result;');
  IF position('properties_at_current_metadata_revision' IN definition)=0 THEN RAISE EXCEPTION 'material_head_extension_location_missing'; END IF;
  EXECUTE definition;
 END IF;

 definition:=pg_get_functiondef('mem.description_vector_register(uuid,text,text)'::regprocedure);
 IF position('importance_not_marked_by_Agent' IN definition)=0 THEN
  definition:=replace(definition,
   'replay:=mem.replay_command(c,''description_vector_register'',b,d);',
   'SELECT * INTO m FROM mem.materials WHERE id=v.material_id FOR UPDATE;
    IF (m.properties #>> ''{governance,important}'') IS DISTINCT FROM ''true'' THEN
     PERFORM authz.assert_effect(h);
     RETURN jsonb_build_object(''state'',''not_indexed'',''reason'',''importance_not_marked_by_Agent'',
      ''fixed_ref'',jsonb_build_object(''material_id'',v.material_id,''version_id'',v.id,''sha256'',v.sha256),
      ''original_readability_unchanged'',true,''decision_owner'',''authorized_Agent_or_member'');
    END IF;
    replay:=mem.replay_command(c,''description_vector_register'',b,d);');
  IF position('importance_not_marked_by_Agent' IN definition)=0 THEN RAISE EXCEPTION 'description_index_extension_location_missing'; END IF;
  EXECUTE definition;
 END IF;

 definition:=pg_get_functiondef('mem.description_vector_search(uuid,text,text)'::regprocedure);
 IF position('explicit_unimportant_excluded' IN definition)=0 THEN
  definition:=replace(definition,
   'AND m.state=''active'' AND dr.state=''active''',
   'AND m.state=''active'' AND (m.properties #>> ''{governance,important}'') IS DISTINCT FROM ''false'' AND dr.state=''active''');
  definition:=replace(definition,
   '''semantic_validity'',''candidate_only_Agent_decides''',
   '''governance'',''explicit_unimportant_excluded;legacy_unassessed_indices_retained_for_review'',''semantic_validity'',''candidate_only_Agent_decides''');
  IF position('explicit_unimportant_excluded' IN definition)=0 THEN RAISE EXCEPTION 'description_search_extension_location_missing'; END IF;
  EXECUTE definition;
 END IF;
END $migration$;

RESET ROLE;
