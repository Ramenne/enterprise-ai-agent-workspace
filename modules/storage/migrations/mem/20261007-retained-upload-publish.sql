CREATE OR REPLACE FUNCTION mem.retained_upload_candidate(h uuid,d text,p text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;o mem.operations;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;c:=mem.guard(h,'mem.upload',d,b);
 IF (b->>'project_id')::uuid IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_mismatch' USING ERRCODE='42501';END IF;
 SELECT * INTO o FROM mem.operations WHERE id=(b->>'operation_id')::uuid AND project_id=(c->>'project_id')::uuid AND actor_id=(c->>'actor_id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM authz.assert_effect(h);
 IF o.state='verified' AND o.object_id IS NOT NULL AND o.lease_until>clock_timestamp() THEN
  RETURN jsonb_build_object('ready',true,'attempt',o.attempt,'fencing_token',o.fencing_token,'lease_until',o.lease_until,'retained_state','same_verified_bytes');
 END IF;
 RETURN jsonb_build_object('ready',false,'state',o.state,'retained_state','normal_publication_path');
END $$;
REVOKE ALL ON FUNCTION mem.retained_upload_candidate(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.retained_upload_candidate(uuid,text,text) TO hub2_mem;
