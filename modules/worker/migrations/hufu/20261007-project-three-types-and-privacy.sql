-- User rule 2026-10-07: team/personal organization-readable; explicitly marked
-- private project access requires actual owner and organization supervisor.
BEGIN;
DO $review_project_shape$ BEGIN
 IF mem.gc_relation_shape('v8.projects'::regclass)<>'5bf3ff5f89151a592741a316a259f379' OR NOT EXISTS(SELECT FROM mem.gc_reference_contracts WHERE schema_name='v8' AND table_name='projects' AND kind='none' AND cardinality(uuid_fields)=0 AND cardinality(json_fields)=0 AND shape_hash='5bf3ff5f89151a592741a316a259f379') THEN RAISE EXCEPTION 'reviewed_project_reference_shape_changed';END IF;
END $review_project_shape$;
DO $reviewed$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='resource_deadline' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='af24a8fd7a4b28daca7256e8e5cd41a05e76e2d90732a8094d2d30016722b8cf') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.resource_deadline';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='check_access' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='a32d5f3c84053b04d3abc641b9a6b8bc3c49e20a99f8c1e6a68ecde7fbc53d0d') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.check_access';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='qualification_deadline' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='40700c350480a2a6987e6229426a76ea5c5b5c0402824e8a6e1bc0d840949782') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.qualification_deadline';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='project_scope_transition' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='bd61ca52ba19cac98ccdc0b0c04d70da7a1a71505c9c48bf45dcaeb577fe50ac') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.project_scope_transition';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='v8' AND p.proname='project_create' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='d6e92f23ea7ca0247d6384f7fd1bc19878ef8e5386472ad3fe59bafad6bb7fa7') THEN RAISE EXCEPTION 'reviewed_definition_changed:v8.project_create';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='v8' AND p.proname='project_convert' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='1b0fdb8dd686d9b4d5bc4b8ba8c50526ecf683114b85dd1530c00ec3b2e0544f') THEN RAISE EXCEPTION 'reviewed_definition_changed:v8.project_convert';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='v8' AND p.proname='project_search' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='fb454e02dad808d7a0d9746d0e3cccc548d8af21386494740c99c6c3923e7d61') THEN RAISE EXCEPTION 'reviewed_definition_changed:v8.project_search';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='authorization_resolve' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='1f21efa15d2bcc4e483416c17f15d70bea529ca0b29682ef1cd9a0ae431d811a') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.authorization_resolve';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='authorization_catalog' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='5b38e564e46275a41852a0fc047c78995cf5f9e78e1b4cd74ddb9cab70b857c7') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.authorization_catalog';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='search_can_read_resource' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='a5e9aedb5da7058e3acec177c2654abcc3022a21e13ff207a70823470e231e00') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.search_can_read_resource';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='engineering_catalog' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='fc110a14626e66fda1ac9457bee9e9ee295911ea561989e09753a567c3bcf00c') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.engineering_catalog';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='engineering_access' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='f938c2436240212a1e1339c9c35080211410cfcead439442151abfbb65519a0b') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.engineering_access';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='database_access' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='4abea2bc0c004f0cf63a60410d4248751dc58c88f36c9603e2a0717b4bb6e1cb') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.database_access';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='database_sqlite_permit' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='6fd057d9d26d00ec260bcf0d79110fdbbd27ac37684be0db649a444c08c501d0') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.database_sqlite_permit';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='external_owner_deadline' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='78eae9de40052f885a3f98f9109e3a12fd63c2a10eaa666446d01d79c8c52ac6') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.external_owner_deadline';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='governance_manager' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='8498b8b1904ca7830199032cdbca63742323ab5871c6e8b2cfd392fcb2e354a1') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.governance_manager';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='lock_archive_project_scope' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='26b47008f9e6c8f1665eb738b3222f5a7175ea277d20055591d59a6de0b6904f') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.lock_archive_project_scope';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='v8' AND p.proname='work_project_move' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='7b6ea09934d5ca08739bbf9ba71116e9f5d5af0f471fc30243130a2754029025') THEN RAISE EXCEPTION 'reviewed_definition_changed:v8.work_project_move';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='shared_resource_check' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='6db611a3870fc9f0f7841adee6d8ad6e49c45c1374b5f9b2c9dd85b586a171ad') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.shared_resource_check';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='mem' AND p.proname='legacy_reference_import' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='4c397fef6cce740eecbdd7dfee83c0e40f0a8bfee456578b1312f39c8c2af8f5') THEN RAISE EXCEPTION 'reviewed_definition_changed:mem.legacy_reference_import';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='lock_resources' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='7b9c8eb04fedefef413456a2e27074f3dd1b20939362e8ce7aeba64ea0b9c9cb') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.lock_resources';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authz' AND p.proname='project_members' AND encode(public.digest(pg_get_functiondef(p.oid),'sha256'),'hex')='473648dfe5d13e49557fa676a5a9d484307f60a29cf0379b7a3e618e7e132aba') THEN RAISE EXCEPTION 'reviewed_definition_changed:authz.project_members';END IF;
END $reviewed$;
SET LOCAL ROLE hub2_v8_owner;
ALTER TABLE v8.projects DROP CONSTRAINT projects_visibility_check;
ALTER TABLE v8.projects ADD CONSTRAINT projects_visibility_check CHECK(visibility IN('personal','team','private'));
RESET ROLE;
-- Only this reviewed classification constraint changed; the project table still
-- contains no Mem fixed-reference consumer columns. Retain all other GC hashes.
UPDATE mem.gc_reference_contracts SET shape_hash=mem.gc_relation_shape('v8.projects'::regclass) WHERE schema_name='v8' AND table_name='projects' AND kind='none' AND cardinality(uuid_fields)=0 AND cardinality(json_fields)=0 AND shape_hash='5bf3ff5f89151a592741a316a259f379';
SET LOCAL ROLE hub2_authz_owner;
CREATE TABLE authz.project_privacy_requests(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,
 organization_id uuid NOT NULL,owner_id uuid NOT NULL REFERENCES authz.principals,
 grantee_id uuid NOT NULL REFERENCES authz.principals,requested_by uuid NOT NULL REFERENCES authz.principals,
 project_epoch bigint NOT NULL,revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','granted','rejected','withdrawn','revoked')),
 purpose text NOT NULL DEFAULT '',expires_at timestamptz,until_revoked boolean NOT NULL,
 owner_approved_by uuid REFERENCES authz.principals,owner_approved_at timestamptz,
 supervisor_approved_by uuid REFERENCES authz.principals,supervisor_approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((expires_at IS NULL)=until_revoked),
 CHECK((owner_approved_by IS NULL)=(owner_approved_at IS NULL)),
 CHECK((supervisor_approved_by IS NULL)=(supervisor_approved_at IS NULL)),
 CHECK(owner_approved_by IS NULL OR owner_approved_by=owner_id),
 CHECK(state<>'granted' OR(owner_approved_by IS NOT NULL AND supervisor_approved_by IS NOT NULL))
);
CREATE INDEX project_privacy_grantee ON authz.project_privacy_requests(project_id,grantee_id) WHERE state='granted';
ALTER TABLE authz.project_privacy_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY guarded_domain_owner_access ON authz.project_privacy_requests FOR ALL TO hub2_authz_owner USING(true) WITH CHECK(true);
REVOKE ALL ON authz.project_privacy_requests FROM PUBLIC,hub2_hufu,hub2_v8,hub2_mem,hub2_worker;

