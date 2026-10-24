-- Counts are evidence for Agent judgment. No runtime receives migration/schema-upgrade authority.
GRANT SELECT(id,actor_id,project_id,fingerprint) ON mem.text_drafts TO hub2_authz_owner;
GRANT SELECT(id,actor_id,project_id,fingerprint,material_id) ON mem.operations TO hub2_authz_owner;
GRANT SELECT(id,actor_id,project_id) ON mem.processing_runs TO hub2_authz_owner;
SET ROLE hub2_authz_owner;
CREATE FUNCTION authz.usage_context(hid uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;audience text;p jsonb;s record;resources jsonb:='[]';owner_only boolean:=false;draft uuid;operation uuid;source_state text:='unknown';
BEGIN
 audience:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' ELSE NULL END;
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF audience IS NULL OR h.audience IS DISTINCT FROM audience THEN RAISE EXCEPTION 'usage_audience_mismatch' USING ERRCODE='42501';END IF;
 -- This is a committed observation, not a new business effect. Later TTL/revocation does not erase the fact.
 IF h.id IS NULL OR h.consumed_at IS NULL THEN RETURN NULL;END IF;
 p:=COALESCE(h.resource->'resolved_resource',h.resource);
 IF audience='mem' THEN
  SELECT id INTO draft FROM mem.text_drafts WHERE actor_id=h.principal_id AND project_id=h.project_id AND (id::text=p->>'resume_id' OR fingerprint=h.request_digest) LIMIT 1;
  owner_only:=draft IS NOT NULL OR p->>'processing_run_id' IS NOT NULL OR p->>'run_id' IS NOT NULL;
  IF p->>'material_id' IS NULL THEN SELECT material_id INTO operation FROM mem.operations WHERE actor_id=h.principal_id AND project_id=h.project_id AND (id::text=p->>'operation_id' OR fingerprint=h.request_digest) LIMIT 1;END IF;
 END IF;
 resources:=jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('role','primary','domain',audience,'project_id',h.project_id,'material_id',COALESCE(p->>'material_id',operation::text),'version_id',p->>'version_id','collection_id',p->>'collection_id','area_id',p->>'area_id','work_item_id',p->>'work_item_id')));
 FOR s IN SELECT resource FROM authz.handle_sources WHERE handle_id=hid LOOP
  resources:=resources||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('role','source','domain','mem','project_id',s.resource->'project_id','material_id',s.resource->'material_id','version_id',s.resource->'version_id','collection_id',s.resource->'collection_id','area_id',s.resource->'area_id')));
 END LOOP;
 IF h.source_context_id IS NOT NULL AND EXISTS(SELECT FROM authz.source_contexts WHERE id=h.source_context_id AND provider<>'unknown') THEN source_state:='source_context_bound';END IF;
 RETURN jsonb_build_object('actor_id',h.principal_id,'client_id',h.client_id,'project_id',h.project_id,'source_context_id',h.source_context_id,'source_state',source_state,'resources',resources,'owner_only',owner_only);
