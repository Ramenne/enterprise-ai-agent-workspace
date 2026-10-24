-- Opt-in legacy restricted archive publication only. Ordinary Mem uploads are unchanged.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.lock_archive_project_scope(hid uuid,expected_revision bigint,expected_owner uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;pr v8.projects;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF session_user<>'hub2_mem' OR h.id IS NULL OR h.audience<>'mem' OR h.action<>'mem.upload' OR h.consumed_at IS NOT NULL OR expected_revision IS NULL OR expected_revision<1 OR expected_owner IS NULL THEN RAISE EXCEPTION 'invalid_archive_scope_guard' USING ERRCODE='42501';END IF;
 -- Same common authority ordering as consume_handle; then hold the current project scope through publication.
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,jsonb_build_array(jsonb_build_object('project_id',h.project_id)));
 SELECT * INTO pr FROM v8.projects WHERE id=h.project_id FOR SHARE;
 IF pr.id IS NULL OR pr.revision IS DISTINCT FROM expected_revision OR pr.owner_id IS DISTINCT FROM expected_owner OR pr.visibility<>'personal' THEN RAISE EXCEPTION 'archive_scope_changed' USING ERRCODE='40001';END IF;
END $$;
REVOKE ALL ON FUNCTION authz.lock_archive_project_scope(uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.lock_archive_project_scope(uuid,bigint,uuid) TO hub2_mem_owner;
RESET ROLE;
SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.claim_archive_upload(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;
 PERFORM authz.lock_archive_project_scope(h,(b->>'expected_project_revision')::bigint,(b->>'expected_owner_id')::uuid);
 -- This delegate is the sole consumer of the handle. No duplicated consume/actor truth.
 RETURN mem.claim_upload(h,d,payload);
END $$;
CREATE FUNCTION mem.publish_archive_upload(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;
 PERFORM authz.lock_archive_project_scope(h,(b->>'expected_project_revision')::bigint,(b->>'expected_owner_id')::uuid);
 -- Real object verification and original operation/lease/content CAS remain authoritative.
 RETURN mem.publish_upload(h,d,payload);
END $$;
REVOKE ALL ON FUNCTION mem.claim_archive_upload(uuid,text,text),mem.publish_archive_upload(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.claim_archive_upload(uuid,text,text),mem.publish_archive_upload(uuid,text,text) TO hub2_mem;
RESET ROLE;
