# Meeting Room Booking backend

See [project setup and business rules](../README.md).

- `npm run migrate`: install the auth baseline and booking schema without removing legacy data.
- `npm run dev`: start the API with nodemon.
- `npm start`: start the API.
- `npm test`: business rules and HTTP authorization tests.
- `npm run test:integration`: opt-in PostgreSQL tests using `MEETING_TEST_DATABASE_URL` (isolated localhost:55439 only).

Migrations now contain only users, authentication tokens, activity logs, and the
meeting-room booking schema. Original filenames are retained for compatibility
with existing `schema_migrations` records. All migration entry points use the same
transactional runner and execute pending SQL files in filename order.

Removed Digital Work migration files do not drop tables or delete data in an
existing database. Run `npm run migrate` from `backend` to apply pending changes.

Migration `023_update_meeting_room_catalog.sql` installs Phòng họp 1, Phòng họp 2,
and Phòng họp nhà máy. Original HO1/HO2 sample rooms are archived from the catalog;
their bookings and IDs remain intact. Custom rooms are preserved. The calendar
selects rooms directly. Existing approval rules still use the access groups
underneath each room (room 1 is automatic; other rooms use assigned access).

The three rooms are the initial catalog. Administrators can add more rooms and
edit room names, capacity, equipment, and status from Room management.

Migration 025 adds `is_default`, editable with the Default room switch when
creating or editing a room. Default rooms allow automatic booking approval;
assigned-room permissions continue to apply. New rooms get an access group
automatically. Deleting a room archives it to preserve booking history and is
blocked while it has pending or approved bookings ending today or later.
