SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.board_identity(proof text, write_mode boolean DEFAULT false, manager_mode boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;p authz.principals;cl authz.clients;BEGIN
 IF authz.runtime_role()<>'hub2_v8' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);
 PERFORM id FROM authz.security_state FOR SHARE;
 SELECT * INTO p FROM authz.principals WHERE id=(i->>'actor_id')::uuid FOR SHARE;
 SELECT * INTO cl FROM authz.clients WHERE id=(i->>'client_id')::uuid FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=(i->>'credential_id')::uuid FOR SHARE;
 i:=authz.authenticate(proof);
 IF p.kind<>'member' OR coalesce(i->'scope_filters','[]'::jsonb)<>'[]'::jsonb THEN RAISE EXCEPTION 'unrestricted_member_credential_required' USING ERRCODE='42501';END IF;
 IF NOT (coalesce(i->'client_actions',to_jsonb(cl.actions)) ? (CASE WHEN write_mode THEN 'v8.work.commit' ELSE 'v8.work.read' END)) THEN RAISE EXCEPTION 'software_action_forbidden' USING ERRCODE='42501';END IF;
 IF manager_mode AND (p.role<>'organization_admin' OR NOT coalesce(i->'client_actions',to_jsonb(cl.actions)) ? 'hufu.qualification.manage') THEN RAISE EXCEPTION 'supervisor_required' USING ERRCODE='42501';END IF;
 RETURN i||jsonb_build_object('role',p.role,'kind',p.kind);
END $$;
REVOKE ALL ON FUNCTION authz.board_identity(text,boolean,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.board_identity(text,boolean,boolean) TO hub2_v8_owner;
CREATE OR REPLACE FUNCTION authz.board_member(org uuid,member uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE p authz.principals;BEGIN
 IF authz.runtime_role()<>'hub2_v8' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM authz.principals WHERE id=member AND organization_id=org AND active AND kind='member' FOR SHARE;
 IF p.id IS NULL THEN RAISE EXCEPTION 'member_not_found' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('member_id',p.id,'name',p.display_name);
END $$;
REVOKE ALL ON FUNCTION authz.board_member(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.board_member(uuid,uuid) TO hub2_v8_owner;
RESET ROLE;
