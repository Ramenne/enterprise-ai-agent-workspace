BEGIN;
CREATE TABLE IF NOT EXISTS authz.database_requests(
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(), project_id uuid NOT NULL REFERENCES v8.projects(id),
 actor_id uuid NOT NULL REFERENCES authz.principals(id), client_id uuid NOT NULL,
 objects jsonb NOT NULL, purpose text NOT NULL, requested_until timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending', revision bigint NOT NULL DEFAULT 1,
 idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 decided_by uuid, decided_client_id uuid, decided_at timestamptz, approval_note text,
 UNIQUE(actor_id,idempotency_key));
CREATE TABLE IF NOT EXISTS authz.database_permissions(
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(), request_id uuid UNIQUE NOT NULL REFERENCES authz.database_requests(id),
 project_id uuid NOT NULL, actor_id uuid NOT NULL, objects jsonb NOT NULL,
 role_name text UNIQUE NOT NULL, approved_by uuid NOT NULL, expires_at timestamptz NOT NULL,
 active boolean NOT NULL DEFAULT true, revoked_at timestamptz, revoked_by uuid);
REVOKE ALL ON authz.database_requests,authz.database_permissions FROM PUBLIC;

CREATE OR REPLACE FUNCTION authz.database_validate(proof text,p_project uuid,items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;allowed jsonb;o jsonb;obj record;out_items jsonb:='[]'; acts text[];
BEGIN
 i:=authz.authenticate(proof);
 IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,p_project)
 OR NOT EXISTS(SELECT FROM v8.projects WHERE id=p_project AND organization_id=(i->>'organization_id')::uuid AND state='active') THEN RAISE EXCEPTION 'project_scope_required' USING ERRCODE='42501';END IF;
 SELECT descriptor->'database_domains' INTO allowed FROM authz.engineering_projects WHERE project_id=p_project AND ready;
 IF items IS NULL OR jsonb_typeof(items)<>'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 200 OR allowed IS NULL THEN RAISE EXCEPTION 'database_objects_required' USING ERRCODE='22023';END IF;
 FOR o IN SELECT value FROM jsonb_array_elements(items) LOOP
  IF NOT allowed ? (o->>'schema') OR o->>'schema' NOT IN ('mem','v8') THEN RAISE EXCEPTION 'database_domain_not_registered' USING ERRCODE='42501';END IF;
  SELECT c.oid,c.relname,n.nspname,c.relkind INTO obj FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=o->>'schema' AND c.relname=o->>'table' AND c.relkind IN('r','p');
  IF obj.oid IS NULL OR jsonb_typeof(o->'actions')<>'array' THEN RAISE EXCEPTION 'table_or_actions_invalid' USING ERRCODE='22023';END IF;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO acts FROM jsonb_array_elements_text(o->'actions');
  IF acts IS NULL OR cardinality(acts) NOT BETWEEN 1 AND 5 OR NOT acts<@ARRAY['inspect','select','insert','update','delete'] THEN RAISE EXCEPTION 'unsupported_database_action' USING ERRCODE='22023';END IF;
  IF acts && ARRAY['select','insert','update','delete'] AND o->>'data_scope' IS DISTINCT FROM 'whole_table' THEN RAISE EXCEPTION 'whole_table_data_scope_must_be_explicit;use_business_API_for_personal_rows' USING ERRCODE='22023';END IF;
  IF acts && ARRAY['insert','update','delete'] AND obj.relname=ANY(ARRAY['content_versions','verified_objects','source_edges','fixed_object_copies','agent_description_revisions','material_use_events','work_updates','work_snapshots','results','adoptions','context_manifests','context_sources','context_views','work_read_receipts','read_receipts']) THEN RAISE EXCEPTION 'immutable_history_requires_business_API' USING ERRCODE='42501';END IF;
  IF o ? 'relation_oid' AND (o->>'relation_oid')::oid<>obj.oid THEN RAISE EXCEPTION 'database_object_replaced' USING ERRCODE='40001';END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(out_items) x WHERE x->>'schema'=obj.nspname AND x->>'table'=obj.relname) THEN RAISE EXCEPTION 'duplicate_table_combine_actions_in_one_object' USING ERRCODE='22023';END IF;
  out_items:=out_items||jsonb_build_array(jsonb_build_object('schema',obj.nspname,'table',obj.relname,'relation_oid',obj.oid,'actions',to_jsonb(acts),'data_scope',CASE WHEN acts && ARRAY['select','insert','update','delete'] THEN 'whole_table' ELSE 'structure_only' END));
 END LOOP;
 RETURN out_items;
