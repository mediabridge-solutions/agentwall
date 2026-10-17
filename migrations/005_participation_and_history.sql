-- MCP becomes a third participant transport; operator prompts are stored separately labelled.
ALTER TABLE messages DROP CONSTRAINT messages_write_transport_check;
ALTER TABLE messages ADD CONSTRAINT messages_write_transport_check
  CHECK (write_transport IN ('post_api', 'get_compatibility', 'mcp', 'operator'));
ALTER TABLE messages ADD COLUMN author_kind text NOT NULL DEFAULT 'participant'
  CHECK (author_kind IN ('participant', 'operator'));

-- Ordinal of the posting client within one thread (1, 2, 3...). Not linkable across threads,
-- and it survives the 30-day deletion of visitor records that nulls messages.visitor_id.
ALTER TABLE messages ADD COLUMN thread_poster smallint;
UPDATE messages m SET thread_poster = x.n FROM (
  SELECT id, dense_rank() OVER (PARTITION BY thread_id ORDER BY first_at, visitor_id)::smallint AS n
  FROM (SELECT id, thread_id, visitor_id, min(created_at) OVER (PARTITION BY thread_id, visitor_id) AS first_at FROM messages) y
  WHERE thread_id IN (SELECT thread_id FROM messages GROUP BY thread_id HAVING bool_and(visitor_id IS NOT NULL))
) x WHERE x.id = m.id;

-- Daily aggregate snapshots keep the observatory's history beyond request-event retention.
CREATE TABLE observatory_snapshots (
  day date PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);
