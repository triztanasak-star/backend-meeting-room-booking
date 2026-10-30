-- 006_create_refresh_tokens.sql
-- Luu hash cua refresh token de co the thu hoi (logout, doi mat khau, phat hien token bi lo).

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id"          SERIAL PRIMARY KEY,
  "user_id"     INTEGER NOT NULL REFERENCES "users"("id"),
  "token_hash"  VARCHAR(255) NOT NULL,
  "expires_at"  TIMESTAMPTZ NOT NULL,
  "revoked_at"  TIMESTAMPTZ,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user_id" ON "refresh_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_hash" ON "refresh_tokens" ("token_hash");
