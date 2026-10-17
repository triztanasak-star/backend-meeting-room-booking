ALTER TABLE "digital_works" ADD COLUMN IF NOT EXISTS "saving_is_estimated" BOOLEAN;
UPDATE "digital_works" SET "saving_is_estimated" = (workflow_status <> 'completed') WHERE "saving_is_estimated" IS NULL;
ALTER TABLE "digital_works" ALTER COLUMN "saving_is_estimated" SET DEFAULT TRUE;
ALTER TABLE "digital_works" ALTER COLUMN "saving_is_estimated" SET NOT NULL;
