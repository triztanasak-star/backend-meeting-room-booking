BEGIN;

ALTER TABLE "digital_works"
  ADD COLUMN IF NOT EXISTS "progress_increased_at" TIMESTAMPTZ;

-- Historical increases were not tracked consistently. Use the last known
-- update as a conservative baseline for existing projects, once only.
UPDATE "digital_works"
SET progress_increased_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
WHERE progress_increased_at IS NULL;

ALTER TABLE "digital_works"
  ALTER COLUMN "progress_increased_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "progress_increased_at" SET NOT NULL;

CREATE OR REPLACE FUNCTION track_work_progress_increase()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.progress_percent > OLD.progress_percent THEN
    NEW.progress_increased_at := CURRENT_TIMESTAMP;
  ELSE
    NEW.progress_increased_at := OLD.progress_increased_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_progress_increased ON "digital_works";
CREATE TRIGGER work_progress_increased
BEFORE UPDATE ON "digital_works"
FOR EACH ROW EXECUTE FUNCTION track_work_progress_increase();

COMMIT;
