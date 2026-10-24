BEGIN;

CREATE OR REPLACE FUNCTION authz.engineering_requests_read(proof text, p_view text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE ident jsonb;items jsonb;
BEGIN
 ident:=authz.authenticate(proof);
 IF p_view NOT IN('mine','pending','managed') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(req)||jsonb_build_object('project_title',ep.title,'resource_scope',ep.descriptor,
  'resources_registered_ready',ep.ready,'qualification_current',CASE WHEN req.qualification_id IS NULL THEN false ELSE authz.qualification_deadline(req.qualification_id,req.actor_id,req.project_id,'resource.read',jsonb_build_object('project_id',req.project_id)) IS NOT NULL END) ORDER BY req.created_at DESC),'[]') INTO items
 FROM authz.engineering_requests req JOIN authz.engineering_projects ep ON ep.project_id=req.project_id
 WHERE authz.client_resource_allowed745((ident->>'client_id')::uuid,req.project_id)
  AND ((p_view='mine' AND req.actor_id=(ident->>'actor_id')::uuid)
   OR (p_view='managed' AND authz.engineering_can_manage(proof,req.project_id))
   OR (p_view='pending' AND req.state='pending' AND authz.engineering_can_manage(proof,req.project_id)));
 RETURN jsonb_build_object('state','read','items',items,'meaning','current_requester_or_existing_project_management_scope;not_a_new_grant');
END $function$;

CREATE OR REPLACE FUNCTION authz.baize_grant_requests_read(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE d jsonb;actor uuid;mgr boolean;items jsonb;
BEGIN
 d:=authz.authorization_application_decision(proof,jsonb_build_object('application_id','baize','action','read'));actor:=(d->>'actor_id')::uuid;mgr:=authz.engineering_can_manage(proof,(d->>'project_id')::uuid);
 IF coalesce(b->>'view','mine') NOT IN('mine','owner','managed','pending','all_visible') THEN RAISE EXCEPTION 'request_view_required' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(authz.baize_grant_request_view(r) ORDER BY created_at DESC),'[]'::jsonb) INTO items FROM authz.baize_grant_requests r WHERE
 ((coalesce(b->>'view','mine')='mine' AND r.grantee_id=actor) OR (b->>'view'='owner' AND r.owner_id=actor) OR (b->>'view'='managed' AND mgr) OR (b->>'view'='pending' AND r.request_deadline>clock_timestamp() AND ((r.owner_id=actor AND r.owner_confirmed_at IS NULL) OR (mgr AND r.manager_confirmed_at IS NULL))) OR (b->>'view'='all_visible' AND (mgr OR actor IN(r.owner_id,r.grantee_id)))) AND (NOT b?'request_id' OR r.id=(b->>'request_id')::uuid) AND (coalesce(b->>'view','mine')<>'pending' OR r.state IN('pending','pending_owner','pending_manager'));
 RETURN jsonb_build_object('state','read','items',items,'manager_can_sign',mgr,'historical_route','/v2/authorization/legacy-grants/list','ownership_is_not_inferred_from_manager',true);
END $function$;

-- Current installed visible() uses this same current software/entry fence; history does not require entry active.
CREATE OR REPLACE FUNCTION vault2.entry_in_software(i jsonb,e vault2.entries) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $function$
 SELECT e.organization_id=(i->>'organization_id')::uuid AND authz.client_resource_allowed745((i->>'client_id')::uuid,e.project_id,e.id,e.name)
$function$;
REVOKE ALL ON FUNCTION vault2.entry_in_software(jsonb,vault2.entries) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault2.entry_in_software(jsonb,vault2.entries) TO hub2_hufu,hub2_authz_owner;

