// Apply only the vehicle module without rerunning unrelated migrations.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');
const filename = '027_vehicle_booking.sql';
async function migrate() {
  await db.withTransaction(async c => {
    await c.query('SELECT pg_advisory_xact_lock(82461102)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(filename VARCHAR(255) PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename])).rows.length) {
      console.log('Already applied:', filename);
      return;
    }
    await c.query(fs.readFileSync(path.join(__dirname, '../migrations', filename), 'utf8'));
    await c.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
    console.log('Applied:', filename);
  });
}
migrate().catch(e => {
  console.error('Vehicle migration rolled back:', e.code, e.message);
  process.exitCode = 1;
}).finally(() => db.end());
