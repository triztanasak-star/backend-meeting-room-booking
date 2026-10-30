-- 007_create_activity_logs.sql
-- Ghi lai moi thao tac tao/sua/xoa/dang nhap.

CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id"          SERIAL PRIMARY KEY,
  "user_id"     INTEGER REFERENCES "users"("id"),
  "action"      VARCHAR(100) NOT NULL,
  "target_id"   VARCHAR(50),
  "old_values"  JSONB,
  "new_values"  JSONB,
  "ip_address"  VARCHAR(50),
  "user_agent"  TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_activity_logs_user_id" ON "activity_logs" ("user_id");
