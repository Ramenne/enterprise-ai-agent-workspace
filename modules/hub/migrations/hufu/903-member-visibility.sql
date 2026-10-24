-- v5.1: visibility helpers must not reintroduce client business ceilings.
SET ROLE hub2_authz_owner;
CREATE OR REPLACE FUNCTION authz.can_read(p_actor uuid, p_project uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE cid uuid;act text;
BEGIN
 IF p_actor IS NULL OR p_project IS NULL THEN RETURN false;END IF;
 PERFORM id FROM authz.security_state FOR SHARE;PERFORM id FROM authz.principals WHERE id=p_actor FOR SHARE;PERFORM id FROM v8.projects WHERE id=p_project FOR SHARE;PERFORM id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project ORDER BY id FOR SHARE;
 FOR cid,act IN SELECT c.id,allowed.action FROM authz.clients c CROSS JOIN (VALUES('mem.read'),('v8.project.read')) allowed(action) WHERE c.principal_id=p_actor AND c.active AND (authz.ordinary_member_client901(c.id) OR allowed.action=ANY(c.actions)) ORDER BY c.id LOOP
  BEGIN PERFORM authz.resource_deadline(p_actor,cid,p_project,act,jsonb_build_object('project_id',p_project));RETURN true;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;RETURN false;
END $function$;
CREATE OR REPLACE FUNCTION authz.can_read_resource(actor uuid, project uuid, r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE cid uuid;
BEGIN
 IF actor IS NULL OR project IS NULL OR r IS NULL THEN RETURN false;END IF;
 FOR cid IN SELECT id FROM authz.clients WHERE principal_id=actor AND active AND (authz.ordinary_member_client901(id) OR 'mem.read'=ANY(actions)) ORDER BY id LOOP
  BEGIN PERFORM authz.resource_deadline(actor,cid,project,'mem.read',r);RETURN true;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 END LOOP;RETURN false;
END $function$;
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
RESET ROLE;
