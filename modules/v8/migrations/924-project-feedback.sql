SET ROLE hub2_v8_owner;
-- The project owner domain supplies the row lock; authz gets no UPDATE privilege.
CREATE OR REPLACE FUNCTION v8.project_feedback_project_lock(pid uuid,org uuid) RETURNS v8.projects
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$DECLARE p v8.projects;BEGIN SELECT * INTO p FROM v8.projects WHERE id=pid AND organization_id=org FOR SHARE;IF p.id IS NULL THEN RAISE EXCEPTION 'project_not_accessible' USING ERRCODE='42501';END IF;RETURN p;END$$;
REVOKE ALL ON FUNCTION v8.project_feedback_project_lock(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.project_feedback_project_lock(uuid,uuid) TO hub2_authz_owner;

CREATE TABLE IF NOT EXISTS v8.project_feedback(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL REFERENCES v8.projects,organization_id uuid NOT NULL,
 reporter_id uuid NOT NULL,client_id uuid NOT NULL,title text NOT NULL,text text NOT NULL,kind text NOT NULL DEFAULT 'problem' CHECK(kind IN('problem','suggestion')),
 visibility text NOT NULL DEFAULT 'project' CHECK(visibility IN('project','reporter_and_handlers')),evidence_links jsonb NOT NULL DEFAULT '[]',origin jsonb NOT NULL DEFAULT '{}',
 handling_state text NOT NULL DEFAULT 'submitted' CHECK(handling_state IN('submitted','in_progress','needs_information','resolved','not_planned')),
 revision bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX IF NOT EXISTS project_feedback_project_state ON v8.project_feedback(project_id,handling_state,id);
CREATE TABLE IF NOT EXISTS v8.project_feedback_updates(
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,feedback_id uuid NOT NULL REFERENCES v8.project_feedback,actor_id uuid NOT NULL,client_id uuid NOT NULL,
 text text NOT NULL,handling_state text,revision bigint NOT NULL,evidence_links jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX IF NOT EXISTS project_feedback_update_page ON v8.project_feedback_updates(feedback_id,seq);
CREATE TABLE IF NOT EXISTS v8.project_feedback_commands(
 actor_id uuid NOT NULL,project_id uuid NOT NULL,idempotency_key text NOT NULL,operation text NOT NULL,body jsonb NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,project_id,idempotency_key));
REVOKE ALL ON v8.project_feedback,v8.project_feedback_updates,v8.project_feedback_commands FROM PUBLIC,hub2_v8;
CREATE OR REPLACE FUNCTION v8.project_feedback_call(proof text,op text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE c jsonb;a uuid;cl uuid;pid uuid;org uuid;f v8.project_feedback;oldcmd v8.project_feedback_commands;result jsonb;items jsonb;lim int;handling boolean;writing boolean;note_id bigint;latest_seq bigint;count_ bigint;last_cursor text;
BEGIN
 IF op NOT IN('submit','query','read','append','operation') THEN RAISE EXCEPTION 'invalid_operation' USING ERRCODE='22023';END IF;
 pid:=(b->>'project_id')::uuid;handling:=op='append' AND b ? 'handling_state';writing:=op IN('submit','append');
 c:=authz.project_feedback_context(proof,pid,handling);a:=(c->>'actor_id')::uuid;cl:=(c->>'client_id')::uuid;org:=(c->>'organization_id')::uuid;lim:=coalesce((b->>'limit')::int,20);
 IF lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_limit' USING ERRCODE='22023';END IF;
 IF writing THEN
  IF NOT(coalesce(c->'client_actions','[]'::jsonb)?'v8.work.commit') THEN RAISE EXCEPTION 'software_write_required' USING ERRCODE='42501';END IF;
  IF length(coalesce(b->>'idempotency_key','')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE='22023';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(a::text||pid::text||(b->>'idempotency_key'),0));
  SELECT * INTO oldcmd FROM v8.project_feedback_commands WHERE actor_id=a AND project_id=pid AND idempotency_key=b->>'idempotency_key';
  IF FOUND THEN
   IF oldcmd.operation<>op OR oldcmd.body<>b THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
   IF oldcmd.result->>'feedback_id' IS NOT NULL THEN
    SELECT * INTO f FROM v8.project_feedback WHERE id=(oldcmd.result->>'feedback_id')::uuid;
    IF f.visibility='reporter_and_handlers' AND f.reporter_id<>a AND NOT(c->>'can_handle')::boolean THEN RAISE EXCEPTION 'feedback_not_accessible' USING ERRCODE='42501';END IF;
   END IF;
   RETURN oldcmd.result||jsonb_build_object('replayed',true);
  END IF;
 END IF;
 IF op='submit' THEN
  IF length(btrim(coalesce(b->>'text','')))=0 THEN RAISE EXCEPTION 'feedback_text_required' USING ERRCODE='22023';END IF;
  INSERT INTO v8.project_feedback(project_id,organization_id,reporter_id,client_id,title,text,kind,visibility,evidence_links,origin)
  VALUES(pid,org,a,cl,coalesce(nullif(btrim(b->>'title'),''),left(b->>'text',100)),b->>'text',coalesce(b->>'kind','problem'),coalesce(b->>'visibility','project'),coalesce(b->'evidence_links','[]'),jsonb_strip_nulls(jsonb_build_object('channel',coalesce(b->>'source_channel','api'),'native_thread_id',b->>'native_thread_id','attribution','client_declared_origin;actor_from_authentication'))) RETURNING * INTO f;
  result:=jsonb_build_object('state','retained','feedback_id',f.id,'project_id',pid,'feedback',to_jsonb(f),'project_title',c->'project_title','project_owner_id',c->'project_owner_id','project_manager_id',c->'project_manager_id','delivery','stored_in_project_feedback_queue;no_notification_or_acceptance_asserted');
 ELSIF op='query' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id),'[]'),count(*),max(x.id::text) INTO items,count_,last_cursor FROM (
   SELECT ff.id feedback_id,ff.id,ff.project_id,ff.reporter_id,ff.title,ff.kind,ff.visibility,ff.handling_state,ff.revision,ff.created_at,ff.updated_at FROM v8.project_feedback ff
   WHERE ff.project_id=pid AND (ff.visibility='project' OR ff.reporter_id=a OR(c->>'can_handle')::boolean)
    AND(b->>'handling_state' IS NULL OR ff.handling_state=b->>'handling_state') AND(b->>'kind' IS NULL OR ff.kind=b->>'kind') AND(b->>'reporter_id' IS NULL OR ff.reporter_id=(b->>'reporter_id')::uuid)
    AND(b->>'cursor' IS NULL OR ff.id>(b->>'cursor')::uuid) ORDER BY ff.id LIMIT lim+1)x;
  IF count_>lim THEN items:=items-lim;last_cursor:=items->(lim-1)->>'id';END IF;
  RETURN jsonb_build_object('state','read','project_id',pid,'project_title',c->'project_title','items',items,'next_cursor',CASE WHEN count_>lim THEN last_cursor ELSE NULL END,'coverage','current_authorized_project_feedback_metadata;not_product_internal_feedback','can_handle',c->'can_handle','observed_at',clock_timestamp());
 ELSIF op='operation' THEN
  SELECT * INTO oldcmd FROM v8.project_feedback_commands WHERE actor_id=a AND project_id=pid AND idempotency_key=b->>'idempotency_key';
  IF oldcmd.actor_id IS NULL THEN RETURN jsonb_build_object('state','not_found');END IF;
  SELECT * INTO f FROM v8.project_feedback WHERE id=(oldcmd.result->>'feedback_id')::uuid AND project_id=pid;
  IF f.visibility='reporter_and_handlers' AND f.reporter_id<>a AND NOT(c->>'can_handle')::boolean THEN RAISE EXCEPTION 'feedback_not_accessible' USING ERRCODE='42501';END IF;
  RETURN jsonb_build_object('state','found','operation',oldcmd.operation,'result',oldcmd.result);
 ELSE
  IF op='append' THEN SELECT * INTO f FROM v8.project_feedback WHERE id=(b->>'feedback_id')::uuid AND project_id=pid FOR UPDATE;
  ELSE SELECT * INTO f FROM v8.project_feedback WHERE id=(b->>'feedback_id')::uuid AND project_id=pid;END IF;
  IF f.id IS NULL OR(f.visibility='reporter_and_handlers' AND f.reporter_id<>a AND NOT(c->>'can_handle')::boolean) THEN RAISE EXCEPTION 'feedback_not_accessible' USING ERRCODE='42501';END IF;
  IF op='read' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.seq),'[]'),count(*),max(x.seq) INTO items,count_,latest_seq FROM (SELECT * FROM v8.project_feedback_updates WHERE feedback_id=f.id AND seq>coalesce((b->>'after_seq')::bigint,0) ORDER BY seq LIMIT lim+1)x;
   IF count_>lim THEN items:=items-lim;latest_seq:=(items->(lim-1)->>'seq')::bigint;END IF;
   RETURN jsonb_build_object('state','read','feedback',to_jsonb(f),'items',items,'next_seq',CASE WHEN count_>lim THEN latest_seq ELSE NULL END,'can_handle',c->'can_handle','handling_semantics','project_handler_declaration;not_external_verification','observed_at',clock_timestamp());
  END IF;
  IF length(btrim(coalesce(b->>'text','')))=0 THEN RAISE EXCEPTION 'feedback_text_required' USING ERRCODE='22023';END IF;
  IF handling AND f.revision<>coalesce((b->>'expected_revision')::bigint,-1) THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';END IF;
  UPDATE v8.project_feedback SET handling_state=CASE WHEN handling THEN b->>'handling_state' ELSE handling_state END,revision=revision+1,updated_at=clock_timestamp() WHERE id=f.id RETURNING * INTO f;
  INSERT INTO v8.project_feedback_updates(feedback_id,actor_id,client_id,text,handling_state,revision,evidence_links) VALUES(f.id,a,cl,b->>'text',CASE WHEN handling THEN f.handling_state ELSE NULL END,f.revision,coalesce(b->'evidence_links','[]')) RETURNING seq INTO note_id;
  result:=jsonb_build_object('state','retained','feedback_id',f.id,'project_id',pid,'update_seq',note_id,'revision',f.revision,'handling_state',f.handling_state,'handling_semantics','project_handler_declaration;not_external_verification');
 END IF;
 INSERT INTO v8.project_feedback_commands(actor_id,project_id,idempotency_key,operation,body,result) VALUES(a,pid,b->>'idempotency_key',op,b,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION v8.project_feedback_call(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.project_feedback_call(text,text,jsonb) TO hub2_v8;
RESET ROLE;
