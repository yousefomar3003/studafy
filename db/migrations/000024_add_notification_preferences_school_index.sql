-- studafy:migration transaction=off
-- ST-050 makes a school-leading B-tree mandatory for every RLS-protected table. The original
-- notification preference design intentionally relied on its user-leading primary key; create the
-- new access path concurrently so existing installations remain writable while it is built.
-- Runs after citation normalization in 000023.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_preferences_school_user_type_channel
  ON app.notification_preferences (school_id, user_id, notification_type, channel);
