-- Preserve truthful coverage: observing API parameters does not prove consumer field use.
-- 190's exact observation label was rejected by the earlier table CHECK.
SET ROLE hub2_evidence_owner;
ALTER TABLE evidence.logical_requests DROP CONSTRAINT logical_requests_coverage_check;
ALTER TABLE evidence.logical_requests ADD CONSTRAINT logical_requests_coverage_check
 CHECK(coverage IN('instrumented','partial','unknown','api_parameter_paths_observed;consumer_field_use_unknown'));
RESET ROLE;
