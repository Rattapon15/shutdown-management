// Shared PostgreSQL connection pool.
require('dotenv').config();
const { Pool } = require('pg');

const SCHEMA = process.env.DB_SCHEMA || 'ai_project';

// Azure Postgres terminates TLS at the gateway with a DigiCert chain that isn't
// in Node's default trust store, so "require" encrypts without chain validation.
// Set DB_SSL_MODE=verify-full (plus DB_CA_CERT) once the CA bundle is deployed.
function sslConfig() {
  const mode = (process.env.DB_SSL_MODE || 'require').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'verify-full') {
    return { rejectUnauthorized: true, ca: process.env.DB_CA_CERT || undefined };
  }
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host:     process.env.DB_HOST,
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  ssl:      sslConfig(),
  // Set at connection time rather than via a post-connect query, so unqualified
  // table names resolve on the very first statement a client runs.
  options:  `-c search_path=${SCHEMA},public`,
  // Cloud Run scales to many instances against a shared database; keep each
  // instance's footprint small so the server-side connection cap isn't hit.
  max:                    Number(process.env.DB_POOL_MAX || 5),
  idleTimeoutMillis:      30_000,
  connectionTimeoutMillis: 15_000,
});

pool.on('error', err => { console.error('[pg] idle client error:', err.message); });

async function query(text, params) { return pool.query(text, params); }

// Runs fn inside a transaction, rolling back on any throw.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTx, SCHEMA };
