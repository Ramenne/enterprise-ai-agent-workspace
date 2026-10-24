-- Directed cooperation reply authority, without project-wide mutation authority.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.handoff_reply_context(proof text, pid uuid, hid uuid, body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $fn$
DECLARE i jsonb;hh record;pr record;rs jsonb;root record;
BEGIN
 IF authz.runtime_role()<>'hub2_v8' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);
 PERFORM authz.require_client_capability(i,'v8.handoff.record');
 IF i->>'principal_kind'<>'member' OR body->>'project_id' IS DISTINCT FROM pid::text OR body->>'handoff_id' IS DISTINCT FROM hid::text THEN
  RAISE EXCEPTION 'handoff_reply_scope_required' USING ERRCODE='42501';END IF;
 rs:=authz.request_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,body,'v8.handoff.record');
 PERFORM authz.lock_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,rs);
 i:=authz.authenticate(proof);
 SELECT * INTO hh FROM v8.handoff_reply_binding(hid);
 SELECT * INTO pr FROM v8.projects WHERE id=pid;
 IF hh.project_id IS DISTINCT FROM pid OR (i->>'actor_id')::uuid NOT IN(hh.from_actor_id,hh.to_actor_id) THEN
  RAISE EXCEPTION 'handoff_participant_required' USING ERRCODE='42501';END IF;
 IF pr.state IS DISTINCT FROM 'active' OR pr.organization_id::text IS DISTINCT FROM i->>'organization_id'
    OR NOT authz.can_read((i->>'actor_id')::uuid,pid)
    OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,pid)
    OR NOT xingxiu.agent_scope((i->>'actor_id')::uuid,pid) THEN
  RAISE EXCEPTION 'handoff_reply_current_scope_required' USING ERRCODE='42501';END IF;
 -- Every explicit referenced output retains its independent source read fence.
 FOR root IN SELECT DISTINCT * FROM authz.request_roots(body,'v8.handoff.record') LOOP
  IF NOT root.implicit AND NOT authz.resource_set_readable((i->>'actor_id')::uuid,(i->>'client_id')::uuid,
       authz.version_resources(root.version_id,'mem.read',(i->>'actor_id')::uuid),'mem.read') THEN
   RAISE EXCEPTION 'handoff_output_read_required' USING ERRCODE='42501';END IF;
 END LOOP;
 RETURN i||jsonb_build_object('project_id',pid,'action','v8.handoff.reply','project_revision',pr.revision);
END $fn$;
REVOKE ALL ON FUNCTION authz.handoff_reply_context(text,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.handoff_reply_context(text,uuid,uuid,jsonb) TO hub2_v8_owner;
RESET ROLE;
