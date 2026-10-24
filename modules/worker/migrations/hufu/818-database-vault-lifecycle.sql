BEGIN;

-- 818: database request lifecycle, inspect-only identity domains and shared verified management.
ALTER TABLE authz.database_requests ADD COLUMN IF NOT EXISTS approved_objects jsonb;
ALTER TABLE authz.database_requests ADD COLUMN IF NOT EXISTS original_payload jsonb;
UPDATE authz.database_requests SET original_payload=jsonb_build_object('project_id',project_id,'objects',objects,'purpose',purpose,'requested_until',requested_until) WHERE original_payload IS NULL;
ALTER TABLE authz.database_requests ADD COLUMN IF NOT EXISTS decision_input jsonb;
ALTER TABLE authz.database_requests ADD COLUMN IF NOT EXISTS replacement_request_id uuid;
ALTER TABLE authz.engineering_requests ADD COLUMN IF NOT EXISTS replacement_database_request_id uuid;
ALTER TABLE authz.engineering_requests DROP CONSTRAINT IF EXISTS engineering_requests_state_check;
ALTER TABLE authz.engineering_requests ADD CONSTRAINT engineering_requests_state_check CHECK(state IN ('pending','approved','rejected','withdrawn','superseded'));
CREATE TABLE IF NOT EXISTS authz.database_request_changes(
 id uuid PRIMARY KEY DEFAULT public.gen_random_uuid(), request_type text NOT NULL CHECK(request_type IN ('database','engineering')),
 request_id uuid NOT NULL, actor_id uuid NOT NULL, client_id uuid NOT NULL, revision bigint NOT NULL,
 operation text NOT NULL, input jsonb NOT NULL, before_snapshot jsonb NOT NULL, after_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(request_type,request_id,revision));
REVOKE ALL ON authz.database_request_changes FROM PUBLIC;


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
  IF NOT allowed ? (o->>'schema') OR o->>'schema' NOT IN ('mem','v8','authn','authz','vault2') THEN RAISE EXCEPTION 'database_domain_not_registered' USING ERRCODE='42501';END IF;
  SELECT c.oid,c.relname,n.nspname,c.relkind INTO obj FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=o->>'schema' AND c.relname=o->>'table' AND c.relkind IN('r','p');
  IF obj.oid IS NULL OR jsonb_typeof(o->'actions')<>'array' THEN RAISE EXCEPTION 'table_or_actions_invalid' USING ERRCODE='22023';END IF;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO acts FROM jsonb_array_elements_text(o->'actions');
  IF acts IS NULL OR cardinality(acts) NOT BETWEEN 1 AND 5 OR NOT acts<@ARRAY['inspect','select','insert','update','delete'] THEN RAISE EXCEPTION 'unsupported_database_action' USING ERRCODE='22023';END IF;
  IF obj.nspname IN ('authn','authz','vault2') AND acts<>ARRAY['inspect'] THEN RAISE EXCEPTION 'sensitive_domain_inspect_only' USING ERRCODE='42501';END IF;
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
 SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'relation_oid',c.oid,'row_security',c.relrowsecurity,'allowed_actions',CASE WHEN n.nspname IN ('authn','authz','vault2') THEN '["inspect"]'::jsonb ELSE '["inspect","select","insert","update","delete"]'::jsonb END,'direct_write',n.nspname IN ('mem','v8') AND c.relname<>ALL(ARRAY['content_versions','verified_objects','source_edges','fixed_object_copies','agent_description_revisions','material_use_events','work_updates','work_snapshots','results','adoptions','context_manifests','context_sources','context_views','work_read_receipts','read_receipts'])) ORDER BY n.nspname,c.relname),'[]') INTO items FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE domains ? n.nspname AND n.nspname IN('mem','v8','authn','authz','vault2') AND c.relkind IN('r','p');
 RETURN jsonb_build_object('state','read','project_id',p_project,'items',items,'data_scope_note','SELECT and mutations require explicit whole_table approval;ordinary private-row access uses business APIs');
END $$;

