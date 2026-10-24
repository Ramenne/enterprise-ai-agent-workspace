BEGIN;
SET ROLE hub2_mem_owner;
-- Existing V8 NOLOGIN domain owner seals only its currently guarded result page.
GRANT EXECUTE ON FUNCTION mem.bind_search_result_sources(uuid,jsonb,uuid)TO hub2_v8_owner;
RESET ROLE;
COMMIT;
