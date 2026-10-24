-- Reviewed current references; no new member qualifications, raw V8 grants or recovery-complete claims.
-- Version numbering and completed copy receipts are historical ledgers, not live consumers.
-- Governance candidates retain declared evidence/revision links, including resolved items conservatively.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='90s';
DO $review$ BEGIN
 IF mem.gc_relation_shape('v8.adoptions'::regclass)<>'d73a6ae0fb7dd5b00e2edeab266b891e' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.adoptions';END IF;
 IF mem.gc_relation_shape('v8.context_sources'::regclass)<>'169a24b27a48e8d806ce26513684ae09' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.context_sources';END IF;
 IF mem.gc_relation_shape('v8.experience_feedback'::regclass)<>'264f8f4a19d1537577c11827a963a45d' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.experience_feedback';END IF;
 IF mem.gc_relation_shape('v8.handoffs'::regclass)<>'82c2ffa29db9c598e0762c31e0cc249c' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.handoffs';END IF;
 IF mem.gc_relation_shape('v8.projects'::regclass)<>'5bf3ff5f89151a592741a316a259f379' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.projects';END IF;
 IF mem.gc_relation_shape('v8.results'::regclass)<>'1a1c4631465b3af62b8aecf2c0fc64e6' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.results';END IF;
 IF mem.gc_relation_shape('v8.work_executions'::regclass)<>'bb02326f19eb9be71d0e4f8ae82522dd' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.work_executions';END IF;
 IF mem.gc_relation_shape('v8.work_items'::regclass)<>'21ed8f2624a73ae6f3d37fe8b6643a7c' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.work_items';END IF;
 IF mem.gc_relation_shape('v8.work_relations'::regclass)<>'3b7f54beaf37d8ec76af0592cbbf397e' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.work_relations';END IF;
 IF mem.gc_relation_shape('mem.object_observations'::regclass)<>'108de4a43883d945b09ddef2b59bc764' THEN RAISE EXCEPTION 'reviewed_shape_changed:mem.object_observations';END IF;
 IF mem.gc_relation_shape('v8.context_views'::regclass)<>'6244eaf756f218910f585c28f28472ab' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.context_views';END IF;
 IF mem.gc_relation_shape('v8.impact_judgments'::regclass)<>'985ef3b90365ffe05f4836820fe92270' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.impact_judgments';END IF;
 IF mem.gc_relation_shape('v8.operations'::regclass)<>'dab991294ede567096dc4f347f39f573' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.operations';END IF;
 IF mem.gc_relation_shape('v8.read_projections'::regclass)<>'e37228ea6773a7a7194f6e55f772bf60' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.read_projections';END IF;
 IF mem.gc_relation_shape('v8.work_read_receipts'::regclass)<>'8182e49cd95cedf113c4d12b00cdfda5' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.work_read_receipts';END IF;
 IF mem.gc_relation_shape('v8.work_snapshots'::regclass)<>'9943daea1b81f8a0e133576f4bdf2584' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.work_snapshots';END IF;
 IF mem.gc_relation_shape('v8.work_updates'::regclass)<>'22e177c50935e0098d16cbf13f098ae6' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.work_updates';END IF;
 IF mem.gc_relation_shape('v8.context_manifests'::regclass)<>'6da05e672d29a0c390631500af99ff6b' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.context_manifests';END IF;
 IF mem.gc_relation_shape('v8.legacy_references'::regclass)<>'723c9e6fbf5255da376906f14fd0a451' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.legacy_references';END IF;
 IF mem.gc_relation_shape('v8.experiences'::regclass)<>'b7a358adeb7b2459571a282aaa50593f' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.experiences';END IF;
 IF mem.gc_relation_shape('mem.archive_copy_receipts749'::regclass)<>'455bdc66a839ef0c75d1c9210bb6d0b2' THEN RAISE EXCEPTION 'reviewed_shape_changed:mem.archive_copy_receipts749';END IF;
 IF mem.gc_relation_shape('mem.file_version_counters'::regclass)<>'0bf42124347d7001cd6470158d8689f9' THEN RAISE EXCEPTION 'reviewed_shape_changed:mem.file_version_counters';END IF;
 IF mem.gc_relation_shape('mem.file_version_numbers'::regclass)<>'ab8977bded379d10dbb33b76406769bb' THEN RAISE EXCEPTION 'reviewed_shape_changed:mem.file_version_numbers';END IF;
 IF mem.gc_relation_shape('v8.governance_candidates'::regclass)<>'5ce25f4e1a6a363214d7cb6bc78b009c' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.governance_candidates';END IF;
 IF mem.gc_relation_shape('v8.governance_events'::regclass)<>'f91c4b711a1a2d1d5382d2a61f9f95d5' THEN RAISE EXCEPTION 'reviewed_shape_changed:v8.governance_events';END IF;
