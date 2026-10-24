BEGIN;
ALTER TABLE authz.database_permissions ADD COLUMN IF NOT EXISTS suspended boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS authz.sqlite_targets(target_id text PRIMARY KEY,project_id uuid NOT NULL REFERENCES v8.projects(id),schema_name text NOT NULL UNIQUE,host text NOT NULL,os_user text NOT NULL,active boolean NOT NULL DEFAULT true);
CREATE TABLE IF NOT EXISTS authz.sqlite_objects(target_id text NOT NULL REFERENCES authz.sqlite_targets(target_id),table_name text NOT NULL,fingerprint text NOT NULL,schema_cookie int NOT NULL,direct_write boolean NOT NULL,active boolean NOT NULL DEFAULT true,PRIMARY KEY(target_id,table_name));
ALTER TABLE authz.sqlite_objects ADD COLUMN IF NOT EXISTS data_enabled boolean NOT NULL DEFAULT false;
REVOKE ALL ON authz.sqlite_targets,authz.sqlite_objects FROM PUBLIC;

DO $$ BEGIN
 IF to_regprocedure('authz.database_validate_before_sqlite(text,uuid,jsonb)') IS NULL THEN ALTER FUNCTION authz.database_validate(text,uuid,jsonb) RENAME TO database_validate_before_sqlite;END IF;
 IF to_regprocedure('authz.database_objects_before_sqlite(text,uuid)') IS NULL THEN ALTER FUNCTION authz.database_objects(text,uuid) RENAME TO database_objects_before_sqlite;END IF;
 IF to_regprocedure('authz.database_decide_before_sqlite(text,jsonb)') IS NULL THEN ALTER FUNCTION authz.database_decide(text,jsonb) RENAME TO database_decide_before_sqlite;END IF;
 IF to_regprocedure('authz.database_revoke_before_sqlite(text,jsonb)') IS NULL THEN ALTER FUNCTION authz.database_revoke(text,jsonb) RENAME TO database_revoke_before_sqlite;END IF;
 IF to_regprocedure('authz.database_expire_before_sqlite()') IS NULL THEN ALTER FUNCTION authz.database_expire() RENAME TO database_expire_before_sqlite;END IF;
END $$;
CREATE OR REPLACE FUNCTION authz.database_validate(proof text,p_project uuid,items jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;o jsonb;t authz.sqlite_targets;obj authz.sqlite_objects;acts text[];out_ jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(items) x JOIN authz.sqlite_targets catalog_target ON catalog_target.schema_name=x->>'schema') THEN RETURN authz.database_validate_before_sqlite(proof,p_project,items);END IF;
 i:=authz.authenticate(proof);
 IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) OR NOT EXISTS(SELECT FROM v8.projects WHERE id=p_project AND organization_id=(i->>'organization_id')::uuid AND state='active') THEN RAISE EXCEPTION 'project_scope_required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(items)<>'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'database_objects_required' USING ERRCODE='22023';END IF;
 FOR o IN SELECT value FROM jsonb_array_elements(items) LOOP
  SELECT * INTO t FROM authz.sqlite_targets WHERE schema_name=o->>'schema' AND project_id=p_project AND active;
  IF t.target_id IS NULL THEN RAISE EXCEPTION 'single_registered_SQLite_backend_required' USING ERRCODE='42501';END IF;
  SELECT * INTO obj FROM authz.sqlite_objects WHERE target_id=t.target_id AND table_name=o->>'table' AND active;
  IF obj.table_name IS NULL OR jsonb_typeof(o->'actions')<>'array' THEN RAISE EXCEPTION 'actual_table_and_actions_required' USING ERRCODE='22023';END IF;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO acts FROM jsonb_array_elements_text(o->'actions');
  IF acts IS NULL OR cardinality(acts) NOT BETWEEN 1 AND 5 OR NOT acts<@ARRAY['inspect','select','insert','update','delete'] THEN RAISE EXCEPTION 'unsupported_database_action' USING ERRCODE='22023';END IF;
  IF acts&&ARRAY['select','insert','update','delete'] AND NOT obj.data_enabled THEN RAISE EXCEPTION 'private_original_rows_require_owner_business_grant;sqlite_structure_only' USING ERRCODE='42501';END IF;
  IF acts&&ARRAY['select','insert','update','delete'] AND o->>'data_scope' IS DISTINCT FROM 'whole_table' THEN RAISE EXCEPTION 'whole_table_includes_all_private_and_member_rows;explicit_scope_required' USING ERRCODE='22023';END IF;
  IF acts&&ARRAY['insert','update','delete'] AND NOT obj.direct_write THEN RAISE EXCEPTION 'original_authority_or_immutable_file_refs_require_business_API' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(out_) x WHERE x->>'table'=obj.table_name) THEN RAISE EXCEPTION 'combine_table_actions_in_one_object' USING ERRCODE='22023';END IF;
  out_:=out_||jsonb_build_array(jsonb_build_object('backend','sqlite','target_id',t.target_id,'schema',t.schema_name,'table',obj.table_name,'fingerprint',obj.fingerprint,'schema_cookie',obj.schema_cookie,'actions',to_jsonb(acts),'data_scope',CASE WHEN acts&&ARRAY['select','insert','update','delete'] THEN 'whole_table' ELSE 'structure_only' END));
 END LOOP;
 RETURN out_;