CREATE OR REPLACE FUNCTION authz.database_apply(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;objects jsonb;r authz.database_requests;v_payload jsonb;
BEGIN
 i:=authz.authenticate(proof);objects:=authz.database_validate(proof,(b->>'project_id')::uuid,b->'objects');
 v_payload:=jsonb_build_object('project_id',(b->>'project_id')::uuid,'objects',objects,'purpose',b->>'purpose','requested_until',(b->>'requested_until')::timestamptz);
 SELECT * INTO r FROM authz.database_requests WHERE actor_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF r.id IS NOT NULL THEN
  IF r.original_payload IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
  RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'replayed',true);
 END IF;
 IF length(coalesce(b->>'purpose','')) NOT BETWEEN 1 AND 4000 OR length(coalesce(b->>'idempotency_key','')) NOT BETWEEN 1 AND 200 OR (b->>'requested_until')::timestamptz<=clock_timestamp() OR (b->>'requested_until')::timestamptz>clock_timestamp()+interval '30 days' OR b->>'requested_until' IS NULL THEN RAISE EXCEPTION 'invalid_request' USING ERRCODE='22023';END IF;
 INSERT INTO authz.database_requests(project_id,actor_id,client_id,objects,purpose,requested_until,idempotency_key,original_payload) VALUES((b->>'project_id')::uuid,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,objects,b->>'purpose',(b->>'requested_until')::timestamptz,b->>'idempotency_key',v_payload) ON CONFLICT(actor_id,idempotency_key) DO NOTHING;
 SELECT * INTO r FROM authz.database_requests WHERE actor_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF r.original_payload IS DISTINCT FROM v_payload THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r));
END $$;

