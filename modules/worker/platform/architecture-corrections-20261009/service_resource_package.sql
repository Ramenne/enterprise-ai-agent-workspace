CREATE OR REPLACE FUNCTION authz.service_resource_package(proof text, mode text, b jsonb, p_key text, p_digest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;actor uuid;pid uuid;sid uuid;p authz.service_resource_packages;old authz.operations;result jsonb;res jsonb;item jsonb;updates jsonb;itemid text; lim int; more boolean; cursor_time timestamptz; cursor_id uuid;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR jsonb_typeof(b)<>'object' OR mode NOT IN('request','read','list','decide','delivery') THEN RAISE EXCEPTION 'invalid_resource_package_input' USING ERRCODE='22023';END IF;
 i:=authz.authenticate(proof);actor:=(i->>'actor_id')::uuid;
 IF mode='list' THEN
  IF b-ARRAY['project_id','service_id','state','limit','cursor','view']<>'{}' OR coalesce((b->>'limit')::int,30) NOT BETWEEN 1 AND 200 OR coalesce(b->>'state','pending') NOT IN('pending','all','requested','approved','partially_delivered','delivered','rejected','withdrawn') THEN RAISE EXCEPTION 'invalid_resource_package_query' USING ERRCODE='22023';END IF;
  IF coalesce(b->>'view','managed') NOT IN('mine','managed','pending') THEN RAISE EXCEPTION 'invalid_resource_package_view' USING ERRCODE='22023'; END IF;
  lim:=coalesce((b->>'limit')::int,30);
  pid:=(b->>'project_id')::uuid;sid:=(b->>'service_id')::uuid;
  IF pid IS NOT NULL THEN PERFORM authz.resource_deadline(actor,(i->>'client_id')::uuid,pid,'v8.project.read',jsonb_build_object('project_id',pid));
  ELSIF coalesce(b->>'view','managed')<>'mine' AND NOT EXISTS(SELECT FROM authz.principals WHERE id=actor AND kind='member' AND role='organization_admin' AND active) THEN RAISE EXCEPTION 'resource_package_project_required' USING ERRCODE='42501';END IF;
  cursor_id:=(b->>'cursor')::uuid;
  IF cursor_id IS NOT NULL THEN
   SELECT created_at INTO cursor_time FROM authz.service_resource_packages WHERE id=cursor_id AND organization_id=(i->>'organization_id')::uuid AND (pid IS NOT NULL OR authz.project_read_visible(i,project_id)) AND (pid IS NULL OR project_id=pid) AND (sid IS NULL OR service_id=sid) AND (coalesce(b->>'view','managed')<>'mine' OR requested_by=actor) AND (coalesce(b->>'state','pending')='all' OR coalesce(b->>'state','pending')='pending' AND state IN('requested','approved','partially_delivered') OR state=b->>'state');
   IF cursor_time IS NULL THEN RAISE EXCEPTION 'cursor_not_currently_visible' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY created_at DESC,package_id DESC),'[]') INTO result FROM(SELECT id AS package_id,project_id,service_id,summary,state,revision,source_ref,requested_by,decision_by,created_at,updated_at FROM authz.service_resource_packages WHERE organization_id=(i->>'organization_id')::uuid AND (pid IS NOT NULL OR authz.project_read_visible(i,project_id)) AND (pid IS NULL OR project_id=pid) AND (sid IS NULL OR service_id=sid) AND (coalesce(b->>'view','managed')<>'mine' OR requested_by=actor) AND (coalesce(b->>'state','pending')='all' OR coalesce(b->>'state','pending')='pending' AND state IN('requested','approved','partially_delivered') OR state=b->>'state') AND (cursor_id IS NULL OR (created_at,id)<(cursor_time,cursor_id)) ORDER BY created_at DESC,id DESC LIMIT lim+1) x;
  more:=jsonb_array_length(result)>lim;
  IF more THEN result:=result-lim; END IF;
  RETURN jsonb_build_object('state','read','items',result,'has_more',more,'next_cursor',CASE WHEN more THEN result->(lim-1)->>'package_id' ELSE NULL END,'complete',NOT more,'coverage','current_organization_and_authorized_project_page','secret_values_in_response',false);
 END IF;
 IF mode='request' THEN
  IF b-ARRAY['project_id','service_id','summary','resources','source_ref']<>'{}' OR coalesce(length(b->>'summary'),0) NOT BETWEEN 1 AND 4000 OR jsonb_typeof(b->'resources') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'resources') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'resource_requirements_required' USING ERRCODE='22023';END IF;
  pid:=(b->>'project_id')::uuid;sid:=(b->>'service_id')::uuid;
  PERFORM authz.resource_deadline(actor,(i->>'client_id')::uuid,pid,'v8.project.read',jsonb_build_object('project_id',pid));
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=sid AND kind='service' AND active AND organization_id=(i->>'organization_id')::uuid) OR NOT EXISTS(SELECT FROM authz.service_authorizations WHERE service_id=sid AND project_id=pid AND active AND application_project_id IS NULL) OR (i->>'principal_kind'='service' AND actor<>sid) THEN RAISE EXCEPTION 'registered_application_required' USING ERRCODE='42501';END IF;
  res:='[]';
  FOR item IN SELECT value FROM jsonb_array_elements(b->'resources') LOOP
   IF jsonb_typeof(item)<>'object' OR item-ARRAY['kind','requirements']<>'{}' OR item->>'kind' IS NULL OR item->>'kind' NOT IN('storage','server','domain','secret','resource','context','other') OR jsonb_typeof(item->'requirements') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid_resource_requirement' USING ERRCODE='22023';END IF;
   IF item->'requirements' ?| ARRAY['secret_value','password','token','private_key','api_key','credential'] THEN RAISE EXCEPTION 'secret_values_use_private_delivery' USING ERRCODE='22023';END IF;
   res:=res||jsonb_build_array(item||jsonb_build_object('item_id',gen_random_uuid()));
  END LOOP;
 ELSE
  IF (mode='read' AND b-ARRAY['package_id','project_id']<>'{}') OR (mode='decide' AND b-ARRAY['package_id','expected_revision','decision','note']<>'{}') OR (mode='delivery' AND b-ARRAY['package_id','expected_revision','items']<>'{}') THEN RAISE EXCEPTION 'invalid_resource_package_input' USING ERRCODE='22023';END IF;
  SELECT * INTO p FROM authz.service_resource_packages WHERE id=(b->>'package_id')::uuid;
  IF p.id IS NULL THEN RAISE EXCEPTION 'resource_package_not_found' USING ERRCODE='42501';END IF;pid:=p.project_id;sid:=p.service_id;
  IF mode='read' THEN
   IF b?'project_id' AND pid IS DISTINCT FROM (b->>'project_id')::uuid THEN RAISE EXCEPTION 'resource_package_scope_required' USING ERRCODE='42501';END IF;
   PERFORM authz.resource_deadline(actor,(i->>'client_id')::uuid,pid,'v8.project.read',jsonb_build_object('project_id',pid));
  ELSE PERFORM authz.service_manager(proof,pid);END IF;
 END IF;
 IF mode<>'read' THEN
  IF coalesce(length(p_key),0) NOT BETWEEN 1 AND 200 OR p_digest !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'resource_package_idempotency_required' USING ERRCODE='22023';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_key,1054));
  SELECT * INTO old FROM authz.operations WHERE principal_id=actor AND idempotency_key=p_key;
  IF old.principal_id IS NOT NULL THEN IF old.request_digest<>p_digest THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='40001';END IF;RETURN old.result;END IF;
  PERFORM id FROM authz.principals WHERE id IN(actor,sid) ORDER BY id FOR SHARE;
  PERFORM id FROM v8.projects WHERE id=pid FOR SHARE;
  IF mode='request' THEN
   PERFORM authz.resource_deadline(actor,(i->>'client_id')::uuid,pid,'v8.project.read',jsonb_build_object('project_id',pid));
   INSERT INTO authz.service_resource_packages(organization_id,project_id,service_id,requested_by,requested_client,summary,resources,source_ref) VALUES((i->>'organization_id')::uuid,pid,sid,actor,(i->>'client_id')::uuid,b->>'summary',res,b->>'source_ref') RETURNING * INTO p;
  ELSE
   PERFORM authz.service_manager(proof,pid);
   SELECT * INTO p FROM authz.service_resource_packages WHERE id=p.id FOR UPDATE;
   IF p.revision IS DISTINCT FROM (b->>'expected_revision')::bigint THEN RAISE EXCEPTION 'resource_package_revision_conflict' USING ERRCODE='40001';END IF;
   IF mode='decide' THEN
    IF p.state<>'requested' OR b->>'decision' IS NULL OR b->>'decision' NOT IN('approve','reject') THEN RAISE EXCEPTION 'resource_package_decision_required' USING ERRCODE='22023';END IF;
    UPDATE authz.service_resource_packages SET state=CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,decision_by=actor,decision_note=b->>'note',approved_at=CASE WHEN b->>'decision'='approve' THEN clock_timestamp() ELSE NULL END,revision=revision+1,updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
   ELSE
    IF p.state NOT IN('approved','partially_delivered','delivered') OR jsonb_typeof(b->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'items') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'approved_resource_package_required' USING ERRCODE='42501';END IF;
    updates:=p.deliveries;
    FOR item IN SELECT value FROM jsonb_array_elements(b->'items') LOOP
     itemid:=item->>'item_id';
     IF NOT EXISTS(SELECT FROM jsonb_array_elements(p.resources) r WHERE r->>'item_id'=itemid) OR item-ARRAY['item_id','status','receipt']<>'{}' OR item->>'status' IS NULL OR item->>'status' NOT IN('delivered','pending','failed') OR jsonb_typeof(item->'receipt') IS DISTINCT FROM 'object' OR (item->'receipt') ?| ARRAY['secret_value','password','token','private_key','api_key','credential'] THEN RAISE EXCEPTION 'invalid_resource_delivery_receipt' USING ERRCODE='22023';END IF;
     IF item->>'status'='delivered' AND item->'receipt'='{}' THEN RAISE EXCEPTION 'actual_delivery_receipt_required' USING ERRCODE='22023';END IF;
     updates:=updates||jsonb_build_object(itemid,item||jsonb_build_object('recorded_by',actor,'recorded_at',clock_timestamp()));
    END LOOP;
    UPDATE authz.service_resource_packages SET deliveries=updates,state=CASE WHEN NOT EXISTS(SELECT FROM jsonb_array_elements(p.resources) r WHERE updates->(r->>'item_id')->>'status' IS DISTINCT FROM 'delivered') THEN 'delivered' ELSE 'partially_delivered' END,revision=revision+1,updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
   END IF;
  END IF;
 END IF;
 result:=jsonb_build_object('state',p.state,'package_id',p.id,'project_id',p.project_id,'service_id',p.service_id,'revision',p.revision,'summary',p.summary,'resources',p.resources,'source_ref',p.source_ref,'requested_by',p.requested_by,'decision_by',p.decision_by,'decision_note',p.decision_note,'approved_at',p.approved_at,'deliveries',p.deliveries,'permission_effect',CASE WHEN mode='decide' AND p.state='approved' THEN 'whole_bundle_approved;configuration_delivery_required' WHEN mode='decide' THEN 'whole_bundle_rejected;no_new_resource_authority' ELSE 'none' END,'runtime_action_approval_required',false,'approval_is_delivery',false,'secret_values_in_response',false);
 IF mode<>'read' THEN
  INSERT INTO authz.operations VALUES(actor,p_key,p_digest,result);
  INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,details) VALUES(actor,(i->>'client_id')::uuid,'authz','service.resource_package.'||mode,p.id,result);
  INSERT INTO evidence.outbox(domain,aggregate_id,aggregate_revision,event_type,project_id,payload) VALUES('authz',p.id,p.revision,'service.resource_package.'||mode,pid,result);
 END IF;
 RETURN result;
END $function$
;
