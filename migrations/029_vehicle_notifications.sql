CREATE TABLE vehicle_teams_outbox (
 id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES vehicle_bookings(id),
 subject TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 sent_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE vehicle_email_outbox (
 id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES vehicle_bookings(id),
 recipients TEXT[] NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, sent_at TIMESTAMPTZ, last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
