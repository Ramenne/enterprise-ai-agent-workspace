SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.legacy_personal_inventory_scope(proof text,target_project uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;subject text;
BEGIN
 IF authz.runtime_role()<>'hub2_mem' THEN RAISE EXCEPTION 'legacy_personal_runtime_required' USING ERRCODE='42501'; END IF;
 i:=authz.authenticate(proof);
 IF NOT (i->'client_actions' ? 'mem.read') THEN RAISE EXCEPTION 'software_mem_read_required' USING ERRCODE='42501'; END IF;
 SELECT legacy_subject INTO subject FROM authz.member_profiles WHERE principal_id=(i->>'actor_id')::uuid;
 IF subject IS NULL OR length(subject)=0 THEN RAISE EXCEPTION 'verified_legacy_identity_missing' USING ERRCODE='42501'; END IF;
 IF target_project IS NOT NULL AND NOT EXISTS(SELECT FROM v8.projects WHERE id=target_project AND owner_id=(i->>'actor_id')::uuid AND visibility='personal' AND state='active') THEN
  RAISE EXCEPTION 'own_personal_project_required' USING ERRCODE='42501';
 END IF;
 IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,target_project,NULL,NULL) THEN
  RAISE EXCEPTION 'software_personal_project_required' USING ERRCODE='42501';
 END IF;
 RETURN jsonb_build_object('actor_id',i->>'actor_id','client_id',i->>'client_id','legacy_subject',subject,'project_id',target_project,'scope','current_actor_owned_legacy_personal_metadata','new_grant',false);
END $$;
REVOKE ALL ON FUNCTION authz.legacy_personal_inventory_scope(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.legacy_personal_inventory_scope(text,uuid) TO hub2_mem;
RESET ROLE;
