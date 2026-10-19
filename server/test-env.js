// Shared setup for the tests. Require this BEFORE ./index.
// Tests run in their own throwaway Postgres schema (dropped at the end) and need TEST_DATABASE_URL.
// They deliberately ignore DATABASE_URL so they can never touch your real database.
const crypto = require('crypto');
if (!process.env.TEST_DATABASE_URL) {
  console.error('Set TEST_DATABASE_URL to a Postgres database for the tests (a Neon dev branch or a local Postgres), e.g.\n  TEST_DATABASE_URL=postgres://postgres@localhost:5432/aduna_test npm test');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DB_SCHEMA = 't_' + crypto.randomBytes(4).toString('hex');
process.env.DB_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
delete process.env.JWT_SECRET;
process.env.NODE_ENV = 'test';
process.env.SIGNUPS_PER_HOUR = '100000';
process.env.AUTH_PER_MINUTE = '100000'; // same for the per-address login/register limiter // the tests create many accounts from one address

const store = require('./db');
// Every byte stored in every table, as one string: what someone with a copy of the database would see.
async function rawDb() {
  let out = '';
  for (const t of ['meta', 'users', 'servers', 'messages', 'dms', 'friendships', 'emojis', 'payments', 'images', 'files']) {
    const { rows } = await store.query(`SELECT * FROM ${t}`);
    for (const r of rows) for (const [k, v] of Object.entries(r)) out += Buffer.isBuffer(v) ? v.toString('latin1') : `${k}=${v}`;
  }
  return out;
}
async function cleanup() {
  store.closeHooks.clear(); // the schema is dropped below, so nothing may try to save into it afterwards
  try { await store.flush(); } catch {}
  try { await store.query(`DROP SCHEMA ${process.env.DB_SCHEMA} CASCADE`); } catch {}
  await store.close();
}
module.exports = { rawDb, cleanup };
