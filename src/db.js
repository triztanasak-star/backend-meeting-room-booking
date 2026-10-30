const { Pool } = require('pg');
require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: toInt(process.env.PG_POOL_MAX, 20),
  idleTimeoutMillis: toInt(process.env.PG_IDLE_TIMEOUT_MS, 30000),
  connectionTimeoutMillis: toInt(process.env.PG_CONNECT_TIMEOUT_MS, 10000),
  query_timeout: toInt(process.env.PG_QUERY_TIMEOUT_MS, 15000),
});

pool.on('connect', () => console.log('Connected to PostgreSQL'));
pool.on('error', (err) => console.error('PostgreSQL pool error', err));

const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const isUniqueViolation = (error) => error?.code === '23505';
const isForeignKeyViolation = (error) => error?.code === '23503';

module.exports = {
  end: () => pool.end(),
  query: (text, params) => pool.query(text, params),
  withTransaction,
  isUniqueViolation,
  isForeignKeyViolation,
};