END $$;
CREATE OR REPLACE FUNCTION authz.database_objects(proof text,p_project uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;pg jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);pg:=authz.database_objects_before_sqlite(proof,p_project);
 SELECT coalesce(jsonb_agg(jsonb_build_object('backend','sqlite','schema',t.schema_name,'table',o.table_name,'target_id',t.target_id,'fingerprint',o.fingerprint,'schema_cookie',o.schema_cookie,'allowed_actions',CASE WHEN NOT o.data_enabled THEN '["inspect"]'::jsonb WHEN o.direct_write THEN '[]'::jsonb||'["inspect","select","insert","update","delete"]'::jsonb ELSE '["inspect","select"]'::jsonb END,'direct_write',o.direct_write,'data_scope_note','whole_table includes every member/private row;engineering rights alone do not grant data')),'[]') INTO items FROM authz.sqlite_targets t JOIN authz.sqlite_objects o ON o.target_id=t.target_id WHERE t.project_id=p_project AND t.active AND o.active;
 RETURN pg||jsonb_build_object('items',(pg->'items')||items);
END $$;
CREATE OR REPLACE FUNCTION authz.database_decide(proof text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.database_requests;chosen jsonb;expiry timestamptz;p authz.database_permissions;effective text;
BEGIN
 SELECT * INTO r FROM authz.database_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(r.objects) x WHERE x->>'backend'='sqlite') THEN RETURN authz.database_decide_before_sqlite(proof,b);END IF;
 i:=authz.authenticate(proof);
 IF NOT authz.engineering_can_manage(proof,r.project_id) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF b->>'decision' NOT IN('approve','reject') OR b->>'decision' IS NULL THEN RAISE EXCEPTION 'decision_required' USING ERRCODE='22023';END IF;
 IF r.state<>'pending' OR r.revision IS DISTINCT FROM(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
 effective:=authz.engineering_management_proof(proof,r.project_id);
 IF b->>'decision'='approve' THEN
  chosen:=authz.database_validate(proof,r.project_id,coalesce(b->'approved_objects',r.objects));
  IF NOT authz.database_scope_subset(chosen,r.objects) THEN RAISE EXCEPTION 'approved_scope_must_be_requested_subset' USING ERRCODE='22023';END IF;
  expiry:=least(r.requested_until,coalesce((b->>'expires_at')::timestamptz,r.requested_until));
  IF expiry<=clock_timestamp() THEN RAISE EXCEPTION 'request_expired' USING ERRCODE='22023';END IF;
  INSERT INTO authz.database_permissions(request_id,project_id,actor_id,objects,role_name,approved_by,expires_at) VALUES(r.id,r.project_id,r.actor_id,chosen,'external_sqlite_'||replace(gen_random_uuid()::text,'-',''),(i->>'actor_id')::uuid,expiry) RETURNING * INTO p;
 ELSE IF length(trim(coalesce(b->>'reason',b->>'approval_note',''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'rejection_reason_required' USING ERRCODE='22023';END IF;END IF;
 UPDATE authz.database_requests SET state=CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,revision=revision+1,decided_by=(i->>'actor_id')::uuid,decided_client_id=(i->>'client_id')::uuid,decided_at=clock_timestamp(),approved_objects=chosen,approval_note=coalesce(b->>'reason',b->>'approval_note') WHERE id=r.id RETURNING * INTO r;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','database.sqlite.'||r.state,r.id,jsonb_build_object('permission_id',p.id,'objects',chosen,'data_scope','whole_table'));
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'permission',to_jsonb(p),'execution_backend','sqlite_authorizer_project_UID;role_name_is_external_handle_not_Postgres_role');
END $$;
CREATE OR REPLACE FUNCTION authz.database_revoke(proof text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;g authz.database_permissions;
BEGIN
 SELECT * INTO g FROM authz.database_permissions WHERE id=(b->>'permission_id')::uuid FOR UPDATE;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(g.objects) x WHERE x->>'backend'='sqlite') THEN RETURN authz.database_revoke_before_sqlite(proof,b);END IF;
 i:=authz.authenticate(proof);IF NOT authz.engineering_can_manage(proof,g.project_id) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 PERFORM authz.engineering_management_proof(proof,g.project_id);
 UPDATE authz.database_permissions SET active=false,revoked_at=clock_timestamp(),revoked_by=(i->>'actor_id')::uuid WHERE id=g.id;
 RETURN jsonb_build_object('state','revoked','permission_id',g.id,'effect','new_sqlite_permits_denied;no_Postgres_role_created_or_dropped');
END $$;
CREATE OR REPLACE FUNCTION authz.database_expire() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE n int;pg jsonb;
BEGIN
 UPDATE authz.database_permissions SET active=false,revoked_at=clock_timestamp() WHERE active AND expires_at<=clock_timestamp() AND EXISTS(SELECT FROM jsonb_array_elements(objects) x WHERE x->>'backend'='sqlite');GET DIAGNOSTICS n=ROW_COUNT;
 pg:=authz.database_expire_before_sqlite();RETURN pg||jsonb_build_object('sqlite_expired',n);
END $$;
CREATE OR REPLACE FUNCTION authz.database_sqlite_permit(proof text,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
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
END $$;
REVOKE ALL ON FUNCTION authz.database_validate(text,uuid,jsonb),authz.database_objects(text,uuid),authz.database_decide(text,jsonb),authz.database_revoke(text,jsonb),authz.database_expire(),authz.database_sqlite_permit(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.database_validate(text,uuid,jsonb),authz.database_objects(text,uuid),authz.database_decide(text,jsonb),authz.database_revoke(text,jsonb),authz.database_expire(),authz.database_sqlite_permit(text,jsonb) TO hub2_hufu;
-- Keep the existing authorization owner and private call chain. No PUBLIC/superuser grants.
ALTER TABLE authz.sqlite_targets OWNER TO hub2_authz_owner;
ALTER TABLE authz.sqlite_objects OWNER TO hub2_authz_owner;
ALTER FUNCTION authz.database_validate(text,uuid,jsonb) OWNER TO hub2_authz_owner;
ALTER FUNCTION authz.database_objects(text,uuid) OWNER TO hub2_authz_owner;
ALTER FUNCTION authz.database_decide(text,jsonb) OWNER TO hub2_authz_owner;
ALTER FUNCTION authz.database_revoke(text,jsonb) OWNER TO hub2_authz_owner;
ALTER FUNCTION authz.database_expire() OWNER TO hub2_authz_owner;
ALTER FUNCTION authz.database_sqlite_permit(text,jsonb) OWNER TO hub2_authz_owner;
GRANT EXECUTE ON FUNCTION authz.database_validate_before_sqlite(text,uuid,jsonb),authz.database_objects_before_sqlite(text,uuid),authz.database_decide_before_sqlite(text,jsonb),authz.database_revoke_before_sqlite(text,jsonb),authz.database_expire_before_sqlite() TO hub2_authz_owner;
GRANT SELECT,UPDATE ON authz.database_requests TO hub2_authz_owner;
GRANT SELECT,INSERT,UPDATE ON authz.database_permissions TO hub2_authz_owner;
COMMIT;