END $review$;
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY['use_evidence']::text[],shape_hash='d73a6ae0fb7dd5b00e2edeab266b891e' WHERE schema_name='v8'AND table_name='adoptions'AND kind='reference'AND uuid_fields=ARRAY['material_id','version_id']::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='169a24b27a48e8d806ce26513684ae09' WHERE schema_name='v8'AND table_name='context_sources'AND kind='reference'AND uuid_fields=ARRAY['material_id','version_id']::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY['evidence']::text[],shape_hash='264f8f4a19d1537577c11827a963a45d' WHERE schema_name='v8'AND table_name='experience_feedback'AND kind='reference'AND uuid_fields=ARRAY['material_id','version_id']::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='82c2ffa29db9c598e0762c31e0cc249c' WHERE schema_name='v8'AND table_name='handoffs'AND kind='none'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='5bf3ff5f89151a592741a316a259f379' WHERE schema_name='v8'AND table_name='projects'AND kind='none'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='1a1c4631465b3af62b8aecf2c0fc64e6' WHERE schema_name='v8'AND table_name='results'AND kind='reference'AND uuid_fields=ARRAY['material_id','version_id']::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='bb02326f19eb9be71d0e4f8ae82522dd' WHERE schema_name='v8'AND table_name='work_executions'AND kind='none'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='21ed8f2624a73ae6f3d37fe8b6643a7c' WHERE schema_name='v8'AND table_name='work_items'AND kind='none'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='3b7f54beaf37d8ec76af0592cbbf397e' WHERE schema_name='v8'AND table_name='work_relations'AND kind='none'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='108de4a43883d945b09ddef2b59bc764' WHERE schema_name='mem'AND table_name='object_observations'AND kind='ledger'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='6244eaf756f218910f585c28f28472ab' WHERE schema_name='v8'AND table_name='context_views'AND kind='ledger'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='985ef3b90365ffe05f4836820fe92270' WHERE schema_name='v8'AND table_name='impact_judgments'AND kind='ledger'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='dab991294ede567096dc4f347f39f573' WHERE schema_name='v8'AND table_name='operations'AND kind='ledger'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='e37228ea6773a7a7194f6e55f772bf60' WHERE schema_name='v8'AND table_name='read_projections'AND kind='ledger'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='8182e49cd95cedf113c4d12b00cdfda5' WHERE schema_name='v8'AND table_name='work_read_receipts'AND kind='ledger'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='9943daea1b81f8a0e133576f4bdf2584' WHERE schema_name='v8'AND table_name='work_snapshots'AND kind='ledger'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='22e177c50935e0098d16cbf13f098ae6' WHERE schema_name='v8'AND table_name='work_updates'AND kind='ledger'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='6da05e672d29a0c390631500af99ff6b' WHERE schema_name='v8'AND table_name='context_manifests'AND kind='mutation'AND uuid_fields=ARRAY[]::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY[]::text[],shape_hash='723c9e6fbf5255da376906f14fd0a451' WHERE schema_name='v8'AND table_name='legacy_references'AND kind='reference'AND uuid_fields=ARRAY['target_version_id','target_material_id']::text[];
UPDATE mem.gc_reference_contracts SET json_fields=ARRAY['evidence']::text[],shape_hash='b7a358adeb7b2459571a282aaa50593f' WHERE schema_name='v8'AND table_name='experiences'AND kind='reference'AND uuid_fields=ARRAY['material_id','version_id']::text[];
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields,shape_hash) VALUES('mem','archive_copy_receipts749','ledger',ARRAY[]::text[],ARRAY[]::text[],'455bdc66a839ef0c75d1c9210bb6d0b2') ON CONFLICT(schema_name,table_name) DO UPDATE SET kind=EXCLUDED.kind,uuid_fields=EXCLUDED.uuid_fields,json_fields=EXCLUDED.json_fields,shape_hash=EXCLUDED.shape_hash;
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields,shape_hash) VALUES('mem','file_version_counters','ledger',ARRAY[]::text[],ARRAY[]::text[],'0bf42124347d7001cd6470158d8689f9') ON CONFLICT(schema_name,table_name) DO UPDATE SET kind=EXCLUDED.kind,uuid_fields=EXCLUDED.uuid_fields,json_fields=EXCLUDED.json_fields,shape_hash=EXCLUDED.shape_hash;
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields,shape_hash) VALUES('mem','file_version_numbers','ledger',ARRAY[]::text[],ARRAY[]::text[],'ab8977bded379d10dbb33b76406769bb') ON CONFLICT(schema_name,table_name) DO UPDATE SET kind=EXCLUDED.kind,uuid_fields=EXCLUDED.uuid_fields,json_fields=EXCLUDED.json_fields,shape_hash=EXCLUDED.shape_hash;
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields,shape_hash) VALUES('v8','governance_candidates','reference',ARRAY[]::text[],ARRAY['evidence_refs','revision_links']::text[],'5ce25f4e1a6a363214d7cb6bc78b009c') ON CONFLICT(schema_name,table_name) DO UPDATE SET kind=EXCLUDED.kind,uuid_fields=EXCLUDED.uuid_fields,json_fields=EXCLUDED.json_fields,shape_hash=EXCLUDED.shape_hash;
INSERT INTO mem.gc_reference_contracts(schema_name,table_name,kind,uuid_fields,json_fields,shape_hash) VALUES('v8','governance_events','ledger',ARRAY[]::text[],ARRAY[]::text[],'f91c4b711a1a2d1d5382d2a61f9f95d5') ON CONFLICT(schema_name,table_name) DO UPDATE SET kind=EXCLUDED.kind,uuid_fields=EXCLUDED.uuid_fields,json_fields=EXCLUDED.json_fields,shape_hash=EXCLUDED.shape_hash;
-- Vault byte authority is Bao secret_ref/secret_version, not Mem content; source and column review retained.
INSERT INTO mem.gc_schema_contracts(schema_name,purpose)VALUES('vault2','infrastructure')ON CONFLICT(schema_name)DO NOTHING;
CREATE OR REPLACE TRIGGER gc_reference_fence BEFORE INSERT OR UPDATE ON v8.governance_candidates FOR EACH ROW EXECUTE FUNCTION mem.gc_reference_fence();
-- Narrow count only. Governance rows remain under V8 ownership and RLS; Mem gets no table SELECT.
GRANT EXECUTE ON FUNCTION mem.gc_fact_keys(text,text,jsonb) TO hub2_v8_owner;
SET LOCAL ROLE hub2_v8_owner;
CREATE OR REPLACE FUNCTION v8.gc_governance_reference_count(keys text[]) RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,v8 AS $count$
 SELECT count(*) FROM v8.governance_candidates t WHERE EXISTS(SELECT FROM mem.gc_fact_keys('v8','governance_candidates',to_jsonb(t))k WHERE k=ANY(keys))
