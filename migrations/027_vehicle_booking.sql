CREATE TABLE vehicle_fleet (
 id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL,
 plate VARCHAR(30) NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE vehicle_drivers (
 id SERIAL PRIMARY KEY, name VARCHAR(120) NOT NULL,
 phone VARCHAR(30) NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE vehicle_approvers (user_id INTEGER PRIMARY KEY REFERENCES users(id));
CREATE TABLE vehicle_bookings (
 id SERIAL PRIMARY KEY, created_by INTEGER NOT NULL REFERENCES users(id),
 booking_date DATE NOT NULL, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 1000),
 destination VARCHAR(500) NOT NULL, purpose VARCHAR(2000) NOT NULL,
 phone VARCHAR(30) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending'
 CHECK(status IN ('pending','approved','rejected','cancelled')),
 reason VARCHAR(2000), reviewed_by INTEGER REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX vehicle_booking_day ON vehicle_bookings(booking_date,status);
CREATE TABLE vehicle_assignments (
 booking_id INTEGER NOT NULL REFERENCES vehicle_bookings(id),
 vehicle_id INTEGER NOT NULL REFERENCES vehicle_fleet(id),
 driver_id INTEGER NOT NULL REFERENCES vehicle_drivers(id),
 PRIMARY KEY(booking_id,vehicle_id), UNIQUE(booking_id,driver_id)
);
