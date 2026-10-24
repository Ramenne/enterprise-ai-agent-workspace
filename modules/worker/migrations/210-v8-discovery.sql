-- Read-only discovery uses current member/client identity, not creation authority.
-- It adds isolated discovery capabilities without replacing applied authz contracts.
SET ROLE hub2_authz_owner;
CREATE TABLE authz.discovery_handles(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),principal_id uuid NOT NULL REFERENCES authz.principals,
 client_id uuid NOT NULL REFERENCES authz.clients,credential_id uuid NOT NULL REFERENCES authz.credentials,
 request_digest text NOT NULL CHECK(request_digest~'^[0-9a-f]{64}$'),source_context_id uuid REFERENCES authz.source_contexts,
 security_era uuid NOT NULL,principal_epoch bigint NOT NULL,client_epoch bigint NOT NULL,credential_epoch bigint NOT NULL,
 expires_at timestamptz NOT NULL,consumed_xid xid8
);
REVOKE ALL ON authz.discovery_handles FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE FUNCTION authz.issue_discovery_handle(p_hash text,p_digest text,p_source jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE identity jsonb;p authz.principals;cl authz.clients;c authz.credentials;sid uuid;h authz.discovery_handles;
BEGIN
 IF session_user<>'hub2_hufu' OR p_hash IS NULL OR p_digest IS NULL OR p_digest!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 identity:=authz.authenticate(p_hash);
 PERFORM authz.lock_resources((identity->>'actor_id')::uuid,(identity->>'client_id')::uuid,(identity->>'credential_id')::uuid,'[]');
 identity:=authz.authenticate(p_hash);
 SELECT * INTO p FROM authz.principals WHERE id=(identity->>'actor_id')::uuid;
 SELECT * INTO cl FROM authz.clients WHERE id=(identity->>'client_id')::uuid;
 SELECT * INTO c FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid;
 IF NOT 'v8.project.read'=ANY(cl.actions) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 INSERT INTO authz.source_contexts(principal_id,client_id,provider,native_key,envelope)
 VALUES(p.id,cl.id,p_source->>'provider',p_source->>'native_key',p_source->'envelope')
 ON CONFLICT(principal_id,client_id,provider,native_key) DO UPDATE SET envelope=EXCLUDED.envelope RETURNING id INTO sid;
 INSERT INTO authz.discovery_handles(principal_id,client_id,credential_id,request_digest,source_context_id,security_era,principal_epoch,client_epoch,credential_epoch,expires_at)
 VALUES(p.id,cl.id,c.id,p_digest,sid,(SELECT era FROM authz.security_state),p.epoch,cl.epoch,c.epoch,
 least(clock_timestamp()+interval '30 seconds',CASE WHEN c.until_revoked THEN 'infinity'::timestamptz ELSE c.expires_at END)) RETURNING * INTO h;
 RETURN jsonb_build_object('handle',h.id,'expires_at',h.expires_at);
END $$;
CREATE FUNCTION authz.consume_discovery_handle(hid uuid,d text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.discovery_handles;p authz.principals;cl authz.clients;c authz.credentials;
BEGIN
 IF session_user<>'hub2_v8' OR hid IS NULL OR d IS NULL THEN RAISE EXCEPTION 'invalid_discovery_handle' USING ERRCODE='42501';END IF;
 SELECT * INTO h FROM authz.discovery_handles WHERE id=hid;
 IF h.id IS NULL OR h.request_digest IS DISTINCT FROM d THEN RAISE EXCEPTION 'invalid_discovery_handle' USING ERRCODE='42501';END IF;
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,'[]');
 SELECT * INTO h FROM authz.discovery_handles WHERE id=hid FOR UPDATE;
 SELECT * INTO p FROM authz.principals WHERE id=h.principal_id;
 SELECT * INTO cl FROM authz.clients WHERE id=h.client_id;
 SELECT * INTO c FROM authz.credentials WHERE id=h.credential_id;
 IF h.security_era IS DISTINCT FROM (SELECT era FROM authz.security_state) OR p.active IS DISTINCT FROM true OR cl.active IS DISTINCT FROM true
 OR c.revoked_at IS NOT NULL OR authz.family_valid(c.id) IS DISTINCT FROM true OR p.epoch<>h.principal_epoch OR cl.epoch<>h.client_epoch OR c.epoch<>h.credential_epoch
 OR (NOT c.until_revoked AND c.expires_at<=clock_timestamp()) OR h.expires_at<=clock_timestamp() OR h.consumed_xid IS NOT NULL OR NOT 'v8.project.read'=ANY(cl.actions)
 THEN RAISE EXCEPTION 'stale_discovery_handle' USING ERRCODE='42501';END IF;
 UPDATE authz.discovery_handles SET consumed_xid=pg_current_xact_id() WHERE id=hid;
 RETURN jsonb_build_object('actor_id',p.id,'client_id',cl.id,'organization_id',p.organization_id);
END $$;
CREATE FUNCTION authz.discovery_project_visible(hid uuid,pid uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.discovery_handles;deadline timestamptz;
BEGIN
 SELECT * INTO h FROM authz.discovery_handles WHERE id=hid;
 IF session_user<>'hub2_v8' OR h.id IS NULL OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR h.expires_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'invalid_discovery_handle' USING ERRCODE='42501';END IF;
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,jsonb_build_array(jsonb_build_object('project_id',pid)));
 BEGIN
  deadline:=authz.resource_deadline(h.principal_id,h.client_id,pid,'v8.project.read',jsonb_build_object('project_id',pid));
 EXCEPTION WHEN insufficient_privilege THEN RETURN false;END;
 UPDATE authz.discovery_handles SET expires_at=least(expires_at,deadline) WHERE id=hid;
 RETURN true;
END $$;
CREATE FUNCTION authz.finish_discovery(hid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE h authz.discovery_handles;c authz.credentials;
BEGIN
 SELECT * INTO h FROM authz.discovery_handles WHERE id=hid;
 IF session_user<>'hub2_v8' OR h.id IS NULL OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR h.expires_at<=clock_timestamp()
 THEN RAISE EXCEPTION 'stale_discovery_handle' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM authz.credentials WHERE id=h.credential_id;
 PERFORM authz.authenticate(c.token_hash);
END $$;
REVOKE ALL ON FUNCTION authz.issue_discovery_handle(text,text,jsonb),authz.consume_discovery_handle(uuid,text),authz.discovery_project_visible(uuid,uuid),authz.finish_discovery(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.issue_discovery_handle(text,text,jsonb) TO hub2_hufu;
GRANT EXECUTE ON FUNCTION authz.consume_discovery_handle(uuid,text),authz.discovery_project_visible(uuid,uuid),authz.finish_discovery(uuid) TO hub2_v8_owner;
RESET ROLE;
SET ROLE hub2_v8_owner;
CREATE INDEX work_discovery_project_id ON v8.work_items(project_id,id);
CREATE FUNCTION v8.project_search(h uuid,d text,p text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;item record;items jsonb:='[]';n integer:=0;lim integer;last_id uuid;more boolean:=false;q text;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;IF EXISTS(SELECT FROM jsonb_object_keys(b) key WHERE key NOT IN('query','limit','cursor')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=COALESCE((b->>'limit')::integer,20);q:=COALESCE(b->>'query','');IF lim NOT BETWEEN 1 AND 100 OR length(q)>200 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=authz.consume_discovery_handle(h,d);
 FOR item IN SELECT pr.* FROM v8.projects pr WHERE pr.organization_id=(c->>'organization_id')::uuid
 AND (b->>'cursor' IS NULL OR pr.id>(b->>'cursor')::uuid)
 AND (q='' OR strpos(lower(pr.title),lower(q))>0)
 AND (pr.owner_id=(c->>'actor_id')::uuid OR pr.visibility='team' OR EXISTS(SELECT FROM authz.qualifications qu WHERE qu.principal_id=(c->>'actor_id')::uuid AND qu.project_id=pr.id AND qu.active))
 ORDER BY pr.id LOOP
  IF NOT authz.discovery_project_visible(h,item.id) THEN CONTINUE;END IF;
  IF n=lim THEN more:=true;EXIT;END IF;
  n:=n+1;last_id:=item.id;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',item.id,'title',item.title,'kind',item.kind,'visibility',item.visibility,'state',item.state,'revision',item.revision,'owner_id',item.owner_id,'manager_id',item.manager_id));
 END LOOP;
 PERFORM authz.finish_discovery(h);
 RETURN jsonb_build_object('state','read','items',items,'returned_count',n,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,
 'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_matching_projects_after_cursor','snapshot',false,'truncated',more),
 'next_step',CASE WHEN more THEN 'continue_with_next_cursor' ELSE 'choose_project_or_create_if_needed' END);
END $$;
CREATE FUNCTION v8.work_search(h uuid,d text,p text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,v8 AS $$
DECLARE b jsonb;c jsonb;item record;ref record;items jsonb:='[]';n integer:=0;lim integer;last_id uuid;more boolean:=false;q text;blocked boolean;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;IF EXISTS(SELECT FROM jsonb_object_keys(b) key WHERE key NOT IN('project_id','query','limit','cursor')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=COALESCE((b->>'limit')::integer,20);q:=COALESCE(b->>'query','');IF lim NOT BETWEEN 1 AND 100 OR length(q)>200 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=v8.guard(h,'v8.work.read',d,b);
 FOR item IN SELECT w.* FROM v8.work_items w WHERE w.project_id=(c->>'project_id')::uuid AND (b->>'cursor' IS NULL OR w.id>(b->>'cursor')::uuid) ORDER BY w.id LOOP
  blocked:=NOT v8.authorized_statement(h,c,item.explanation);
  FOR ref IN SELECT jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256) AS value FROM v8.results WHERE work_item_id=item.id LOOP
   IF NOT v8.authorized_ref(h,c,ref.value) THEN blocked:=true;END IF;
  END LOOP;
  IF q<>'' AND strpos(lower(item.goal),lower(q))=0 AND (blocked OR strpos(lower(item.description),lower(q))=0) THEN CONTINUE;END IF;
  IF n=lim THEN more:=true;EXIT;END IF;
  n:=n+1;last_id:=item.id;
  items:=items||jsonb_build_array(jsonb_build_object('work_item_id',item.id,'short_no',item.short_no,'goal',item.goal,'summary',CASE WHEN blocked THEN NULL ELSE item.description END,'state',item.state,'revision',item.revision,'related_assessment',item.related_assessment,'narrative_coverage',CASE WHEN blocked THEN 'restricted_and_omitted' ELSE 'current_authorized' END));
 END LOOP;
 PERFORM authz.assert_effect(h);
 RETURN jsonb_build_object('state','read','items',items,'returned_count',n,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,
 'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_matching_work_after_cursor','snapshot',false,'truncated',more,'narrative','current_authorized_only'),
 'next_step',CASE WHEN more THEN 'continue_with_next_cursor' ELSE 'read_selected_work_item' END);
END $$;
REVOKE ALL ON FUNCTION v8.project_search(uuid,text,text),v8.work_search(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.project_search(uuid,text,text),v8.work_search(uuid,text,text) TO hub2_v8;
RESET ROLE;