CREATE OR REPLACE FUNCTION authz.database_scope_subset(chosen jsonb, requested jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT jsonb_typeof(chosen)='array' AND jsonb_array_length(chosen)>0 AND NOT EXISTS(
 SELECT FROM jsonb_array_elements(chosen) c WHERE NOT EXISTS(
 SELECT FROM jsonb_array_elements(requested) r WHERE c->>'schema'=r->>'schema' AND c->>'table'=r->>'table'
 AND c->>'relation_oid'=r->>'relation_oid' AND (c->'actions')<@(r->'actions')
 AND (c->>'data_scope'='structure_only' OR c->>'data_scope'=r->>'data_scope')))
$$;

CREATE OR REPLACE FUNCTION authz.database_decide(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;r authz.database_requests;pid uuid;role_name text;o jsonb;privs text;expires timestamptz;result authz.database_permissions;effective text;chosen jsonb;v_decision_input jsonb;
BEGIN
 i:=authz.authenticate(proof); SELECT * INTO r FROM authz.database_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
 IF r.id IS NULL OR NOT authz.engineering_can_manage(proof,r.project_id) THEN RAISE EXCEPTION 'manager_required' USING ERRCODE='42501';END IF;
 IF b->>'decision' IS NULL OR b->>'decision' NOT IN ('approve','reject') OR coalesce((b->>'expected_revision')::bigint,0)<1 THEN RAISE EXCEPTION 'decision_or_revision_required' USING ERRCODE='22023';END IF;
 v_decision_input:=jsonb_build_object('decision',b->>'decision','approved_objects',coalesce(b->'approved_objects',r.objects),'expires_at',coalesce(b->>'expires_at',r.requested_until::text),'approval_note',coalesce(b->>'approval_note',''),'reason',coalesce(b->>'reason',''));
 IF r.state<>'pending' THEN
  IF r.decided_by=(i->>'actor_id')::uuid AND r.revision=(b->>'expected_revision')::bigint+1 AND r.decision_input=v_decision_input AND r.state=(CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END) THEN SELECT * INTO result FROM authz.database_permissions WHERE request_id=r.id;RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'permission',to_jsonb(result),'replayed',true);END IF;
  RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';
 END IF;
 IF r.revision<>(b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
 effective:=authz.engineering_management_proof(proof,r.project_id);
 IF b->>'decision'='approve' THEN
  chosen:=authz.database_validate(proof,r.project_id,coalesce(b->'approved_objects',r.objects));
  IF NOT authz.database_scope_subset(chosen,r.objects) THEN RAISE EXCEPTION 'approved_scope_must_be_requested_subset' USING ERRCODE='22023';END IF;
  expires:=least(r.requested_until,coalesce((b->>'expires_at')::timestamptz,r.requested_until));
  IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'request_expired' USING ERRCODE='22023';END IF;
  pid:=public.gen_random_uuid();role_name:='hubdb_'||replace(pid::text,'-','');
  EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
  EXECUTE format('GRANT %I TO hub2_hufu',role_name);
  FOR o IN SELECT value FROM jsonb_array_elements(chosen) LOOP
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
  INSERT INTO authz.database_permissions(id,request_id,project_id,actor_id,objects,role_name,approved_by,expires_at) VALUES(pid,r.id,r.project_id,r.actor_id,chosen,role_name,(i->>'actor_id')::uuid,expires) RETURNING * INTO result;
 END IF;
 IF b->>'decision'='reject' AND length(btrim(coalesce(b->>'reason',b->>'approval_note',''))) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'rejection_reason_required' USING ERRCODE='22023';END IF;
 UPDATE authz.database_requests SET approved_objects=chosen,decision_input=v_decision_input,state=CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,revision=revision+1,decided_by=(i->>'actor_id')::uuid,decided_client_id=(i->>'client_id')::uuid,decided_at=clock_timestamp(),approval_note=left(coalesce(b->>'reason',b->>'approval_note'),4000) WHERE id=r.id RETURNING * INTO r;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','database.request.'||r.state,r.id,jsonb_build_object('permission_id',result.id,'requested_objects',r.objects,'approved_objects',chosen,'expires_at',expires));
 RETURN jsonb_build_object('state',r.state,'request',to_jsonb(r),'permission',to_jsonb(result),'authority','verified_current_manager;not_a_full_engineering_grant');
END $$;

CREATE OR REPLACE FUNCTION authz.database_access(proof text,b jsonb,p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;g authz.database_permissions;o jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF b->>'schema' IN ('authn','authz','vault2') AND p_action<>'inspect' THEN RAISE EXCEPTION 'sensitive_domain_inspect_only' USING ERRCODE='42501';END IF;
 IF p_action NOT IN('inspect','select','insert','update','delete') OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,(b->>'project_id')::uuid) OR NOT (CASE WHEN p_action IN('inspect','select') THEN 'mem.read' ELSE 'mem.write' END)=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions'))) THEN RAISE EXCEPTION 'software_scope_required' USING ERRCODE='42501';END IF;
 SELECT p.* INTO g FROM authz.database_permissions p JOIN authz.principals issuer ON issuer.id=p.approved_by JOIN v8.projects pr ON pr.id=p.project_id WHERE p.actor_id=(i->>'actor_id')::uuid AND p.project_id=(b->>'project_id')::uuid AND p.active AND p.expires_at>clock_timestamp() AND pr.state='active' AND issuer.active AND issuer.organization_id=pr.organization_id AND (issuer.id=pr.manager_id OR issuer.role='organization_admin' OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=issuer.id AND q.project_id=pr.id AND q.kind='management' AND authz.management_valid(q.id,issuer.id,pr.id))) AND EXISTS(SELECT FROM jsonb_array_elements(p.objects) x WHERE x->>'schema'=b->>'schema' AND x->>'table'=b->>'table' AND (x->'actions' ? p_action OR p_action='inspect')) ORDER BY p.expires_at DESC LIMIT 1 FOR SHARE OF p;
 IF g.id IS NULL THEN RAISE EXCEPTION 'database_permission_required' USING ERRCODE='42501';END IF;
 SELECT value INTO o FROM jsonb_array_elements(g.objects) WHERE value->>'schema'=b->>'schema' AND value->>'table'=b->>'table';
 IF to_regclass(format('%I.%I',o->>'schema',o->>'table'))::oid IS DISTINCT FROM (o->>'relation_oid')::oid THEN RAISE EXCEPTION 'database_object_replaced' USING ERRCODE='40001';END IF;
 IF NOT pg_has_role(session_user,g.role_name,'SET') THEN EXECUTE format('GRANT %I TO %I',g.role_name,session_user);END IF;
 RETURN jsonb_build_object('permission_id',g.id,'role_name',g.role_name,'actor_id',i->>'actor_id','client_id',i->>'client_id','object',o,'expires_at',g.expires_at);
END $$;

CREATE OR REPLACE FUNCTION authz.database_inspect(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE access jsonb;rel oid;cols jsonb;cons jsonb;idx jsonb;pol jsonb;sensitive boolean;
BEGIN
 access:=authz.database_access(proof,b,'inspect');rel:=(access->'object'->>'relation_oid')::oid;sensitive:=b->>'schema' IN ('authn','authz','vault2');
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'sequence',pg_get_serial_sequence(format('%I.%I',b->>'schema',b->>'table'),a.attname),'default',CASE WHEN sensitive THEN NULL ELSE pg_get_expr(d.adbin,d.adrelid) END) ORDER BY a.attnum),'[]') INTO cols FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=rel AND a.attnum>0 AND NOT a.attisdropped;
 SELECT coalesce(jsonb_agg(CASE WHEN sensitive THEN jsonb_build_object('name',conname,'kind',contype,'columns',conkey,'referenced_relation_oid',confrelid,'definition',CASE WHEN contype IN ('p','u','f') THEN pg_get_constraintdef(oid) ELSE NULL END) ELSE jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid)) END),'[]') INTO cons FROM pg_constraint WHERE conrelid=rel;
 SELECT coalesce(jsonb_agg(CASE WHEN sensitive THEN jsonb_build_object('name',(SELECT relname FROM pg_class WHERE oid=indexrelid),'unique',indisunique,'primary',indisprimary,'columns',indkey::text,'has_expression',indexprs IS NOT NULL,'has_predicate',indpred IS NOT NULL,'definition',CASE WHEN indexprs IS NULL AND indpred IS NULL THEN pg_get_indexdef(indexrelid) ELSE NULL END) ELSE to_jsonb(pg_get_indexdef(indexrelid)) END),'[]') INTO idx FROM pg_index WHERE indrelid=rel;
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',polname,'command',polcmd,'roles',to_jsonb(polroles),'permissive',polpermissive,'using',CASE WHEN sensitive THEN NULL ELSE pg_get_expr(polqual,polrelid) END,'check',CASE WHEN sensitive THEN NULL ELSE pg_get_expr(polwithcheck,polrelid) END)),'[]') INTO pol FROM pg_policy WHERE polrelid=rel;
 RETURN jsonb_build_object('state','read','object',access->'object','columns',cols,'constraints',cons,'indexes',idx,'policies',pol,'coverage',CASE WHEN sensitive THEN 'safe_structure_no_rows_defaults_or_expression_bodies' ELSE 'table_structure_no_business_rows' END);
