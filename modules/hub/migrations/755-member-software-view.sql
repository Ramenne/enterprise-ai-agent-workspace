-- Current genuine browser member metadata only. No issued token or new authority.
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.member_software_view(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;actor uuid;cid uuid;pr record;projects jsonb:='[]';clients jsonb;deadline timestamptz;
BEGIN
 IF authz.runtime_role() IS DISTINCT FROM 'hub2_hufu' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(p_hash);actor:=(i->>'actor_id')::uuid;cid:=(i->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=actor FOR SHARE;PERFORM id FROM authz.clients WHERE id=cid FOR SHARE;
 i:=authz.authenticate(p_hash);
 IF (i->>'is_primary')::boolean IS DISTINCT FROM true OR i->>'authority_source' IS DISTINCT FROM 'authn_session' OR NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND active AND kind='member') THEN RAISE EXCEPTION 'current_primary_member_session_required' USING ERRCODE='42501';END IF;
 FOR pr IN SELECT id,title,kind,visibility FROM v8.projects WHERE state='active' ORDER BY created_at DESC,id LOOP
  IF NOT authz.client_resource_allowed745(cid,pr.id) THEN CONTINUE;END IF;
  BEGIN deadline:=authz.resource_deadline(actor,cid,pr.id,'v8.project.read',jsonb_build_object('project_id',pr.id));EXCEPTION WHEN insufficient_privilege THEN deadline:=NULL;END;
  IF deadline IS NOT NULL THEN projects:=projects||jsonb_build_array(jsonb_build_object('project_id',pr.id,'title',pr.title,'kind',pr.kind,'visibility',pr.visibility));END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(jsonb_build_object('client_id',cl.id,'label',cl.label,'actions',cl.actions,'active',cl.active,'credentials',coalesce((SELECT jsonb_agg(jsonb_build_object('credential_id',c.id,'until_revoked',c.until_revoked,'expires_at',c.expires_at,'revoked',c.revoked_at IS NOT NULL,'authority_source',c.authority_source)ORDER BY c.id)FROM authz.credentials c WHERE c.client_id=cl.id AND NOT c.is_primary),'[]'),'scope_filters',coalesce(f.clauses,'[]'))ORDER BY cl.id),'[]') INTO clients
 FROM authz.clients cl LEFT JOIN authz.client_filters745 f ON f.client_id=cl.id WHERE cl.principal_id=actor AND EXISTS(SELECT FROM authz.credentials c WHERE c.client_id=cl.id AND NOT c.is_primary AND c.authority_source IN('member_issued_api','delegated_api')) AND NOT(cl.actions&&ARRAY['hufu.credential.manage','hufu.qualification.manage','hufu.management.delegate','hufu.vault.decide']);
 i:=authz.authenticate(p_hash);
 RETURN jsonb_build_object('state','current_member_software','actor_id',actor,'authority_source',i->>'authority_source','current_primary',true,'projects',projects,'clients',clients,'mcp_url','https://hufu.example.invalid/mcp','issued_tokens_returned',false);
END $$;
REVOKE ALL ON FUNCTION authz.member_software_view(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.member_software_view(text) TO hub2_hufu;
RESET ROLE;
