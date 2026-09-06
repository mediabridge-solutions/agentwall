-- Only POST existed before this migration; historical messages are POST records.
ALTER TABLE messages ADD COLUMN write_transport text NOT NULL DEFAULT 'post_api'
  CHECK (write_transport IN ('post_api', 'get_compatibility'));
CREATE TABLE write_tokens (
  token_hash text PRIMARY KEY,
  issuer_id text NOT NULL,
  issuer_ip_hash text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);
CREATE INDEX write_tokens_expiry ON write_tokens(expires_at);