END $$;

CREATE OR REPLACE FUNCTION authz.database_objects(proof text,p_project uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;domains jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) OR NOT EXISTS(SELECT FROM v8.projects WHERE id=p_project AND organization_id=(i->>'organization_id')::uuid AND state='active') THEN RAISE EXCEPTION 'project_scope_required' USING ERRCODE='42501';END IF;
 SELECT descriptor->'database_domains' INTO domains FROM authz.engineering_projects WHERE project_id=p_project AND ready;
 SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'relation_oid',c.oid,'row_security',c.relrowsecurity,'direct_write',c.relname<>ALL(ARRAY['content_versions','verified_objects','source_edges','fixed_object_copies','agent_description_revisions','material_use_events','work_updates','work_snapshots','results','adoptions','context_manifests','context_sources','context_views','work_read_receipts','read_receipts'])) ORDER BY n.nspname,c.relname),'[]') INTO items FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE domains ? n.nspname AND n.nspname IN('mem','v8') AND c.relkind IN('r','p');
 RETURN jsonb_build_object('state','read','project_id',p_project,'items',items,'data_scope_note','SELECT and mutations require explicit whole_table approval;ordinary private-row access uses business APIs');
END $$;

CREATE OR REPLACE FUNCTION authz.database_apply(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;objects jsonb;r authz.database_requests;
BEGIN
 i:=authz.authenticate(proof);objects:=authz.database_validate(proof,(b->>'project_id')::uuid,b->'objects');
 IF length(coalesce(b->>'purpose','')) NOT BETWEEN 1 AND 4000 OR length(coalesce(b->>'idempotency_key','')) NOT BETWEEN 1 AND 200 OR (b->>'requested_until')::timestamptz<=clock_timestamp() OR (b->>'requested_until')::timestamptz>clock_timestamp()+interval '30 days' OR b->>'requested_until' IS NULL THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023';END IF;
 INSERT INTO authz.database_requests(project_id,actor_id,client_id,objects,purpose,requested_until,idempotency_key) VALUES((b->>'project_id')::uuid,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,objects,b->>'purpose',(b->>'requested_until')::timestamptz,b->>'idempotency_key') ON CONFLICT(actor_id,idempotency_key) DO NOTHING;
 SELECT * INTO r FROM authz.database_requests WHERE actor_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF r.objects<>objects OR r.project_id<>(b->>'project_id')::uuid OR r.purpose<>b->>'purpose' OR r.requested_until<>(b->>'requested_until')::timestamptz THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r));
END $$;

CREATE OR REPLACE FUNCTION authz.database_requests_read(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF coalesce(b->>'view','mine') NOT IN ('mine','pending') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(x),'[]') INTO items FROM (SELECT to_jsonb(r)||jsonb_build_object('project_title',p.title) x FROM authz.database_requests r JOIN v8.projects p ON p.id=r.project_id WHERE ((coalesce(b->>'view','mine')='mine' AND r.actor_id=(i->>'actor_id')::uuid) OR (b->>'view'='pending' AND r.state='pending' AND authz.engineering_can_manage(proof,r.project_id))) AND (NOT b ? 'request_id' OR r.id=(b->>'request_id')::uuid) ORDER BY r.created_at DESC LIMIT 200) q;
 RETURN jsonb_build_object('state','read','items',items,'coverage','up_to_200_current_scope_requests');
END $$;

