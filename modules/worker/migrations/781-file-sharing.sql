BEGIN;
SET ROLE hub2_authz_owner;
CREATE TABLE authz.material_shares781(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),project_id uuid NOT NULL,material_id uuid NOT NULL,qualification_id uuid NOT NULL REFERENCES authz.qualifications(id),issuer_id uuid NOT NULL REFERENCES authz.principals(id),recipient_id uuid NOT NULL REFERENCES authz.principals(id),access text NOT NULL CHECK(access IN('read','edit')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz);
REVOKE ALL ON authz.material_shares781 FROM PUBLIC,hub2_hufu,hub2_mem,hub2_v8;
CREATE FUNCTION authz.material_share781(proof text,b jsonb)RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,authz AS $$
DECLARE i jsonb;a uuid;cl uuid;pid uuid;mid uuid;pr v8.projects;s authz.material_shares781;target uuid;hits integer;qid uuid;acts text[];expiry timestamptz;unlimited boolean;result jsonb;key text:=b->>'idempotency_key';fp text:=encode(public.digest(b::text,'sha256'),'hex');old authz.operations;command text:=b->>'command';
BEGIN
 IF session_user<>'hub2_hufu' OR coalesce(command,'')NOT IN('grant','revoke','list','received') THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 i:=authz.authenticate(proof);a:=(i->>'actor_id')::uuid;cl:=(i->>'client_id')::uuid;
 PERFORM id FROM authz.security_state FOR SHARE;
 IF command='received' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('share_id',x.id,'project_id',x.project_id,'material_id',x.material_id,'access',x.access,'expires_at',q.expires_at,'until_revoked',q.until_revoked,'version_scope','file_all_versions','issuer',p.display_name)),'[]') INTO result FROM authz.material_shares781 x JOIN authz.qualifications q ON q.id=x.qualification_id JOIN authz.principals p ON p.id=x.issuer_id WHERE x.recipient_id=a AND x.revoked_at IS NULL AND authz.client_resource_allowed745(cl,x.project_id) AND authz.qualification_deadline(q.id,a,x.project_id,'mem.read',jsonb_build_object('project_id',x.project_id,'material_id',x.material_id))>clock_timestamp();
  RETURN jsonb_build_object('state','received_shares','items',result,'client_scope_applies',true);
 END IF;
 pid:=(b->>'project_id')::uuid;mid:=(b->>'material_id')::uuid;
 SELECT * INTO pr FROM v8.projects WHERE id=pid FOR SHARE;
 IF pr.id IS NULL OR NOT EXISTS(SELECT FROM mem.materials WHERE id=mid AND project_id=pid) OR NOT authz.client_resource_allowed745(cl,pid) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';END IF;
 PERFORM authz.resource_deadline(a,cl,pid,CASE WHEN command='list' THEN 'mem.read' ELSE 'mem.share' END,jsonb_build_object('project_id',pid,'material_id',mid));
 IF command='list' THEN
  IF NOT(a=pr.manager_id OR(pr.visibility='personal'AND a=pr.owner_id))THEN RAISE EXCEPTION 'file_management_required' USING ERRCODE='42501';END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('share_id',x.id,'recipient_id',x.recipient_id,'recipient_name',p.display_name,'access',x.access,'expires_at',q.expires_at,'until_revoked',q.until_revoked,'active',x.revoked_at IS NULL AND q.active AND NOT q.frozen AND(q.until_revoked OR q.expires_at>clock_timestamp()),'version_scope','file_all_versions')),'[]')INTO result FROM authz.material_shares781 x JOIN authz.qualifications q ON q.id=x.qualification_id JOIN authz.principals p ON p.id=x.recipient_id WHERE x.material_id=mid AND x.project_id=pid;
  RETURN jsonb_build_object('state','file_shares','items',result);
 END IF;
 IF NOT(a=pr.manager_id OR(pr.visibility='personal'AND a=pr.owner_id))THEN RAISE EXCEPTION 'file_management_required' USING ERRCODE='42501';END IF;
 IF coalesce(key,'')='' OR length(key)>200 THEN RAISE EXCEPTION 'idempotency_key_required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(a::text||key,781));
 SELECT * INTO old FROM authz.operations WHERE principal_id=a AND idempotency_key=key;
 IF old.principal_id IS NOT NULL THEN IF old.request_digest<>fp THEN RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE='23505';END IF;RETURN old.result;END IF;
 IF command='grant' THEN
  IF b->>'access'NOT IN('read','edit')OR b->>'access'IS NULL THEN RAISE EXCEPTION 'invalid_access';END IF;
  target:=(b->>'recipient_id')::uuid;
  IF target IS NULL THEN
   SELECT count(*),(array_agg(id))[1]INTO hits,target FROM authz.principals WHERE organization_id=(i->>'organization_id')::uuid AND active AND display_name=b->>'recipient_name';
   IF hits<>1 THEN RAISE EXCEPTION 'recipient_name_missing_or_ambiguous';END IF;
  END IF;
  IF NOT EXISTS(SELECT FROM authz.principals WHERE id=target AND organization_id=(i->>'organization_id')::uuid AND active)THEN RAISE EXCEPTION 'organization_mismatch' USING ERRCODE='42501';END IF;
  expiry:=(b->>'expires_at')::timestamptz;unlimited:=coalesce((b->>'until_revoked')::boolean,false);
  IF(expiry IS NULL)<>unlimited OR(expiry IS NOT NULL AND(NOT isfinite(expiry)OR expiry<=clock_timestamp()))THEN RAISE EXCEPTION 'invalid_expiry';END IF;
  acts:=CASE b->>'access'WHEN'edit'THEN ARRAY['mem.read','mem.write','mem.upload']ELSE ARRAY['mem.read']END;
  INSERT INTO authz.qualifications(principal_id,project_id,actions,source_actor_id,kind,depth,expires_at,until_revoked,source_project_revision,resource_selector,source_basis)
  VALUES(target,pid,acts,a,'work',0,expiry,unlimited,pr.revision,jsonb_build_object('version',1,'kind','set','materials',jsonb_build_array(mid)),'independent_work')RETURNING id INTO qid;
  INSERT INTO authz.material_shares781(project_id,material_id,qualification_id,issuer_id,recipient_id,access)VALUES(pid,mid,qid,a,target,b->>'access')RETURNING * INTO s;
  result:=jsonb_build_object('state','shared','share_id',s.id,'material_id',mid,'project_id',pid,'recipient_id',target,'access',s.access,'version_scope','file_all_versions','until_revoked',unlimited,'expires_at',expiry,'other_files_shared',false);
 ELSE
  SELECT * INTO s FROM authz.material_shares781 WHERE id=(b->>'share_id')::uuid AND project_id=pid AND material_id=mid FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'share_not_found';END IF;
  UPDATE authz.qualifications SET active=false,epoch=epoch+1 WHERE id=s.qualification_id;
  UPDATE authz.material_shares781 SET revoked_at=coalesce(revoked_at,clock_timestamp())WHERE id=s.id;
  result:=jsonb_build_object('state','revoked','share_id',s.id,'future_access_removed',true,'other_authorizations_unchanged',true,'downloaded_copies_recalled',false);
 END IF;
 INSERT INTO authz.operations(principal_id,idempotency_key,request_digest,result)VALUES(a,key,fp,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION authz.material_share781(text,jsonb)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.material_share781(text,jsonb)TO hub2_hufu;
RESET ROLE;
COMMIT;