CREATE FUNCTION authz.project_privacy_read_deadline(p_actor uuid,p_project uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
 SELECT max(CASE WHEN r.until_revoked THEN 'infinity'::timestamptz ELSE r.expires_at END)
 FROM authz.project_privacy_requests r
 JOIN v8.projects pr ON pr.id=r.project_id AND pr.visibility='private' AND pr.state='active'
 JOIN authz.principals target ON target.id=r.grantee_id AND target.active AND target.kind IN('member','service') AND target.organization_id=pr.organization_id
 JOIN authz.principals owner ON owner.id=r.owner_approved_by AND owner.active AND owner.kind='member' AND owner.id=pr.owner_id AND owner.organization_id=pr.organization_id
 JOIN authz.principals supervisor ON supervisor.id=r.supervisor_approved_by AND supervisor.active AND supervisor.kind='member' AND supervisor.role='organization_admin' AND supervisor.organization_id=pr.organization_id
 WHERE r.grantee_id=p_actor AND r.project_id=p_project AND r.state='granted'
 AND r.project_epoch=pr.epoch AND r.owner_id=pr.owner_id AND r.organization_id=pr.organization_id
 AND r.owner_approved_at IS NOT NULL AND r.supervisor_approved_at IS NOT NULL
 AND(r.until_revoked OR r.expires_at>clock_timestamp())
$$;
REVOKE ALL ON FUNCTION authz.project_privacy_read_deadline(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.project_privacy_read_deadline(uuid,uuid) TO hub2_hufu,hub2_v8,hub2_mem,hub2_worker,hub2_v8_owner,hub2_mem_owner;

CREATE FUNCTION authz.project_privacy_api(proof text,command text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;actor authz.principals;pr record;r authz.project_privacy_requests;
 reqid uuid;grantee uuid;lim integer;view_name text;items jsonb;request_key text;fingerprint text;prior authz.operations;
 result jsonb;until_flag boolean;expires timestamptz;leg text;decision text;was_effective boolean;now_effective boolean;scope_pid uuid;previous_state text;o uuid:=gen_random_uuid();
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR (command IS NULL OR command NOT IN('apply','requests','decide','revoke')) OR b IS NULL OR jsonb_typeof(b)<>'object' THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 i:=authz.authenticate(proof);
 SELECT * INTO actor FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND kind='member';
 IF actor.id IS NULL OR NOT authz.ordinary_member_client901((i->>'client_id')::uuid) THEN RAISE EXCEPTION 'current_member_privacy_action_required' USING ERRCODE='42501';END IF;
 IF command='requests' THEN
  IF EXISTS(SELECT FROM jsonb_object_keys(b) k WHERE k NOT IN('request_id','project_id','view','limit','cursor')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
  view_name:=coalesce(b->>'view','all_visible');lim:=coalesce((b->>'limit')::integer,50);
  IF view_name NOT IN('mine','owner','supervisor','all_visible') OR lim NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.id),'[]'::jsonb) INTO items FROM(
   SELECT q.id,to_jsonb(q)||jsonb_build_object('owner_label',(SELECT display_name FROM authz.principals WHERE id=q.owner_id),'grantee_label',(SELECT display_name FROM authz.principals WHERE id=q.grantee_id),'requester_label',(SELECT display_name FROM authz.principals WHERE id=q.requested_by),'effective_read',coalesce(authz.project_privacy_read_deadline(q.grantee_id,q.project_id)>clock_timestamp(),false),'project_contents_included',false) AS item
   FROM authz.project_privacy_requests q
   WHERE q.organization_id=actor.organization_id
   AND(q.grantee_id=actor.id OR q.requested_by=actor.id OR q.owner_id=actor.id OR actor.role='organization_admin')
   AND(view_name='all_visible' OR view_name='mine' AND(q.grantee_id=actor.id OR q.requested_by=actor.id) OR view_name='owner' AND q.owner_id=actor.id OR view_name='supervisor' AND actor.role='organization_admin')
   AND(b->>'request_id' IS NULL OR q.id=(b->>'request_id')::uuid)
   AND(b->>'project_id' IS NULL OR q.project_id=(b->>'project_id')::uuid)
   AND(b->>'cursor' IS NULL OR q.id>(b->>'cursor')::uuid)
   AND authz.client_resource_allowed745((i->>'client_id')::uuid,q.project_id)
   ORDER BY q.id LIMIT lim+1
  )x;
  RETURN jsonb_build_object('state','read','items',CASE WHEN jsonb_array_length(items)>lim THEN items- lim ELSE items END,'next_cursor',CASE WHEN jsonb_array_length(items)>lim THEN items->(lim-1)->>'id' ELSE NULL END,'coverage','current_member_privacy_requests_only;no_project_contents');
 END IF;
 IF command='apply' THEN
  IF EXISTS(SELECT FROM jsonb_object_keys(b) k WHERE k NOT IN('project_id','grantee_id','purpose','expires_at','until_revoked','idempotency_key')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 ELSIF command='decide' THEN
  IF EXISTS(SELECT FROM jsonb_object_keys(b) k WHERE k NOT IN('request_id','expected_revision','decision','leg','reason','idempotency_key')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 ELSE
  IF EXISTS(SELECT FROM jsonb_object_keys(b) k WHERE k NOT IN('request_id','expected_revision','reason','idempotency_key')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 END IF;
 request_key:=b->>'idempotency_key';
 IF coalesce(length(request_key),0) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE='22023';END IF;
 fingerprint:=encode(public.digest('project_privacy.'||command||E'\n'||b::text,'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(actor.id::text||E'\n'||request_key,0));
 SELECT * INTO prior FROM authz.operations WHERE principal_id=actor.id AND idempotency_key=request_key;
 IF FOUND THEN
  IF prior.request_digest IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;
  RETURN prior.result||jsonb_build_object('replayed',true,'current_permission','query_requests_or_read_target;not_inferred_from_old_receipt');
 END IF;
 -- Same ordered authority fences as current effects. A decision increments the
 -- grantee epoch only when effective permission changes, invalidating old handles.
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals ORDER BY id FOR UPDATE;
 IF command='apply' THEN scope_pid:=(b->>'project_id')::uuid;ELSE SELECT project_id INTO scope_pid FROM authz.project_privacy_requests WHERE id=(b->>'request_id')::uuid;END IF;
 IF scope_pid IS NULL THEN RAISE EXCEPTION 'request_not_available' USING ERRCODE='42501';END IF;
 PERFORM authz.lock_resources(actor.id,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,jsonb_build_array(jsonb_build_object('project_id',scope_pid)));
 i:=authz.authenticate(proof);
 SELECT * INTO actor FROM authz.principals WHERE id=(i->>'actor_id')::uuid AND active AND kind='member';
 IF actor.id IS NULL OR NOT authz.ordinary_member_client901((i->>'client_id')::uuid) THEN RAISE EXCEPTION 'current_member_privacy_action_required' USING ERRCODE='42501';END IF;
 IF command='apply' THEN
  SELECT * INTO pr FROM v8.projects WHERE id=(b->>'project_id')::uuid FOR SHARE;
  IF pr.id IS NULL OR pr.organization_id IS DISTINCT FROM actor.organization_id OR pr.visibility<>'private' OR pr.state<>'active'
   OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,pr.id) THEN RAISE EXCEPTION 'private_project_request_not_available' USING ERRCODE='42501';END IF;
  grantee:=coalesce((b->>'grantee_id')::uuid,actor.id);
  IF grantee<>actor.id AND actor.id<>pr.owner_id THEN RAISE EXCEPTION 'owner_invitation_required' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=grantee AND active AND kind IN('member','service') AND organization_id=pr.organization_id) THEN RAISE EXCEPTION 'invalid_grantee' USING ERRCODE='22023';END IF;
  expires:=(b->>'expires_at')::timestamptz;until_flag:=coalesce((b->>'until_revoked')::boolean,expires IS NULL);
  IF(until_flag AND expires IS NOT NULL) OR(NOT until_flag AND(expires IS NULL OR expires<=clock_timestamp())) THEN RAISE EXCEPTION 'invalid_expiry' USING ERRCODE='22023';END IF;
  IF coalesce(length(b->>'purpose'),0)>4000 THEN RAISE EXCEPTION 'purpose_too_long' USING ERRCODE='22023';END IF;
  INSERT INTO authz.project_privacy_requests(project_id,organization_id,owner_id,grantee_id,requested_by,project_epoch,purpose,expires_at,until_revoked)
   VALUES(pr.id,pr.organization_id,pr.owner_id,grantee,actor.id,pr.epoch,coalesce(b->>'purpose',''),expires,until_flag) RETURNING * INTO r;
 ELSE
  SELECT * INTO r FROM authz.project_privacy_requests WHERE id=(b->>'request_id')::uuid FOR UPDATE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM actor.organization_id OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,r.project_id) THEN RAISE EXCEPTION 'request_not_available' USING ERRCODE='42501';END IF;
  SELECT * INTO pr FROM v8.projects WHERE id=r.project_id FOR SHARE;
  IF command='revoke' THEN
   IF actor.id<>r.owner_id AND actor.role<>'organization_admin' THEN RAISE EXCEPTION 'privacy_owner_or_supervisor_required' USING ERRCODE='42501';END IF;
  ELSE
   decision:=b->>'decision';leg:=b->>'leg';
   IF decision='withdraw' THEN
    IF actor.id NOT IN(r.requested_by,r.grantee_id) THEN RAISE EXCEPTION 'requester_required' USING ERRCODE='42501';END IF;
   ELSE
    IF decision NOT IN('approve','reject') OR decision IS NULL OR leg NOT IN('owner','supervisor') OR leg IS NULL THEN RAISE EXCEPTION 'decision_and_leg_required' USING ERRCODE='22023';END IF;
    IF leg='owner' AND(actor.id<>r.owner_id OR pr.owner_id IS DISTINCT FROM actor.id) THEN RAISE EXCEPTION 'actual_project_owner_required' USING ERRCODE='42501';END IF;
    IF leg='supervisor' AND actor.role<>'organization_admin' THEN RAISE EXCEPTION 'actual_organization_supervisor_required' USING ERRCODE='42501';END IF;
   END IF;
  END IF;
  IF(b->>'expected_revision')::bigint IS DISTINCT FROM r.revision THEN RAISE EXCEPTION 'request_revision_conflict' USING ERRCODE='40001';END IF;
  previous_state:=r.state;
  was_effective:=coalesce(authz.project_privacy_read_deadline(r.grantee_id,r.project_id)>clock_timestamp(),false);
  IF command='revoke' THEN
   IF r.state NOT IN('pending','granted') THEN RAISE EXCEPTION 'request_not_active' USING ERRCODE='22023';END IF;
   UPDATE authz.project_privacy_requests SET state='revoked',revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
  ELSE
   IF r.state<>'pending' THEN RAISE EXCEPTION 'request_not_pending' USING ERRCODE='22023';END IF;
   IF decision='withdraw' OR decision='reject' THEN
    UPDATE authz.project_privacy_requests SET state=CASE WHEN decision='withdraw' THEN 'withdrawn' ELSE 'rejected' END,revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
   ELSE
    IF pr.visibility IS DISTINCT FROM 'private' OR pr.state IS DISTINCT FROM 'active' OR pr.epoch IS DISTINCT FROM r.project_epoch OR pr.owner_id IS DISTINCT FROM r.owner_id OR(NOT r.until_revoked AND r.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'request_scope_or_expiry_changed' USING ERRCODE='40001';END IF;
    IF leg='owner' THEN
     IF r.owner_approved_by IS NOT NULL THEN RAISE EXCEPTION 'owner_leg_already_decided' USING ERRCODE='22023';END IF;
     UPDATE authz.project_privacy_requests SET owner_approved_by=actor.id,owner_approved_at=clock_timestamp() WHERE id=r.id;
    ELSE
     IF r.supervisor_approved_by IS NOT NULL THEN RAISE EXCEPTION 'supervisor_leg_already_decided' USING ERRCODE='22023';END IF;
     UPDATE authz.project_privacy_requests SET supervisor_approved_by=actor.id,supervisor_approved_at=clock_timestamp() WHERE id=r.id;
    END IF;
    UPDATE authz.project_privacy_requests SET state=CASE WHEN owner_approved_by IS NOT NULL AND supervisor_approved_by IS NOT NULL THEN 'granted' ELSE 'pending' END,revision=revision+1,updated_at=clock_timestamp() WHERE id=r.id RETURNING * INTO r;
    IF r.state='granted' AND authz.project_privacy_read_deadline(r.grantee_id,r.project_id) IS NULL THEN RAISE EXCEPTION 'both_current_roles_required' USING ERRCODE='42501';END IF;
   END IF;
  END IF;
  now_effective:=coalesce(authz.project_privacy_read_deadline(r.grantee_id,r.project_id)>clock_timestamp(),false);
  IF(previous_state='granted' OR r.state='granted') AND r.grantee_id IS DISTINCT FROM pr.owner_id THEN UPDATE authz.principals SET epoch=epoch+1 WHERE id=r.grantee_id;END IF;
 END IF;
 result:=jsonb_build_object('state',r.state,'request_id',r.id,'project_id',r.project_id,'revision',r.revision,'grantee_id',r.grantee_id,'owner_approved',r.owner_approved_by IS NOT NULL,'supervisor_approved',r.supervisor_approved_by IS NOT NULL,'effective_read',coalesce(authz.project_privacy_read_deadline(r.grantee_id,r.project_id)>clock_timestamp(),false),'operation_id',o,'next_step',CASE WHEN r.state='pending' THEN 'obtain_each_missing_actual_role_approval' WHEN r.state='granted' THEN 'read_same_project_as_grantee;other_work_actions_still_need_qualification' ELSE 'new_request_requires_both_roles_again' END);
 INSERT INTO evidence.audit(actor_id,client_id,domain,action,aggregate_id,revision,operation_id,details)
  VALUES(actor.id,(i->>'client_id')::uuid,'authz','project_privacy.'||command,r.id,r.revision,o,jsonb_build_object('project_id',r.project_id,'state',r.state,'leg',leg,'grantee_id',r.grantee_id));
 INSERT INTO authz.operations(principal_id,idempotency_key,request_digest,result) VALUES(actor.id,request_key,fingerprint,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION authz.project_privacy_api(text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.project_privacy_api(text,text,jsonb) TO hub2_hufu;
RESET ROLE;
-- Current authority wrappers and project functions are appended by the build script.
SET LOCAL ROLE hub2_authz_owner;
CREATE FUNCTION authz.project_read_visible(i jsonb,pid uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 PERFORM authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,pid,'v8.project.read',jsonb_build_object('project_id',pid));
 RETURN true;
EXCEPTION WHEN insufficient_privilege THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION authz.project_read_visible(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.project_read_visible(jsonb,uuid) TO hub2_hufu,hub2_v8,hub2_mem,hub2_worker;
CREATE FUNCTION authz.require_project_creation_role(c jsonb,visibility text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE actor authz.principals;
BEGIN
 IF authz.runtime_role()<>'hub2_v8' THEN RAISE EXCEPTION 'invalid_coordination_caller' USING ERRCODE='42501';END IF;
 SELECT * INTO actor FROM authz.principals WHERE id=(c->>'actor_id')::uuid AND active;
 IF actor.id IS NULL OR actor.organization_id IS DISTINCT FROM (c->>'organization_id')::uuid THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501';END IF;
 IF visibility IS NULL OR visibility NOT IN('personal','team') THEN RAISE EXCEPTION 'privacy_requires_explicit_project_mark' USING ERRCODE='42501';END IF;
 IF visibility='team' AND(actor.role<>'organization_admin' OR actor.kind<>'member') THEN RAISE EXCEPTION 'team_creation_requires_supervisor' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION authz.require_project_creation_role(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.require_project_creation_role(jsonb,text) TO hub2_v8_owner;

RESET ROLE; -- retain each reviewed existing function owner and ACL
CREATE OR REPLACE FUNCTION authz.resource_deadline(p_actor uuid, p_client uuid, p_project uuid, p_action text, r jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE p authz.principals; pr record; deadline timestamptz; privacy_deadline timestamptz:='infinity'; q record;
BEGIN
 IF p_action NOT IN('mem.upload','mem.read','mem.write','mem.delete','mem.share','mem.process','mem.correct','mem.discover','mem.read_history','v8.project.create','v8.project.read','v8.project.convert','v8.project.update','v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read','v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read','v8.experience.publish','v8.experience.feedback','v8.experience.read') THEN RAISE EXCEPTION 'unknown_action' USING ERRCODE='42501'; END IF;
 IF p_actor IS NULL OR p_client IS NULL OR p_project IS NULL OR p_action IS NULL OR r IS NULL THEN RAISE EXCEPTION 'invalid_authority_input' USING ERRCODE='42501'; END IF;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 IF p.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients c WHERE c.id=p_client AND c.principal_id=p_actor AND c.active) THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501'; END IF;
 PERFORM authz.require_client_capability(jsonb_build_object('actor_id',p_actor,'client_id',p_client),p_action);
 IF NOT authz.client_resource_allowed745(p_client,p_project) THEN RAISE EXCEPTION 'restricted_credential_scope_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF NOT FOUND THEN
  IF p_action='v8.project.create' AND (r->>'project_id')::uuid=p_project AND (r->>'organization_id')::uuid=p.organization_id AND (r->>'owner_id')::uuid=p_actor THEN
   IF coalesce(r->>'visibility','personal') NOT IN('personal','team') THEN RAISE EXCEPTION 'privacy_requires_explicit_project_mark' USING ERRCODE='42501';END IF;
   IF r->>'visibility'='team' AND(p.role<>'organization_admin' OR p.kind<>'member') THEN RAISE EXCEPTION 'team_creation_requires_supervisor' USING ERRCODE='42501';END IF;
   RETURN 'infinity';END IF;
  RAISE EXCEPTION 'invisible_project' USING ERRCODE='42501';
 END IF;
 IF pr.state<>'active' OR pr.kind NOT IN('project','dialogue') OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',p_project,r) THEN RAISE EXCEPTION 'invalid_project_resource' USING ERRCODE='42501'; END IF;
 IF p_action='v8.project.create' AND pr.owner_id=p_actor THEN RETURN 'infinity'; END IF;
 IF pr.visibility='private' AND pr.owner_id<>p_actor THEN
  privacy_deadline:=authz.project_privacy_read_deadline(p_actor,p_project);
  IF privacy_deadline IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;
 END IF;
 IF p_action IN('v8.project.convert','v8.project.update') THEN
  IF pr.visibility='private' AND pr.owner_id<>p_actor THEN RAISE EXCEPTION 'privacy_owner_controls_classification' USING ERRCODE='42501';END IF;
  IF pr.owner_id=p_actor OR(pr.visibility IN('personal','team') AND p.role='organization_admin' AND p.kind='member') THEN RETURN 'infinity';END IF;
 END IF;
 IF (pr.visibility IN('personal','private') AND pr.owner_id=p_actor) OR p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND (pr.owner_id=p_actor OR pr.visibility IN('personal','team')) THEN RETURN 'infinity'; END IF;
 IF pr.visibility='private' AND p_action IN('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read') AND privacy_deadline>clock_timestamp() THEN RETURN privacy_deadline;END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=p_actor AND project_id=p_project AND kind='work' ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,p_actor,p_project,p_action,r); IF deadline IS NOT NULL THEN RETURN least(deadline,privacy_deadline); END IF;
 END LOOP;
 RAISE EXCEPTION 'member_qualification_required' USING ERRCODE='42501';
END $function$;
CREATE OR REPLACE FUNCTION authz.check_access(p_actor uuid,p_client uuid,p_project uuid,p_action text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE pr v8.projects;actor authz.principals;
BEGIN
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF pr.id IS NULL AND p_action='v8.project.create' THEN
  SELECT * INTO actor FROM authz.principals WHERE id=p_actor;
  IF actor.active IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM authz.clients WHERE id=p_client AND principal_id=p_actor AND active) THEN RAISE EXCEPTION 'identity_mismatch' USING ERRCODE='42501';END IF;
  PERFORM authz.require_client_capability(jsonb_build_object('actor_id',p_actor,'client_id',p_client),p_action);
  IF NOT authz.client_resource_allowed745(p_client,p_project) THEN RAISE EXCEPTION 'restricted_credential_scope_required' USING ERRCODE='42501';END IF;
  RETURN NULL; -- full create visibility/identity resource is checked by issue_handle.
 END IF;
 PERFORM authz.resource_deadline(p_actor,p_client,p_project,p_action,jsonb_build_object('project_id',p_project));
 RETURN pr.revision;
END $$;
CREATE OR REPLACE FUNCTION authz.qualification_deadline(qid uuid, p_actor uuid, p_project uuid, p_action text, r jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE q authz.qualifications;p authz.principals;pr record;parent authz.qualifications;root authz.qualifications;issuer authz.principals;deadline timestamptz:='infinity'; privacy_deadline timestamptz:='infinity';
BEGIN
 SELECT * INTO q FROM authz.qualifications WHERE id=qid;
 SELECT * INTO p FROM authz.principals WHERE id=p_actor;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project;
 IF q.id IS NULL OR p.id IS NULL OR pr.id IS NULL OR p.active IS DISTINCT FROM true OR (pr.state IS DISTINCT FROM 'active' AND p_action NOT IN ('mem.read','mem.discover','mem.read_history','v8.project.read','v8.work.read','v8.work.related_candidates','v8.adoption.read','v8.context.read','v8.context.materialize','v8.handoff.read','v8.experience.read')) OR pr.kind NOT IN('project','dialogue') OR p.organization_id IS DISTINCT FROM pr.organization_id OR q.principal_id IS DISTINCT FROM p_actor OR q.project_id IS DISTINCT FROM p_project OR q.kind<>'work' OR q.active IS DISTINCT FROM true OR q.frozen OR (p_action=ANY(q.actions)) IS DISTINCT FROM true OR NOT authz.selector_matches(q.resource_selector,p_project,r) THEN RETURN NULL;END IF;
 IF pr.visibility='private' AND pr.owner_id<>p_actor THEN privacy_deadline:=authz.project_privacy_read_deadline(p_actor,p_project);IF privacy_deadline IS NULL THEN RETURN NULL;END IF;END IF;
 SELECT * INTO issuer FROM authz.principals WHERE id=q.source_actor_id;
 IF issuer.active IS DISTINCT FROM true OR issuer.organization_id IS DISTINCT FROM pr.organization_id THEN RETURN NULL;END IF;
 IF NOT q.until_revoked THEN deadline:=q.expires_at;END IF;
 IF deadline IS NULL OR deadline<=clock_timestamp() THEN RETURN NULL;END IF;
 IF q.parent_id IS NULL THEN
  IF q.source_basis='independent_work' OR q.source_actor_id=pr.manager_id OR (pr.visibility IN('personal','private') AND q.source_actor_id=pr.owner_id) OR issuer.role='organization_admin' THEN RETURN least(deadline,privacy_deadline);END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO parent FROM authz.qualifications WHERE id=q.parent_id;
 IF parent.id IS NULL OR parent.kind<>'management' OR parent.active IS DISTINCT FROM true OR parent.frozen OR parent.project_id<>p_project OR q.source_actor_id NOT IN(parent.principal_id,parent.source_actor_id) OR (q.actions<@parent.actions) IS DISTINCT FROM true OR NOT authz.selector_subset(q.resource_selector,parent.resource_selector) THEN RETURN NULL;END IF;
 IF NOT parent.until_revoked THEN deadline:=least(deadline,parent.expires_at);END IF;
 SELECT * INTO issuer FROM authz.principals WHERE id=parent.source_actor_id;
 IF issuer.active IS DISTINCT FROM true OR issuer.organization_id IS DISTINCT FROM pr.organization_id OR deadline<=clock_timestamp() THEN RETURN NULL;END IF;
 IF parent.depth=0 THEN
  IF parent.source_actor_id=pr.manager_id OR (pr.visibility IN('personal','private') AND parent.source_actor_id=pr.owner_id) OR issuer.role='organization_admin' THEN RETURN least(deadline,privacy_deadline);END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO root FROM authz.qualifications WHERE id=parent.parent_id;
 SELECT * INTO issuer FROM authz.principals WHERE id=root.source_actor_id;
 IF root.id IS NULL OR root.kind<>'management' OR root.depth<>0 OR root.active IS DISTINCT FROM true OR root.frozen OR root.project_id<>p_project OR parent.source_actor_id IS DISTINCT FROM root.principal_id OR issuer.active IS DISTINCT FROM true OR issuer.organization_id IS DISTINCT FROM pr.organization_id OR (parent.actions<@root.actions) IS DISTINCT FROM true OR NOT authz.selector_subset(parent.resource_selector,root.resource_selector) THEN RETURN NULL;END IF;
 IF NOT root.until_revoked THEN deadline:=least(deadline,root.expires_at);END IF;
 IF deadline<=clock_timestamp() OR NOT(root.source_actor_id=pr.manager_id OR (pr.visibility IN('personal','private') AND root.source_actor_id=pr.owner_id) OR issuer.role='organization_admin') THEN RETURN NULL;END IF;
 RETURN least(deadline,privacy_deadline);
END $function$;
CREATE OR REPLACE FUNCTION authz.project_scope_transition(c jsonb, p_project uuid, p_expected bigint, p_visibility text, p_kind text, p_manager uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE pr record; actor authz.principals; manager authz.principals; root_qualification uuid; leader_qualification uuid; next_revision bigint;existing authz.qualifications;selector jsonb:='{"version":1,"kind":"project"}';preset authz.work_presets;
 management_actions text[]:=ARRAY['mem.read','mem.upload','mem.write','mem.delete','mem.process','mem.correct','mem.share',
 'v8.project.convert','v8.project.update',
 'v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read',
 'v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read',
 'v8.experience.publish','v8.experience.publish','v8.experience.feedback','v8.experience.read'];
 work_actions text[]:=ARRAY['mem.read','mem.upload','mem.write','mem.delete','mem.share','mem.correct','mem.process',
 'v8.work.open','v8.work.read','v8.work.commit','v8.work.related_candidates','v8.adoption.set','v8.adoption.read',
 'v8.context.prepare','v8.context.materialize','v8.context.read','v8.handoff.record','v8.handoff.read',
 'v8.experience.publish','v8.experience.feedback','v8.experience.read'];
BEGIN
 IF authz.runtime_role()<>'hub2_v8' OR p_visibility NOT IN('personal','team','private') OR p_kind NOT IN('project','dialogue')
 OR (c->>'project_id')::uuid IS DISTINCT FROM p_project THEN RAISE EXCEPTION 'invalid_coordination' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor FROM authz.principals WHERE id=(c->>'actor_id')::uuid AND active;
 SELECT * INTO pr FROM v8.projects WHERE id=p_project FOR UPDATE;
 IF actor.id IS NULL OR pr.id IS NULL OR pr.revision<>p_expected OR actor.organization_id<>pr.organization_id THEN RAISE EXCEPTION 'revision_or_identity_conflict' USING ERRCODE='40001'; END IF;
 IF actor.id NOT IN(pr.owner_id,pr.manager_id) AND actor.role<>'organization_admin' THEN RAISE EXCEPTION 'management_required' USING ERRCODE='42501'; END IF;
 IF p_visibility='team' AND(actor.role<>'organization_admin' OR actor.kind<>'member') THEN RAISE EXCEPTION 'team_creation_requires_supervisor' USING ERRCODE='42501';END IF;
 IF(pr.visibility='private' OR p_visibility='private') AND actor.id<>pr.owner_id THEN RAISE EXCEPTION 'privacy_owner_controls_classification' USING ERRCODE='42501';END IF;
 next_revision:=CASE WHEN c->>'action'='v8.project.create' THEN p_expected ELSE p_expected+1 END;
 IF p_visibility='team' THEN
  SELECT * INTO manager FROM authz.principals WHERE id=p_manager AND active AND role='organization_admin' AND organization_id=pr.organization_id FOR SHARE;
  IF manager.id IS NULL THEN RAISE EXCEPTION 'invalid_organization_manager' USING ERRCODE='42501'; END IF;
  SELECT * INTO existing FROM authz.qualifications WHERE project_id=p_project AND principal_id=manager.id AND kind='management' AND depth=0 AND active AND NOT frozen ORDER BY CASE WHEN resource_selector->>'kind'='set' THEN 0 ELSE 1 END,id LIMIT 1;
  IF existing.id IS NOT NULL THEN selector:=existing.resource_selector;management_actions:=existing.actions;END IF;
  SELECT * INTO preset FROM authz.work_presets WHERE project_id=p_project;
  IF preset.project_id IS NOT NULL AND preset.actions<@management_actions AND authz.selector_subset(preset.resource_selector,selector) THEN work_actions:=preset.actions;selector:=preset.resource_selector;
  ELSE SELECT array_agg(a) INTO work_actions FROM unnest(work_actions) a WHERE a=ANY(management_actions);END IF;
  -- Explicit management source, distinct from ordinary work rights. Retain independent work qualifications.
  UPDATE authz.qualifications SET active=false,epoch=epoch+1 WHERE project_id=p_project AND kind='management';
  INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,depth,until_revoked,source_project_revision)
   VALUES(manager.id,p_project,management_actions,manager.id,'management',0,true,next_revision) RETURNING id INTO root_qualification;
  UPDATE authz.qualifications SET resource_selector=selector,expires_at=CASE WHEN existing.id IS NOT NULL THEN existing.expires_at END,until_revoked=CASE WHEN existing.id IS NOT NULL THEN existing.until_revoked ELSE true END WHERE id=root_qualification;
  IF cardinality(work_actions)>0 THEN INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,until_revoked,source_project_revision,resource_selector,source_basis) VALUES(manager.id,p_project,work_actions,manager.id,root_qualification,'work',1,true,next_revision,selector,'management_appointment');END IF;
  IF pr.owner_id<>manager.id AND cardinality(work_actions)>0 THEN
   INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,until_revoked,source_project_revision)
    VALUES(pr.owner_id,p_project,work_actions,manager.id,root_qualification,'management',1,true,next_revision) RETURNING id INTO leader_qualification;
  UPDATE authz.qualifications SET resource_selector=selector WHERE id=leader_qualification;
  ELSE leader_qualification:=CASE WHEN pr.owner_id=manager.id THEN root_qualification ELSE NULL END; END IF;
  IF cardinality(work_actions)>0 THEN
  INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,parent_id,kind,depth,until_revoked,source_project_revision)
   VALUES(pr.owner_id,p_project,work_actions,manager.id,leader_qualification,'work',1,true,next_revision);
  END IF;
 UPDATE authz.qualifications SET resource_selector=selector,expires_at=CASE WHEN existing.id IS NOT NULL THEN existing.expires_at END,until_revoked=CASE WHEN existing.id IS NOT NULL THEN existing.until_revoked ELSE true END WHERE project_id=p_project AND (id=leader_qualification OR (parent_id IN(root_qualification,leader_qualification) AND kind='work'));
 ELSIF p_manager IS DISTINCT FROM pr.owner_id THEN
  RAISE EXCEPTION 'personal_manager_must_be_owner' USING ERRCODE='42501';
 END IF;
 -- Called after exclusive principal fencing for project create/convert in consume_handle.

 RETURN jsonb_build_object('state','coordinated','manager_id',p_manager,'root_management_qualification',root_qualification,
  'leader_management_qualification',leader_qualification);
END $function$;
CREATE OR REPLACE FUNCTION authz.authorization_resolve(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;items jsonb;
BEGIN
 i:=authz.authenticate(proof);
 SELECT coalesce(jsonb_agg(jsonb_build_object('project_id',p.id,'title',p.title,'visibility',p.visibility,'kind',p.kind)),'[]') INTO items FROM v8.projects p
 WHERE p.organization_id=(i->>'organization_id')::uuid AND p.state='active' AND authz.project_read_visible(i,p.id)
 AND authz.client_resource_allowed745((i->>'client_id')::uuid,p.id)
 AND (NOT b ? 'project_id' OR p.id=(b->>'project_id')::uuid)
 AND (NOT b ? 'project' OR p.title=b->>'project' OR (b->>'project'='机灵' AND p.id='6aedbc32-3768-47cc-a1e2-ff4297be5be7'));
 IF jsonb_array_length(items)=0 THEN RETURN jsonb_build_object('state','project_not_found','candidates',items);END IF;
 IF jsonb_array_length(items)<>1 THEN RETURN jsonb_build_object('state','choose_project','candidates',items);END IF;
 RETURN jsonb_build_object('state','resolved','project',items->0);
END $function$;
CREATE OR REPLACE FUNCTION authz.authorization_catalog(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;p record;e authz.engineering_projects;acts text[];a text;allowed text[];d timestamptz;items jsonb:='[]';resolved jsonb;gid uuid;
BEGIN
 i:=authz.authenticate(proof);
 IF b ? 'project' OR b ? 'project_id' THEN resolved:=authz.authorization_resolve(proof,b);IF resolved->>'state'<>'resolved' THEN RETURN resolved;END IF;gid:=(resolved->'project'->>'project_id')::uuid;END IF;
 FOR p IN SELECT * FROM v8.projects WHERE organization_id=(i->>'organization_id')::uuid AND state='active' AND (gid IS NULL OR id=gid) AND authz.project_read_visible(i,v8.projects.id) AND authz.client_resource_allowed745((i->>'client_id')::uuid,id) ORDER BY title LOOP
  SELECT * INTO e FROM authz.engineering_projects WHERE project_id=p.id;
  SELECT actions INTO acts FROM authz.work_presets WHERE project_id=p.id;acts:=coalesce(acts,authz.business_actions());allowed:='{}';
  FOREACH a IN ARRAY acts LOOP
   BEGIN d:=authz.resource_deadline((i->>'actor_id')::uuid,(i->>'client_id')::uuid,p.id,a,jsonb_build_object('project_id',p.id));IF d>clock_timestamp() THEN allowed:=array_append(allowed,a);END IF;EXCEPTION WHEN insufficient_privilege THEN NULL;END;
  END LOOP;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',p.id,'title',p.title,'visibility',p.visibility,'can_manage',authz.engineering_can_manage(proof,p.id),
   'business',jsonb_build_object('ready',acts<@allowed,'allowed_actions',allowed,'missing_actions',ARRAY(SELECT unnest(acts) EXCEPT SELECT unnest(allowed)),'apply',jsonb_build_object('path','/v2/authorization/apply','profile','business')),
   'engineering',CASE WHEN e.project_id IS NULL THEN jsonb_build_object('state','not_registered') ELSE jsonb_build_object('registered',e.ready,'resources',e.descriptor,'apply_path','/v2/engineering/apply') END,
   'database',jsonb_build_object('domains',coalesce(e.descriptor->'database_domains','[]'),'domains_backend','postgresql','domains_note','empty PostgreSQL domains does not indicate absence of SQLite;discover actual schemas/tables/backend using objects','objects_path','/v2/database-access/objects','objects_fields',jsonb_build_array('project_id'),'sqlite_inspect_path','/v2/database-access/sqlite/inspect','sqlite_execute_path','/v2/database-access/sqlite/execute','help_path','/v2/database-access/help'),
   'routes',jsonb_build_object('credentials','/v2/vault/directory','resource_apply','/v2/authorization/apply','management_challenge','/v2/engineering/management/challenge')));
 END LOOP;
 RETURN jsonb_build_object('state','read','identity',jsonb_build_object('actor_id',i->>'actor_id','client_id',i->>'client_id'),'items',items,'coverage','currently_visible_projects_and_registered_resources;not_a_grant');
END $function$;
CREATE OR REPLACE FUNCTION authz.search_can_read_resource(actor uuid,project uuid,r jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
BEGIN
 IF actor IS NULL OR project IS NULL OR r IS NULL THEN RETURN false;END IF;
 RETURN authz.can_read_resource(actor,project,r);
END $$;
CREATE OR REPLACE FUNCTION authz.engineering_catalog(proof text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;e record;permit jsonb;access jsonb;items jsonb:='[]';
BEGIN
 i:=authz.authenticate(proof);
 FOR e IN
  SELECT ep.* FROM authz.engineering_projects ep
  JOIN v8.projects p ON p.id=ep.project_id
  WHERE p.organization_id=(i->>'organization_id')::uuid
    AND authz.project_read_visible(i,p.id)
    AND (
      authz.client_resource_allowed745((i->>'client_id')::uuid,p.id)
      OR EXISTS (
        SELECT 1 FROM authz.qualifications q
        WHERE q.principal_id=(i->>'actor_id')::uuid
          AND q.project_id=p.id
          AND q.kind='work'
          AND q.actions @> ARRAY['resource.read']
          AND authz.qualification_deadline(q.id,(i->>'actor_id')::uuid,p.id,'resource.read',jsonb_build_object('project_id',p.id))>clock_timestamp()
      )
    )
 LOOP
  BEGIN
   permit:=authz.engineering_access(proof,e.project_id,'read');
   access:=jsonb_build_object('state','enabled','expires_at',CASE WHEN permit->>'engineering_authority_source'='organization_supervisor' THEN NULL ELSE permit->'deadline' END,'execution_permit_until',permit->'deadline','qualification_id',permit->'qualification_id','authority_source',COALESCE(permit->>'engineering_authority_source','project_qualification'));
  EXCEPTION WHEN insufficient_privilege THEN
   access:=jsonb_build_object('state','not_granted','next_step','apply_for_whole_project');
  END;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',e.project_id,'title',e.title,'ready',e.ready,'resources',e.descriptor,'revision',e.revision,'current_access',access));
 END LOOP;
 RETURN jsonb_build_object('state','read','items',items);
END $function$;
CREATE OR REPLACE FUNCTION authz.engineering_access(proof text, p_project uuid, p_operation text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE
 i jsonb;
 b authz.engineering_bindings;
 q authz.qualifications;
 pr authz.engineering_projects;
 d timestamptz;
 act text;
 client_scope boolean;
 account_scope boolean := false;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR p_operation NOT IN('read','write','deploy') THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
 END IF;
 i:=authz.authenticate(proof);
 IF EXISTS(SELECT FROM v8.projects WHERE id=p_project AND visibility='private' AND owner_id<>(i->>'actor_id')::uuid) AND authz.project_privacy_read_deadline((i->>'actor_id')::uuid,p_project) IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;

 act:='resource.'||p_operation;
 PERFORM authz.require_client_capability(i,act);
 SELECT * INTO pr FROM authz.engineering_projects WHERE project_id=p_project;
 client_scope:=authz.client_resource_allowed745((i->>'client_id')::uuid,p_project);

 -- Organization supervisor authority is account-based. It does not require
 -- a synthetic personal application or a client-specific project grant.
 -- Service/delegated credentials never inherit this role; explicit scope stays.
 IF pr.ready IS TRUE AND client_scope
    AND i->>'principal_kind'='member'
    AND ((i->>'is_primary')::boolean OR i->>'authority_source'='member_issued_api')
    AND EXISTS(SELECT FROM authz.principals actor JOIN v8.projects project
       ON project.organization_id=actor.organization_id
       WHERE actor.id=(i->>'actor_id')::uuid AND actor.active
         AND actor.role='organization_admin' AND project.id=p_project
         AND (project.visibility='team' OR project.owner_id=actor.id)) THEN
  d:=least(clock_timestamp()+interval '30 minutes',
      COALESCE((pr.descriptor->>'resource_valid_until')::timestamptz,'infinity'::timestamptz),
      CASE WHEN COALESCE((i->>'until_revoked')::boolean,false)
        THEN 'infinity'::timestamptz ELSE (i->>'expires_at')::timestamptz END);
  IF d<=clock_timestamp() THEN RAISE EXCEPTION 'engineering_resource_expired' USING ERRCODE='42501';END IF;
  RETURN i||jsonb_build_object('project_id',p_project,'deadline',d,
     'descriptor',pr.descriptor,'operation',p_operation,'qualification_id',NULL,
     'engineering_authority_source','organization_supervisor',
     'authority_rechecked_each_call',true);
 END IF;


 -- The member's active project qualification is authoritative for project
 -- scope.  This is intentionally independent of a stale client project
 -- filter.  The client action list is checked below as the capability ceiling.
 FOR q IN
  SELECT * FROM authz.qualifications
  WHERE principal_id=(i->>'actor_id')::uuid
    AND project_id=p_project
    AND kind='work'
    AND actions @> ARRAY[act]
 LOOP
  d:=authz.qualification_deadline(q.id,(i->>'actor_id')::uuid,p_project,act,jsonb_build_object('project_id',p_project));
  IF d IS NOT NULL AND d>clock_timestamp() THEN
   account_scope:=true;
   IF b.client_id IS NULL OR b.expires_at<=clock_timestamp() THEN
    INSERT INTO authz.engineering_bindings(project_id,client_id,qualification_id,expires_at,approved_actor_id)
    VALUES(p_project,(i->>'client_id')::uuid,q.id,d,q.source_actor_id)
    ON CONFLICT(project_id,client_id) DO UPDATE
      SET qualification_id=EXCLUDED.qualification_id,
          expires_at=EXCLUDED.expires_at,
          approved_actor_id=EXCLUDED.approved_actor_id;
    SELECT * INTO b FROM authz.engineering_bindings
    WHERE project_id=p_project AND client_id=(i->>'client_id')::uuid;
   END IF;
   EXIT;
  END IF;
 END LOOP;

 IF pr.ready IS DISTINCT FROM true
    OR b.client_id IS NULL
    OR b.expires_at<=clock_timestamp()
    OR NOT client_scope THEN
  RAISE EXCEPTION 'engineering_project_access_required' USING ERRCODE='42501';
 END IF;

 -- Keep the software capability ceiling, but do not require a project-specific
 -- MCP. Read operations need a read-capable client; writes/deploys need write.
 IF p_operation='read' THEN
  IF NOT('mem.read'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))
         OR 'v8.project.read'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))
         OR 'mem.write'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))) THEN
   RAISE EXCEPTION 'software_work_capability_required' USING ERRCODE='42501';
  END IF;
 ELSE
  IF NOT('mem.write'=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions')))) THEN
   RAISE EXCEPTION 'software_work_capability_required' USING ERRCODE='42501';
  END IF;
 END IF;

 d:=authz.qualification_deadline(b.qualification_id,(i->>'actor_id')::uuid,p_project,act,jsonb_build_object('project_id',p_project));
 IF d IS NULL THEN RAISE EXCEPTION 'engineering_qualification_expired_or_revoked' USING ERRCODE='42501';END IF;
 RETURN i||jsonb_build_object('project_id',p_project,'deadline',least(d,b.expires_at,CASE WHEN (i->>'until_revoked')::boolean THEN 'infinity'::timestamptz ELSE (i->>'expires_at')::timestamptz END),'descriptor',pr.descriptor,'operation',p_operation,'qualification_id',b.qualification_id);
END $function$;
CREATE OR REPLACE FUNCTION authz.database_access(proof text, b jsonb, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;g authz.database_permissions;o jsonb;
BEGIN
 i:=authz.authenticate(proof);
 IF EXISTS(SELECT FROM v8.projects WHERE id=(b->>'project_id')::uuid AND visibility='private' AND owner_id<>(i->>'actor_id')::uuid) AND authz.project_privacy_read_deadline((i->>'actor_id')::uuid,(b->>'project_id')::uuid) IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;

 IF b->>'schema' IN ('authn','authz','vault2') AND p_action<>'inspect' THEN RAISE EXCEPTION 'sensitive_domain_inspect_only' USING ERRCODE='42501';END IF;
 IF p_action NOT IN('inspect','select','insert','update','delete') OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,(b->>'project_id')::uuid) OR NOT (CASE WHEN p_action IN('inspect','select') THEN 'mem.read' ELSE 'mem.write' END)=ANY(ARRAY(SELECT jsonb_array_elements_text(i->'client_actions'))) THEN RAISE EXCEPTION 'software_scope_required' USING ERRCODE='42501';END IF;
 SELECT p.* INTO g FROM authz.database_permissions p JOIN authz.principals issuer ON issuer.id=p.approved_by JOIN v8.projects pr ON pr.id=p.project_id WHERE p.actor_id=(i->>'actor_id')::uuid AND p.project_id=(b->>'project_id')::uuid AND p.active AND NOT p.suspended AND p.expires_at>clock_timestamp() AND pr.state='active' AND issuer.active AND issuer.organization_id=pr.organization_id AND (issuer.id=pr.manager_id OR issuer.role='organization_admin' OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=issuer.id AND q.project_id=pr.id AND q.kind='management' AND authz.management_valid(q.id,issuer.id,pr.id))) AND EXISTS(SELECT FROM jsonb_array_elements(p.objects) x WHERE x->>'schema'=b->>'schema' AND x->>'table'=b->>'table' AND (x->'actions' ? p_action OR p_action='inspect')) ORDER BY p.expires_at DESC LIMIT 1 FOR SHARE OF p;
 IF g.id IS NULL THEN RAISE EXCEPTION 'database_permission_required' USING ERRCODE='42501';END IF;
 SELECT value INTO o FROM jsonb_array_elements(g.objects) WHERE value->>'schema'=b->>'schema' AND value->>'table'=b->>'table';
 IF to_regclass(format('%I.%I',o->>'schema',o->>'table'))::oid IS DISTINCT FROM (o->>'relation_oid')::oid THEN RAISE EXCEPTION 'database_object_replaced' USING ERRCODE='40001';END IF;
 IF NOT pg_has_role(session_user,g.role_name,'SET') THEN EXECUTE format('GRANT %I TO %I',g.role_name,session_user);END IF;
 RETURN jsonb_build_object('permission_id',g.id,'role_name',g.role_name,'actor_id',i->>'actor_id','client_id',i->>'client_id','object',o,'expires_at',least(g.expires_at,coalesce(authz.project_privacy_read_deadline((i->>'actor_id')::uuid,(b->>'project_id')::uuid),'infinity'::timestamptz)));
END $function$;
CREATE OR REPLACE FUNCTION authz.database_sqlite_permit(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;t authz.sqlite_targets;objects jsonb;until_at timestamptz;first_permission uuid;
BEGIN
 i:=authz.authenticate(proof);
 IF EXISTS(SELECT FROM v8.projects WHERE id=(b->>'project_id')::uuid AND visibility='private' AND owner_id<>(i->>'actor_id')::uuid) AND authz.project_privacy_read_deadline((i->>'actor_id')::uuid,(b->>'project_id')::uuid) IS NULL THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;
SELECT * INTO t FROM authz.sqlite_targets WHERE schema_name=b->>'schema' AND project_id=(b->>'project_id')::uuid AND active;
 IF t.target_id IS NULL OR NOT authz.client_resource_allowed745((i->>'client_id')::uuid,t.project_id) THEN RAISE EXCEPTION 'registered_sqlite_project_required' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('table',x->>'table','actions',x->'actions','fingerprint',x->>'fingerprint','schema_cookie',(x->>'schema_cookie')::int,'permission_id',g.id)),'[]'),min(g.expires_at),(array_agg(g.id))[1] INTO objects,until_at,first_permission FROM authz.database_permissions g JOIN authz.principals issuer ON issuer.id=g.approved_by JOIN v8.projects p ON p.id=g.project_id CROSS JOIN LATERAL jsonb_array_elements(g.objects) x JOIN authz.sqlite_objects o ON o.target_id=t.target_id AND o.table_name=x->>'table' WHERE g.actor_id=(i->>'actor_id')::uuid AND g.project_id=t.project_id AND g.active AND NOT g.suspended AND g.expires_at>clock_timestamp() AND issuer.active AND issuer.organization_id=p.organization_id AND p.state='active' AND (issuer.id=p.manager_id OR issuer.role='organization_admin' OR EXISTS(SELECT FROM authz.qualifications q WHERE q.principal_id=issuer.id AND q.project_id=p.id AND q.kind='management' AND authz.management_valid(q.id,issuer.id,p.id))) AND x->>'backend'='sqlite' AND x->>'target_id'=t.target_id AND x->>'fingerprint'=o.fingerprint AND o.active AND (o.data_enabled OR NOT ((x->'actions') ?| ARRAY['select','insert','update','delete']));
 IF jsonb_array_length(objects)=0 THEN RAISE EXCEPTION 'database_permission_required' USING ERRCODE='42501';END IF;
 IF NOT(i->'client_actions'?'mem.read') AND NOT(i->'client_actions'?'mem.write') THEN RAISE EXCEPTION 'software_scope_required' USING ERRCODE='42501';END IF;
 IF NOT(i->'client_actions'?'mem.read') THEN SELECT jsonb_agg(x||jsonb_build_object('actions',(SELECT coalesce(jsonb_agg(a),'[]') FROM jsonb_array_elements_text(x->'actions') a WHERE a IN('insert','update','delete')))) INTO objects FROM jsonb_array_elements(objects) x;END IF;
 -- Write actions cannot exceed current software ceiling even with a prior grant.
 IF NOT (i->'client_actions'?'mem.write') THEN SELECT jsonb_agg(x||jsonb_build_object('actions',(SELECT coalesce(jsonb_agg(a),'[]') FROM jsonb_array_elements_text(x->'actions') a WHERE a IN('inspect','select')))) INTO objects FROM jsonb_array_elements(objects) x;END IF;
 until_at:=least(until_at,clock_timestamp()+interval '20 seconds',coalesce(authz.project_privacy_read_deadline((i->>'actor_id')::uuid,t.project_id),'infinity'::timestamptz));
 RETURN jsonb_build_object('backend','sqlite','target_id',t.target_id,'host',t.host,'project_id',t.project_id,'actor_id',i->>'actor_id','client_id',i->>'client_id','credential_id',i->>'credential_id','deadline',until_at,'objects',objects,'permission_id',first_permission,'data_scope','approved whole_table;not private-row-only');
END $function$;
CREATE OR REPLACE FUNCTION authz.external_owner_deadline(actor uuid, pid uuid, r jsonb)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE p authz.principals;pr record;q record;deadline timestamptz;best timestamptz;
BEGIN
 -- Lock the real owner/delegation dependencies, independent of an old login session.
 PERFORM authz.lock_resources(actor,NULL,NULL,jsonb_build_array(r));
 SELECT * INTO p FROM authz.principals WHERE id=actor;SELECT * INTO pr FROM v8.projects WHERE id=pid;
 IF p.active IS DISTINCT FROM true OR pr.id IS NULL OR pr.state<>'active'OR pr.organization_id IS DISTINCT FROM p.organization_id OR NOT authz.selector_matches('{"version":1,"kind":"project"}',pid,r)THEN RETURN NULL;END IF;
 IF pr.visibility IN('personal','private')AND pr.owner_id=actor THEN RETURN 'infinity';END IF;
 FOR q IN SELECT id FROM authz.qualifications WHERE principal_id=actor AND project_id=pid AND kind='work'ORDER BY id LOOP
  deadline:=authz.qualification_deadline(q.id,actor,pid,'mem.share',r);
  IF deadline IS NOT NULL AND(best IS NULL OR deadline>best)THEN best:=deadline;END IF;
 END LOOP;RETURN best;
END $function$;
CREATE OR REPLACE FUNCTION authz.governance_manager(hid uuid, r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE h authz.handles;pr v8.projects;q authz.qualifications;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF h.id IS NULL OR h.consumed_xid IS DISTINCT FROM pg_current_xact_id() OR (r->>'project_id')::uuid IS DISTINCT FROM h.project_id THEN RETURN false;END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=h.project_id;
 IF pr.manager_id=h.principal_id OR (pr.visibility IN('personal','private') AND pr.owner_id=h.principal_id) THEN RETURN true;END IF;
 FOR q IN SELECT * FROM authz.qualifications WHERE principal_id=h.principal_id AND project_id=h.project_id AND kind='management' LOOP
  IF authz.management_valid(q.id,h.principal_id,h.project_id) AND authz.selector_matches(q.resource_selector,h.project_id,r) THEN RETURN true;END IF;
 END LOOP;RETURN false;
END $function$;
CREATE OR REPLACE FUNCTION authz.lock_archive_project_scope(hid uuid, expected_revision bigint, expected_owner uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE h authz.handles;pr v8.projects;
BEGIN
 SELECT * INTO h FROM authz.handles WHERE id=hid;
 IF authz.runtime_role()<>'hub2_mem' OR h.id IS NULL OR h.audience<>'mem' OR h.action<>'mem.upload' OR h.consumed_at IS NOT NULL OR expected_revision IS NULL OR expected_revision<1 OR expected_owner IS NULL THEN RAISE EXCEPTION 'invalid_archive_scope_guard' USING ERRCODE='42501';END IF;
 -- Same common authority ordering as consume_handle; then hold the current project scope through publication.
 PERFORM authz.lock_resources(h.principal_id,h.client_id,h.credential_id,jsonb_build_array(jsonb_build_object('project_id',h.project_id)));
 SELECT * INTO pr FROM v8.projects WHERE id=h.project_id FOR SHARE;
 IF pr.visibility='team' THEN
  PERFORM t.service_id FROM authz.baize_callback_targets749 t JOIN authz.principals p ON p.id=t.service_id WHERE t.service_id=h.principal_id AND t.project_id=pr.id AND t.owner_id=expected_owner AND t.active AND p.kind='service' AND p.active FOR SHARE OF t;
  IF NOT FOUND THEN RAISE EXCEPTION 'registered_baize_service_target_required' USING ERRCODE='42501';END IF;
 END IF;
 IF pr.id IS NULL OR pr.revision IS DISTINCT FROM expected_revision OR pr.owner_id IS DISTINCT FROM expected_owner OR pr.visibility NOT IN('personal','team','private') THEN RAISE EXCEPTION 'archive_scope_changed' USING ERRCODE='40001';END IF;
END $function$;
CREATE OR REPLACE FUNCTION authz.shared_resource_check(p_hash text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE u authz.shared_resource_usage;t authz.resource_typed_targets58;r authz.resource_regions58;mq authz.qualifications;cq authz.qualifications;ma authz.resource_areas;
 a authz.resource_areas;et authz.resource_execution_targets;pr record;cp record;identity jsonb;permit jsonb;expiry timestamptz;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR jsonb_typeof(b)<>'object'
 OR NOT b?&ARRAY['usage_id','project_id','area_id','region_id','target_id','operation','action','request_hash','phase']
 OR b-ARRAY['usage_id','project_id','area_id','region_id','target_id','operation','action','request_hash','phase']<>'{}'::jsonb
 OR b->>'phase' NOT IN('start','effect','final','replay') THEN RAISE EXCEPTION 'shared_scope_required' USING ERRCODE='42501';END IF;
 SELECT * INTO u FROM authz.shared_resource_usage WHERE id=(b->>'usage_id')::uuid FOR SHARE;
 SELECT * INTO t FROM authz.resource_typed_targets58 WHERE id=u.target_id FOR SHARE;
 SELECT * INTO r FROM authz.resource_regions58 WHERE id=t.region_id FOR SHARE;
 SELECT * INTO ma FROM authz.resource_areas WHERE id=t.area_id FOR SHARE;
 SELECT * INTO a FROM authz.resource_areas WHERE id=u.area_id FOR SHARE;
 SELECT * INTO et FROM authz.resource_execution_targets WHERE area_id=u.area_id FOR SHARE;
 SELECT * INTO pr FROM v8.projects WHERE id=r.project_id;
 SELECT * INTO cp FROM v8.projects WHERE id=u.project_id;
 IF u.id IS NULL OR NOT u.active OR u.expires_at<=clock_timestamp() OR NOT t.active OR NOT r.active OR NOT a.active
 OR ma.id IS NULL OR NOT ma.active OR ma.project_id IS DISTINCT FROM r.project_id
 OR u.project_id<>(b->>'project_id')::uuid OR u.area_id<>(b->>'area_id')::uuid OR a.project_id<>u.project_id
 OR t.region_id<>(b->>'region_id')::uuid OR t.id<>b->>'target_id'
 OR et.endpoint_id IS DISTINCT FROM t.endpoint_id OR et.environment IS DISTINCT FROM t.environment
 OR NOT(b->>'action'=ANY(u.actions)) OR NOT(b->>'action'=ANY(t.actions))
 OR pr.state IS DISTINCT FROM 'active' OR cp.state IS DISTINCT FROM 'active'
 OR cp.organization_id IS DISTINCT FROM pr.organization_id OR NOT authz.provider_metadata_safe62(u.scope)
 THEN RAISE EXCEPTION 'shared_target_scope_denied' USING ERRCODE='42501';END IF;
 IF (u.source_actor_id IS DISTINCT FROM pr.manager_id AND NOT(pr.visibility IN('personal','private') AND u.source_actor_id=pr.owner_id))
 AND (u.source_qualification_id IS NULL OR NOT authz.management_valid(u.source_qualification_id,u.source_actor_id,r.project_id))
 THEN RAISE EXCEPTION 'shared_management_source_invalid' USING ERRCODE='42501';END IF;
 IF (u.consumer_source_actor_id IS DISTINCT FROM cp.manager_id AND NOT(cp.visibility IN('personal','private') AND u.consumer_source_actor_id=cp.owner_id))
 AND (u.consumer_source_qualification_id IS NULL OR NOT authz.management_valid(u.consumer_source_qualification_id,u.consumer_source_actor_id,u.project_id))
 THEN RAISE EXCEPTION 'shared_consumer_source_invalid' USING ERRCODE='42501';END IF;
 IF NOT EXISTS(SELECT FROM authz.principals WHERE id=u.source_actor_id AND active)
 OR NOT EXISTS(SELECT FROM authz.principals WHERE id=u.consumer_source_actor_id AND active)
 THEN RAISE EXCEPTION 'shared_source_inactive' USING ERRCODE='42501';END IF;
 -- The installed typed checker is authoritative for adapter action -> operation.
 -- Compare against the original target actions; only these installed actions apply.
 IF b->>'operation' IS DISTINCT FROM (CASE
 WHEN b->>'action' IN('db.document.read','ssh.file.read','ssh.service.status','cos.object.head','lighthouse.instance.describe','lighthouse.firewall.describe','dnspod.domain.describe','dnspod.records.describe','cloud.session.status','cvm.instance.describe') THEN 'read'
 WHEN b->>'action' IN('db.schema.apply_artifact','ssh.artifact.deploy') THEN 'deploy'
 WHEN b->>'action' IN('db.document.put','db.document.delete','ssh.file.write','cos.object.put','cos.object.copy','lighthouse.instance.start','lighthouse.instance.restart','lighthouse.instance.stop','lighthouse.firewall.replace','dnspod.record.modify','cloud.session.issue','cloud.session.stop') THEN 'write'
 ELSE NULL END) THEN RAISE EXCEPTION 'shared_action_operation_mismatch' USING ERRCODE='42501';END IF;
 permit:=authz.resource_execution_check(p_hash,jsonb_build_object('project_id',u.project_id,'area_id',u.area_id,'endpoint_id',t.endpoint_id,'environment',t.environment,'operation',b->>'operation','request_hash',b->>'request_hash','phase',CASE WHEN b->>'phase'='start' THEN 'start' ELSE 'effect' END));
 identity:=authz.authenticate(p_hash);
 IF(pr.visibility='private' AND pr.owner_id<>(identity->>'actor_id')::uuid AND authz.project_privacy_read_deadline((identity->>'actor_id')::uuid,pr.id) IS NULL) OR(cp.visibility='private' AND cp.owner_id<>(identity->>'actor_id')::uuid AND authz.project_privacy_read_deadline((identity->>'actor_id')::uuid,cp.id) IS NULL) THEN RAISE EXCEPTION 'privacy_dual_authorization_required' USING ERRCODE='42501';END IF;

 -- Delegated management must cover this operation and exact area, not merely
 -- be a valid manager somewhere in the project. Locks fence concurrent revoke.
 IF u.source_qualification_id IS NOT NULL THEN
  SELECT * INTO mq FROM authz.qualifications WHERE id=u.source_qualification_id FOR SHARE;
  IF NOT authz.management_valid(mq.id,u.source_actor_id,r.project_id)
  OR NOT('resource.'||(b->>'operation')=ANY(mq.actions))
  OR NOT authz.selector_matches(mq.resource_selector,r.project_id,jsonb_build_object('project_id',r.project_id,'area_id',t.area_id))
  THEN RAISE EXCEPTION 'shared_source_operation_denied' USING ERRCODE='42501';END IF;
 END IF;
 IF u.consumer_source_qualification_id IS NOT NULL THEN
  SELECT * INTO cq FROM authz.qualifications WHERE id=u.consumer_source_qualification_id FOR SHARE;
  IF NOT authz.management_valid(cq.id,u.consumer_source_actor_id,u.project_id)
  OR NOT('resource.'||(b->>'operation')=ANY(cq.actions))
  OR NOT authz.selector_matches(cq.resource_selector,u.project_id,jsonb_build_object('project_id',u.project_id,'area_id',u.area_id))
  THEN RAISE EXCEPTION 'shared_consumer_operation_denied' USING ERRCODE='42501';END IF;
 END IF;
 WITH RECURSIVE family AS(SELECT id,parent_credential_id,expires_at,until_revoked FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid UNION SELECT p.id,p.parent_credential_id,p.expires_at,p.until_revoked FROM authz.credentials p JOIN family f ON p.id=f.parent_credential_id)
 SELECT min(CASE WHEN until_revoked THEN 'infinity'::timestamptz ELSE expires_at END) INTO expiry FROM family;
 IF expiry IS NULL OR expiry<=clock_timestamp() THEN RAISE EXCEPTION 'shared_credential_expired' USING ERRCODE='42501';END IF;
 RETURN permit||jsonb_build_object('format','resource-execution-permit.v2','deadline',least((permit->>'deadline')::timestamptz,expiry,u.expires_at),'region_id',r.id,'region_epoch',r.epoch,'target_id',t.id,'target_epoch',t.epoch,'target_fingerprint',t.fingerprint,'descriptor_hash',t.descriptor_hash,'operation',b->>'operation','adapter_action',b->>'action','phase',b->>'phase','usage_id',u.id,'usage_epoch',u.epoch,'scope',u.scope,'security_era',(SELECT era FROM authz.security_state WHERE id),'principal_epoch',(SELECT epoch FROM authz.principals WHERE id=(identity->>'actor_id')::uuid),'client_epoch',(SELECT epoch FROM authz.clients WHERE id=(identity->>'client_id')::uuid),'credential_epoch',(SELECT epoch FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid));
END $function$;
CREATE OR REPLACE FUNCTION authz.lock_resources(actor uuid, client uuid, credential uuid, resources jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE project_ids uuid[];qids uuid[];people uuid[];origin uuid;fid uuid;
BEGIN
 SELECT array_agg(DISTINCT (r->>'project_id')::uuid) INTO project_ids FROM jsonb_array_elements(resources) r;
 SELECT array_agg(id),array_agg(DISTINCT person) INTO qids,people FROM (
  WITH RECURSIVE dependencies AS(SELECT q.id,q.parent_id,q.source_actor_id,q.principal_id FROM authz.qualifications q WHERE q.project_id=ANY(project_ids) AND q.principal_id=actor UNION SELECT q.id,q.parent_id,q.source_actor_id,q.principal_id FROM authz.qualifications q JOIN dependencies d ON q.id=d.parent_id)
  SELECT d.id,x.person FROM dependencies d CROSS JOIN LATERAL(VALUES(d.source_actor_id),(d.principal_id)) x(person)) selected;
 SELECT array_agg(DISTINCT person) INTO people FROM(SELECT unnest(coalesce(people,'{}'::uuid[])) person UNION SELECT r.owner_approved_by FROM authz.project_privacy_requests r JOIN v8.projects p ON p.id=r.project_id WHERE r.project_id=ANY(project_ids) AND r.grantee_id=actor AND r.state='granted' AND p.visibility='private' AND r.project_epoch=p.epoch UNION SELECT r.supervisor_approved_by FROM authz.project_privacy_requests r JOIN v8.projects p ON p.id=r.project_id WHERE r.project_id=ANY(project_ids) AND r.grantee_id=actor AND r.state='granted' AND p.visibility='private' AND r.project_epoch=p.epoch) deps WHERE person IS NOT NULL;
 SELECT family_id INTO fid FROM authz.credentials WHERE id=credential;
 SELECT origin_credential_id INTO origin FROM authz.refresh_families WHERE id=fid;
 PERFORM id FROM authz.security_state FOR SHARE;
 PERFORM id FROM authz.principals WHERE id=actor OR id=ANY(people) OR id IN(SELECT owner_id FROM v8.projects WHERE id=ANY(project_ids)) OR id IN(SELECT manager_id FROM v8.projects WHERE id=ANY(project_ids)) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.clients WHERE id=client OR id IN(SELECT client_id FROM authz.credentials WHERE id=origin) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.credentials WHERE id=credential OR id=origin ORDER BY id FOR SHARE;
 PERFORM id FROM authz.refresh_families WHERE id=fid FOR SHARE;
 PERFORM id FROM v8.projects WHERE id=ANY(project_ids) ORDER BY id FOR SHARE;
 PERFORM id FROM authz.qualifications WHERE id=ANY(qids) ORDER BY id FOR SHARE;
 PERFORM r.id FROM authz.project_privacy_requests r WHERE r.project_id=ANY(project_ids) AND r.grantee_id=actor AND r.state='granted' ORDER BY r.id FOR SHARE;
 PERFORM d.id FROM mem.disclosures d WHERE d.output_version_id IN(SELECT (r->>'version_id')::uuid FROM jsonb_array_elements(resources) r WHERE r->>'version_id' ~* '^[0-9a-f-]{36}$') ORDER BY d.id FOR SHARE;
 PERFORM id FROM authz.resource_areas WHERE id IN(SELECT (r->>'area_id')::uuid FROM jsonb_array_elements(resources) r WHERE r->>'area_id' ~ '^[0-9a-f-]{36}$') ORDER BY id FOR SHARE;
END $function$;
CREATE OR REPLACE FUNCTION authz.project_members(proof text, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'authz'
AS $function$
DECLARE i jsonb;p v8.projects;out_ jsonb;lim int;off_ int;
BEGIN
 i:=authz.authenticate(proof);
 SELECT * INTO p FROM v8.projects WHERE id=(b->>'project_id')::uuid AND organization_id=(i->>'organization_id')::uuid AND state='active' AND visibility IN('team','personal','private');
 IF p.id IS NULL THEN RAISE EXCEPTION 'active_project_required' USING ERRCODE='42501';END IF;
 PERFORM authz.lock_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,(i->>'credential_id')::uuid,authz.request_resources((i->>'actor_id')::uuid,(i->>'client_id')::uuid,jsonb_build_object('project_id',p.id),'v8.project.read'));
 PERFORM authz.check_access((i->>'actor_id')::uuid,(i->>'client_id')::uuid,p.id,'v8.project.read');
 lim:=coalesce((b->>'limit')::int,100);off_:=coalesce((b->>'offset')::int,0);
 IF lim NOT BETWEEN 1 AND 100 OR off_<0 THEN RAISE EXCEPTION 'invalid_pagination' USING ERRCODE='22023';END IF;
 WITH qualified AS (
 SELECT q.principal_id,unnest(q.actions) action FROM authz.qualifications q JOIN authz.principals issuer ON issuer.id=q.source_actor_id
 WHERE q.project_id=p.id AND q.kind='work' AND q.active AND NOT q.frozen AND issuer.active AND (q.until_revoked OR q.expires_at>clock_timestamp())
 AND ((q.parent_id IS NULL AND (q.source_basis='independent_work' OR q.source_actor_id=p.manager_id OR (issuer.role='organization_admin' AND issuer.organization_id=p.organization_id)))
 OR EXISTS(SELECT FROM authz.qualifications parent WHERE parent.id=q.parent_id AND q.actions<@parent.actions AND authz.management_valid(parent.id,parent.principal_id,p.id)))
 ), grouped AS (SELECT principal_id,array_agg(DISTINCT action) actions FROM qualified GROUP BY principal_id),members AS (
 SELECT a.id actor_id,a.display_name, a.id=p.manager_id is_manager,coalesce(g.actions,'{}') actions FROM authz.principals a LEFT JOIN grouped g ON g.principal_id=a.id
 WHERE a.organization_id=p.organization_id AND a.active AND a.kind='member' AND (a.id IN(p.owner_id,p.manager_id) OR ('mem.read'=ANY(g.actions) AND 'v8.project.read'=ANY(g.actions))) ORDER BY a.id LIMIT lim+1 OFFSET off_)
 SELECT coalesce(jsonb_agg(jsonb_build_object('actor_id',actor_id,'display_name',display_name,'is_manager',is_manager,'can_read',true,'can_write','mem.write'=ANY(actions) AND 'v8.work.commit'=ANY(actions))),'[]') INTO out_ FROM members;
 RETURN jsonb_build_object('state','read','project_id',p.id,'members',CASE WHEN jsonb_array_length(out_)>lim THEN out_-lim ELSE out_ END,'next_offset',CASE WHEN jsonb_array_length(out_)>lim THEN off_+lim ELSE NULL END,'coverage','current_project_qualified_members;not_organization_directory','authority','current_member_project_read;not_a_grant');
END $function$;

RESET ROLE; -- retain each reviewed existing function owner and ACL
CREATE OR REPLACE FUNCTION v8.project_create(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); pr v8.projects;manager uuid;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.project.create',d,b);
 r:=v8.replay(c,'project_create',b,d);IF r IS NOT NULL THEN RETURN r;END IF;
 IF (b->>'owner_id')::uuid IS DISTINCT FROM (c->>'actor_id')::uuid OR (b->>'organization_id')::uuid IS DISTINCT FROM (c->>'organization_id')::uuid THEN RAISE EXCEPTION 'identity_override' USING ERRCODE='42501';END IF;
 IF b->>'visibility' IS NULL OR b->>'visibility' NOT IN('personal','team') THEN RAISE EXCEPTION 'privacy_requires_explicit_project_mark' USING ERRCODE='42501';END IF;
 PERFORM authz.require_project_creation_role(c,b->>'visibility');
 manager:=(c->>'actor_id')::uuid;
 IF b->>'visibility'='team' THEN manager:=v8.select_manager(c,(b->>'manager_id')::uuid);IF manager IS NULL THEN RETURN jsonb_build_object('state','manager_selection_required','project_id',c->'project_id','items',v8.manager_options(c),'retained_state','not_created','next_step','agent_selects_effective_manager_and_retries');END IF;END IF;
 PERFORM authz.assert_effect(h);INSERT INTO v8.projects(id,organization_id,kind,visibility,owner_id,manager_id,title) VALUES((c->>'project_id')::uuid,(c->>'organization_id')::uuid,b->>'kind',b->>'visibility',(c->>'actor_id')::uuid,manager,b->>'title') RETURNING * INTO pr;
 IF pr.visibility='team' THEN PERFORM authz.project_scope_transition(c,pr.id,pr.revision,pr.visibility,pr.kind,pr.manager_id);END IF;
 PERFORM v8.emit(c,'project.created',pr.id,1,o,jsonb_build_object('kind',pr.kind,'visibility',pr.visibility));RETURN v8.remember(c,'project_create',b,d,o,jsonb_build_object('state','created','project',to_jsonb(pr),'domain_revision',pr.revision));
END $function$;
CREATE OR REPLACE FUNCTION v8.project_convert(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb; c jsonb; r jsonb; o uuid:=gen_random_uuid(); pr v8.projects;manager uuid;
BEGIN
 IF encode(public.digest(p,'sha256'),'hex')<>d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501'; END IF;
 b:=p::jsonb;c:=v8.guard(h,'v8.project.convert',d,b);
 r:=v8.replay(c,'project_convert',b,d);IF r IS NOT NULL THEN RETURN r;END IF;
 SELECT * INTO pr FROM v8.projects WHERE id=(c->>'project_id')::uuid;manager:=CASE WHEN b->>'visibility'='team' THEN COALESCE((b->>'manager_id')::uuid,CASE WHEN pr.visibility='team' THEN pr.manager_id ELSE v8.select_manager(c,NULL) END) ELSE pr.owner_id END;
 IF manager IS NULL THEN RETURN jsonb_build_object('state','manager_selection_required','items',v8.manager_options(c),'retained_state','scope_unchanged','next_step','agent_selects_effective_manager_and_retries');END IF;PERFORM authz.assert_effect(h);r:=authz.project_scope_transition(c,(c->>'project_id')::uuid,(b->>'expected_revision')::bigint,b->>'visibility',b->>'kind',manager);
 SELECT * INTO pr FROM v8.projects WHERE id=(c->>'project_id')::uuid FOR UPDATE;
 UPDATE v8.projects SET visibility=b->>'visibility',kind=b->>'kind',manager_id=(r->>'manager_id')::uuid,revision=revision+1,epoch=epoch+1,event_revision=event_revision+1 WHERE id=pr.id RETURNING * INTO pr;
 PERFORM v8.emit(c,'project.scope_changed',pr.id,pr.event_revision,o,jsonb_build_object('revision',pr.revision,'visibility',pr.visibility,'kind',pr.kind,'agent_reason',b->'reason','agent_judgment',b->'judgment'));RETURN v8.remember(c,'project_convert',b,d,o,jsonb_build_object('state','converted','project',to_jsonb(pr),'domain_revision',pr.revision));
END $function$;
CREATE OR REPLACE FUNCTION v8.project_search(h uuid, d text, p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb;c jsonb;item record;items jsonb:='[]';n integer:=0;lim integer;last_id uuid;more boolean:=false;q text;
BEGIN
 IF p IS NULL OR d IS NULL OR encode(public.digest(p,'sha256'),'hex') IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 b:=p::jsonb;IF EXISTS(SELECT FROM jsonb_object_keys(b) key WHERE key NOT IN('query','limit','cursor')) THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 lim:=COALESCE((b->>'limit')::integer,20);q:=COALESCE(b->>'query','');IF lim NOT BETWEEN 1 AND 100 OR length(q)>200 THEN RAISE EXCEPTION 'invalid_input' USING ERRCODE='22023';END IF;
 c:=authz.consume_discovery_handle(h,d);
 FOR item IN SELECT pr.* FROM v8.projects pr WHERE pr.organization_id=(c->>'organization_id')::uuid
 AND (b->>'cursor' IS NULL OR pr.id>(b->>'cursor')::uuid)
 AND (q='' OR strpos(lower(pr.title),lower(q))>0)
 AND (pr.owner_id=(c->>'actor_id')::uuid OR pr.visibility IN('personal','team') OR authz.project_privacy_read_deadline((c->>'actor_id')::uuid,pr.id) IS NOT NULL OR EXISTS(SELECT FROM authz.qualifications qu WHERE qu.principal_id=(c->>'actor_id')::uuid AND qu.project_id=pr.id AND qu.active))
 ORDER BY pr.id LOOP
  IF NOT authz.discovery_project_visible(h,item.id) THEN CONTINUE;END IF;
  IF n=lim THEN more:=true;EXIT;END IF;
  n:=n+1;last_id:=item.id;
  items:=items||jsonb_build_array(jsonb_build_object('project_id',item.id,'title',item.title,'kind',item.kind,'visibility',item.visibility,'state',item.state,'revision',item.revision,'owner_id',item.owner_id,'manager_id',item.manager_id,'properties',item.properties,'governance',coalesce(item.properties->'governance','{}')));
 END LOOP;
 PERFORM authz.finish_discovery(h);
 RETURN jsonb_build_object('state','read','items',items,'returned_count',n,'next_cursor',CASE WHEN more THEN last_id ELSE NULL END,
 'coverage',jsonb_build_object('complete',NOT more,'scope','current_authorized_matching_projects_after_cursor','snapshot',false,'truncated',more),
 'next_step',CASE WHEN more THEN 'continue_with_next_cursor' ELSE 'choose_project_or_create_if_needed' END);
END $function$;
CREATE OR REPLACE FUNCTION v8.work_project_move(h uuid, target_h uuid, d text, p text, target_d text, target_p text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'v8'
AS $function$
DECLARE b jsonb:=p::jsonb;tb jsonb:=target_p::jsonb;c jsonb;tc jsonb;r jsonb;source v8.projects;target v8.projects;w v8.work_items;o uuid:=gen_random_uuid();note jsonb;canonical text;prior jsonb;
BEGIN
 IF p IS NULL OR target_p IS NULL OR d IS NULL OR target_d IS NULL OR encode(public.digest(p,'sha256'),'hex')IS DISTINCT FROM d OR encode(public.digest(target_p,'sha256'),'hex')IS DISTINCT FROM target_d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 IF b->>'expected_revision'IS NULL OR (b->>'expected_revision')::bigint<1 OR b-ARRAY['project_id','target_project_id','work_item_id','expected_revision','idempotency_key','reason']<>'{}'::jsonb OR (b->>'project_id')::uuid=(b->>'target_project_id')::uuid OR tb<>jsonb_build_object('project_id',b->'target_project_id','idempotency_key',b->'idempotency_key')THEN RAISE EXCEPTION 'invalid_move_target' USING ERRCODE='22023';END IF;
 c:=v8.guard(h,'v8.work.commit',d,b);tc:=v8.guard(target_h,'v8.work.commit',target_d,tb);
 IF c->>'actor_id'IS DISTINCT FROM tc->>'actor_id' OR c->>'client_id'IS DISTINCT FROM tc->>'client_id' THEN RAISE EXCEPTION 'move_identity_mismatch' USING ERRCODE='42501';END IF;
 r:=v8.replay(c,'work_project_move',b,d);IF r IS NOT NULL THEN PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(target_h);RETURN r;END IF;
 PERFORM 1 FROM v8.projects WHERE id IN((b->>'project_id')::uuid,(b->>'target_project_id')::uuid)ORDER BY id FOR UPDATE;
 SELECT * INTO source FROM v8.projects WHERE id=(b->>'project_id')::uuid;SELECT * INTO target FROM v8.projects WHERE id=(b->>'target_project_id')::uuid;
 -- This route is a narrow correction within one personal audience. Team or
 -- different-owner moves require a separate explicit disclosure decision.
 IF source.id IS NULL OR target.id IS NULL OR source.organization_id<>target.organization_id OR source.visibility NOT IN('personal','private') OR target.visibility NOT IN('personal','private')OR source.owner_id<>target.owner_id OR source.owner_id<>(c->>'actor_id')::uuid THEN RAISE EXCEPTION 'same_personal_owner_scope_required' USING ERRCODE='42501';END IF;
 w:=v8.lock_work(c,(b->>'work_item_id')::uuid);
 IF w.revision<>(b->>'expected_revision')::bigint THEN RETURN v8.remember(c,'work_project_move',b,d,o,jsonb_build_object('state','conflict','error_code','revision_conflict','work_item_id',w.id,'domain_revision',w.revision,'retained_state','association_unchanged'));END IF;
 PERFORM authz.assert_effect(h);PERFORM authz.assert_effect(target_h);
 prior:=to_jsonb(w)||jsonb_build_object('fixed_refs',(SELECT coalesce(jsonb_agg(jsonb_build_object('material_id',material_id,'version_id',version_id,'sha256',sha256,'role',role)),'[]')FROM v8.results WHERE work_item_id=w.id));
 INSERT INTO v8.work_snapshots(work_item_id,work_revision,record,canonical_text,sha256)VALUES(w.id,w.revision,prior,v8.canonical_json(prior),encode(public.digest(v8.canonical_json(prior),'sha256'),'hex'))ON CONFLICT DO NOTHING;
 UPDATE v8.work_items SET project_id=target.id,revision=revision+1,event_revision=event_revision+1,updated_at=clock_timestamp()WHERE id=w.id RETURNING * INTO w;
 note:=jsonb_build_object('work_item_id',w.id,'project_id',target.id,'previous_project_id',source.id,'previous_revision',w.revision-1,'work_revision',w.revision,'kind','project_association_correction','reason',b->'reason','properties',jsonb_build_object('governance',jsonb_build_object('purpose','business','association_state','corrected_same_personal_scope')),'history_semantics','prior_statements_and_fixed_refs_retained_with_original_scope');canonical:=v8.canonical_json(note);
 INSERT INTO v8.work_updates(id,work_item_id,work_revision,actor_id,client_id,source_context_id,payload,canonical_text,sha256)VALUES(o,w.id,w.revision,(c->>'actor_id')::uuid,(c->>'client_id')::uuid,(c->>'source_context_id')::uuid,note,canonical,encode(public.digest(canonical,'sha256'),'hex'));
 PERFORM v8.emit(tc,'work.project_association_changed',w.id,w.event_revision,o,jsonb_build_object('previous_project_id',source.id,'target_project_id',target.id,'short_no',w.short_no));
 RETURN v8.remember(c,'work_project_move',b,d,o,jsonb_build_object('state','moved','work_item',to_jsonb(w),'work_item_id',w.id,'short_no',w.short_no,'project_id',target.id,'domain_revision',w.revision,'receipt',note,'coverage','same_owner_personal_scope;historical_original_statements_and_fixed_refs_retained'));
END $function$;

RESET ROLE; -- retain each reviewed existing function owner and ACL
CREATE OR REPLACE FUNCTION mem.legacy_reference_import(h uuid, d text, payload text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'mem'
AS $function$
DECLARE b jsonb:=payload::jsonb;c jsonb;old mem.legacy_reference_bindings;r mem.legacy_reference_bindings;scope mem.legacy_import_scopes;v mem.content_versions;item jsonb;result jsonb:='[]';replay jsonb;kind text;
BEGIN
 IF encode(public.digest(payload,'sha256'),'hex')IS DISTINCT FROM d THEN RAISE EXCEPTION 'digest_mismatch' USING ERRCODE='42501';END IF;
 c:=mem.guard(h,'mem.process',d,b);SELECT * INTO scope FROM mem.legacy_import_scopes WHERE id=(b->>'import_scope_id')::uuid FOR SHARE;
 IF scope.id IS NULL OR scope.active IS DISTINCT FROM true OR scope.expires_at<=clock_timestamp()OR scope.project_id IS DISTINCT FROM(c->>'project_id')::uuid OR scope.actor_id IS DISTINCT FROM(c->>'actor_id')::uuid OR scope.source_system IS DISTINCT FROM b->>'source_system'THEN RAISE EXCEPTION 'legacy_import_scope_required' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(b->'items')IS DISTINCT FROM'array'OR jsonb_array_length(b->'items')NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_legacy_import_batch';END IF;
 replay:=mem.replay_command(c,'legacy_reference_import',b,d);IF replay IS NOT NULL THEN PERFORM authz.assert_effect(h);RETURN replay;END IF;
 -- Serialize creation and CAS in the exact actor/project/import namespace; no global lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(scope.project_id::text||':'||scope.actor_id::text||':'||scope.source_system,0));
 FOR item IN SELECT value FROM jsonb_array_elements(b->'items')LOOP
  kind:=item->>'reference_kind';IF NOT(item->>'category'=ANY(scope.categories))OR kind IS NULL OR kind NOT IN('fixed','latest','unknown','unfinished')OR length(coalesce(item->>'source_id',''))NOT BETWEEN 1 AND 256 OR length(coalesce(item->>'field_path',''))NOT BETWEEN 1 AND 1024 OR length(coalesce(item->>'original_address',''))>8192 THEN RAISE EXCEPTION 'legacy_binding_invalid';END IF;
  SELECT * INTO old FROM mem.legacy_reference_bindings WHERE project_id=scope.project_id AND actor_id=scope.actor_id AND source_system=scope.source_system AND category=item->>'category'AND source_id=item->>'source_id'AND field_path=item->>'field_path'FOR UPDATE;
  IF coalesce(old.revision,0)IS DISTINCT FROM(item->>'expected_revision')::bigint THEN RAISE EXCEPTION 'legacy_mapping_revision_conflict' USING ERRCODE='40001';END IF;
  IF kind='fixed'THEN
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(scope.source_inventory)e WHERE e->>'category'=item->>'category'AND e->>'source_id'=item->>'source_id'AND e->>'field_path'=item->>'field_path'AND e->>'original_address'=item->>'original_address'AND e->>'target_material_id'=item->'fixed_ref'->>'material_id'AND e->>'source_record_sha256'=item->>'source_record_sha256'AND e->>'original_content_sha256'=item->>'original_content_sha256'AND(e->>'legacy_version')::bigint=(item->>'legacy_version')::bigint)THEN RAISE EXCEPTION 'legacy_historical_source_inventory_required' USING ERRCODE='42501';END IF;
   SELECT * INTO v FROM mem.content_versions WHERE id=(item->'fixed_ref'->>'version_id')::uuid AND material_id=(item->'fixed_ref'->>'material_id')::uuid AND sha256=item->'fixed_ref'->>'sha256'AND size=(item->'fixed_ref'->>'size')::bigint;
   IF v.id IS NULL OR NOT EXISTS(SELECT FROM mem.materials WHERE id=v.material_id AND project_id=scope.project_id)OR item->>'original_content_sha256'IS DISTINCT FROM v.sha256 OR(item->>'legacy_version')::bigint IS NULL OR(item->>'legacy_version')::bigint<=0 OR coalesce((item->>'source_record_sha256')~'^[a-f0-9]{64}$',false)IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM jsonb_array_elements(b->'verified_fixed_refs')x WHERE x->>'version_id'=v.id::text AND x->>'sha256'=v.sha256 AND(x->>'size')::bigint=v.size)THEN RAISE EXCEPTION 'legacy_fixed_proof_required' USING ERRCODE='42501';END IF;
   PERFORM mem.description_bind_sources(h,jsonb_build_array(jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256)),scope.actor_id);
  ELSIF kind='latest'THEN
   IF NOT EXISTS(SELECT FROM jsonb_array_elements(scope.source_inventory)e WHERE e->>'category'=item->>'category'AND e->>'source_id'=item->>'source_id'AND e->>'field_path'=item->>'field_path'AND e->>'original_address'=item->>'original_address'AND e->>'source_record_sha256'=item->>'source_record_sha256'AND e->>'target_material_id'=item->>'material_id')THEN RAISE EXCEPTION 'legacy_latest_identity_inventory_required' USING ERRCODE='42501';END IF;
   SELECT cv.* INTO v FROM mem.materials m JOIN mem.content_versions cv ON cv.id=m.current_version_id WHERE m.id=(item->>'material_id')::uuid AND m.project_id=scope.project_id;
   IF v.id IS NULL THEN RAISE EXCEPTION 'legacy_latest_material_unpublished';END IF;PERFORM mem.description_bind_sources(h,jsonb_build_array(jsonb_build_object('material_id',v.material_id,'version_id',v.id,'sha256',v.sha256)),scope.actor_id);
  ELSE IF item?'fixed_ref'OR item?'material_id'THEN RAISE EXCEPTION 'unknown_cannot_be_fixed';END IF;END IF;
  PERFORM authz.assert_effect(h);
  INSERT INTO mem.legacy_reference_bindings(project_id,actor_id,source_system,visibility,category,source_id,field_path,original_address,legacy_version,reference_kind,target_material_id,target_version_id,target_sha256,target_size,source_record_sha256,original_content_sha256,declaration,created_client_id)
  VALUES(scope.project_id,scope.actor_id,scope.source_system,CASE WHEN item->>'category'='personal_archive'THEN'actor'ELSE scope.visibility END,item->>'category',item->>'source_id',item->>'field_path',coalesce(item->>'original_address',''),(item->>'legacy_version')::bigint,kind,CASE WHEN kind IN('fixed','latest')THEN v.material_id END,CASE WHEN kind='fixed'THEN v.id END,CASE WHEN kind='fixed'THEN v.sha256 END,CASE WHEN kind='fixed'THEN v.size END,item->>'source_record_sha256',item->>'original_content_sha256',coalesce(item->'declaration','{}'),(c->>'client_id')::uuid)
  ON CONFLICT(project_id,actor_id,source_system,category,source_id,field_path)DO UPDATE SET visibility=excluded.visibility,original_address=excluded.original_address,legacy_version=excluded.legacy_version,reference_kind=excluded.reference_kind,target_material_id=excluded.target_material_id,target_version_id=excluded.target_version_id,target_sha256=excluded.target_sha256,target_size=excluded.target_size,source_record_sha256=excluded.source_record_sha256,original_content_sha256=excluded.original_content_sha256,declaration=excluded.declaration,revision=mem.legacy_reference_bindings.revision+1,updated_at=clock_timestamp()RETURNING * INTO r;
  result:=result||jsonb_build_array(jsonb_build_object('binding_id',r.id,'revision',r.revision,'reference_kind',kind,'state',CASE WHEN kind='unknown'THEN'needs_mapping'WHEN kind='unfinished'THEN'unfinished'ELSE'bound'END));
 END LOOP;
 IF scope.expires_at<=clock_timestamp()THEN RAISE EXCEPTION 'legacy_import_scope_expired' USING ERRCODE='42501';END IF;PERFORM authz.assert_effect(h);
 RETURN mem.remember_command(c,'legacy_reference_import',b,d,jsonb_build_object('state','imported','items',result,'writer_cutover',false,'GC_registered',true));
END $function$;
RESET ROLE;
-- Invalidate pre-policy handles; no project IDs, files or work history change.
SET LOCAL ROLE hub2_authz_owner;
UPDATE authz.security_state SET era=gen_random_uuid();
RESET ROLE;
COMMIT;