END $$;

ALTER TABLE authz.engineering_contexts ADD COLUMN IF NOT EXISTS authorized_actions text[] NOT NULL DEFAULT '{}';

-- Compatible management confirmation: exact original software/credential, live primary,
-- original software resource filters, and project boundary remain authoritative.
CREATE OR REPLACE FUNCTION authz.management_context_valid(i jsonb, p_project uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.engineering_contexts;p jsonb;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RETURN false;END IF;
 IF p_project IS NOT NULL AND NOT authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) THEN RETURN false;END IF;
 FOR c IN SELECT * FROM authz.engineering_contexts
 WHERE actor_id=(i->>'actor_id')::uuid AND client_id=(i->>'client_id')::uuid AND credential_id=(i->>'credential_id')::uuid
 AND expires_at>clock_timestamp() AND (project_id IS NULL OR project_id=p_project)
 AND authority_source IN ('verified_email_otp','explicit_user_approved_operator') ORDER BY created_at DESC LOOP
  BEGIN p:=authz.authenticate(c.primary_proof);EXCEPTION WHEN insufficient_privilege THEN CONTINUE;END;
  IF p->>'actor_id'=i->>'actor_id' AND p->>'is_primary'='true' THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
END $$;

CREATE OR REPLACE FUNCTION authz.management_context_allows(i jsonb, p_project uuid, p_action text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE c authz.engineering_contexts;p jsonb;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' THEN RETURN false;END IF;
 IF p_project IS NOT NULL AND NOT authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) THEN RETURN false;END IF;
 FOR c IN SELECT * FROM authz.engineering_contexts
 WHERE actor_id=(i->>'actor_id')::uuid AND client_id=(i->>'client_id')::uuid AND credential_id=(i->>'credential_id')::uuid
 AND expires_at>clock_timestamp() AND (project_id IS NULL OR project_id=p_project)
 AND p_action=ANY(authorized_actions)
 AND authority_source IN ('verified_email_otp','explicit_user_approved_operator') ORDER BY created_at DESC LOOP
  BEGIN p:=authz.authenticate(c.primary_proof);EXCEPTION WHEN insufficient_privilege THEN CONTINUE;END;
  IF p->>'actor_id'=i->>'actor_id' AND p->>'is_primary'='true' THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
