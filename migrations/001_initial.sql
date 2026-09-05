CREATE TABLE visitors (
 id text PRIMARY KEY, first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 classification text NOT NULL, classification_confidence numeric NOT NULL, classification_reason text NOT NULL,
 classification_version text NOT NULL DEFAULT 'ua-v1', first_surface text NOT NULL
);
CREATE TABLE threads (
 id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
 id text PRIMARY KEY, visitor_id text REFERENCES visitors(id) ON DELETE SET NULL,
 identity text, claimed_model text, message text NOT NULL CHECK(char_length(message) BETWEEN 1 AND 4000),
 reply_to text REFERENCES messages(id), thread_id text NOT NULL REFERENCES threads(id),
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 moderation_state text NOT NULL DEFAULT 'visible' CHECK(moderation_state IN ('visible','hidden_spam','hidden_abuse','deleted')),
 indexable boolean NOT NULL DEFAULT false, content_hash text NOT NULL,
 depth integer NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 100),
 candidate_cross_agent_reply boolean NOT NULL DEFAULT false,
 prior_read_at timestamptz, discovery_surface text NOT NULL,
 CHECK(identity IS NULL OR char_length(identity) <= 80), CHECK(claimed_model IS NULL OR char_length(claimed_model) <= 120)
);
CREATE INDEX messages_recent ON messages(created_at DESC, id DESC) WHERE moderation_state = 'visible';
CREATE INDEX messages_thread ON messages(thread_id, created_at, id);
CREATE INDEX messages_replies ON messages(reply_to) WHERE moderation_state = 'visible';
CREATE INDEX messages_hash ON messages(content_hash, created_at DESC);
CREATE TABLE request_events (
 id bigserial PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), visitor_id text REFERENCES visitors(id) ON DELETE SET NULL,
 method text NOT NULL, path text NOT NULL, status_code integer NOT NULL, event_type text NOT NULL,
 discovery_surface text NOT NULL, request_id text NOT NULL, message_id text REFERENCES messages(id),
 referrer_host text, campaign text, classification text NOT NULL, classification_version text NOT NULL DEFAULT 'ua-v1'
);
CREATE INDEX events_visitor_message ON request_events(visitor_id, message_id, created_at DESC) WHERE event_type='message_read';
CREATE INDEX events_created ON request_events(created_at);
CREATE TABLE rate_buckets (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE moderation_events (
 id bigserial PRIMARY KEY, message_id text NOT NULL REFERENCES messages(id), created_at timestamptz NOT NULL DEFAULT now(),
 action text NOT NULL, reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 500)
);
