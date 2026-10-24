-- Agent declarations remain the source of current meaning; this is navigation,
-- not an automatic interpretation of events or a rewrite of historical briefs.
SET ROLE hub2_v8_owner;
ALTER FUNCTION v8.work_read(uuid,text,text) RENAME TO work_read_bounded_230;
REVOKE ALL ON FUNCTION v8.work_read_bounded_230(uuid,text,text) FROM PUBLIC,hub2_v8,hub2_mem,hub2_worker,hub2_hufu;
CREATE FUNCTION v8.work_read(h uuid,d text,p text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE r jsonb;b jsonb;c jsonb;note record;summary jsonb:=NULL;view_revision bigint;
BEGIN
 r:=v8.work_read_bounded_230(h,d,p);b:=p::jsonb;
 SELECT to_jsonb(i) INTO c FROM authz.effect_identity(h) i;c:=c||jsonb_build_object('project_id',b->'project_id');
 view_revision:=(r->'work_item'->>'revision')::bigint;
 FOR note IN SELECT * FROM v8.work_updates WHERE work_item_id=(b->>'work_item_id')::uuid
   AND work_revision<=view_revision AND jsonb_typeof(payload->'summary')='string' AND length(payload->>'summary')>0
   ORDER BY work_revision DESC LOOP
  IF v8.authorized_statement(h,c,note.payload) THEN
   summary:=jsonb_build_object('text',left(note.payload->>'summary',2000),'work_revision',note.work_revision,'update_id',note.id,
     'statement_sha256',note.sha256,'actor_id',note.actor_id,'kind','agent_or_member_declared',
     'coverage','latest_currently_authorized_declared_summary_at_view_revision','truncated',length(note.payload->>'summary')>2000,
     'expansion',jsonb_build_object('tool','v8.statement.read_chunk','arguments',jsonb_build_object('project_id',b->'project_id',
        'kind','work_update','statement_id',note.id),'field_path',jsonb_build_array('summary')));
   EXIT;
  END IF;
 END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN r||jsonb_build_object('current_summary',summary,'brief_semantics','work_item.description_is_initial_brief;history_retained',
   'summary_semantics','latest_authorized_explicit_declaration;not_inferred_completion_or_global_latest');
END $$;
REVOKE ALL ON FUNCTION v8.work_read(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.work_read(uuid,text,text) TO hub2_v8;
RESET ROLE;
