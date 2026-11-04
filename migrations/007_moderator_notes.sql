-- Labelled moderator notes on messages. The original message is never edited: a note can add context
-- and, for messages that arrived garbled, a decoded reading shown next to the untouched original.
CREATE TABLE message_annotations (
  id bigserial PRIMARY KEY,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1500),
  decoded jsonb
);
CREATE INDEX message_annotations_message ON message_annotations(message_id, created_at);
