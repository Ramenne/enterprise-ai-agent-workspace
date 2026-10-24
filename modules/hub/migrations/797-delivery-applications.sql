BEGIN; SET ROLE hub2_authz_owner;
CREATE TABLE vault2.delivery_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
 applicant_id uuid NOT NULL REFERENCES authz.principals(id), applicant_client_id uuid NOT NULL,
 title text NOT NULL, purpose jsonb, requested_expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','approved','rejected')),
 revision integer NOT NULL DEFAULT 1, idempotency_key text NOT NULL,
 item_id uuid REFERENCES vault2.delivery_items(id), approved_until timestamptz,
 decided_by uuid REFERENCES authz.principals(id), decision_reason jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), decided_at timestamptz,
 UNIQUE(applicant_id,idempotency_key)
);
CREATE INDEX ON vault2.delivery_requests(organization_id,state,created_at);
CREATE TABLE vault2.delivery_request_audit(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES vault2.delivery_requests(id),
 actor_id uuid NOT NULL,client_id uuid NOT NULL,event text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE vault2.delivery_items ADD COLUMN request_id uuid REFERENCES vault2.delivery_requests(id);
REVOKE ALL ON vault2.delivery_requests,vault2.delivery_request_audit FROM PUBLIC,hub2_hufu;
ALTER TABLE vault2.delivery_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault2.delivery_request_audit ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION vault2.delivery_request_identity(proof text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb; BEGIN
 i:=authz.vault_current_identity(proof,NULL);
 IF NOT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND kind='member') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 -- Applying asks for a decision; it never grants or reads a secret.
 RETURN i;
END $$;
CREATE FUNCTION vault2.delivery_request_manager(i jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
 SELECT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND role='organization_admin')
 AND (coalesce((i->>'is_primary')::boolean,false) OR (i->'client_actions' ? 'hufu.credential.manage' AND i->'scope_filters'='[]'::jsonb))
$$;
CREATE FUNCTION vault2.delivery_request_reviewer(i jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
 SELECT EXISTS(SELECT FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND role='organization_admin')
 AND (coalesce((i->>'is_primary')::boolean,false) OR (i->'client_actions' ? 'hufu.vault.read' AND i->'scope_filters'='[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION vault2.delivery_request_reviewer(jsonb) FROM PUBLIC;
CREATE FUNCTION vault2.delivery_request_shape(a vault2.delivery_requests) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
 SELECT jsonb_build_object('application_id',a.id,'applicant_id',a.applicant_id,'applicant',(SELECT display_name FROM authz.principals WHERE id=a.applicant_id),'title',a.title,'purpose',a.purpose,'requested_expires_at',a.requested_expires_at,'state',a.state,'revision',a.revision,'item_id',a.item_id,'approved_until',a.approved_until,'decision_reason',a.decision_reason,'created_at',a.created_at,'decided_at',a.decided_at,'decided_by',a.decided_by,'approver',(SELECT display_name FROM authz.principals WHERE id=a.decided_by))
$$;
CREATE FUNCTION vault2.delivery_apply(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;a vault2.delivery_requests;expiry timestamptz; BEGIN
 i:=vault2.delivery_request_identity(proof);
 IF coalesce(length(b->>'title'),0) NOT BETWEEN 1 AND 160 OR coalesce(length(b->>'idempotency_key'),0) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 expiry:=coalesce((b->>'requested_expires_at')::timestamptz,clock_timestamp()+interval '7 days');
 IF expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '30 days' THEN RAISE EXCEPTION 'invalid_expiry' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended((i->>'actor_id')||':delivery_apply:'||(b->>'idempotency_key'),0));
 SELECT * INTO a FROM vault2.delivery_requests WHERE applicant_id=(i->>'actor_id')::uuid AND idempotency_key=b->>'idempotency_key';
 IF a.id IS NOT NULL THEN
  IF a.title<>b->>'title' OR a.purpose IS DISTINCT FROM b->'purpose' THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505'; END IF;
  RETURN vault2.delivery_request_shape(a)||jsonb_build_object('replayed',true);
 END IF;
 INSERT INTO vault2.delivery_requests(organization_id,applicant_id,applicant_client_id,title,purpose,requested_expires_at,idempotency_key)
 VALUES((i->>'organization_id')::uuid,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,b->>'title',b->'purpose',expiry,b->>'idempotency_key') RETURNING * INTO a;
 INSERT INTO vault2.delivery_request_audit(request_id,actor_id,client_id,event) VALUES(a.id,a.applicant_id,a.applicant_client_id,'applied');
 RETURN vault2.delivery_request_shape(a);
END $$;
CREATE FUNCTION vault2.delivery_applications(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;view_name text:=coalesce(b->>'view','mine');items jsonb;n integer:=coalesce((b->>'limit')::integer,50);cursor_row vault2.delivery_requests; BEGIN
 i:=vault2.delivery_request_identity(proof);
 IF view_name NOT IN('mine','pending','reviewed') OR n NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF view_name<>'mine' AND NOT vault2.delivery_request_reviewer(i) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF b->>'cursor' IS NOT NULL THEN
  SELECT * INTO cursor_row FROM vault2.delivery_requests WHERE id=(b->>'cursor')::uuid AND organization_id=(i->>'organization_id')::uuid AND(view_name<>'mine' OR applicant_id=(i->>'actor_id')::uuid);
  IF cursor_row.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 SELECT coalesce(jsonb_agg(x.value ORDER BY x.created_at DESC,x.id DESC),'[]'::jsonb) INTO items FROM(
  SELECT id,created_at,vault2.delivery_request_shape(a) value FROM vault2.delivery_requests a
  WHERE organization_id=(i->>'organization_id')::uuid
  AND CASE view_name WHEN 'mine' THEN applicant_id=(i->>'actor_id')::uuid WHEN 'pending' THEN state='pending' ELSE state<>'pending' END
  AND(cursor_row.id IS NULL OR(a.created_at,a.id)<(cursor_row.created_at,cursor_row.id)) ORDER BY created_at DESC,id DESC LIMIT n
 )x;
 RETURN jsonb_build_object('items',items,'next_cursor',CASE WHEN jsonb_array_length(items)=n THEN items->(n-1)->'application_id' ELSE NULL END,'view',view_name);
END $$;
CREATE FUNCTION vault2.delivery_candidates(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;a vault2.delivery_requests;items jsonb; BEGIN
 i:=vault2.delivery_request_identity(proof);
 SELECT * INTO a FROM vault2.delivery_requests WHERE id=(b->>'application_id')::uuid AND organization_id=(i->>'organization_id')::uuid;
 IF a.id IS NULL OR NOT vault2.delivery_request_reviewer(i) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'title',d.title,'filename',d.filename,'expires_at',d.expires_at,'scope',d.scope) ORDER BY d.created_at DESC),'[]'::jsonb) INTO items
 FROM vault2.delivery_items d WHERE d.recipient_id=a.applicant_id AND d.active AND d.expires_at>clock_timestamp() AND(d.request_id IS NULL OR d.request_id=a.id);
 RETURN jsonb_build_object('application',vault2.delivery_request_shape(a),'items',items);
END $$;
CREATE FUNCTION vault2.delivery_decide(proof text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
DECLARE i jsonb;a vault2.delivery_requests;d vault2.delivery_items;expiry timestamptz; BEGIN
 i:=vault2.delivery_request_identity(proof);
 IF NOT vault2.delivery_request_manager(i) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM vault2.delivery_requests WHERE id=(b->>'application_id')::uuid AND organization_id=(i->>'organization_id')::uuid FOR UPDATE;
 IF a.id IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF b->>'decision' NOT IN('approve','reject') OR b->>'decision' IS NULL THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023'; END IF;
 IF a.state<>'pending' THEN
  IF a.state=(CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END) AND (b->>'decision'='reject' OR a.item_id=(b->>'item_id')::uuid) THEN RETURN vault2.delivery_request_shape(a)||jsonb_build_object('replayed',true); END IF;
  RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001';
 END IF;
 IF a.revision IS DISTINCT FROM(b->>'expected_revision')::int THEN RAISE EXCEPTION 'revision_conflict' USING ERRCODE='40001'; END IF;
 IF b->>'decision'='approve' THEN
  SELECT * INTO d FROM vault2.delivery_items WHERE id=(b->>'item_id')::uuid AND recipient_id=a.applicant_id AND active AND expires_at>clock_timestamp() AND(request_id IS NULL OR request_id=a.id) FOR UPDATE;
  IF d.id IS NULL THEN RETURN jsonb_build_object('state','failed','error_code','recipient_delivery_required','next_step','upload_for_this_applicant_then_approve'); END IF;
  expiry:=least(d.expires_at,a.requested_expires_at,coalesce((b->>'expires_at')::timestamptz,a.requested_expires_at));
  IF expiry<=clock_timestamp() THEN RAISE EXCEPTION 'invalid_expiry' USING ERRCODE='22023'; END IF;
  UPDATE vault2.delivery_items SET request_id=a.id WHERE id=d.id;
 END IF;
 UPDATE vault2.delivery_requests SET state=CASE WHEN b->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,revision=revision+1,item_id=d.id,approved_until=expiry,decided_by=(i->>'actor_id')::uuid,decision_reason=b->'reason',decided_at=clock_timestamp() WHERE id=a.id RETURNING * INTO a;
 INSERT INTO vault2.delivery_request_audit(request_id,actor_id,client_id,event) VALUES(a.id,(i->>'actor_id')::uuid,(i->>'client_id')::uuid,a.state);
 RETURN vault2.delivery_request_shape(a);
END $$;
CREATE FUNCTION vault2.delivery_request_allowed(d vault2.delivery_items) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,vault2 AS $$
 SELECT d.request_id IS NULL OR EXISTS(SELECT FROM vault2.delivery_requests a WHERE a.id=d.request_id AND a.item_id=d.id AND a.applicant_id=d.recipient_id AND a.state='approved' AND a.approved_until>clock_timestamp())
$$;
-- Preserve existing explicitly granted files. Only application-bound uploads
-- are gated by the new decision at every list/OTP/download entry point.
DO $gate$ DECLARE name text; before text;after text; BEGIN
 FOREACH name IN ARRAY ARRAY['delivery_list(text)','delivery_prepare(text,jsonb)','delivery_verify(text,jsonb)','delivery_download_prepare(text,uuid)'] LOOP
 before:=pg_get_functiondef(('vault2.'||name)::regprocedure);
 IF name='delivery_list(text)' THEN
 after:=replace(before,'AND active AND expires_at>clock_timestamp();','AND active AND expires_at>clock_timestamp() AND vault2.delivery_request_allowed(delivery_items);');
 ELSE
 after:=replace(before,'FOR SHARE;','AND vault2.delivery_request_allowed(d) FOR SHARE;');
 -- The row variable d is assigned only after SELECT; use the table's
 -- current composite row in that selection, not an uninitialized variable.
 after:=replace(after,'vault2.delivery_request_allowed(d) FOR SHARE','vault2.delivery_request_allowed(delivery_items) FOR SHARE');
 END IF;
 IF after=before THEN RAISE EXCEPTION 'reviewed_delivery_definition_changed: %',name; END IF;
 EXECUTE after;
 END LOOP;
END $gate$;
-- Application binding at upload time: storing a file is not approving it.
DO $bind$ DECLARE before text;after text; BEGIN
 before:=pg_get_functiondef('vault2.delivery_register_prepare(text,jsonb)'::regprocedure);
 after:=replace(before,'key:=''api:''', $p$IF b->>'application_id' IS NOT NULL THEN
 IF NOT EXISTS(SELECT FROM vault2.delivery_requests WHERE id=(b->>'application_id')::uuid AND applicant_id=r.id AND organization_id=p.organization_id AND state='pending') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 key:='api:'$p$);
 after:=replace(after,'RETURN jsonb_build_object(''item_id'',d.id', $p$IF b->>'application_id' IS NOT NULL THEN UPDATE vault2.delivery_items SET request_id=(b->>'application_id')::uuid WHERE id=d.id AND NOT active; END IF;
 RETURN jsonb_build_object('item_id',d.id$p$);
 IF after=before THEN RAISE EXCEPTION 'reviewed_register_definition_changed'; END IF;
 EXECUTE after;
END $bind$;
REVOKE ALL ON FUNCTION vault2.delivery_request_identity(text),vault2.delivery_request_manager(jsonb),vault2.delivery_request_shape(vault2.delivery_requests),vault2.delivery_request_allowed(vault2.delivery_items) FROM PUBLIC;
REVOKE ALL ON FUNCTION vault2.delivery_apply(text,jsonb),vault2.delivery_applications(text,jsonb),vault2.delivery_candidates(text,jsonb),vault2.delivery_decide(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vault2.delivery_apply(text,jsonb),vault2.delivery_applications(text,jsonb),vault2.delivery_candidates(text,jsonb),vault2.delivery_decide(text,jsonb) TO hub2_hufu;

-- Management APIs also accept an explicitly authorized management software,
-- rather than demanding a browser-only primary session.
DO $manager_api$ DECLARE name text;before text;after text; BEGIN
 FOREACH name IN ARRAY ARRAY['delivery_recipients(text)','delivery_register_prepare(text,jsonb)','delivery_register_finish(text,jsonb)'] LOOP
  before:=pg_get_functiondef(('vault2.'||name)::regprocedure);
  after:=replace(before,'NOT coalesce((i->>''is_primary'')::boolean,false)', CASE WHEN name='delivery_recipients(text)' THEN 'NOT vault2.delivery_request_reviewer(i)' ELSE 'NOT vault2.delivery_request_manager(i)' END);
  IF after=before THEN RAISE EXCEPTION 'reviewed_manager_definition_changed: %',name; END IF;
  EXECUTE after;
 END LOOP;
END $manager_api$;
RESET ROLE; COMMIT;
