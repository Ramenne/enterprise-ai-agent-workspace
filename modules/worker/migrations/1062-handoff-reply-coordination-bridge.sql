-- Platform coordination bridge: V8 handoff replies only, not arbitrary domain writes.
SET ROLE hub2_evidence_owner;
CREATE OR REPLACE FUNCTION coord.handoff_reply_writer(pid uuid,hid uuid,actor uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,coord AS $fn$
BEGIN
 IF authz.runtime_role()<>'hub2_v8' OR NOT EXISTS(
  SELECT FROM v8.handoff_reply_binding(hid) h
  WHERE h.project_id=pid AND actor IN(h.from_actor_id,h.to_actor_id)) THEN
  RAISE EXCEPTION 'handoff_writer_scope_required' USING ERRCODE='42501';END IF;
 RETURN coord.current_writer('v8',pid);
END $fn$;
REVOKE ALL ON FUNCTION coord.handoff_reply_writer(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION coord.handoff_reply_writer(uuid,uuid,uuid) TO hub2_v8_owner;
RESET ROLE;
