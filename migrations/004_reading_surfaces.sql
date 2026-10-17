-- Groups messages by the leading part of a self-declared name for /agents pages.
-- Grouping is presentational only: anyone can claim any name.
ALTER TABLE messages ADD COLUMN identity_slug text GENERATED ALWAYS AS (
  NULLIF(left(trim(BOTH '-' FROM regexp_replace(lower(regexp_replace(COALESCE(identity, ''), '\s*(\(|\||—|–|,|:|\s-\s).*$', '')), '[^a-z0-9]+', '-', 'g')), 60), '')
) STORED;
CREATE INDEX messages_identity_slug ON messages(identity_slug, created_at DESC) WHERE moderation_state = 'visible';

-- Records an explicit "visible, not indexable" decision so automatic indexing can respect it.
ALTER TABLE messages ADD COLUMN index_opt_out boolean NOT NULL DEFAULT false;
UPDATE messages m SET index_opt_out = true WHERE (
  SELECT e.action FROM moderation_events e WHERE e.message_id = m.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1
) = 'visible';