CREATE OR REPLACE FUNCTION vault2.applications(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $function$
DECLARE i jsonb;items jsonb;v text:=b->>'view';state_name text:=b->>'state';
BEGIN
 i:=vault2.identity(proof);
 IF v IS NOT NULL AND v NOT IN ('mine','pending','managed') THEN RAISE EXCEPTION 'invalid_view' USING ERRCODE='22023';END IF;
 IF state_name IS NOT NULL AND state_name NOT IN ('pending','approved','rejected','withdrawn') THEN RAISE EXCEPTION 'invalid_state' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'entry_id',a.entry_id,'application_id',a.id,'status',a.state,'state',a.state,'revision',a.revision,'applicant_id',a.applicant_id,'applicant_client_id',a.applicant_client_id,'applicant',(SELECT display_name FROM authz.principals WHERE id=a.applicant_id),'applicant_username',coalesce((SELECT legacy_subject FROM authz.legacy_member_maps WHERE principal_id=a.applicant_id AND active ORDER BY registered_at,id LIMIT 1),(SELECT legacy_subject FROM vault2.service_bindings WHERE principal_id=a.applicant_id AND active ORDER BY legacy_subject LIMIT 1)),'key_id',(SELECT name FROM vault2.entries WHERE id=a.entry_id),'purpose',a.purpose,'requested_expires_at',a.requested_expires_at,'requested_until_revoked',a.requested_until_revoked) ORDER BY a.id),'[]') INTO items FROM (
 SELECT a.* FROM vault2.applications a JOIN vault2.entries e ON e.id=a.entry_id
 WHERE vault2.entry_in_software(i,e) AND ((b->>'entry_id' IS NULL AND b->>'key' IS NULL) OR e.id=vault2.resolve_entry(i,b))
 AND CASE v WHEN 'mine' THEN a.applicant_id=(i->>'actor_id')::uuid AND EXISTS(SELECT FROM authz.clients WHERE id=(i->>'client_id')::uuid AND active AND 'hufu.vault.read'=ANY(actions))
 WHEN 'managed' THEN vault2.may_decide(i,e)
 WHEN 'pending' THEN vault2.may_decide(i,e) AND a.state='pending'
 ELSE (a.applicant_id=(i->>'actor_id')::uuid AND EXISTS(SELECT FROM authz.clients WHERE id=(i->>'client_id')::uuid AND active AND 'hufu.vault.read'=ANY(actions))) OR vault2.may_decide(i,e) END
 AND (CASE WHEN v IS NULL THEN coalesce(state_name,'pending')=a.state ELSE state_name IS NULL OR state_name=a.state END)
 AND (b->>'cursor' IS NULL OR a.id>(b->>'cursor')::uuid) ORDER BY a.id LIMIT 100)a;
 RETURN jsonb_build_object('state','applications','items',items,'next_cursor',CASE WHEN jsonb_array_length(items)=100 THEN items->99->'id' ELSE NULL END,'view',coalesce(v,'legacy_visible'),'coverage','bounded_current_scope_page');
END $function$;

CREATE OR REPLACE FUNCTION vault2.delivery_applications(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'vault2'
AS $function$
DECLARE i jsonb;view_name text:=coalesce(b->>'view','mine');items jsonb;n integer:=coalesce((b->>'limit')::integer,50);cursor_row vault2.delivery_requests; BEGIN
 i:=vault2.delivery_request_identity(proof);
 IF view_name NOT IN('mine','pending','reviewed','managed') OR n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF view_name<>'mine' AND NOT vault2.delivery_request_reviewer(i) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF b->>'cursor' IS NOT NULL THEN
  SELECT * INTO cursor_row FROM vault2.delivery_requests WHERE id=(b->>'cursor')::uuid AND organization_id=(i->>'organization_id')::uuid AND(view_name<>'mine' OR applicant_id=(i->>'actor_id')::uuid);
  IF cursor_row.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.created_at DESC,x.id DESC),'[]'::jsonb) INTO items FROM(
  SELECT id,created_at,vault2.delivery_request_shape(a) value FROM vault2.delivery_requests a
  WHERE organization_id=(i->>'organization_id')::uuid
  AND CASE view_name WHEN 'mine' THEN applicant_id=(i->>'actor_id')::uuid WHEN 'pending' THEN state='pending' WHEN 'managed' THEN true ELSE state<>'pending' END
  AND(cursor_row.id IS NULL OR(a.created_at,a.id)<(cursor_row.created_at,cursor_row.id)) ORDER BY created_at DESC,id DESC LIMIT n
 )x;
 RETURN jsonb_build_object('items',items,'next_cursor',CASE WHEN jsonb_array_length(items)=n THEN items->(n-1)->'application_id' ELSE NULL END,'view',view_name);
END $function$;

