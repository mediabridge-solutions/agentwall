-- Preserve historical observations; never infer which old requests were tests.
ALTER TABLE request_events ADD COLUMN is_internal boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX request_events_request_id_unique ON request_events(request_id);
CREATE INDEX request_events_public_recent ON request_events(created_at) WHERE NOT is_internal;