$count$;
REVOKE ALL ON FUNCTION v8.gc_governance_reference_count(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION v8.gc_governance_reference_count(text[]) TO hub2_mem_owner;
RESET ROLE;
DO $patch$ DECLARE definition text;needle text; BEGIN
 definition:=pg_get_functiondef('mem.gc_scan(uuid,text,text)'::regprocedure);
 needle:='EXECUTE format($scan$SELECT count(*)FROM %I.%I t WHERE EXISTS(SELECT FROM mem.gc_fact_keys($1,$2,to_jsonb(t))k WHERE k=ANY($3))$scan$,r.nspname,r.relname)INTO n USING r.nspname,r.relname,refs;';
 IF position('v8.gc_governance_reference_count(refs)'in definition)=0 THEN
  IF position(needle in definition)=0 THEN RAISE EXCEPTION 'gc_scan_patch_anchor_changed';END IF;
  EXECUTE replace(definition,needle,'IF r.nspname=''v8''AND r.relname=''governance_candidates''THEN SELECT v8.gc_governance_reference_count(refs)INTO n;ELSE '||needle||'END IF;');
 END IF;
 definition:=pg_get_functiondef('mem.gc_catalog()'::regprocedure);
 needle:='pg_get_functiondef(''mem.gc_fact_keys(text,text,jsonb)''::regprocedure)';
 IF position('v8.gc_governance_reference_count(text[])'in definition)=0 THEN
  IF position(needle in definition)=0 THEN RAISE EXCEPTION 'gc_catalog_patch_anchor_changed';END IF;
  EXECUTE replace(definition,needle,needle||'||pg_get_functiondef(''v8.gc_governance_reference_count(text[])''::regprocedure)');
 END IF;
 IF NOT EXISTS(SELECT FROM mem.gc_fact_keys('v8','governance_candidates','{"evidence_refs":[{"version_id":"e48cb247-f55e-477b-aaaf-d8e991508e41"}],"revision_links":[]}'::jsonb)k WHERE k='uuid:e48cb247-f55e-477b-aaaf-d8e991508e41') THEN RAISE EXCEPTION 'governance_reference_key_missing';END IF;
 IF NOT EXISTS(SELECT FROM mem.gc_fact_keys('v8','experience_feedback','{"evidence":[{"version_id":"e48cb247-f55e-477b-aaaf-d8e991508e41"}]}'::jsonb)k WHERE k='uuid:e48cb247-f55e-477b-aaaf-d8e991508e41') THEN RAISE EXCEPTION 'feedback_evidence_key_missing';END IF;
 IF has_table_privilege('hub2_mem_owner','v8.governance_candidates','SELECT') THEN RAISE EXCEPTION 'unexpected_raw_governance_grant';END IF;
END $patch$;
COMMIT;
