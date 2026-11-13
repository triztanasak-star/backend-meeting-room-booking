CREATE TABLE IF NOT EXISTS meeting_booking_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  minimum_notice_days INTEGER NOT NULL DEFAULT 0 CHECK (minimum_notice_days BETWEEN 0 AND 3650)
);
INSERT INTO meeting_booking_settings(id, minimum_notice_days) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
