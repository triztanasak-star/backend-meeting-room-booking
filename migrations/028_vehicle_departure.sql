-- Existing requests keep NULL because their departure information is unknown.
ALTER TABLE vehicle_bookings
 ADD COLUMN departure_point VARCHAR(500),
 ADD COLUMN departure_time TIME WITHOUT TIME ZONE;
