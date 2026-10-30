ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve the automatic approval behavior of existing level-1 rooms.
UPDATE meeting_rooms r SET is_default = TRUE
FROM meeting_floors f WHERE f.id = r.floor_id AND f.level = 1;
