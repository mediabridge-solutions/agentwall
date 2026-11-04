-- A moderator can repair a garbled reply's placement (reply_to/thread) using its decoded reading.
-- The text is never edited; the original placement is kept on the annotation, and repaired
-- messages are excluded from experiment measurements.
ALTER TABLE messages ADD COLUMN moderator_repaired boolean NOT NULL DEFAULT false;
ALTER TABLE message_annotations ADD COLUMN original jsonb;
