BEGIN;
ALTER TABLE authz.database_permissions ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
ALTER TABLE authz.database_permissions ADD COLUMN IF NOT EXISTS lifecycle_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE authz.database_permissions ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE authz.database_permissions ADD COLUMN IF NOT EXISTS suspension_changed_by uuid;

-- Fixed physical role helper retains the original PostgreSQL role administrator.
-- Only the authorization owner may invoke it, never a member or Hufu public role.
CREATE OR REPLACE FUNCTION authz.database_role_suspension(p_permission uuid,want_frozen boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE v_g authz.database_permissions;v_role oid;v_o jsonb;v_member record;v_priv text;v_seq text;v_rel regclass;
BEGIN
 SELECT * INTO v_g FROM authz.database_permissions WHERE id=p_permission FOR UPDATE;
 IF v_g.id IS NULL OR v_g.role_name !~ '^hubdb_[0-9a-f]{32}$' OR EXISTS(SELECT FROM jsonb_array_elements(v_g.objects) x WHERE x->>'backend'='sqlite') THEN RAISE EXCEPTION 'physical_database_role_required' USING ERRCODE='42501';END IF;
 SELECT oid INTO v_role FROM pg_roles WHERE rolname=v_g.role_name AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcanlogin;
 IF v_role IS NULL THEN RAISE EXCEPTION 'original_database_role_missing' USING ERRCODE='40001';END IF;
 IF want_frozen THEN
  FOR v_member IN SELECT member,grantor FROM pg_auth_members WHERE roleid=v_role LOOP
   EXECUTE format('REVOKE %I FROM %I GRANTED BY %I CASCADE',v_g.role_name,pg_get_userbyid(v_member.member),pg_get_userbyid(v_member.grantor));
  END LOOP;
 END IF;
 FOR v_o IN SELECT value FROM jsonb_array_elements(v_g.objects) LOOP
  IF want_frozen THEN
   -- Revoke the original OID even if renamed; never touch a replacement table.
   v_rel:=(v_o->>'relation_oid')::oid::regclass;
   IF EXISTS(SELECT FROM pg_class WHERE oid=v_rel) THEN
    EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',v_rel,v_g.role_name);
    FOR v_seq IN SELECT pg_get_serial_sequence(format('%I.%I',n.nspname,c.relname),a.attname) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE a.attrelid=v_rel AND a.attnum>0 AND NOT a.attisdropped LOOP
     IF v_seq IS NOT NULL THEN EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %I',v_seq,v_g.role_name);END IF;
    END LOOP;
   END IF;
   IF EXISTS(SELECT FROM pg_namespace WHERE nspname=v_o->>'schema') THEN EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I',v_o->>'schema',v_g.role_name);END IF;
  ELSE
   IF to_regclass(format('%I.%I',v_o->>'schema',v_o->>'table'))::oid IS DISTINCT FROM (v_o->>'relation_oid')::oid THEN RAISE EXCEPTION 'database_object_replaced' USING ERRCODE='40001';END IF;
   EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',v_o->>'schema',v_g.role_name);
   SELECT string_agg(upper(value),',') INTO v_priv FROM jsonb_array_elements_text(v_o->'actions') WHERE value IN('select','insert','update','delete');
   IF v_priv IS NOT NULL THEN EXECUTE format('GRANT %s ON TABLE %I.%I TO %I',v_priv,v_o->>'schema',v_o->>'table',v_g.role_name);END IF;
   IF v_o->'actions'?'insert' THEN
    FOR v_seq IN SELECT pg_get_serial_sequence(format('%I.%I',v_o->>'schema',v_o->>'table'),a.attname) FROM pg_attribute a WHERE a.attrelid=(v_o->>'relation_oid')::oid AND a.attnum>0 AND NOT a.attisdropped LOOP
     IF v_seq IS NOT NULL THEN EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I',v_seq,v_g.role_name);END IF;
    END LOOP;
   END IF;
  END IF;
 END LOOP;
 IF NOT want_frozen THEN EXECUTE format('GRANT %I TO hub2_hufu',v_g.role_name);END IF;
END $$;
ALTER FUNCTION authz.database_role_suspension(uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION authz.database_role_suspension(uuid,boolean) FROM PUBLIC,hub2_hufu;
GRANT EXECUTE ON FUNCTION authz.database_role_suspension(uuid,boolean) TO hub2_authz_owner;

CREATE OR REPLACE FUNCTION authz.database_grant_change(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE v_i jsonb;v_g authz.database_permissions;v_op text;v_source_valid boolean;v_checked jsonb;
BEGIN
 v_op:=b->>'operation';
 IF v_op IS NULL OR v_op NOT IN('freeze','unfreeze','restore','revoke') THEN RAISE EXCEPTION 'unsupported_database_grant_operation' USING ERRCODE='22023';END IF;
 IF v_op='revoke' THEN RETURN authz.database_revoke(proof,jsonb_build_object('permission_id',b->>'permission_id'));END IF;
 v_i:=authz.authenticate(proof);
 SELECT * INTO v_g FROM authz.database_permissions WHERE id=(b->>'permission_id')::uuid FOR UPDATE;
 IF v_g.id IS NULL OR NOT authz.engineering_can_manage(proof,v_g.project_id) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF NOT v_g.active THEN RAISE EXCEPTION 'revoked_database_grant_cannot_restore' USING ERRCODE='42501';END IF;
 IF v_g.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'expired_database_grant_cannot_restore' USING ERRCODE='42501';END IF;
 PERFORM authz.engineering_management_proof(proof,v_g.project_id);
 IF b?'expected_revision' AND (b->>'expected_revision')::bigint IS DISTINCT FROM v_g.lifecycle_revision THEN RAISE EXCEPTION 'grant_revision_conflict' USING ERRCODE='40001';END IF;
 IF v_op IN('unfreeze','restore') THEN
  SELECT EXISTS(SELECT FROM authz.principals issuer JOIN v8.projects pr ON pr.id=v_g.project_id WHERE issuer.id=v_g.approved_by AND issuer.active AND pr.state='active' AND issuer.organization_id=pr.organization_id AND (issuer.id=pr.manager_id OR issuer.role='organization_admin' OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=issuer.id AND q.project_id=pr.id AND q.kind='management' AND authz.management_valid(q.id,issuer.id,pr.id)))) INTO v_source_valid;
  IF NOT v_source_valid THEN RAISE EXCEPTION 'original_database_approval_source_invalid;cannot_restore' USING ERRCODE='42501';END IF;
  -- Revalidate original table identities/actions; do not expand scope or expiry.
  v_checked:=authz.database_validate(proof,v_g.project_id,v_g.objects);
  IF NOT authz.database_scope_subset(v_checked,v_g.objects) THEN RAISE EXCEPTION 'original_database_scope_changed;cannot_restore' USING ERRCODE='40001';END IF;
 END IF;
 IF v_g.suspended=(v_op='freeze') THEN RETURN jsonb_build_object('state',CASE WHEN v_g.suspended THEN 'frozen' ELSE 'active' END,'permission',to_jsonb(v_g),'replayed',true,'scope_and_expiry_unchanged',true);END IF;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(v_g.objects) x WHERE x->>'backend'='sqlite') THEN PERFORM authz.database_role_suspension(v_g.id,v_op='freeze');END IF;
 UPDATE authz.database_permissions SET suspended=v_op='freeze',lifecycle_revision=lifecycle_revision+1,suspended_at=CASE WHEN v_op='freeze' THEN clock_timestamp() ELSE NULL END,suspension_changed_by=(v_i->>'actor_id')::uuid WHERE id=v_g.id RETURNING * INTO v_g;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((v_i->>'actor_id')::uuid,(v_i->>'client_id')::uuid,'authz','database.grant.'||v_op,v_g.id,jsonb_build_object('suspended',v_g.suspended,'lifecycle_revision',v_g.lifecycle_revision,'expires_at',v_g.expires_at,'scope_and_expiry_unchanged',true));
 RETURN jsonb_build_object('state',CASE WHEN v_g.suspended THEN 'frozen' ELSE 'active' END,'permission',to_jsonb(v_g),'scope_and_expiry_unchanged',true,'effect','new_requests_recheck_suspension;inflight_operation_not_relabelled');
END $$;
ALTER FUNCTION authz.database_grant_change(text,jsonb) OWNER TO hub2_authz_owner;
REVOKE ALL ON FUNCTION authz.database_grant_change(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.database_grant_change(text,jsonb) TO hub2_hufu;

-- Read gates derived from current live functions; owners/ACL preserved.
CREATE OR REPLACE FUNCTION authz.database_access(proof text, b jsonb, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;g authz.database_permissions;o jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF b->>'schema' IN ('authn','authz','vault2') AND p_action<>'inspect' THEN RAISE EXCEPTION 'sensitive_domain_inspect_only' USING ERRCODE='42501';END IF;
 IF p_action NOT IN('inspect','select','insert','update','delete') OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,(b->>'project_id')::uuid) OR NOT (CASE WHEN p_action IN('inspect','select') THEN 'mem.read' ELSE 'mem.write' END)=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions'))) THEN RAISE EXCEPTION 'software_scope_required' USING ERRCODE='42501';END IF;
 SELECT p.* INTO g FROM authz.database_permissions p JOIN authz.principals issuer ON issuer.id=p.approved_by JOIN v8.projects pr ON pr.id=p.project_id WHERE p.actor_id=(i->>'actor_id')::uuid AND p.project_id=(b->>'project_id')::uuid AND p.active AND NOT p.suspended AND p.expires_at>clock_timestamp() AND pr.state='active' AND issuer.active AND issuer.organization_id=pr.organization_id AND (issuer.id=pr.manager_id OR issuer.role='organization_admin' OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=issuer.id AND q.project_id=pr.id AND q.kind='management' AND authz.management_valid(q.id,issuer.id,pr.id))) AND EXISTS(SELECT FROM jsonb_array_elements(p.objects) x WHERE x->>'schema'=b->>'schema' AND x->>'table'=b->>'table' AND (x->'actions' ? p_action OR p_action='inspect')) ORDER BY p.expires_at DESC LIMIT 1 FOR SHARE OF p;
 IF g.id IS NULL THEN RAISE EXCEPTION 'database_permission_required' USING ERRCODE='42501';END IF;
 SELECT value INTO o FROM jsonb_array_elements(g.objects) WHERE value->>'schema'=b->>'schema' AND value->>'table'=b->>'table';
 IF to_regclass(format('%I.%I',o->>'schema',o->>'table'))::oid IS DISTINCT FROM (o->>'relation_oid')::oid THEN RAISE EXCEPTION 'database_object_replaced' USING ERRCODE='40001';END IF;
 IF NOT pg_has_role(session_user,g.role_name,'SET') THEN EXECUTE format('GRANT %I TO %I',g.role_name,session_user);END IF;
 RETURN jsonb_build_object('permission_id',g.id,'role_name',g.role_name,'actor_id',i->>'actor_id','client_id',i->>'client_id','object',o,'expires_at',g.expires_at);
END $function$;

CREATE OR REPLACE FUNCTION authz.database_permissions_read(proof text, b jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF coalesce(b->>'view','mine') NOT IN ('mine','managed') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('effective_now',g.active AND NOT g.suspended AND g.expires_at>clock_timestamp())),'[]') INTO items FROM authz.database_permissions g WHERE ((coalesce(b->>'view','mine')='mine' AND g.actor_id=(i->>'actor_id')::uuid AND authz.client_resource_allowed745((i->>'client_id')::uuid,g.project_id)) OR (b->>'view'='managed' AND authz.engineering_can_manage(proof,g.project_id))) AND (NOT b ? 'project_id' OR g.project_id=(b->>'project_id')::uuid);
 RETURN jsonb_build_object('state','read','items',items,'effective_now_note','active,not suspended and unexpired;each operation also rechecks issuer,client and object');
