ALTER FUNCTION authz.client_identity_lookup(text,uuid) OWNER TO hub2_authz_owner;
-- v5.1: ordinary member clients share member authority; explicitly restricted
-- delegated/controller/service credentials retain their technical boundaries.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.ordinary_member_client901(cid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
 SELECT EXISTS(SELECT FROM authz.clients c JOIN authz.principals p ON p.id=c.principal_id
 WHERE c.id=cid AND c.active AND p.active AND p.kind='member'
 AND EXISTS(SELECT FROM authz.credentials k WHERE k.client_id=c.id AND k.revoked_at IS NULL
   AND (k.until_revoked OR k.expires_at>clock_timestamp()) AND authz.family_valid(k.id)
   AND k.authority_source IN('authn_session','member_issued_api','legacy_hufu_verified','operator_verified_mcp_whoami','operator_verified_mcp_whoami_management83'))
 AND NOT EXISTS(SELECT FROM authz.credentials k WHERE k.client_id=c.id AND k.revoked_at IS NULL
   AND (k.until_revoked OR k.expires_at>clock_timestamp()) AND k.authority_source IN('delegated_api','organization_owner_approved_controlled_project_software','operator_current_owned_GC_fixture')))
$$;
REVOKE ALL ON FUNCTION authz.ordinary_member_client901(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.ordinary_member_client901(uuid) TO hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE OR REPLACE FUNCTION authz.authenticate(p_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE c authz.credentials; cl authz.clients; p authz.principals; base text[]; ordinary boolean; filters jsonb;
BEGIN
 base:=ARRAY['v8.project.create','v8.project.read','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.context.read','v8.handoff.read','v8.experience.read'];
 SELECT * INTO c FROM authz.credentials WHERE token_hash=p_hash;
 SELECT * INTO cl FROM authz.clients WHERE id=c.client_id;
 SELECT * INTO p FROM authz.principals WHERE id=cl.principal_id;
 IF p_hash IS NULL OR p.id IS NULL OR cl.id IS NULL OR c.id IS NULL OR p.active IS DISTINCT FROM true OR cl.active IS DISTINCT FROM true OR c.revoked_at IS NOT NULL OR authz.family_valid(c.id) IS DISTINCT FROM true OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp()) THEN
  RAISE EXCEPTION 'unauthenticated' USING ERRCODE='42501';
 END IF;
 ordinary:=authz.ordinary_member_client901(cl.id);
 SELECT coalesce(f.clauses,'[]'::jsonb) INTO filters FROM authz.client_filters745 f WHERE f.client_id=cl.id;
 RETURN jsonb_build_object(
  'principal_kind',p.kind,'member_role',p.role,
  'authorization_mode',CASE WHEN ordinary THEN 'member_qualification' ELSE 'restricted_credential' END,
  'scope_filters',coalesce(filters,'[]'::jsonb),
  'scope_filter_semantics',CASE WHEN ordinary THEN 'informational_legacy_metadata' ELSE 'technical_restriction' END,
  'actor_id',p.id,
  'client_id',cl.id,
  'credential_id',c.id,
  'organization_id',p.organization_id,
  'member_label',p.display_name,
  'client_label',cl.label,
  'client_actions',ARRAY(SELECT DISTINCT x FROM unnest(cl.actions||CASE WHEN ordinary THEN base ELSE ARRAY[]::text[] END) AS x ORDER BY x),
  'expires_at',c.expires_at,
  'until_revoked',c.until_revoked,
  'is_primary',c.is_primary,
  'credential_type',CASE WHEN c.is_primary THEN 'primary_member' WHEN c.parent_credential_id IS NOT NULL THEN 'delegated_api' WHEN c.authority_source='member_issued_api' THEN 'member_api' ELSE 'unclassified' END,
  'authority_source',c.authority_source,
  'parent_credential_id',c.parent_credential_id,
  'authorization_note',CASE WHEN ordinary THEN 'member_connection_includes_base_project_and_work_actions;project_qualification_and_special_resources_still_apply' ELSE 'restricted_credential_actions_and_scope_remain_required' END
 );
END $function$;
CREATE OR REPLACE FUNCTION authz.require_client_capability(identity jsonb, capability text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.clients; p authz.principals;
BEGIN
 SELECT * INTO c FROM authz.clients WHERE id=(identity->>'client_id')::uuid;
 SELECT * INTO p FROM authz.principals WHERE id=c.principal_id;
 IF identity IS NULL OR c.id IS NULL OR c.principal_id IS DISTINCT FROM (identity->>'actor_id')::uuid OR NOT c.active OR NOT p.active THEN
 RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 IF NOT authz.ordinary_member_client901(c.id) AND (capability=ANY(c.actions)) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'restricted_credential_capability_required' USING ERRCODE='42501'; END IF;
END $$;
CREATE OR REPLACE FUNCTION authz.client_resource_allowed745(cid uuid,pid uuid,eid uuid DEFAULT NULL,ename text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE clause jsonb; filters jsonb;
BEGIN
 IF NOT EXISTS(SELECT FROM authz.clients c JOIN authz.principals p ON p.id=c.principal_id WHERE c.id=cid AND c.active AND p.active) THEN RETURN false; END IF;
 IF authz.ordinary_member_client901(cid) THEN RETURN true; END IF;
 SELECT clauses INTO filters FROM authz.client_filters745 WHERE client_id=cid;
 FOR clause IN SELECT value FROM jsonb_array_elements(coalesce(filters,'[]'::jsonb)) LOOP
  IF clause ? 'project_ids' AND NOT coalesce(clause->'project_ids' ? pid::text,false) THEN RETURN false; END IF;
  IF clause ? 'allowed_entries' AND (eid IS NOT NULL OR ename IS NOT NULL) AND NOT(coalesce(clause->'allowed_entries' ? eid::text,false) OR coalesce(clause->'allowed_entries' ? ename,false)) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION authz.check_access(p_actor uuid, p_client uuid, p_project uuid, p_action text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE p authz.principals; pr record; allowed boolean;
BEGIN
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p_action NOT IN ('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501'; END IF;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active) THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 PERFORM authz.require_client_capability(jsonb_build_object('actor_id',p_actor,'client_id',p_client),p_action);
 IF NOT authz.client_resource_allowed745(p_client,p_project) THEN RAISE EXCEPTION 'restricted_credential_scope_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN IF p_action='v8.project.create' THEN RETURN NULL; END IF; RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501'; END IF;
 IF pr.state<>'active' THEN RAISE EXCEPTION 'project_closed' USING ERRCODE='42501'; END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor AND pr.organization_id=p.organization_id THEN RETURN pr.revision; END IF;
 IF p_action IN ('v8.project.convert','v8.project.update') AND pr.manager_id=p_actor THEN RETURN pr.revision; END IF;
 IF pr.owner_id=p_actor AND (pr.visibility='personal' OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read')) THEN RETURN pr.revision; END IF;
 IF p_action IN ('mem.read','mem.discover','mem.read_history','v8.read','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND pr.visibility='team' AND pr.organization_id=p.organization_id THEN RETURN pr.revision; END IF;
 SELECT EXISTS(SELECT FROM authz.qualifications q JOIN authz.principals issuer ON issuer.id=q.source_actor_id WHERE q.principal_id=p_actor AND q.project_id=p_project AND q.kind='work' AND q.active AND issuer.active AND (q.until_revoked OR q.expires_at>clock_timestamp()) AND p_action=ANY(q.actions) AND ((q.parent_id IS NULL AND (q.source_basis='independent_work' OR q.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND q.source_actor_id=pr.owner_id) OR (issuer.role='organization_admin' AND issuer.organization_id=pr.organization_id))) OR EXISTS(SELECT FROM authz.qualifications parent JOIN authz.principals pi ON pi.id=parent.source_actor_id WHERE parent.id=q.parent_id AND parent.active AND parent.kind='management' AND parent.depth<=1 AND pi.active AND (parent.until_revoked OR parent.expires_at>clock_timestamp()) AND ((parent.depth=0 AND (parent.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND parent.source_actor_id=pr.owner_id))) OR EXISTS(SELECT FROM authz.qualifications root WHERE root.id=parent.parent_id AND root.active AND root.kind='management' AND root.depth=0 AND (root.source_actor_id=pr.manager_id OR (pr.visibility='personal' AND root.source_actor_id=pr.owner_id)) AND (root.until_revoked OR root.expires_at>clock_timestamp()) AND parent.actions<@root.actions)) AND q.actions<@parent.actions))) INTO allowed;
 IF NOT allowed THEN RAISE EXCEPTION 'member_qualification_required' USING ERRCODE='42501'; END IF;
 RETURN pr.revision;
END $function$;
CREATE OR REPLACE FUNCTION authz.resource_deadline(p_actor uuid, p_client uuid, p_project uuid, p_action text, r jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE p authz.principals; pr record; deadline timestamptz; q record;
BEGIN
 IF p_action NOT IN('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501'; END IF;
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL OR p_action IS NULL OR r IS NULL THEN RAISE EXCEPTION 'invalid_authority_input' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active) THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 PERFORM authz.require_client_capability(jsonb_build_object('actor_id',p_actor,'client_id',p_client),p_action);
 IF NOT authz.client_resource_allowed745(p_client,p_project) THEN RAISE EXCEPTION 'restricted_credential_scope_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN
  IF p_action='v8.project.create' AND (r->>'project_id')::uuid=p_project AND (r->>'organization_id')::uuid=p.organization_id AND (r->>'owner_id')::uuid=p_actor THEN RETURN 'infinity'; END IF;
  RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501';
 END IF;
 IF pr.state<>'active' OR pr.kind NOT IN('project','dialogue') OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',p_project,r) THEN RAISE EXCEPTION 'invalid_project_resource' USING ERRCODE='42501'; END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor THEN RETURN 'infinity'; END IF;
 IF p_action IN('v8.project.convert','v8.project.update') AND pr.manager_id=p_actor THEN RETURN 'infinity'; END IF;
 IF (pr.visibility='personal' AND pr.owner_id=p_actor) OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND (pr.owner_id=p_actor OR pr.visibility='team') THEN RETURN 'infinity'; END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project AND kind='work' ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,p_actor,p_project,p_action,r); IF deadline IS NOT NULL THEN RETURN deadline; END IF;
 END LOOP;
 RAISE EXCEPTION 'member_qualification_required' USING ERRCODE='42501';
END $function$;
CREATE OR REPLACE FUNCTION authz.client_identity_lookup(p_hash text, p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE ident jsonb; rec record; cred record;
BEGIN
 ident:=authz.authenticate(p_hash);
 IF NOT EXISTS(SELECT FROM authz.principals WHERE id=(ident->>'actor_id')::uuid AND active AND kind='member' AND role='organization_admin') THEN
  RAISE EXCEPTION 'client_lookup_management_required' USING ERRCODE='42501';
 END IF;
 SELECT c.id,c.label,c.principal_id,c.active,c.epoch,c.created_at,p.display_name INTO rec
 FROM authz.clients c JOIN authz.principals p ON p.id=c.principal_id WHERE c.id=p_client_id AND p.organization_id=(ident->>'organization_id')::uuid;
 IF rec.id IS NULL THEN RETURN jsonb_build_object('state','not_found','error_code','client_not_found','client_id',p_client_id,'next_step','check_client_id_or_current_member_connections','retryable',false); END IF;
 SELECT id,expires_at,until_revoked,revoked_at,is_primary,authority_source INTO cred FROM authz.credentials WHERE client_id=rec.id ORDER BY (revoked_at IS NULL) DESC,(until_revoked OR expires_at>clock_timestamp()) DESC,expires_at DESC NULLS FIRST,epoch DESC,id DESC LIMIT 1;
 RETURN jsonb_build_object('state','found','credential_selection','effective_representative_not_creation_order','owner',jsonb_build_object('display_name',rec.display_name,'actor_id',rec.principal_id),'client',jsonb_build_object('id',rec.id,'label',rec.label,'active',rec.active,'epoch',rec.epoch,'created_at',rec.created_at),'credential',coalesce(jsonb_build_object('id',cred.id,'expires_at',cred.expires_at,'until_revoked',cred.until_revoked,'revoked_at',cred.revoked_at,'is_primary',cred.is_primary,'authority_source',cred.authority_source),'{}'::jsonb));
END $function$;
CREATE OR REPLACE FUNCTION authz.engineering_grant_existing(proof text, p_project uuid, p_principal uuid, p_until timestamp with time zone, p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
 END IF;
 i:=authz.authenticate(proof);
 PERFORM authz.engineering_management_proof(proof,p_project);
 IF NOT EXISTS(SELECT FROM v8.projects p JOIN authz.principals a ON a.id=(i->>'actor_id')::uuid
   WHERE p.id=p_project AND (p.manager_id=a.id OR (a.role='organization_admin' AND p.organization_id=a.organization_id)))
   AND NOT EXISTS(SELECT FROM authz.qualifications q WHERE q.project_id=p_project AND q.principal_id=(i->>'actor_id')::uuid
     AND q.kind='management' AND authz.management_valid(q.id,q.principal_id,p_project)) THEN
  RAISE EXCEPTION 'management_required' USING ERRCODE='42501';
 END IF;
 RETURN authz.engineering_grant(proof,p_project,p_principal,p_until,p_key);
END $function$;
ALTER FUNCTION authz.authenticate(text) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.authenticate(text) FROM PUBLIC;
ALTER FUNCTION authz.require_client_capability(jsonb,text) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.require_client_capability(jsonb,text) FROM PUBLIC;
ALTER FUNCTION authz.check_access(uuid,uuid,uuid,text) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.check_access(uuid,uuid,uuid,text) FROM PUBLIC;
ALTER FUNCTION authz.resource_deadline(uuid,uuid,uuid,text,jsonb) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.resource_deadline(uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
ALTER FUNCTION authz.client_resource_allowed745(uuid,uuid,uuid,text) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.client_resource_allowed745(uuid,uuid,uuid,text) FROM PUBLIC;
ALTER FUNCTION authz.client_identity_lookup(text,uuid) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.client_identity_lookup(text,uuid) FROM PUBLIC;
ALTER FUNCTION authz.engineering_grant_existing(text,uuid,uuid,timestamptz,text) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.engineering_grant_existing(text,uuid,uuid,timestamptz,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.client_identity_lookup(text,uuid) TO hub2_hufu;
RESET ROLE;
