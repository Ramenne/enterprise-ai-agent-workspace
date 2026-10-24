-- Candidate only. Root assigns canonical number and installs only after review.
-- Area qualifications remain the current authority; Region routes an assigned
-- set of areas without turning an informational responsible label into a grant.
SET ROLE hub2_authz_owner;
CREATE TABLE authz.resource_regions58(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,label text NOT NULL,active boolean NOT NULL DEFAULT false,epoch bigint NOT NULL DEFAULT 1);
CREATE TABLE authz.resource_typed_targets58(
 id text PRIMARY KEY,region_id uuid NOT NULL REFERENCES authz.resource_regions58(id),area_id uuid NOT NULL REFERENCES authz.resource_areas(id),
 endpoint_id uuid NOT NULL REFERENCES authz.resource_endpoints(id),kind text NOT NULL CHECK(kind IN('postgres','ssh','cos','lighthouse')),
 environment text NOT NULL,actions text[] NOT NULL,fingerprint text NOT NULL,descriptor_hash text NOT NULL CHECK(descriptor_hash~'^[a-f0-9]{64}$'),active boolean NOT NULL DEFAULT false,epoch bigint NOT NULL DEFAULT 1);
REVOKE ALL ON authz.resource_regions58,authz.resource_typed_targets58 FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8,hub2_worker;
CREATE FUNCTION authz.resource_execution_check_typed(p_hash text,b jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE t authz.resource_typed_targets58;r authz.resource_regions58;a authz.resource_areas;permit jsonb;identity jsonb;credential_deadline timestamptz;
BEGIN
 IF authz.runtime_role()<>'hub2_hufu' OR b IS NULL OR jsonb_typeof(b)<>'object'
 OR NOT b ?& ARRAY['project_id','region_id','area_id','target_id','operation','action','request_hash','phase']
 OR b->>'phase' NOT IN('start','effect','final','replay') THEN RAISE EXCEPTION 'typed_resource_scope_required' USING ERRCODE='42501';END IF;
 SELECT * INTO t FROM authz.resource_typed_targets58 WHERE id=b->>'target_id' FOR SHARE;
 SELECT * INTO r FROM authz.resource_regions58 WHERE id=t.region_id FOR SHARE;
 SELECT * INTO a FROM authz.resource_areas WHERE id=t.area_id FOR SHARE;
 IF t.id IS NULL OR NOT t.active OR r.id IS NULL OR NOT r.active OR a.id IS NULL OR NOT a.active
 OR r.id<>(b->>'region_id')::uuid OR a.id<>(b->>'area_id')::uuid OR r.project_id<>(b->>'project_id')::uuid OR a.project_id<>r.project_id OR NOT(b->>'action'=ANY(t.actions))
 THEN RAISE EXCEPTION 'typed_target_region_action_denied' USING ERRCODE='42501';END IF;
 IF b->>'operation' IS DISTINCT FROM (CASE
 WHEN b->>'action' IN('db.document.read','ssh.file.read','ssh.service.status','cos.object.head','lighthouse.instance.describe','lighthouse.firewall.describe') THEN 'read'
 WHEN b->>'action' IN('db.schema.apply_artifact','ssh.artifact.deploy') THEN 'deploy'
 WHEN b->>'action' IN('db.document.put','db.document.delete','ssh.file.write','cos.object.put','cos.object.copy','lighthouse.instance.start','lighthouse.instance.restart','lighthouse.firewall.replace') THEN 'write'
 ELSE NULL END) THEN RAISE EXCEPTION 'typed_action_operation_mismatch' USING ERRCODE='42501';END IF;
 -- Original exact current member/client/family/project/area qualification lock,
 -- endpoint epoch, operation ceiling and bounded effect permit are retained.
 permit:=authz.resource_execution_check(p_hash,jsonb_build_object('project_id',r.project_id,'area_id',a.id,'endpoint_id',t.endpoint_id,'environment',t.environment,'operation',b->>'operation','request_hash',b->>'request_hash','phase',CASE WHEN b->>'phase'='start' THEN 'start' ELSE 'effect' END));
 identity:=authz.authenticate(p_hash);
 -- authenticate deliberately omits secret/expiry details; derive the leaf and
 -- parent credential deadlines from the current rows already protected by the
 -- original resource authority fence, without changing SQL360.
 WITH RECURSIVE family AS(SELECT id,parent_credential_id,expires_at,until_revoked FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid UNION SELECT p.id,p.parent_credential_id,p.expires_at,p.until_revoked FROM authz.credentials p JOIN family f ON p.id=f.parent_credential_id)SELECT min(CASE WHEN until_revoked THEN 'infinity'::timestamptz ELSE expires_at END)INTO credential_deadline FROM family;
 IF credential_deadline IS NULL OR credential_deadline<=clock_timestamp()THEN RAISE EXCEPTION 'typed_credential_expired' USING ERRCODE='42501';END IF;
 permit:=permit||jsonb_build_object('deadline',least((permit->>'deadline')::timestamptz,credential_deadline));
 RETURN permit||jsonb_build_object('format','resource-execution-permit.v2','region_id',r.id,'region_epoch',r.epoch,'target_id',t.id,'target_epoch',t.epoch,'target_fingerprint',t.fingerprint,'descriptor_hash',t.descriptor_hash,'operation',b->>'operation','adapter_action',b->>'action','phase',b->>'phase','security_era',(SELECT era FROM authz.security_state WHERE id),'principal_epoch',(SELECT epoch FROM authz.principals WHERE id=(identity->>'actor_id')::uuid),'client_epoch',(SELECT epoch FROM authz.clients WHERE id=(identity->>'client_id')::uuid),'credential_epoch',(SELECT epoch FROM authz.credentials WHERE id=(identity->>'credential_id')::uuid));
END $$;
REVOKE ALL ON FUNCTION authz.resource_execution_check_typed(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.resource_execution_check_typed(text,jsonb) TO hub2_hufu;
RESET ROLE;