CREATE OR REPLACE FUNCTION authz.inbox_project_request_visible(proof text,i jsonb,r authz.access_requests,v text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
 SELECT authz.client_resource_allowed745((i->>'client_id')::uuid,r.project_id)
 AND EXISTS(SELECT FROM v8.projects WHERE id=r.project_id AND organization_id=(i->>'organization_id')::uuid)
 AND CASE v WHEN 'mine' THEN r.actor_id=(i->>'actor_id')::uuid
 WHEN 'managed' THEN authz.engineering_can_manage(proof,r.project_id)
 WHEN 'pending' THEN (r.state='pending' AND authz.engineering_can_manage(proof,r.project_id)) OR (r.state='needs_changes' AND r.actor_id=(i->>'actor_id')::uuid)
 ELSE false END
$$;
CREATE OR REPLACE FUNCTION authz.inbox_database_request_visible(proof text,i jsonb,r authz.database_requests,v text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
 SELECT authz.client_resource_allowed745((i->>'client_id')::uuid,r.project_id)
 AND EXISTS(SELECT FROM v8.projects WHERE id=r.project_id AND organization_id=(i->>'organization_id')::uuid)
 AND CASE v WHEN 'mine' THEN r.actor_id=(i->>'actor_id')::uuid
 WHEN 'managed' THEN authz.engineering_can_manage(proof,r.project_id)
 WHEN 'pending' THEN r.state='pending' AND authz.engineering_can_manage(proof,r.project_id)
 ELSE false END
$$;
REVOKE ALL ON FUNCTION authz.inbox_project_request_visible(text,jsonb,authz.access_requests,text),authz.inbox_database_request_visible(text,jsonb,authz.database_requests,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION authz.authorization_applications(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;v text:=coalesce(b->>'view','mine');n int:=coalesce((b->>'limit')::int,200);anchor authz.access_requests;items jsonb;more boolean;
BEGIN
 i:=authz.authenticate(proof);
 IF v NOT IN('mine','managed','pending') OR n NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_inbox_view_or_limit' USING ERRCODE='22023';END IF;
 IF b ? 'cursor' THEN
  SELECT * INTO anchor FROM authz.access_requests r WHERE r.id=(b->>'cursor')::uuid AND authz.inbox_project_request_visible(proof,i,r,v);
  IF anchor.id IS NULL THEN RAISE EXCEPTION 'cursor_not_currently_visible;read_first_page' USING ERRCODE='42501';END IF;
 END IF;
 SELECT coalesce(jsonb_agg(x),'[]') INTO items FROM (
 SELECT to_jsonb(r)||jsonb_build_object('kind','project','request_id',r.id,'requester',a.display_name,'project_title',p.title) x
 FROM authz.access_requests r JOIN v8.projects p ON p.id=r.project_id JOIN authz.principals a ON a.id=r.actor_id
 WHERE authz.inbox_project_request_visible(proof,i,r,v) AND (NOT b?'request_id' OR r.id=(b->>'request_id')::uuid)
 AND (anchor.id IS NULL OR (r.created_at,r.id)<(anchor.created_at,anchor.id)) ORDER BY r.created_at DESC,r.id DESC LIMIT n+1)t;
 more:=jsonb_array_length(items)>n;
 SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO items FROM jsonb_array_elements(items) WITH ORDINALITY e(value,ord) WHERE ord<=n;
 RETURN jsonb_build_object('state','read','items',items,'has_more',more,'next_cursor',CASE WHEN more THEN items->(n-1)->'id' ELSE NULL END,'limit',n,'pagination_supported',true,'coverage','current_scope_page;created_at_uuid_desc');
END $$;
CREATE OR REPLACE FUNCTION authz.database_requests_read(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;v text:=coalesce(b->>'view','mine');n int:=coalesce((b->>'limit')::int,200);anchor authz.database_requests;items jsonb;more boolean;
BEGIN
 i:=authz.authenticate(proof);
 IF v NOT IN('mine','managed','pending') OR n NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'invalid_inbox_view_or_limit' USING ERRCODE='22023';END IF;
 IF b ? 'cursor' THEN
  SELECT * INTO anchor FROM authz.database_requests r WHERE r.id=(b->>'cursor')::uuid AND authz.inbox_database_request_visible(proof,i,r,v);
  IF anchor.id IS NULL THEN RAISE EXCEPTION 'cursor_not_currently_visible;read_first_page' USING ERRCODE='42501';END IF;
 END IF;
 SELECT coalesce(jsonb_agg(x),'[]') INTO items FROM (
 SELECT to_jsonb(r)||jsonb_build_object('project_title',p.title) x FROM authz.database_requests r JOIN v8.projects p ON p.id=r.project_id
 WHERE authz.inbox_database_request_visible(proof,i,r,v) AND (NOT b?'request_id' OR r.id=(b->>'request_id')::uuid)
 AND (anchor.id IS NULL OR (r.created_at,r.id)<(anchor.created_at,anchor.id)) ORDER BY r.created_at DESC,r.id DESC LIMIT n+1)t;
 more:=jsonb_array_length(items)>n;
 SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO items FROM jsonb_array_elements(items) WITH ORDINALITY e(value,ord) WHERE ord<=n;
 RETURN jsonb_build_object('state','read','items',items,'has_more',more,'next_cursor',CASE WHEN more THEN items->(n-1)->'id' ELSE NULL END,'limit',n,'pagination_supported',true,'coverage','current_scope_page;created_at_uuid_desc');
END $$;

COMMIT;
