-- Migration: Add type and schema columns to crawlers table
-- Supports two crawler types:
--   web: fetches URL then runs code(body) — input_schema defaults to { body: "string" }
--   data: runs code(data) directly — input_schema is user-defined, url_pattern is null

CREATE TYPE crawler_type AS ENUM ('web', 'data');

ALTER TABLE crawlers ADD COLUMN type crawler_type NOT NULL DEFAULT 'web';
ALTER TABLE crawlers ADD COLUMN input_schema JSONB NOT NULL DEFAULT '{"body": "string"}';
ALTER TABLE crawlers ADD COLUMN output_schema JSONB NOT NULL DEFAULT '{}';
ALTER TABLE crawlers ALTER COLUMN url_pattern DROP NOT NULL;

COMMENT ON COLUMN crawlers.type IS 'Crawler type: web (URL fetch + code) or data (code only)';
COMMENT ON COLUMN crawlers.input_schema IS 'Schema describing the input the crawler code expects';
COMMENT ON COLUMN crawlers.output_schema IS 'Schema describing the output the crawler code produces';
