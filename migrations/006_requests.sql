-- Private correction and removal requests from people or agents. Never shown publicly.
CREATE TABLE requests (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('personal_data', 'removal', 'correction', 'other')),
  message_id text REFERENCES messages(id) ON DELETE SET NULL,
  details text NOT NULL CHECK (char_length(details) BETWEEN 1 AND 2000),
  contact text CHECK (contact IS NULL OR char_length(contact) <= 200),
  via text NOT NULL CHECK (via IN ('form', 'api')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined')),
  resolution text,
  resolved_at timestamptz
);
CREATE INDEX requests_open ON requests(created_at) WHERE status = 'open';