END $$;

CREATE OR REPLACE FUNCTION authz.database_request_change(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;old jsonb;after_row jsonb;r authz.database_requests;e authz.engineering_requests;
 replacement authz.database_requests;typ text;op text;v_id uuid;rev bigint;project uuid;actor uuid;
 new_objects jsonb;new_until timestamptz;new_purpose text;reason text;prior authz.database_request_changes;
BEGIN
 i:=authz.authenticate(proof);typ:=coalesce(b->>'request_type','database');op:=b->>'operation';v_id:=(b->>'request_id')::uuid;rev:=(b->>'expected_revision')::bigint;
 reason:=btrim(coalesce(b->>'reason',''));
 IF typ NOT IN ('database','engineering') OR op IS NULL OR op NOT IN ('revise','withdraw','supersede') OR v_id IS NULL OR rev IS NULL OR rev<1 OR length(reason) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'change_operation_revision_and_reason_required' USING ERRCODE='22023';END IF;
 IF typ='database' THEN SELECT * INTO r FROM authz.database_requests WHERE database_requests.id=v_id FOR UPDATE;old:=to_jsonb(r);project:=r.project_id;actor:=r.actor_id;
 ELSE SELECT * INTO e FROM authz.engineering_requests WHERE engineering_requests.id=v_id FOR UPDATE;old:=to_jsonb(e);project:=e.project_id;actor:=e.actor_id;END IF;
 IF old->>'id' IS NULL OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,project) THEN RAISE EXCEPTION 'request_scope_required' USING ERRCODE='42501';END IF;
 IF actor IS DISTINCT FROM (i->>'actor_id')::uuid THEN
  IF op<>'supersede' OR NOT authz.engineering_can_manage(proof,project) THEN RAISE EXCEPTION 'request_owner_required' USING ERRCODE='42501';END IF;
  PERFORM authz.engineering_management_proof(proof,project);
 END IF;
 SELECT * INTO prior FROM authz.database_request_changes WHERE request_type=typ AND request_id=v_id AND revision=rev+1;
 IF (old->>'revision')::bigint<>rev THEN
  IF prior.id IS NOT NULL AND prior.actor_id=(i->>'actor_id')::uuid AND prior.client_id=(i->>'client_id')::uuid AND prior.input=b THEN
   RETURN jsonb_build_object('state',prior.after_snapshot->>'state','request',old,'change_id',prior.id,'replayed',true,'replacement_request_id',old->>'replacement_request_id');
  END IF;
  RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';
 END IF;
 IF old->>'state'<>'pending' THEN RAISE EXCEPTION 'only_pending_request_can_change' USING ERRCODE='40001';END IF;
 IF op='revise' THEN
  IF typ<>'database' OR b ? 'replacement_request_id' THEN RAISE EXCEPTION 'database_revision_only' USING ERRCODE='22023';END IF;
  new_objects:=authz.database_validate(proof,project,coalesce(b->'objects',r.objects));
  new_until:=coalesce((b->>'requested_until')::timestamptz,r.requested_until);new_purpose:=coalesce(b->>'purpose',r.purpose);
  IF length(btrim(new_purpose)) NOT BETWEEN 1 AND 4000 OR new_until<=clock_timestamp() OR new_until>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'invalid_revision' USING ERRCODE='22023';END IF;
  UPDATE authz.database_requests SET objects=new_objects,purpose=new_purpose,requested_until=new_until,revision=revision+1 WHERE database_requests.id=v_id RETURNING to_jsonb(database_requests.*) INTO after_row;
 ELSE
  IF b ? 'objects' OR b ? 'purpose' OR b ? 'requested_until' THEN RAISE EXCEPTION 'unexpected_revision_fields' USING ERRCODE='22023';END IF;
  IF op='supersede' THEN
   IF b->>'replacement_request_id' IS NULL OR b->>'expected_replacement_revision' IS NULL THEN RAISE EXCEPTION 'replacement_and_revision_required' USING ERRCODE='22023';END IF;
   SELECT * INTO replacement FROM authz.database_requests WHERE database_requests.id=(b->>'replacement_request_id')::uuid FOR SHARE;
   IF replacement.id IS NULL OR (typ='database' AND replacement.id=v_id) OR replacement.actor_id<>actor OR replacement.project_id<>project OR replacement.state NOT IN ('pending','approved') OR replacement.revision<>(b->>'expected_replacement_revision')::bigint OR replacement.requested_until<=clock_timestamp() THEN RAISE EXCEPTION 'replacement_must_be_current_same_subject_project' USING ERRCODE='40001';END IF;
  ELSIF b ? 'replacement_request_id' OR b ? 'expected_replacement_revision' THEN RAISE EXCEPTION 'unexpected_replacement_fields' USING ERRCODE='22023';END IF;
  IF typ='database' THEN
   UPDATE authz.database_requests SET state=CASE op WHEN 'withdraw' THEN 'withdrawn' ELSE 'superseded' END,revision=revision+1,replacement_request_id=replacement.id WHERE database_requests.id=v_id RETURNING to_jsonb(database_requests.*) INTO after_row;
  ELSE
   UPDATE authz.engineering_requests SET state=CASE op WHEN 'withdraw' THEN 'withdrawn' ELSE 'superseded' END,revision=revision+1,replacement_database_request_id=replacement.id WHERE engineering_requests.id=v_id RETURNING to_jsonb(engineering_requests.*) INTO after_row;
  END IF;
 END IF;
 INSERT INTO authz.database_request_changes(request_type,request_id,actor_id,client_id,revision,operation,input,before_snapshot,after_snapshot)
 VALUES(typ,v_id,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,rev+1,op,b,old,after_row) RETURNING * INTO prior;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details)
 VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz',typ||'.request.'||op,v_id,jsonb_build_object('change_id',prior.id,'revision',rev+1,'replacement_database_request_id',replacement.id,'reason',reason));
 RETURN jsonb_build_object('state',after_row->>'state','request_type',typ,'request',after_row,'change_id',prior.id,'replacement_request',CASE WHEN replacement.id IS NOT NULL THEN to_jsonb(replacement) ELSE NULL END,'permission_effect','request_only;no_grant_created_or_revoked');
