// Install only the authentication baseline and meeting-room schema.
// Legacy Digital Work tables and user credentials remain intact.
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const db = require("../src/db");
async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Configure it in backend/.env.");
  }
  await db.withTransaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(82461102)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(filename VARCHAR(255) PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
    );
    const migrationsDir = path.join(__dirname, "../migrations");
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const applied = await c.query(
        "SELECT 1 FROM schema_migrations WHERE filename=$1",
        [file],
      );
      if (applied.rows.length) {
        console.log("Already applied:", file);
        continue;
      }
      try {
        await c.query(
          fs.readFileSync(path.join(migrationsDir, file), "utf8"),
        );
      } catch (error) {
        throw new Error(`${file} [${error.code || "ERROR"}]: ${error.message}`, {
          cause: error,
        });
      }
      await c.query("INSERT INTO schema_migrations(filename) VALUES ($1)", [
        file,
      ]);
      console.log("Applied:", file);
    }
    await c.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users(email)",
    );
  });
}
migrate()
  .then(() => {
    console.log("Meeting Room Booking database is ready.");
  })
  .catch((e) => {
    console.error("Migration rolled back:", e.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
