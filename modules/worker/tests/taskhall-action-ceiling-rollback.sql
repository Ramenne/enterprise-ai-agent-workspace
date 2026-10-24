-- Only synthetic rows. Existing team project is a read-only foreign-key scope;
-- no actual project, principal, credential or grant is modified. Always ROLLBACK.
SET ROLE hub2_authz_owner;
INSERT INTO authz.principals(id,organization_id,kind,display_name,role,trusted_source)
SELECT fixture.id,pr.organization_id,'service',fixture.label,'member','synthetic-taskhall-rollback-fixture'
FROM v8.projects pr CROSS JOIN(VALUES
('ed3258cb-44c5-45bc-a8c7-f06486cf7e00'::uuid,'synthetic task service'),
('9f78abc6-56dd-4bd9-a5df-8e796253a041'::uuid,'synthetic full foundation service'),
('5f1c621d-0261-4288-af7b-2df5927cb0f5'::uuid,'synthetic storage only service')) fixture(id,label)
WHERE pr.id='69197d56-41b0-4c8b-ac19-181f63e87c1f';
INSERT INTO authz.clients(id,principal_id,label,actions) VALUES
('bedb86cb-beaf-414b-a7aa-7aaf44e28d3f','ed3258cb-44c5-45bc-a8c7-f06486cf7e00','synthetic task client',authz.service_actions(ARRAY['task_board'])),
('95afec23-4a3b-468d-ab01-29b500eaaa91','9f78abc6-56dd-4bd9-a5df-8e796253a041','synthetic full client',authz.service_actions(ARRAY['storage','resources','context','work'])),
('f90c389e-2702-4a7e-a1cb-2971cad2918c','5f1c621d-0261-4288-af7b-2df5927cb0f5','synthetic excess declared client',authz.service_actions(ARRAY['storage','resources','context','work'])),
('d4d49505-c816-4174-a1a5-3e3318de5c14','ed3258cb-44c5-45bc-a8c7-f06486cf7e00','synthetic narrowed task client',ARRAY['v8.board.read']),
('e20b19ba-46e0-4fb7-aa3e-68a3ff64503c','ed3258cb-44c5-45bc-a8c7-f06486cf7e00','synthetic wrong project client',authz.service_actions(ARRAY['task_board']));
INSERT INTO authz.service_clients(client_id,service_id,project_ids,issued_by)
SELECT id,principal_id,CASE WHEN label='synthetic wrong project client' THEN ARRAY['870e2f15-c9ec-4eac-ac51-3107812aa9a0'::uuid] ELSE ARRAY['69197d56-41b0-4c8b-ac19-181f63e87c1f'::uuid] END,(SELECT manager_id FROM v8.projects WHERE id='69197d56-41b0-4c8b-ac19-181f63e87c1f') FROM authz.clients WHERE id::text LIKE '95000000-0000-4000-8000-00000000010%';
INSERT INTO authz.credentials(client_id,token_hash,until_revoked,authority_source)
SELECT id,encode(public.digest('synthetic-taskhall-fixture-'||id::text,'sha256'),'hex'),true,'product_service_authorized' FROM authz.clients WHERE id::text LIKE '95000000-0000-4000-8000-00000000010%';
INSERT INTO authz.service_authorizations(service_id,project_id,capabilities,source_actor_id)
SELECT fixture.id,pr.id,fixture.caps,pr.manager_id FROM v8.projects pr CROSS JOIN(VALUES
('ed3258cb-44c5-45bc-a8c7-f06486cf7e00'::uuid,ARRAY['task_board']),
('9f78abc6-56dd-4bd9-a5df-8e796253a041'::uuid,ARRAY['storage','resources','context','work']),
('5f1c621d-0261-4288-af7b-2df5927cb0f5'::uuid,ARRAY['storage'])) fixture(id,caps) WHERE pr.id='69197d56-41b0-4c8b-ac19-181f63e87c1f';
DO $tests$
DECLARE ident jsonb;pid uuid:='69197d56-41b0-4c8b-ac19-181f63e87c1f';sid uuid:='ed3258cb-44c5-45bc-a8c7-f06486cf7e00';cid uuid:='bedb86cb-beaf-414b-a7aa-7aaf44e28d3f';proof text;denied boolean;act text;
BEGIN
 proof:=encode(public.digest('synthetic-taskhall-fixture-'||cid::text,'sha256'),'hex');
 ident:=authz.authenticate(proof);
 ASSERT ident->>'authorization_mode'='product_service';
 ASSERT ident->'client_actions'=to_jsonb(authz.service_actions(ARRAY['task_board'])),'task service acquired extra capabilities';
 FOREACH act IN ARRAY authz.service_actions(ARRAY['task_board']) LOOP
  PERFORM authz.require_client_capability(ident,act);
  ASSERT authz.service_deadline(sid,cid,pid,act,jsonb_build_object('project_id',pid)) IS NOT NULL;
 END LOOP;
 FOREACH act IN ARRAY ARRAY['mem.read','mem.write','mem.process','resource.read','resource.write','resource.deploy','v8.context.read','v8.work.commit','hufu.vault.read','hufu.qualification.manage'] LOOP
  denied:=false;BEGIN PERFORM authz.require_client_capability(ident,act);EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied,'capability escaped task scope';
  ASSERT authz.service_deadline(sid,cid,pid,act,jsonb_build_object('project_id',pid)) IS NULL,'resource action escaped grant scope';
  ASSERT authz.service_deadline(sid,NULL,pid,act,jsonb_build_object('project_id',pid)) IS NULL,'external-owner action escaped grant scope';
 END LOOP;
 denied:=false;BEGIN PERFORM authz.resource_deadline(sid,cid,pid,'mem.read',jsonb_build_object('project_id',pid));EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied;
 ASSERT authz.service_client_actions('d4d49505-c816-4174-a1a5-3e3318de5c14')=ARRAY['v8.board.read'];
 ASSERT authz.service_deadline(sid,'d4d49505-c816-4174-a1a5-3e3318de5c14',pid,'v8.board.claim',jsonb_build_object('project_id',pid)) IS NULL;
 ASSERT authz.service_client_actions('e20b19ba-46e0-4fb7-aa3e-68a3ff64503c')=ARRAY[]::text[];
 ASSERT authz.service_deadline(sid,'e20b19ba-46e0-4fb7-aa3e-68a3ff64503c',pid,'v8.board.read',jsonb_build_object('project_id',pid)) IS NULL;
 -- Full foundation retains its complete actually authorized legacy ability set.
 ASSERT authz.service_client_actions('95afec23-4a3b-468d-ab01-29b500eaaa91')=authz.service_actions(ARRAY['storage','resources','context','work']);
 ASSERT authz.service_deadline('9f78abc6-56dd-4bd9-a5df-8e796253a041','95afec23-4a3b-468d-ab01-29b500eaaa91',pid,'mem.read',jsonb_build_object('project_id',pid)) IS NOT NULL;
 ASSERT authz.service_deadline('9f78abc6-56dd-4bd9-a5df-8e796253a041','95afec23-4a3b-468d-ab01-29b500eaaa91',pid,'resource.write',jsonb_build_object('project_id',pid)) IS NOT NULL;
 -- Actual grant caps dominate an excessively broad declared client action array.
 ASSERT authz.service_client_actions('f90c389e-2702-4a7e-a1cb-2971cad2918c')=authz.service_actions(ARRAY['storage']);
 ASSERT authz.service_deadline('5f1c621d-0261-4288-af7b-2df5927cb0f5','f90c389e-2702-4a7e-a1cb-2971cad2918c',pid,'resource.deploy',jsonb_build_object('project_id',pid)) IS NULL;
 UPDATE authz.service_authorizations SET active=false WHERE service_id=sid;
 ASSERT authz.authenticate(proof)->'client_actions'='[]'::jsonb;
 denied:=false;BEGIN PERFORM authz.require_client_capability(ident,'v8.board.read');EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied,'cached identity survived grant revocation';
 ASSERT authz.service_deadline(sid,cid,pid,'v8.board.read',jsonb_build_object('project_id',pid)) IS NULL;
 UPDATE authz.service_authorizations SET active=true,until_revoked=false,expires_at=clock_timestamp()-interval '1 second' WHERE service_id=sid;
 ASSERT authz.service_client_actions(cid)=ARRAY[]::text[];
 UPDATE authz.service_authorizations SET until_revoked=true,expires_at=NULL WHERE service_id=sid;
 UPDATE authz.credentials SET revoked_at=clock_timestamp() WHERE client_id=cid;
 denied:=false;BEGIN PERFORM authz.authenticate(proof);EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied;
END $tests$;
RESET ROLE;
ROLLBACK;