END $$;

CREATE OR REPLACE FUNCTION authz.database_request_history(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;project uuid;actor uuid;typ text;items jsonb;
BEGIN
 i:=authz.authenticate(proof);typ:=coalesce(b->>'request_type','database');
 IF typ='database' THEN SELECT project_id,actor_id INTO project,actor FROM authz.database_requests WHERE id=(b->>'request_id')::uuid;
 ELSIF typ='engineering' THEN SELECT project_id,actor_id INTO project,actor FROM authz.engineering_requests WHERE id=(b->>'request_id')::uuid;
 ELSE RAISE EXCEPTION 'invalid_request_type' USING ERRCODE='22023';END IF;
 IF project IS NULL OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,project) OR (actor<>(i->>'actor_id')::uuid AND NOT authz.engineering_can_manage(proof,project)) THEN RAISE EXCEPTION 'request_scope_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.revision),'[]') INTO items FROM authz.database_request_changes c WHERE request_type=typ AND request_id=(b->>'request_id')::uuid;
 RETURN jsonb_build_object('state','read','request_type',typ,'request_id',b->>'request_id','items',items);
END $$;

CREATE OR REPLACE FUNCTION authz.engineering_context_register(proof text, primary_proof text, p_project uuid, p_source text, p_until timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;p jsonb;id uuid;temporary_actions text[]:='{}';
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_source NOT IN('verified_email_otp','explicit_user_approved_operator') OR p_until>clock_timestamp()+interval '3 hours' OR p_until<=clock_timestamp() THEN RAISE EXCEPTION 'invalid_management_context' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);p:=authz.authenticate(primary_proof);
 IF i->>'actor_id' IS DISTINCT FROM p->>'actor_id' OR p->>'is_primary'<>'true' THEN RAISE EXCEPTION 'same_current_primary_required' USING ERRCODE='42501';END IF;
 -- The OTP session is a temporary software management context; original client actions are not changed.
 -- Current authorization sources, project filters, actor/software/credential and expiry still apply.
 IF i->'client_actions' ? 'hufu.vault.read' AND (
  (p_project IS NULL AND i->'scope_filters'='[]'::jsonb AND EXISTS(SELECT FROM authz.principals WHERE principals.id=(i->>'actor_id')::uuid AND active AND role='organization_admin')) OR
  (p_project IS NOT NULL AND authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) AND EXISTS(
   SELECT FROM v8.projects pr JOIN authz.principals a ON a.id=(i->>'actor_id')::uuid WHERE pr.id=p_project AND pr.state='active' AND a.active AND pr.organization_id=a.organization_id AND
   (pr.manager_id=a.id OR (pr.visibility='personal' AND pr.owner_id=a.id) OR a.role='organization_admin' OR EXISTS(
    SELECT FROM authz.qualifications q WHERE q.project_id=pr.id AND q.principal_id=a.id AND 'credential.manage'=ANY(q.actions) AND authz.management_valid(q.id,a.id,pr.id)))))
 ) THEN temporary_actions:=CASE WHEN p_project IS NULL THEN ARRAY['hufu.vault.decide','hufu.vault.delivery.manage'] ELSE ARRAY['hufu.vault.decide'] END;END IF;
 -- The operator variant is installed only by the server administrator, not exposed publicly.
 INSERT INTO authz.engineering_contexts(actor_id,client_id,credential_id,primary_proof,project_id,authority_source,expires_at,authorized_actions)
 VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,primary_proof,p_project,p_source,p_until,temporary_actions) RETURNING engineering_contexts.id INTO id;
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details)
 VALUES((i->>'actor_id')::uuid,(i->>'client_id')::uuid,'authz','engineering.context',id,jsonb_build_object('source',p_source,'project_id',p_project,'expires_at',p_until,'authorized_actions',to_jsonb(temporary_actions),'email_verification_claimed',p_source='verified_email_otp'));
 RETURN jsonb_build_object('state','management_ready','context_id',id,'expires_at',p_until,'authority_source',p_source,'authorized_actions',to_jsonb(temporary_actions),'original_software_unchanged',true,'project_id',p_project);
