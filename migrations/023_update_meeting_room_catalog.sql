-- Keep old room IDs and bookings for history, but hide the old sample catalog.
ALTER TABLE meeting_rooms ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

UPDATE meeting_rooms r
SET archived_at = COALESCE(r.archived_at, NOW())
FROM meeting_floors f JOIN meeting_sites s ON s.id = f.site_id
WHERE r.floor_id = f.id
  AND s.name IN ('HO1', 'HO2')
  AND f.level BETWEEN 1 AND 8
  AND r.name = s.name || '.' || f.level || '01';

INSERT INTO meeting_sites(name) VALUES ('Phòng họp') ON CONFLICT DO NOTHING;

-- Retain the existing access-control structure underneath direct room selection.
INSERT INTO meeting_floors(site_id, name, level)
SELECT s.id, catalog.name, catalog.level
FROM meeting_sites s
CROSS JOIN (VALUES
  ('Phòng họp 1', 1),
  ('Phòng họp 2', 2),
  ('Phòng họp nhà máy', 3)
) AS catalog(name, level)
WHERE s.name = 'Phòng họp'
ON CONFLICT DO NOTHING;

INSERT INTO meeting_rooms(floor_id, name, capacity, equipment)
SELECT f.id, f.name, 12, 'Màn hình, bảng trắng'
FROM meeting_floors f JOIN meeting_sites s ON s.id = f.site_id
WHERE s.name = 'Phòng họp' AND f.level BETWEEN 1 AND 3
ON CONFLICT DO NOTHING;
