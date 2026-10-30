-- Preserve existing users and legacy application data.
CREATE TABLE IF NOT EXISTS meeting_sites (
 id SERIAL PRIMARY KEY, name VARCHAR(60) NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS meeting_floors (
 id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL REFERENCES meeting_sites(id),
 name VARCHAR(80) NOT NULL, level INTEGER NOT NULL,
 UNIQUE(site_id, level)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS meeting_floor_id INTEGER REFERENCES meeting_floors(id);
CREATE TABLE IF NOT EXISTS meeting_floor_admins (
 user_id INTEGER NOT NULL REFERENCES users(id), floor_id INTEGER NOT NULL REFERENCES meeting_floors(id),
 PRIMARY KEY(user_id, floor_id)
);
CREATE TABLE IF NOT EXISTS meeting_rooms (
 id SERIAL PRIMARY KEY, floor_id INTEGER NOT NULL REFERENCES meeting_floors(id),
 name VARCHAR(120) NOT NULL, capacity INTEGER NOT NULL CHECK(capacity > 0),
 equipment TEXT NOT NULL DEFAULT '', status VARCHAR(20) NOT NULL DEFAULT 'active'
 CHECK(status IN ('active','maintenance')), UNIQUE(floor_id, name)
);
CREATE TABLE IF NOT EXISTS meeting_bookings (
 id SERIAL PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES meeting_rooms(id),
 created_by INTEGER NOT NULL REFERENCES users(id), title VARCHAR(255) NOT NULL,
 mode VARCHAR(20) NOT NULL CHECK(mode IN ('single','multiple')),
 start_date DATE NOT NULL, end_date DATE NOT NULL, start_time TIME NOT NULL, end_time TIME NOT NULL,
 participants TEXT[] NOT NULL DEFAULT '{}', participant_count INTEGER NOT NULL CHECK(participant_count > 0),
 incharge VARCHAR(255) NOT NULL, phone VARCHAR(40) NOT NULL, note TEXT NOT NULL DEFAULT '',
 status VARCHAR(20) NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')),
 reason TEXT, reviewed_by INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK(end_date >= start_date), CHECK(end_time > start_time)
);
CREATE INDEX IF NOT EXISTS meeting_booking_room_dates ON meeting_bookings(room_id,start_date,end_date);
CREATE TABLE IF NOT EXISTS meeting_notifications (
 id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 booking_id INTEGER NOT NULL REFERENCES meeting_bookings(id), message TEXT NOT NULL,
 read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS meeting_email_outbox (
 id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES meeting_bookings(id),
 recipients TEXT[] NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, sent_at TIMESTAMPTZ, last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The room catalog is installed by 023_update_meeting_room_catalog.sql.
