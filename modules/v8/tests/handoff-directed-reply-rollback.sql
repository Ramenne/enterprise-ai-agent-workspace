-- Synthetic members, project, work and handoff; all effects rollback.
BEGIN;
INSERT INTO authz.principals(id,organization_id,kind,display_name,role,trusted_source)
SELECT ('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'d38af612-4736-4e6c-a8da-458999402fd2',
CASE WHEN n=4 THEN 'service' ELSE 'member' END,'synthetic reply '||n,'member','handoff-reply-rollback-test' FROM generate_series(1,4)n;
INSERT INTO authz.clients(id,principal_id,label,actions)
SELECT ('97000000-0000-4000-8000-'||lpad((100+n)::text,12,'0'))::uuid,
('97000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'synthetic reply client '||n,ARRAY['v8.handoff.record','v8.handoff.read'] FROM generate_series(1,4)n;
INSERT INTO authz.credentials(client_id,token_hash,until_revoked,authority_source)
SELECT id,md5('synthetic-reply-'||id::text)||md5('synthetic-reply-'||id::text),true,
CASE WHEN label LIKE '%4' THEN 'delegated_api' ELSE 'member_issued_api' END FROM authz.clients WHERE id::text LIKE '97000000-0000-4000-8000-00000000010%';
INSERT INTO v8.projects(id,organization_id,owner_id,manager_id,kind,visibility,title)
VALUES('c0de5759-c805-4177-a492-c53e16c0625d','d38af612-4736-4e6c-a8da-458999402fd2','2564a9b9-76b6-4115-a832-cfa7c9d97fe6','2564a9b9-76b6-4115-a832-cfa7c9d97fe6','project','personal','synthetic personal reply');
INSERT INTO v8.work_items(id,short_no,project_id,actor_id,client_id,goal)
VALUES('7c113238-736b-47b6-acf7-26dff77b70e3',97000301,'c0de5759-c805-4177-a492-c53e16c0625d','2564a9b9-76b6-4115-a832-cfa7c9d97fe6','bceccbf9-4033-4914-af8e-1e98fc45b922','synthetic reply work');
INSERT INTO v8.context_manifests(id,project_id,work_item_id,work_revision,actor_id,manifest,sha256,source_coverage,expires_at)
VALUES('8b154d58-af09-4234-a32c-6d5b2391402a','c0de5759-c805-4177-a492-c53e16c0625d','7c113238-736b-47b6-acf7-26dff77b70e3',1,'2564a9b9-76b6-4115-a832-cfa7c9d97fe6','{}',repeat('a',64),'unknown',now()+interval '1 hour');
INSERT INTO v8.handoffs(id,work_item_id,context_id,from_actor_id,to_actor_id,rationale,next_actions,state)
VALUES('100f788f-25a3-45f0-abc1-a4a3c4fb8d7f','7c113238-736b-47b6-acf7-26dff77b70e3','8b154d58-af09-4234-a32c-6d5b2391402a','2564a9b9-76b6-4115-a832-cfa7c9d97fe6','11b56aed-f579-4f53-a2be-84626f29153f','synthetic request','[]','prepared');
SET SESSION AUTHORIZATION hub2_v8;
DO $tests$
DECLARE b jsonb:='{"project_id":"c0de5759-c805-4177-a492-c53e16c0625d","handoff_id":"100f788f-25a3-45f0-abc1-a4a3c4fb8d7f","expected_revision":1,"handling_state":"waiting_external","summary":"synthetic approval; not resource delivery","outputs":[],"limitations":[],"idempotency_key":"synthetic-directed-reply"}';
proof text:=md5('synthetic-reply-42ad28be-80f5-46e7-afcf-a491f66a9b17')||md5('synthetic-reply-42ad28be-80f5-46e7-afcf-a491f66a9b17');
r jsonb;original jsonb;other jsonb;denied boolean;
BEGIN
 r:=v8.handoff_progress_member(proof,encode(sha256(convert_to(b::text,'UTF8')),'hex'),b::text);original:=r;
 ASSERT r->>'state'='saved' AND r->>'revision'='2','recipient without project write could not reply';
 r:=v8.handoff_progress_member(proof,encode(sha256(convert_to(b::text,'UTF8')),'hex'),b::text);ASSERT r=original,'same submission duplicated';
 other:=b||'{"idempotency_key":"synthetic-outsider"}';
 denied:=false;BEGIN PERFORM v8.handoff_progress_member(md5('synthetic-reply-1abaed4b-ef0d-4a3c-a607-b45c162fb077')||md5('synthetic-reply-1abaed4b-ef0d-4a3c-a607-b45c162fb077'),encode(sha256(convert_to(other::text,'UTF8')),'hex'),other::text);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='handoff_participant_required';END;ASSERT denied,'outsider replied';
 other:=b||'{"idempotency_key":"synthetic-sender-recipient-action","expected_revision":2}';
 denied:=false;BEGIN PERFORM v8.handoff_progress_member(md5('synthetic-reply-bceccbf9-4033-4914-af8e-1e98fc45b922')||md5('synthetic-reply-bceccbf9-4033-4914-af8e-1e98fc45b922'),encode(sha256(convert_to(other::text,'UTF8')),'hex'),other::text);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='recipient_required';END;ASSERT denied,'sender acted as recipient';
 other:=b||'{"idempotency_key":"synthetic-recipient-confirm","expected_revision":2,"handling_state":"confirmed"}';
 denied:=false;BEGIN PERFORM v8.handoff_progress_member(proof,encode(sha256(convert_to(other::text,'UTF8')),'hex'),other::text);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='sender_required';END;ASSERT denied,'recipient confirmed for sender';
 other:=b||'{"idempotency_key":"synthetic-stale-cas"}';
 denied:=false;BEGIN PERFORM v8.handoff_progress_member(proof,encode(sha256(convert_to(other::text,'UTF8')),'hex'),other::text);
 EXCEPTION WHEN serialization_failure THEN denied:=SQLERRM='handoff_revision_conflict';END;ASSERT denied,'stale revision accepted';
 other:=b||'{"idempotency_key":"synthetic-wrong-project","project_id":"f5474973-1340-4f2e-aabd-627d46d1be84"}';
 denied:=false;BEGIN PERFORM v8.handoff_progress_member(proof,encode(sha256(convert_to(other::text,'UTF8')),'hex'),other::text);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied,'wrong project accepted';
 other:=b||'{"idempotency_key":"synthetic-service"}';
 denied:=false;BEGIN PERFORM v8.handoff_progress_member(md5('synthetic-reply-27876556-fa58-46a8-a15e-41afaf085891')||md5('synthetic-reply-27876556-fa58-46a8-a15e-41afaf085891'),encode(sha256(convert_to(other::text,'UTF8')),'hex'),other::text);
 EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;ASSERT denied,'service impersonated member';
 other:=b||'{"idempotency_key":"synthetic-invalid-output","expected_revision":2,"outputs":[{"material_id":"a35ba2a3-bccf-4d68-a3e6-30ce1d1f5d03","version_id":"76aacb88-9ebf-4838-a43f-7383dfed50d8","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}';
 denied:=false;BEGIN PERFORM v8.handoff_progress_member(proof,encode(sha256(convert_to(other::text,'UTF8')),'hex'),other::text);
 EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value THEN denied:=true;END;ASSERT denied,'invalid output accepted';
 other:=b||'{"idempotency_key":"synthetic-confirm","expected_revision":2,"handling_state":"confirmed"}';
 r:=v8.handoff_progress_member(md5('synthetic-reply-bceccbf9-4033-4914-af8e-1e98fc45b922')||md5('synthetic-reply-bceccbf9-4033-4914-af8e-1e98fc45b922'),encode(sha256(convert_to(other::text,'UTF8')),'hex'),other::text);
 ASSERT r->>'revision'='3','sender could not confirm';
 RAISE NOTICE 'PASS directed reply, replay, roles, outsider, CAS, project, service and fixed-output fences';
END $tests$;
RESET SESSION AUTHORIZATION;
DO $tests$ BEGIN
 ASSERT NOT EXISTS(SELECT FROM authz.qualifications WHERE principal_id='11b56aed-f579-4f53-a2be-84626f29153f'),'reply granted project authority';
 ASSERT (SELECT event_revision FROM v8.handoffs WHERE id='100f788f-25a3-45f0-abc1-a4a3c4fb8d7f')=3,'failed requests mutated state';
 ASSERT (SELECT count(*) FROM v8.operations WHERE actor_id IN('2564a9b9-76b6-4115-a832-cfa7c9d97fe6','11b56aed-f579-4f53-a2be-84626f29153f'))=2,'duplicate effects';
END $tests$;
UPDATE authz.credentials SET revoked_at=now() WHERE client_id='42ad28be-80f5-46e7-afcf-a491f66a9b17';
SET SESSION AUTHORIZATION hub2_v8;
DO $tests$
DECLARE b jsonb:='{"project_id":"c0de5759-c805-4177-a492-c53e16c0625d","handoff_id":"100f788f-25a3-45f0-abc1-a4a3c4fb8d7f","expected_revision":3,"handling_state":"waiting_external","idempotency_key":"synthetic-revoked"}';denied boolean:=false;
BEGIN
 BEGIN PERFORM v8.handoff_progress_member(md5('synthetic-reply-42ad28be-80f5-46e7-afcf-a491f66a9b17')||md5('synthetic-reply-42ad28be-80f5-46e7-afcf-a491f66a9b17'),encode(sha256(convert_to(b::text,'UTF8')),'hex'),b::text);
 EXCEPTION WHEN insufficient_privilege THEN denied:=SQLERRM='unauthenticated';END;ASSERT denied,'revoked credential replied';
END $tests$;
RESET SESSION AUTHORIZATION;
ROLLBACK;