END $$;
CREATE FUNCTION authz.governance_manager(hid uuid,r jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.handles;pr v8.projects;q authz.qualifications;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR (r->>'project_id')::uuid IS DISTINCT FROM h.project_id THEN RETURN false;END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=h.project_id;
 IF pr.manager_id=h.principal_id OR (pr.visibility='personal' AND pr.owner_id=h.principal_id) THEN RETURN true;END IF;
 FOR q IN SELECT * FROM authz.qualifications WHERE principal_id=h.principal_id AND project_id=h.project_id AND kind='management' LOOP
  IF authz.management_valid(q.id,h.principal_id,h.project_id) AND authz.selector_matches(q.resource_selector,h.project_id,r) THEN RETURN true;END IF;
 END LOOP;RETURN false;
END $$;
REVOKE ALL ON FUNCTION authz.usage_context(uuid),authz.governance_manager(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.usage_context(uuid),authz.governance_manager(uuid,jsonb) TO hub2_evidence_owner;
GRANT EXECUTE ON FUNCTION authz.request_roots(jsonb,text) TO hub2_v8_owner;
RESET ROLE;

SET ROLE hub2_evidence_owner;
ALTER TABLE jobs.tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE jobs.tasks ADD CONSTRAINT tasks_kind_check CHECK(kind IN ('index','verification_compensation','projection_invalidation','maintenance','governance_rollup','mem_gc_dry_run','read_temp_cleanup','property_snapshot'));
ALTER TABLE evidence.logical_requests ADD COLUMN actor_id uuid,ADD COLUMN client_id uuid,ADD COLUMN project_id uuid,ADD COLUMN authority_resources jsonb NOT NULL DEFAULT '[]',ADD COLUMN owner_only boolean NOT NULL DEFAULT true,ADD COLUMN scope_state text NOT NULL DEFAULT 'unknown',ADD COLUMN source_state text NOT NULL DEFAULT 'unknown';
CREATE INDEX logical_requests_scope_window ON evidence.logical_requests(project_id,actor_id,occurred_at);
CREATE INDEX logical_requests_project_window ON evidence.logical_requests(project_id,occurred_at DESC,request_id) WHERE scope_state='trusted';
CREATE FUNCTION evidence.record_usage_scoped(request uuid,action text,schema_version text,traffic text,success boolean,coverage text,result_count bigint,duration_ms double precision,paths jsonb,handles uuid[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
DECLARE hid uuid;c jsonb;actor uuid;client uuid;project uuid;source uuid;resources jsonb:='[]';private boolean:=false;contexts integer:=0;state text:='unknown';source_state text:='unknown';existing evidence.logical_requests;service text;
BEGIN
 IF handles IS NULL OR cardinality(handles)>200 THEN RAISE EXCEPTION 'invalid_usage_handles';END IF;
 service:=CASE session_user WHEN 'hub2_mem' THEN 'mem' WHEN 'hub2_v8' THEN 'v8' ELSE NULL END;
 IF service IS NULL THEN RAISE EXCEPTION 'domain_usage_required' USING ERRCODE='42501';END IF;
 FOREACH hid IN ARRAY handles LOOP
  c:=authz.usage_context(hid);IF c IS NULL THEN CONTINUE;END IF;
  IF contexts=0 THEN actor:=(c->>'actor_id')::uuid;client:=(c->>'client_id')::uuid;project:=(c->>'project_id')::uuid;source:=(c->>'source_context_id')::uuid;source_state:=c->>'source_state';
  ELSIF actor IS DISTINCT FROM (c->>'actor_id')::uuid OR client IS DISTINCT FROM (c->>'client_id')::uuid OR project IS DISTINCT FROM (c->>'project_id')::uuid THEN RAISE EXCEPTION 'usage_scope_identity_conflict' USING ERRCODE='23505';END IF;
  IF source IS DISTINCT FROM (c->>'source_context_id')::uuid THEN source:=NULL;source_state:='mixed_or_unknown';END IF;
  resources:=resources||(c->'resources');private:=private OR (c->>'owner_only')::boolean;contexts:=contexts+1;
 END LOOP;
 SELECT COALESCE(jsonb_agg(value ORDER BY value::text),'[]') INTO resources FROM (SELECT DISTINCT value FROM jsonb_array_elements(resources)) normalized;
 IF contexts>0 AND jsonb_array_length(resources)<=200 THEN state:='trusted';ELSE resources:='[]';state:='unknown';private:=true;END IF;
 SELECT * INTO existing FROM evidence.logical_requests lr WHERE lr.request_id=request AND lr.service=service AND lr.action=action;
 IF existing.request_id IS NOT NULL AND existing.source_context_id IS DISTINCT FROM source THEN source:=existing.source_context_id;source_state:='mixed_or_unknown';END IF;
 PERFORM evidence.record_usage(request,action,schema_version,source,traffic,success,coverage,result_count,duration_ms,paths);
 SELECT * INTO existing FROM evidence.logical_requests lr WHERE lr.request_id=request AND lr.service=service AND lr.action=action FOR UPDATE;
 IF existing.scope_state='trusted' AND state='trusted' AND (existing.actor_id,existing.client_id,existing.project_id) IS DISTINCT FROM (actor,client,project) THEN RAISE EXCEPTION 'logical_request_scope_conflict' USING ERRCODE='23505';END IF;
 IF existing.scope_state<>'trusted' OR state='trusted' THEN UPDATE evidence.logical_requests lr SET actor_id=actor,client_id=client,project_id=project,authority_resources=resources,owner_only=private,scope_state=state,source_state=source_state,success=lr.success OR success WHERE lr.request_id=request AND lr.service=service AND lr.action=action;END IF;
END $$;

-- Literal object keys and normalized array wildcards. Counts never contain field values.
CREATE FUNCTION evidence.json_property_paths(value jsonb,root text DEFAULT 'properties',dynamic text[] DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,evidence AS $$
DECLARE queue jsonb:=jsonb_build_array(jsonb_build_object('value',value,'path',root,'depth',0));item jsonb;child jsonb;key text;path text;seen jsonb:='{}';nodes integer:=0;incomplete boolean:=false;
BEGIN
 WHILE jsonb_array_length(queue)>0 LOOP
  item:=queue->0;queue:=queue-0;nodes:=nodes+1;
  IF nodes>2000 THEN incomplete:=true;EXIT;END IF;
  IF (item->>'depth')::integer>12 OR length(item->>'path')>240 THEN incomplete:=true;CONTINUE;END IF;
  IF item->>'path'<>root THEN seen:=seen||jsonb_build_object(item->>'path',true);END IF;
  IF jsonb_typeof(item->'value')='object' THEN
   FOR key,child IN SELECT * FROM jsonb_each(item->'value') LOOP
    IF jsonb_array_length(queue)>=2000 THEN incomplete:=true;EXIT;END IF;
    path:=(item->>'path')||CASE WHEN (item->>'path')=ANY(dynamic) THEN '.*' WHEN key ~ '^[A-Za-z_$][A-Za-z0-9_$]*$' THEN '.'||key ELSE '['||to_jsonb(key)::text||']' END;
    queue:=queue||jsonb_build_array(jsonb_build_object('value',CASE WHEN jsonb_typeof(child) IN ('object','array') THEN child ELSE 'null'::jsonb END,'path',path,'depth',(item->>'depth')::integer+1));
   END LOOP;
  ELSIF jsonb_typeof(item->'value')='array' THEN
   FOR child IN SELECT * FROM jsonb_array_elements(item->'value') LIMIT 64 LOOP queue:=queue||jsonb_build_array(jsonb_build_object('value',CASE WHEN jsonb_typeof(child) IN ('object','array') THEN child ELSE 'null'::jsonb END,'path',(item->>'path')||'[*]','depth',(item->>'depth')::integer+1));END LOOP;
   IF jsonb_array_length(item->'value')>64 THEN incomplete:=true;END IF;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('paths',COALESCE((SELECT jsonb_agg(path_key ORDER BY path_key) FROM jsonb_object_keys(seen) path_key),'[]'),'incomplete',incomplete);
END $$;
CREATE FUNCTION evidence.count_property_objects(objects jsonb,max_paths integer DEFAULT 200,dynamic text[] DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,evidence AS $$
DECLARE object jsonb;path jsonb;paths jsonb;counts jsonb:='{}';observed integer:=0;unknown integer:=0;rows jsonb;truncated boolean;
BEGIN
 IF max_paths NOT BETWEEN 1 AND 4096 OR cardinality(dynamic)>20 OR jsonb_typeof(objects) IS DISTINCT FROM 'array' OR jsonb_array_length(objects)>500 THEN RAISE EXCEPTION 'invalid_property_sample';END IF;
 FOR object IN SELECT * FROM jsonb_array_elements(objects) LOOP
  observed:=observed+1;paths:=evidence.json_property_paths(object,'properties',dynamic);
  IF (paths->>'incomplete')::boolean THEN unknown:=unknown+1;END IF;
  FOR path IN SELECT * FROM jsonb_array_elements(paths->'paths') LOOP counts:=counts||jsonb_build_object(path#>>'{}',COALESCE((counts->>(path#>>'{}'))::integer,0)+1);END LOOP;
 END LOOP;
 truncated:=(SELECT count(*) FROM jsonb_each(counts))>max_paths;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('path',key,'objects_with_path',value::text::bigint,'observed_objects',observed,'rate',CASE WHEN observed>0 THEN value::text::numeric/observed ELSE NULL END) ORDER BY key),'[]') INTO rows FROM (SELECT key,value FROM jsonb_each(counts) ORDER BY key LIMIT max_paths) paths;
 RETURN jsonb_build_object('observed_objects',observed,'unknown_path_objects',unknown,'rate_coverage',CASE WHEN unknown>0 THEN 'lower_bound_for_incomplete_object_paths' ELSE 'exact_within_observed_sample' END,'items',rows,'path_truncated',truncated,'coverage','current_authorized_bounded_sample','restricted_objects','not_counted_or_disclosed','denominator','observed_authorized_objects_only','values','not_recorded','dynamic_keys',CASE WHEN cardinality(dynamic)>0 THEN 'caller_declared_containers_normalized' ELSE 'literal_keys_not_semantic_schema_fields' END,'adoption_effect','not_measured');
END $$;
REVOKE ALL ON FUNCTION evidence.record_usage_scoped(uuid,text,text,text,boolean,text,bigint,double precision,jsonb,uuid[]),evidence.json_property_paths(jsonb,text,text[]),evidence.count_property_objects(jsonb,integer,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.record_usage_scoped(uuid,text,text,text,boolean,text,bigint,double precision,jsonb,uuid[]) TO hub2_mem,hub2_v8;
GRANT EXECUTE ON FUNCTION evidence.count_property_objects(jsonb,integer,text[]),evidence.json_property_paths(jsonb,text,text[]),evidence.worker_guard(text) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;

SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.governance_json_visible(h uuid,value jsonb) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,mem AS $$
DECLARE ref record;item jsonb;candidate text;vid uuid;
BEGIN
 FOR ref IN SELECT * FROM authz.request_roots(value,'mem.read') LOOP PERFORM mem.assert_version_sources(h,ref.version_id,'mem.read');END LOOP;
 IF jsonb_typeof(value->'source'->'actual_inputs')='array' THEN FOR item IN SELECT * FROM jsonb_array_elements(value->'source'->'actual_inputs') LOOP
  candidate:=CASE WHEN jsonb_typeof(item)='object' THEN item->>'version_id' WHEN jsonb_typeof(item)='string' THEN item#>>'{}' ELSE NULL END;
  IF candidate ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN SELECT id INTO vid FROM mem.content_versions WHERE id=candidate::uuid;IF vid IS NOT NULL THEN PERFORM mem.assert_version_sources(h,vid,'mem.read');END IF;END IF;
 END LOOP;END IF;
 IF value->>'base_version_id' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN SELECT id INTO vid FROM mem.content_versions WHERE id=(value->>'base_version_id')::uuid;IF vid IS NOT NULL THEN PERFORM mem.assert_version_sources(h,vid,'mem.read');END IF;END IF;
 RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
CREATE FUNCTION mem.governance_resource_visible(h uuid,c jsonb,r jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE m mem.materials;v mem.content_versions;
BEGIN
 IF r->>'material_id' IS NOT NULL THEN
  SELECT * INTO m FROM mem.materials WHERE id=(r->>'material_id')::uuid AND project_id=(r->>'project_id')::uuid;
  IF m.id IS NULL OR (m.current_version_id IS NULL AND m.owner_id IS DISTINCT FROM (c->>'actor_id')::uuid) THEN RETURN false;END IF;
  IF r->>'version_id' IS NULL AND m.current_version_id IS NOT NULL THEN PERFORM mem.assert_version_sources(h,m.current_version_id,'mem.read');END IF;
 END IF;
 IF r->>'version_id' IS NOT NULL THEN
  SELECT * INTO v FROM mem.content_versions WHERE id=(r->>'version_id')::uuid;
  IF v.id IS NULL OR (r->>'material_id' IS NOT NULL AND v.material_id::text IS DISTINCT FROM r->>'material_id') THEN RETURN false;END IF;
  PERFORM mem.assert_version_sources(h,v.id,'mem.read');
 END IF;
 PERFORM authz.assert_sources(h,jsonb_build_array(r-'role'-'domain'),'mem.read');RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION mem.governance_json_visible(uuid,jsonb),mem.governance_resource_visible(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.governance_json_visible(uuid,jsonb),mem.governance_resource_visible(uuid,jsonb,jsonb) TO hub2_evidence_owner,hub2_v8_owner;
RESET ROLE;
SET ROLE hub2_v8_owner;
CREATE FUNCTION v8.governance_resource_visible(h uuid,c jsonb,r jsonb) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
BEGIN
 IF r->>'work_item_id' IS NOT NULL AND NOT EXISTS(SELECT FROM v8.work_items WHERE id=(r->>'work_item_id')::uuid AND project_id=(r->>'project_id')::uuid) THEN RETURN false;END IF;
 PERFORM authz.assert_request_resource(h,r-'role'-'domain');RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION v8.governance_resource_visible(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.governance_resource_visible(uuid,jsonb,jsonb) TO hub2_evidence_owner;
RESET ROLE;
GRANT SELECT(id,project_id,material_id,collection_id,active) ON mem.placements TO hub2_evidence_owner;

SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.usage_row_visible(h uuid,c jsonb,b jsonb,entry evidence.logical_requests) RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,evidence AS $$
DECLARE r jsonb;
BEGIN
 IF entry.scope_state<>'trusted' OR entry.project_id IS DISTINCT FROM (c->>'project_id')::uuid OR (entry.owner_only AND entry.actor_id IS DISTINCT FROM (c->>'actor_id')::uuid) THEN RETURN false;END IF;
 IF COALESCE(b->>'mode','self')='self' AND entry.actor_id IS DISTINCT FROM (c->>'actor_id')::uuid THEN RETURN false;END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(entry.authority_resources) LOOP
  IF r->>'role'='primary' THEN
   IF b->>'material_id' IS NOT NULL AND r->>'material_id' IS DISTINCT FROM b->>'material_id' THEN RETURN false;END IF;
   IF b->>'work_item_id' IS NOT NULL AND r->>'work_item_id' IS DISTINCT FROM b->>'work_item_id' THEN RETURN false;END IF;
   IF b->>'collection_id' IS NOT NULL AND r->>'collection_id' IS DISTINCT FROM b->>'collection_id' AND NOT EXISTS(SELECT FROM mem.placements WHERE active AND material_id=(r->>'material_id')::uuid AND collection_id=(b->>'collection_id')::uuid AND project_id=(c->>'project_id')::uuid) THEN RETURN false;END IF;
   IF b->>'mode'='project' AND NOT authz.governance_manager(h,r) THEN RETURN false;END IF;
  END IF;
  IF r->>'domain'='v8' AND r->>'role'='primary' THEN IF NOT v8.governance_resource_visible(h,c,r) THEN RETURN false;END IF;
  ELSIF NOT mem.governance_resource_visible(h,c,r) THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE FUNCTION evidence.scoped_usage_report(h uuid,c jsonb,b jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE start_at timestamptz:=COALESCE((b->>'window_start')::timestamptz,clock_timestamp()-interval '30 days');end_at timestamptz:=COALESCE((b->>'window_end')::timestamptz,clock_timestamp());n integer:=COALESCE((b->>'max_requests')::integer,200);max_paths integer:=COALESCE((b->>'max_paths')::integer,200);entry evidence.logical_requests;ids uuid[]:='{}';actions text[]:='{}';services text[]:='{}';used jsonb;coverage jsonb;observed integer:=0;paths_total integer;
BEGIN
 IF end_at<=start_at OR n NOT BETWEEN 1 AND 500 OR max_paths NOT BETWEEN 1 AND 200 OR COALESCE(b->>'mode','self') NOT IN ('self','project') THEN RAISE EXCEPTION 'invalid_usage_window';END IF;
 IF b->>'mode'='project' AND NOT authz.governance_manager(h,b) THEN RAISE EXCEPTION 'governance_management_required' USING ERRCODE='42501';END IF;
 FOR entry IN SELECT * FROM evidence.logical_requests lr WHERE lr.project_id=(c->>'project_id')::uuid AND lr.scope_state='trusted' AND lr.occurred_at>=start_at AND lr.occurred_at<end_at AND (b->>'mode'='project' OR lr.actor_id=(c->>'actor_id')::uuid) ORDER BY lr.occurred_at DESC,lr.request_id LIMIT n LOOP
  IF evidence.usage_row_visible(h,c,b,entry) THEN ids:=array_append(ids,entry.request_id);actions:=array_append(actions,entry.action);services:=array_append(services,entry.service);observed:=observed+1;END IF;
 END LOOP;
 SELECT count(*) INTO paths_total FROM (SELECT u.path,u.purpose,u.service,u.action,u.schema_version,r.traffic_kind FROM evidence.field_usage u JOIN evidence.logical_requests r USING(request_id,service,action) JOIN unnest(ids,actions,services) selected(request_id,action,service) USING(request_id,action,service) GROUP BY u.path,u.purpose,u.service,u.action,u.schema_version,r.traffic_kind) allpaths;
 SELECT COALESCE(jsonb_agg(to_jsonb(x)||jsonb_build_object('rate',x.used_requests::numeric/nullif(x.observed_requests,0)) ORDER BY x.service,x.action,x.path,x.purpose),'[]') INTO used FROM (
  SELECT u.service,u.action,u.schema_version,r.traffic_kind,u.path,u.purpose,count(*) used_requests,
  (SELECT count(*) FROM evidence.logical_requests denominator JOIN unnest(ids,actions,services) selected(request_id,action,service) USING(request_id,action,service) WHERE denominator.service=u.service AND denominator.action=u.action AND denominator.schema_version=u.schema_version AND denominator.traffic_kind=r.traffic_kind) observed_requests
  FROM evidence.field_usage u JOIN evidence.logical_requests r USING(request_id,service,action) JOIN unnest(ids,actions,services) selected(request_id,action,service) USING(request_id,action,service)
  GROUP BY u.service,u.action,u.schema_version,r.traffic_kind,u.path,u.purpose ORDER BY u.service,u.action,u.path,u.purpose LIMIT max_paths) x;
 SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]') INTO coverage FROM (SELECT r.coverage,r.source_state,count(*) requests FROM evidence.logical_requests r JOIN unnest(ids,actions,services) selected(request_id,action,service) USING(request_id,action,service) GROUP BY r.coverage,r.source_state) x;
 IF b->>'mode'='project' AND NOT authz.governance_manager(h,b) THEN RAISE EXCEPTION 'governance_management_required' USING ERRCODE='42501';END IF;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('window_start',start_at,'window_end',end_at,'mode',COALESCE(b->>'mode','self'),'observed_requests',observed,'items',used,'coverage',coverage,'sampling','bounded_current_authorized_request_history','scan_limit',n,'path_truncated',paths_total>max_paths,'historical_scope_missing','unknown_excluded_not_backfilled','direct_sql_and_offline','unknown','consumer_field_use','unknown_api_parameter_paths_only','whole_json_return','response_is_separate_path_not_every_leaf_use','adoption_effect','not_measured','restricted_requests','not_counted_or_disclosed');
END $$;
REVOKE ALL ON FUNCTION evidence.usage_row_visible(uuid,jsonb,jsonb,evidence.logical_requests),evidence.scoped_usage_report(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.scoped_usage_report(uuid,jsonb,jsonb) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
GRANT USAGE ON SCHEMA authz,v8,mem TO hub2_evidence_owner;
GRANT EXECUTE ON FUNCTION authz.assert_effect(uuid) TO hub2_evidence_owner;

SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.field_governance(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE b jsonb;c jsonb;m mem.materials;draft mem.text_drafts;materials jsonb:='[]';drafts jsonb:='[]';n integer;usage jsonb;current_at timestamptz:=clock_timestamp();r jsonb;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=mem.guard(h,'mem.read',d,b);n:=COALESCE((b->>'max_objects')::integer,100);
 IF n NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_governance_limit';END IF;
 FOR m IN SELECT * FROM mem.materials mm WHERE project_id=(c->>'project_id')::uuid AND state='active' AND (b->>'material_id' IS NULL OR id=(b->>'material_id')::uuid) AND (b->>'collection_id' IS NULL OR EXISTS(SELECT FROM mem.placements p WHERE p.material_id=mm.id AND p.active AND p.collection_id=(b->>'collection_id')::uuid)) ORDER BY id LIMIT 1000 LOOP
  r:=jsonb_build_object('project_id',m.project_id,'material_id',m.id);
  IF NOT mem.governance_resource_visible(h,c,r) OR NOT mem.governance_json_visible(h,jsonb_build_object('properties',m.properties)) THEN CONTINUE;END IF;
  materials:=materials||jsonb_build_array(m.properties);IF jsonb_array_length(materials)>=n THEN EXIT;END IF;
 END LOOP;
 FOR draft IN SELECT * FROM mem.text_drafts WHERE actor_id=(c->>'actor_id')::uuid AND project_id=(c->>'project_id')::uuid AND (b->>'material_id' IS NULL OR body->>'material_id'=b->>'material_id') AND (b->>'collection_id' IS NULL OR EXISTS(SELECT FROM mem.placements p WHERE p.active AND p.material_id=(body->>'material_id')::uuid AND p.collection_id=(b->>'collection_id')::uuid)) ORDER BY id LIMIT 1000 LOOP
  IF NOT mem.governance_json_visible(h,draft.body) THEN CONTINUE;END IF;
  IF draft.body->>'material_id' IS NOT NULL AND NOT mem.governance_resource_visible(h,c,jsonb_build_object('project_id',draft.project_id,'material_id',draft.body->>'material_id')) THEN CONTINUE;END IF;
  drafts:=drafts||jsonb_build_array(COALESCE(draft.body->'properties','{}'));IF jsonb_array_length(drafts)>=n THEN EXIT;END IF;
 END LOOP;
 usage:=evidence.scoped_usage_report(h,c,b);
 PERFORM authz.assert_effect(h);
 RETURN evidence.governance_response_budget(jsonb_build_object('state','read','measured_at',current_at,'appearance',jsonb_build_object('material_properties',evidence.count_property_objects(materials,COALESCE((b->>'max_paths')::integer,200),ARRAY(SELECT jsonb_array_elements_text(COALESCE(b->'dynamic_containers','[]')))),'own_text_draft_properties',evidence.count_property_objects(drafts,COALESCE((b->>'max_paths')::integer,200),ARRAY(SELECT jsonb_array_elements_text(COALESCE(b->'dynamic_containers','[]'))))),'request_usage',usage,'history','request_window_is_historical_appearance_is_current','schema_change','agent_proposal_only_no_ddl_authority','unknown_scope','old_observations_not_attributed_or_backfilled'));
END $$;
REVOKE ALL ON FUNCTION mem.field_governance(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.field_governance(uuid,text,text) TO hub2_mem;
RESET ROLE;
SET ROLE hub2_v8_owner;
CREATE FUNCTION v8.field_governance(h uuid,d text,payload text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;entry record;properties jsonb:='[]';explanations jsonb:='[]';judgments jsonb:='[]';n integer;usage jsonb;current_at timestamptz:=clock_timestamp();visible boolean;
BEGIN
 IF payload IS NULL OR encode(public.digest(payload,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;b:=payload::jsonb;c:=v8.guard(h,'v8.work.read',d,b);n:=COALESCE((b->>'max_objects')::integer,100);
 IF n NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_governance_limit';END IF;
 FOR entry IN SELECT u.payload FROM v8.work_updates u JOIN v8.work_items w ON w.id=u.work_item_id WHERE w.project_id=(c->>'project_id')::uuid AND (b->>'work_item_id' IS NULL OR w.id=(b->>'work_item_id')::uuid) ORDER BY u.id LIMIT 1000 LOOP
  BEGIN visible:=v8.authorized_statement(h,c,entry.payload);EXCEPTION WHEN invalid_text_representation THEN visible:=mem.governance_json_visible(h,entry.payload);END;
  IF NOT visible THEN CONTINUE;END IF;
  properties:=properties||jsonb_build_array(COALESCE(entry.payload->'properties','{}'));explanations:=explanations||jsonb_build_array(COALESCE(entry.payload->'explanation','{}'));IF jsonb_array_length(properties)>=n THEN EXIT;END IF;
 END LOOP;
 FOR entry IN SELECT j.payload FROM v8.impact_judgments j WHERE project_id=(c->>'project_id')::uuid AND (b->>'work_item_id' IS NULL OR work_item_id=(b->>'work_item_id')::uuid) ORDER BY id LIMIT 1000 LOOP
  BEGIN visible:=v8.authorized_statement(h,c,entry.payload);EXCEPTION WHEN invalid_text_representation THEN visible:=mem.governance_json_visible(h,entry.payload);END;
  IF NOT visible THEN CONTINUE;END IF;
  judgments:=judgments||jsonb_build_array(COALESCE(entry.payload->'properties','{}'));IF jsonb_array_length(judgments)>=n THEN EXIT;END IF;
 END LOOP;
 usage:=evidence.scoped_usage_report(h,c,b);PERFORM authz.assert_effect(h);
 RETURN evidence.governance_response_budget(jsonb_build_object('state','read','measured_at',current_at,'appearance',jsonb_build_object('work_update_properties',evidence.count_property_objects(properties,COALESCE((b->>'max_paths')::integer,200),ARRAY(SELECT jsonb_array_elements_text(COALESCE(b->'dynamic_containers','[]')))),'work_update_explanation',evidence.count_property_objects(explanations,COALESCE((b->>'max_paths')::integer,200),ARRAY(SELECT jsonb_array_elements_text(COALESCE(b->'dynamic_containers','[]')))),'impact_judgment_properties',evidence.count_property_objects(judgments,COALESCE((b->>'max_paths')::integer,200),ARRAY(SELECT jsonb_array_elements_text(COALESCE(b->'dynamic_containers','[]'))))),'request_usage',usage,'history','request_window_is_historical_appearance_is_current','schema_change','agent_proposal_only_no_ddl_authority','unknown_scope','old_observations_not_attributed_or_backfilled'));
END $$;
REVOKE ALL ON FUNCTION v8.field_governance(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.field_governance(uuid,text,text) TO hub2_v8;
RESET ROLE;

SET ROLE hub2_mem_owner;
CREATE FUNCTION mem.worker_property_sample(n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,mem AS $$
DECLARE materials jsonb;drafts jsonb;
BEGIN
 IF n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_property_limit';END IF;PERFORM evidence.worker_guard('worker.governance');
 SELECT COALESCE(jsonb_agg(properties),'[]') INTO materials FROM (SELECT properties FROM mem.materials ORDER BY id LIMIT n) sample;
 SELECT COALESCE(jsonb_agg(properties),'[]') INTO drafts FROM (SELECT COALESCE(body->'properties','{}') properties FROM mem.text_drafts ORDER BY id LIMIT n) sample;
 PERFORM evidence.worker_guard('worker.governance');
 RETURN jsonb_build_object('material_properties',evidence.count_property_objects(materials,4096),'text_draft_properties',evidence.count_property_objects(drafts,4096));
END $$;
REVOKE ALL ON FUNCTION mem.worker_property_sample(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mem.worker_property_sample(integer) TO hub2_evidence_owner;
RESET ROLE;
SET ROLE hub2_v8_owner;
CREATE FUNCTION v8.worker_property_sample(n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE properties jsonb;explanations jsonb;judgments jsonb;
BEGIN
 IF n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_property_limit';END IF;PERFORM evidence.worker_guard('worker.governance');
 SELECT COALESCE(jsonb_agg(COALESCE(payload->'properties','{}')),'[]'),COALESCE(jsonb_agg(COALESCE(payload->'explanation','{}')),'[]') INTO properties,explanations FROM (SELECT payload FROM v8.work_updates ORDER BY id LIMIT n) sample;
 SELECT COALESCE(jsonb_agg(COALESCE(payload->'properties','{}')),'[]') INTO judgments FROM (SELECT payload FROM v8.impact_judgments ORDER BY id LIMIT n) sample;
 PERFORM evidence.worker_guard('worker.governance');RETURN jsonb_build_object('work_update_properties',evidence.count_property_objects(properties,4096),'work_update_explanation',evidence.count_property_objects(explanations,4096),'impact_judgment_properties',evidence.count_property_objects(judgments,4096));
END $$;
REVOKE ALL ON FUNCTION v8.worker_property_sample(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.worker_property_sample(integer) TO hub2_evidence_owner;
RESET ROLE;
SET ROLE hub2_evidence_owner;
ALTER TABLE evidence.property_snapshots ADD COLUMN snapshot_key text UNIQUE,ADD COLUMN coverage jsonb NOT NULL DEFAULT '{}';
CREATE FUNCTION evidence.collect_property_snapshots(period_start timestamptz,n integer DEFAULT 100) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
DECLARE samples jsonb;domain text;sample jsonb;namespace text;report jsonb;counts jsonb;key text;id uuid;ids jsonb:='[]';
BEGIN
 IF period_start IS NULL OR n NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid_property_period';END IF;PERFORM evidence.worker_guard('worker.governance');
 samples:=jsonb_build_object('mem',mem.worker_property_sample(n),'v8',v8.worker_property_sample(n));
 FOR domain,sample IN SELECT * FROM jsonb_each(samples) LOOP FOR namespace,report IN SELECT * FROM jsonb_each(sample) LOOP
  key:='property:'||domain||':'||namespace||':'||to_char(period_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  SELECT COALESCE(jsonb_object_agg(item->>'path',(item->>'objects_with_path')::bigint),'{}') INTO counts FROM jsonb_array_elements(report->'items') item;
  PERFORM evidence.worker_guard('worker.governance');
  INSERT INTO evidence.property_snapshots(service,schema_version,observed_objects,unknown_objects,counts,snapshot_key,coverage) VALUES(domain||'.'||namespace,'json-property-paths.v1',(report->>'observed_objects')::bigint,(report->>'unknown_path_objects')::bigint,counts,key,jsonb_build_object('scope','internal_global_bounded_sample_not_member_view','period_start',period_start,'sample_limit',n,'namespace',namespace,'path_truncated',report->'path_truncated','unknown_unobserved_objects','not_measured','values','not_recorded','semantic_governance','agent_judgment')) ON CONFLICT(snapshot_key) DO NOTHING;
  SELECT property_snapshots.id INTO id FROM evidence.property_snapshots WHERE snapshot_key=key;ids:=ids||jsonb_build_array(id);
 END LOOP;END LOOP;
 RETURN jsonb_build_object('state','snapshots_recorded','snapshot_ids',ids,'coverage','internal_global_bounded_actual_json_samples','member_visibility','never_global_snapshot','values','not_recorded');
END $$;
CREATE FUNCTION evidence.property_snapshot_internal(id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,evidence AS $$
#variable_conflict use_variable
BEGIN PERFORM evidence.worker_guard('worker.governance');RETURN (SELECT to_jsonb(s) FROM evidence.property_snapshots s WHERE s.id=id);END $$;
REVOKE ALL ON FUNCTION evidence.collect_property_snapshots(timestamptz,integer),evidence.property_snapshot_internal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.collect_property_snapshots(timestamptz,integer),evidence.property_snapshot_internal(uuid) TO hub2_worker;
RESET ROLE;

-- Transport budget clips statistic paths with coverage markers; it never changes stored JSON or denominators.
SET ROLE hub2_evidence_owner;
CREATE FUNCTION evidence.governance_response_budget(report jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,evidence AS $$
DECLARE name text;part jsonb;items jsonb;limit_n integer;clipped boolean:=false;
BEGIN
 WHILE octet_length(report::text)>180000 LOOP
  FOR name,part IN SELECT * FROM jsonb_each(report->'appearance') LOOP
   limit_n:=greatest(1,jsonb_array_length(part->'items')/2);
   SELECT COALESCE(jsonb_agg(value ORDER BY ordinality),'[]') INTO items FROM jsonb_array_elements(part->'items') WITH ORDINALITY WHERE ordinality<=limit_n;
   report:=jsonb_set(report,ARRAY['appearance',name],part||jsonb_build_object('items',items,'path_truncated',true));
  END LOOP;
  part:=report->'request_usage';limit_n:=greatest(1,jsonb_array_length(part->'items')/2);
  SELECT COALESCE(jsonb_agg(value ORDER BY ordinality),'[]') INTO items FROM jsonb_array_elements(part->'items') WITH ORDINALITY WHERE ordinality<=limit_n;
  report:=jsonb_set(report,ARRAY['request_usage'],part||jsonb_build_object('items',items,'path_truncated',true));clipped:=true;
 END LOOP;
 RETURN report||jsonb_build_object('response_path_budget_truncated',clipped,'statistics_are_not_schema_columns',true);
END $$;
REVOKE ALL ON FUNCTION evidence.governance_response_budget(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence.governance_response_budget(jsonb) TO hub2_mem_owner,hub2_v8_owner;
RESET ROLE;