CREATE OR REPLACE FUNCTION authz.database_decide(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.database_requests;pid uuid;role_name text;o jsonb;privs text;expires timestamptz;result authz.database_permissions;effective text;
BEGIN
 i:=authz.authenticate(proof); SELECT * INTO r FROM authz.database_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR NOT authz.engineering_can_manage(proof,r.project_id) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF b->>'decision' IS NULL OR b->>'decision' NOT IN ('approve','reject') OR coalesce((b->>'expected_revision')::bigint,0)<1 THEN RAISE EXCEPTION 'decision_or_revision_required' USING ERRCODE='22023';END IF;
 IF r.state<>'pending' THEN
  IF r.decided_by=(i->>'actor_id')::uuid AND r.revision=(b->>'expected_revision')::bigint+1 AND r.state=(CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END) THEN SELECT * INTO result FROM authz.database_permissions WHERE request_id=r.id;RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'permission',to_jsonb(result),'replayed',true);END IF;
  RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';
 END IF;
 IF r.revision<>(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
 effective:=authz.engineering_management_proof(proof,r.project_id);
 IF b->>'decision'='approve' THEN
  PERFORM authz.database_validate(proof,r.project_id,r.objects);
  expires:=least(r.requested_until,coalesce((b->>'expires_at')::timestamptz,r.requested_until));
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'request_expired' USING ERRCODE='22023';END IF;
  pid:=public.gen_random_uuid();role_name:='hubdb_'||replace(pid::text,'-','');
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
  EXECUTE format('GRANT %I TO hub2_hufu',role_name);
  FOR o IN SELECT value FROM jsonb_array_elements(r.objects) LOOP
   EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I',o->>'schema',role_name);
   SELECT string_agg(upper(value),',') INTO privs FROM jsonb_array_elements_text(o->'actions') WHERE value<>'inspect';
   IF privs IS NOT NULL THEN
    EXECUTE format('GRANT %s ON TABLE %I.%I TO %I',privs,o->>'schema',o->>'table',role_name);
    IF EXISTS(SELECT FROM pg_class WHERE oid=(o->>'relation_oid')::oid AND relrowsecurity) THEN EXECUTE format('CREATE POLICY %I ON %I.%I TO %I USING (true) WITH CHECK (true)',role_name,o->>'schema',o->>'table',role_name);END IF;
   END IF;
   IF o->'actions' ? 'insert' THEN
    FOR privs IN SELECT pg_get_serial_sequence(format('%I.%I',o->>'schema',o->>'table'),a.attname) FROM pg_attribute a WHERE a.attrelid=(o->>'relation_oid')::oid AND a.attnum>0 AND NOT a.attisdropped LOOP
     IF privs IS NOT NULL THEN EXECUTE format('GRANT USAGE ON SEQUENCE %s TO %I',privs,role_name);END IF;
    END LOOP;
   END IF;
  END LOOP;
  INSERT INTO authz.database_permissions(id,request_id,project_id,actor_id,objects,role_name,approved_by,expires_at) VALUES(pid,r.id,r.project_id,r.actor_id,r.objects,role_name,(i->>'actor_id')::uuid,expires) RETURNING * INTO result;
 END IF;
 UPDATE authz.database_requests SET state=CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,revision=revision+1,decided_by=(i->>'actor_id')::uuid,decided_client_id=(i->>'client_id')::uuid,decided_at=clock_timestamp(),approval_note=left(b->>'approval_note',4000) WHERE id=r.id RETURNING * INTO r;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','database.request.'||r.state,r.id,jsonb_build_object('permission_id',result.id,'objects',r.objects,'expires_at',expires));
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'permission',to_jsonb(result),'authority','verified_current_manager;not_a_full_engineering_grant');
END $$;

CREATE OR REPLACE FUNCTION authz.database_permissions_read(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 SELECT coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('effective_now',g.active AND g.expires_at>clock_timestamp() AND authz.client_resource_allowed745((i->>'client_id')::uuid,g.project_id))),'[]') INTO items FROM authz.database_permissions g WHERE g.actor_id=(i->>'actor_id')::uuid;
 RETURN jsonb_build_object('state','read','items',items);
END $$;

