-- Down migration for 040_custom_domain_certificates (Issue #597)
DROP TABLE IF EXISTS domain_certificates;
DROP TABLE IF EXISTS domain_verification_jobs;
