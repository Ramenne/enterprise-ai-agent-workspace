SET ROLE hub2_authz_owner;
-- A service credential's action ceiling is intersected with its live declared grants.
-- No member default actions or full-foundation actions are added implicitly.
CREATE OR REPLACE FUNCTION authz.service_client_actions(cid uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $f$
 SELECT ARRAY(SELECT DISTINCT a.action FROM authz.service_clients sc
 JOIN authz.clients c ON c.id=sc.client_id AND c.principal_id=sc.service_id AND c.active
 JOIN authz.principals p ON p.id=sc.service_id AND p.kind='service' AND p.active
 JOIN authz.service_authorizations g ON g.service_id=sc.service_id AND g.active AND (g.until_revoked OR g.expires_at>clock_timestamp())
 JOIN v8.projects pr ON pr.id=g.project_id AND pr.state='active' AND pr.organization_id=p.organization_id
 JOIN authz.principals issuer ON issuer.id=g.source_actor_id AND issuer.active AND issuer.organization_id=p.organization_id
 CROSS JOIN LATERAL unnest(authz.service_actions(g.capabilities)) a(action)
 WHERE sc.client_id=cid AND a.action=ANY(c.actions) AND (g.project_id=ANY(sc.project_ids) OR g.application_project_id=ANY(sc.project_ids))
 AND (g.application_project_id IS NULL OR EXISTS(SELECT FROM authz.service_authorizations base JOIN v8.projects app ON app.id=base.project_id AND app.state='active' AND app.organization_id=p.organization_id JOIN authz.principals bi ON bi.id=base.source_actor_id AND bi.active AND bi.organization_id=p.organization_id WHERE base.service_id=sc.service_id AND base.project_id=g.application_project_id AND base.application_project_id IS NULL AND base.active AND (base.until_revoked OR base.expires_at>clock_timestamp()) AND a.action=ANY(authz.service_actions(base.capabilities))))
 ORDER BY a.action)
$f$;
REVOKE ALL ON FUNCTION authz.service_client_actions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.service_client_actions(uuid) TO hub2_hufu,hub2_mem,hub2_v8,hub2_worker,hub2_v8_owner;

CREATE OR REPLACE FUNCTION authz.authenticate(p_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE c authz.credentials; cl authz.clients; p authz.principals; base text[]; ordinary boolean; filters jsonb;
BEGIN
 base:=ARRAY['mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read'];
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
  'authorization_mode',CASE WHEN authz.product_service_client(cl.id) THEN 'product_service' WHEN ordinary THEN 'member_qualification' ELSE 'restricted_credential' END,
  'scope_filters',coalesce(filters,'[]'::jsonb),
  'scope_filter_semantics',CASE WHEN ordinary THEN 'informational_legacy_metadata' ELSE 'technical_restriction' END,
  'actor_id',p.id,
  'client_id',cl.id,
  'credential_id',c.id,
  'organization_id',p.organization_id,
  'member_label',p.display_name,
  'client_label',cl.label,
  'client_actions',ARRAY(SELECT DISTINCT x FROM unnest(CASE WHEN authz.product_service_client(cl.id) THEN authz.service_client_actions(cl.id) ELSE cl.actions||CASE WHEN ordinary THEN base ELSE ARRAY[]::text[] END END) AS x ORDER BY x),
  'expires_at',c.expires_at,
  'until_revoked',c.until_revoked,
  'is_primary',c.is_primary,
  'credential_type',CASE WHEN c.is_primary THEN 'primary_member' WHEN c.parent_credential_id IS NOT NULL THEN 'delegated_api' WHEN c.authority_source='member_issued_api' THEN 'member_api' ELSE 'unclassified' END,
  'authority_source',c.authority_source,'service_class',CASE WHEN authz.product_service_client(cl.id) THEN 'product' ELSE NULL END,'agent_work_required',NOT authz.product_service_client(cl.id),
  'parent_credential_id',c.parent_credential_id,
  'authorization_note',CASE WHEN authz.product_service_client(cl.id) THEN 'declared_service_actions_intersect_current_authorized_capabilities;resource_scope_rechecked_on_use' WHEN ordinary THEN 'member_connection_includes_base_project_and_work_actions;project_qualification_and_special_resources_still_apply' ELSE 'restricted_credential_actions_and_scope_remain_required' END
 );
END $function$;

CREATE OR REPLACE FUNCTION authz.require_client_capability(identity jsonb, capability text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE c authz.clients; p authz.principals;
BEGIN
 SELECT * INTO c FROM authz.clients WHERE id=(identity->>'client_id')::uuid;
 SELECT * INTO p FROM authz.principals WHERE id=c.principal_id;
 IF identity IS NULL OR c.id IS NULL OR c.principal_id IS DISTINCT FROM (identity->>'actor_id')::uuid OR NOT c.active OR NOT p.active THEN
 RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 IF authz.product_service_client(c.id) THEN
  IF (capability=ANY(authz.service_client_actions(c.id))) IS DISTINCT FROM true THEN RAISE EXCEPTION 'service_capability_required' USING ERRCODE='42501';END IF;
  RETURN;
 END IF;
 IF NOT authz.ordinary_member_client901(c.id) AND (capability=ANY(c.actions)) IS DISTINCT FROM true THEN
 RAISE EXCEPTION 'restricted_credential_capability_required' USING ERRCODE='42501'; END IF;
END $function$;

CREATE OR REPLACE FUNCTION authz.service_deadline(actor uuid, client uuid, project uuid, action text, resource jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE g authz.service_authorizations;p authz.principals;pr record;issuer authz.principals;deadline timestamptz;base authz.service_authorizations;app record;base_issuer authz.principals;
BEGIN
 SELECT * INTO p FROM authz.principals WHERE id=actor;
 SELECT * INTO g FROM authz.service_authorizations WHERE service_id=actor AND project_id=project;
 SELECT * INTO pr FROM v8.projects WHERE id=project;
 SELECT * INTO issuer FROM authz.principals WHERE id=g.source_actor_id;
 IF client IS NOT NULL AND NOT EXISTS(SELECT FROM authz.service_clients sc JOIN authz.clients c ON c.id=sc.client_id WHERE sc.client_id=client AND sc.service_id=actor AND c.principal_id=actor AND c.active AND (project=ANY(sc.project_ids) OR g.application_project_id=ANY(sc.project_ids))) THEN RETURN NULL;END IF;
 IF client IS NOT NULL AND NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=client AND c.principal_id=actor AND c.active AND action=ANY(c.actions)) THEN RETURN NULL;END IF;
 IF g.application_project_id IS NOT NULL THEN
  SELECT * INTO base FROM authz.service_authorizations WHERE service_id=actor AND project_id=g.application_project_id;
  SELECT * INTO app FROM v8.projects WHERE id=g.application_project_id;
  SELECT * INTO base_issuer FROM authz.principals WHERE id=base.source_actor_id;
  IF pr.owner_id IS DISTINCT FROM g.data_owner_id OR NOT EXISTS(SELECT FROM authz.principals WHERE id=g.data_owner_id AND active AND organization_id=pr.organization_id) OR base.id IS NULL OR NOT base.active OR base.application_project_id IS NOT NULL OR NOT(base.until_revoked OR base.expires_at>clock_timestamp()) OR app.state IS DISTINCT FROM 'active' OR app.organization_id IS DISTINCT FROM pr.organization_id OR base_issuer.active IS DISTINCT FROM true OR base_issuer.organization_id IS DISTINCT FROM pr.organization_id OR (action=ANY(authz.service_actions(base.capabilities))) IS DISTINCT FROM true THEN RETURN NULL;END IF;
 END IF;
 IF p.kind IS DISTINCT FROM 'service' OR NOT p.active OR g.id IS NULL OR NOT g.active OR pr.id IS NULL OR pr.state<>'active' OR pr.organization_id<>p.organization_id OR issuer.active IS DISTINCT FROM true OR issuer.organization_id<>p.organization_id OR (action=ANY(authz.service_actions(g.capabilities))) IS DISTINCT FROM true OR NOT authz.selector_matches(g.resource_selector,project,resource) THEN RETURN NULL;END IF;
 deadline:=CASE WHEN g.until_revoked THEN 'infinity'::timestamptz ELSE g.expires_at END;
 IF deadline<=clock_timestamp() THEN RETURN NULL;END IF;
 IF g.application_project_id IS NULL AND pr.visibility='private' AND pr.owner_id<>actor THEN deadline:=least(deadline,authz.project_privacy_read_deadline(actor,project));IF authz.project_privacy_read_deadline(actor,project) IS NULL THEN RETURN NULL;END IF;END IF;
 IF g.application_project_id IS NOT NULL THEN deadline:=least(deadline,CASE WHEN base.until_revoked THEN 'infinity'::timestamptz ELSE base.expires_at END);END IF;
 RETURN deadline;
END $function$;

RESET ROLE;
