-- Consolidate the original room-1 booking before removing obsolete sample rooms.
-- Abort if the destination already has bookings; merging needs conflict review.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM meeting_bookings b JOIN meeting_rooms r ON r.id = b.room_id
    JOIN meeting_floors f ON f.id = r.floor_id
    JOIN meeting_sites s ON s.id = f.site_id
    WHERE s.name = 'HO1' AND r.name = 'HO1.101'
  ) AND EXISTS (
    SELECT 1 FROM meeting_bookings b JOIN meeting_rooms r ON r.id = b.room_id
    WHERE r.name = 'Phòng họp 1' AND r.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot merge HO1.101: Phòng họp 1 already has bookings';
  END IF;

  UPDATE meeting_bookings b SET room_id = target.id
  FROM meeting_rooms old_room
  JOIN meeting_floors f ON f.id = old_room.floor_id
  JOIN meeting_sites s ON s.id = f.site_id
  CROSS JOIN meeting_rooms target
  WHERE b.room_id = old_room.id AND s.name = 'HO1'
    AND old_room.name = 'HO1.101'
    AND target.name = 'Phòng họp 1' AND target.archived_at IS NULL;

  IF EXISTS (
    SELECT 1 FROM meeting_bookings b JOIN meeting_rooms r ON r.id = b.room_id
    WHERE r.archived_at IS NOT NULL
       OR r.name NOT IN ('Phòng họp 1', 'Phòng họp 2', 'Phòng họp nhà máy')
  ) THEN
    RAISE EXCEPTION 'Obsolete rooms still have bookings; no data was deleted';
  END IF;
END $$;

DELETE FROM meeting_rooms
WHERE archived_at IS NOT NULL
   OR name NOT IN ('Phòng họp 1', 'Phòng họp 2', 'Phòng họp nhà máy');

DELETE FROM meeting_floors f
WHERE NOT EXISTS (SELECT 1 FROM meeting_rooms r WHERE r.floor_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.meeting_floor_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM meeting_floor_admins a WHERE a.floor_id = f.id);

DELETE FROM meeting_sites s
WHERE NOT EXISTS (SELECT 1 FROM meeting_floors f WHERE f.site_id = s.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_meeting_rooms_name ON meeting_rooms(name);