END $function$;

CREATE OR REPLACE FUNCTION authz.database_sqlite_permit(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;t authz.sqlite_targets;objects jsonb;until_at timestamptz;first_permission uuid;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO t FROM authz.sqlite_targets WHERE schema_name=b->>'schema' AND project_id=(b->>'project_id')::uuid AND active;
 IF t.target_id IS NULL OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,t.project_id) THEN RAISE EXCEPTION 'registered_sqlite_project_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('table',x->>'table','actions',x->'actions','fingerprint',x->>'fingerprint','schema_cookie',(x->>'schema_cookie')::int,'permission_id',g.id)),'[]'),min(g.expires_at),(array_agg(g.id))[1] INTO objects,until_at,first_permission FROM authz.database_permissions g JOIN authz.principals issuer ON issuer.id=g.approved_by JOIN v8.projects p ON p.id=g.project_id CROSS JOIN LATERAL jsonb_array_elements(g.objects) x JOIN authz.sqlite_objects o ON o.target_id=t.target_id AND o.table_name=x->>'table' WHERE g.actor_id=(i->>'actor_id')::uuid AND g.project_id=t.project_id AND g.active AND NOT g.suspended AND g.expires_at>clock_timestamp() AND issuer.active AND issuer.organization_id=p.organization_id AND p.state='active' AND (issuer.id=p.manager_id OR issuer.role='organization_admin' OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=issuer.id AND q.project_id=p.id AND q.kind='management' AND authz.management_valid(q.id,issuer.id,p.id))) AND x->>'backend'='sqlite' AND x->>'target_id'=t.target_id AND x->>'fingerprint'=o.fingerprint AND o.active AND (o.data_enabled OR NOT ((x->'actions') ?| ARRAY['select','insert','update','delete']));
 IF jsonb_array_length(objects)=0 THEN RAISE EXCEPTION 'database_permission_required' USING ERRCODE='42501';END IF;
 IF NOT(i->'client_actions'?'mem.read') AND NOT(i->'client_actions'?'mem.write') THEN RAISE EXCEPTION 'software_scope_required' USING ERRCODE='42501';END IF;
 IF NOT(i->'client_actions'?'mem.read') THEN SELECT jsonb_agg(x||jsonb_build_object('actions',(SELECT coalesce(jsonb_agg(a),'[]') FROM jsonb_array_elements_text(x->'actions') a WHERE a IN('insert','update','delete')))) INTO objects FROM jsonb_array_elements(objects) x;END IF;
 -- Write actions cannot exceed current software ceiling even with a prior grant.
 IF NOT (i->'client_actions'?'mem.write') THEN SELECT jsonb_agg(x||jsonb_build_object('actions',(SELECT coalesce(jsonb_agg(a),'[]') FROM jsonb_array_elements_text(x->'actions') a WHERE a IN('inspect','select')))) INTO objects FROM jsonb_array_elements(objects) x;END IF;
 until_at:=least(until_at,clock_timestamp()+interval '20 seconds');
 RETURN jsonb_build_object('backend','sqlite','target_id',t.target_id,'host',t.host,'project_id',t.project_id,'actor_id',i->>'actor_id','client_id',i->>'client_id','credential_id',i->>'credential_id','deadline',until_at,'objects',objects,'permission_id',first_permission,'data_scope','approved whole_table;not private-row-only');
END $function$;


COMMIT;