END $function$;

CREATE OR REPLACE FUNCTION vault2.delivery_request_manager(i jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
 SELECT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND role='organization_admin')
 AND (coalesce((i->>'is_primary')::boolean,false)
 OR (i->'scope_filters'='[]'::jsonb AND i->'client_actions' ? 'hufu.credential.manage')
 OR (i->'scope_filters'='[]'::jsonb AND i->'client_actions' ? 'hufu.vault.decide' AND authz.management_context_valid(i,NULL))
 OR (i->'scope_filters'='[]'::jsonb AND i->'client_actions' ? 'hufu.vault.read' AND authz.management_context_allows(i,NULL,'hufu.vault.delivery.manage')))
$$;

CREATE OR REPLACE FUNCTION vault2.may_decide_deadline(i jsonb, e vault2.entries)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault2'
AS $function$
DECLARE p authz.principals;pr v8.projects;q authz.qualifications;root authz.qualifications;deadline timestamptz;best timestamptz;
BEGIN
 IF NOT authz.client_resource_allowed745((i->>'client_id')::uuid,e.project_id,e.id,e.name)THEN RETURN NULL;END IF;
 -- Existing full manager path remains valid; decide-only never expands it.
 IF EXISTS(SELECT FROM authz.clients WHERE id=(i->>'client_id')::uuid AND active AND 'hufu.credential.manage'=ANY(actions))THEN RETURN vault2.manager_deadline(i,e);END IF;
 IF NOT (i->'client_actions' ? 'hufu.vault.read' AND authz.management_context_allows(i,e.project_id,'hufu.vault.decide')) THEN
 BEGIN PERFORM authz.require_client_capability(i,'hufu.vault.decide');EXCEPTION WHEN insufficient_privilege THEN RETURN NULL;END;END IF;
 SELECT * INTO p FROM authz.principals WHERE id=(i->>'actor_id')::uuid;SELECT * INTO pr FROM v8.projects WHERE id=e.project_id;
 IF p.active IS DISTINCT FROM true OR pr.state IS DISTINCT FROM'active'OR p.organization_id IS DISTINCT FROM e.organization_id OR pr.organization_id IS DISTINCT FROM e.organization_id THEN RETURN NULL;END IF;
 -- Same real principal, original client filters and decide ceiling; confirmation is not a grant.
 IF authz.management_context_valid(i,e.project_id) AND
 (p.role='organization_admin' OR pr.manager_id=p.id OR (pr.visibility='personal' AND pr.owner_id=p.id)) THEN RETURN 'infinity'::timestamptz;END IF;
 -- Approver-only access requires a real current credential.manage management qualification.
 -- A legacy role/name/mission/sponsor is not a new grant or a substitute for this fact.
 FOR q IN SELECT * FROM authz.qualifications WHERE principal_id=p.id AND project_id=e.project_id AND 'credential.manage'=ANY(actions)LOOP
  IF authz.management_valid(q.id,p.id,e.project_id)AND authz.selector_matches(q.resource_selector,e.project_id,jsonb_build_object('project_id',e.project_id,'area_id',e.area_id))THEN
   deadline:=CASE WHEN q.until_revoked THEN'infinity'::timestamptz ELSE q.expires_at END;
   IF q.parent_id IS NOT NULL THEN SELECT * INTO root FROM authz.qualifications WHERE id=q.parent_id;deadline:=least(deadline,CASE WHEN root.until_revoked THEN'infinity'::timestamptz ELSE root.expires_at END);END IF;
   IF deadline>clock_timestamp()THEN best:=greatest(best,deadline);END IF;
  END IF;
 END LOOP;RETURN best;