CREATE OR REPLACE FUNCTION authz.database_access(proof text,b jsonb,p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;g authz.database_permissions;o jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF p_action NOT IN('inspect','select','insert','update','delete') OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,(b->>'project_id')::uuid) OR NOT (CASE WHEN p_action IN('inspect','select') THEN 'mem.read' ELSE 'mem.write' END)=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions'))) THEN RAISE EXCEPTION 'software_scope_required' USING ERRCODE='42501';END IF;
 SELECT p.* INTO g FROM authz.database_permissions p JOIN authz.principals issuer ON issuer.id=p.approved_by JOIN v8.projects pr ON pr.id=p.project_id WHERE p.actor_id=(i->>'actor_id')::uuid AND p.project_id=(b->>'project_id')::uuid AND p.active AND p.expires_at>clock_timestamp() AND pr.state='active' AND issuer.active AND issuer.organization_id=pr.organization_id AND (issuer.id=pr.manager_id OR issuer.role='organization_admin' OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=issuer.id AND q.project_id=pr.id AND q.kind='management' AND authz.management_valid(q.id,issuer.id,pr.id))) AND EXISTS(SELECT FROM jsonb_array_elements(p.objects) x WHERE x->>'schema'=b->>'schema' AND x->>'table'=b->>'table' AND (x->'actions' ? p_action OR p_action='inspect')) ORDER BY p.expires_at DESC LIMIT 1 FOR SHARE OF p;
 IF g.id IS NULL THEN RAISE EXCEPTION 'database_permission_required' USING ERRCODE='42501';END IF;
 SELECT value INTO o FROM jsonb_array_elements(g.objects) WHERE value->>'schema'=b->>'schema' AND value->>'table'=b->>'table';
 IF to_regclass(format('%I.%I',o->>'schema',o->>'table'))::oid IS DISTINCT FROM (o->>'relation_oid')::oid THEN RAISE EXCEPTION 'database_object_replaced' USING ERRCODE='40001';END IF;
 IF NOT pg_has_role(session_user,g.role_name,'SET') THEN EXECUTE format('GRANT %I TO %I',g.role_name,session_user);END IF;
 RETURN jsonb_build_object('permission_id',g.id,'role_name',g.role_name,'actor_id',i->>'actor_id','client_id',i->>'client_id','object',o,'expires_at',g.expires_at);
END $$;

CREATE OR REPLACE FUNCTION authz.database_revoke(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;g authz.database_permissions;o jsonb;effective text;
BEGIN
 i:=authz.authenticate(proof);SELECT * INTO g FROM authz.database_permissions WHERE id=(b->>'permission_id')::uuid FOR UPDATE;
 IF g.id IS NULL OR NOT authz.engineering_can_manage(proof,g.project_id) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 effective:=authz.engineering_management_proof(proof,g.project_id);
 IF NOT g.active THEN RETURN jsonb_build_object('state','revoked','replayed',true);END IF;
 FOR o IN SELECT value FROM jsonb_array_elements(g.objects) LOOP
  IF to_regclass(format('%I.%I',o->>'schema',o->>'table'))::oid=(o->>'relation_oid')::oid THEN
   EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',g.role_name,o->>'schema',o->>'table');
   EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %I',o->>'schema',o->>'table',g.role_name);
  END IF;
 END LOOP;
 EXECUTE format('REVOKE %I FROM hub2_hufu',g.role_name);
 EXECUTE format('DROP OWNED BY %I',g.role_name);
 EXECUTE format('DROP ROLE %I',g.role_name);
 UPDATE authz.database_permissions SET active=false,revoked_at=clock_timestamp(),revoked_by=(i->>'actor_id')::uuid WHERE id=g.id;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','database.permission.revoked',g.id,jsonb_build_object('project_id',g.project_id));
 RETURN jsonb_build_object('state','revoked','permission_id',g.id);
END $$;

CREATE OR REPLACE FUNCTION authz.database_inspect(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE access jsonb;rel oid;cols jsonb;cons jsonb;idx jsonb;pol jsonb;
BEGIN
 access:=authz.database_access(proof,b,'inspect');rel:=(access->'object'->>'relation_oid')::oid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum),'[]') INTO cols FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=rel AND a.attnum>0 AND NOT a.attisdropped;
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid))),'[]') INTO cons FROM pg_constraint WHERE conrelid=rel;
 SELECT coalesce(jsonb_agg(pg_get_indexdef(indexrelid)),'[]') INTO idx FROM pg_index WHERE indrelid=rel;
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',polname,'command',polcmd,'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid))),'[]') INTO pol FROM pg_policy WHERE polrelid=rel;
 RETURN jsonb_build_object('state','read','object',access->'object','columns',cols,'constraints',cons,'indexes',idx,'policies',pol,'coverage','table_structure_no_business_rows');
END $$;

REVOKE ALL ON FUNCTION authz.database_validate(text,uuid,jsonb),authz.database_objects(text,uuid),authz.database_apply(text,jsonb),authz.database_requests_read(text,jsonb),authz.database_decide(text,jsonb),authz.database_permissions_read(text),authz.database_access(text,jsonb,text),authz.database_revoke(text,jsonb),authz.database_inspect(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.database_objects(text,uuid),authz.database_apply(text,jsonb),authz.database_requests_read(text,jsonb),authz.database_decide(text,jsonb),authz.database_permissions_read(text),authz.database_access(text,jsonb,text),authz.database_revoke(text,jsonb),authz.database_inspect(text,jsonb) TO hub2_hufu;
COMMIT;