END$function$;


CREATE OR REPLACE FUNCTION authz.management_context_status(proof text,p_project uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF p_project IS NOT NULL AND NOT authz.client_resource_allowed745((i->>'client_id')::uuid,p_project) THEN RAISE EXCEPTION 'project_scope_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('context_id',c.id,'project_id',c.project_id,'expires_at',c.expires_at,'authorized_actions',to_jsonb(c.authorized_actions),'authority_source',c.authority_source) ORDER BY c.created_at DESC),'[]') INTO items
 FROM authz.engineering_contexts c WHERE c.actor_id=(i->>'actor_id')::uuid AND c.client_id=(i->>'client_id')::uuid AND c.credential_id=(i->>'credential_id')::uuid AND c.expires_at>clock_timestamp() AND (c.project_id IS NULL OR c.project_id=p_project);
 RETURN jsonb_build_object('state','read','actor_id',i->>'actor_id','client_id',i->>'client_id','contexts',items,'management_verified',authz.management_context_valid(i,p_project),'vault_decide_context_ready',authz.management_context_allows(i,p_project,'hufu.vault.decide'),'current_project_management_source',CASE WHEN p_project IS NOT NULL THEN authz.engineering_can_manage(proof,p_project) ELSE EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND role='organization_admin') END,'effect','confirmation_only;each_specialist_rechecks_current_management_source_and_original_scope');
END $$;
REVOKE ALL ON FUNCTION authz.management_context_status(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.management_context_status(text,uuid) TO hub2_hufu;

REVOKE ALL ON FUNCTION authz.database_scope_subset(jsonb,jsonb),authz.management_context_valid(jsonb,uuid),authz.management_context_allows(jsonb,uuid,text),authz.database_request_change(text,jsonb),authz.database_request_history(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.database_request_change(text,jsonb),authz.database_request_history(text,jsonb),authz.management_context_valid(jsonb,uuid),authz.management_context_allows(jsonb,uuid,text) TO hub2_hufu;
COMMIT;
