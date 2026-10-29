// Persistence: PostgreSQL (built for Neon), with every record encrypted at rest (AES-256-GCM).
//
// The rest of the server still talks to `store.db.users / servers / messages / dms / friendships`
// and calls `store.save()` after changing something. This module keeps those collections in memory
// and writes only the records that changed to Postgres, each one sealed with the master key.
// Neon (or anyone with a copy of the database) only ever sees ciphertext.
//
// Required environment:
//   DATABASE_URL        Postgres connection string (Neon: copy it from the dashboard, "Connect").
//   DB_ENCRYPTION_KEY   64 hex chars (32 bytes). In production this is required. For local development
//                       only, if it is not set a key is created once and kept in data/db.key.
// Optional:
//   JWT_SECRET          session signing secret. If unset, a random one is created and stored (encrypted)
//                       in the database, so sessions survive restarts and redeploys.
//   R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
//                       keep images and attachments in a Cloudflare R2 bucket instead of Postgres.
//   STORAGE_LIMIT_GB    with R2: refuse new uploads above this many GB stored (default 4, 0 = no limit). This covers everything
//                       that is not a clip: profile pictures, banners, emoji and attachments.
//   CLIPS_R2_BUCKET     a SEPARATE R2 bucket for clips (short videos), with the same R2_* credentials. Clips have their own
//                       cap (CLIPS_LIMIT_GB, default 5, see clips.js), so 4 + 5 = 9 GB stays under R2's 10 GB free tier.
//   DB_SCHEMA           use a separate Postgres schema (used by the tests).
//
// Startup is asynchronous: call `await store.init()` before serving requests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => Number(v)); // BIGINT (timestamps) -> number

const DATA_DIR = path.join(__dirname, '..', 'data');
const COLLECTIONS = ['users', 'servers', 'messages', 'dms', 'friendships', 'emojis', 'payments', 'bots', 'calllog', 'themes', 'groups', 'gmsgs', 'badges', 'artists', 'clips'];
const SCHEMA = process.env.DB_SCHEMA;
if (SCHEMA && !/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error('DB_SCHEMA may only contain letters, digits and underscores');

let saveTimer = null;

// ---------- encryption ----------
function getMasterKey() {
  const fromEnv = process.env.DB_ENCRYPTION_KEY;
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) throw new Error('DB_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    return Buffer.from(fromEnv, 'hex');
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('DB_ENCRYPTION_KEY is not set. In production it is required (a key file on a host with a temporary disk would be lost on the next deploy). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  // local development: keep a key next to the project
  const f = path.join(DATA_DIR, 'db.key');
  try {
    const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    if (k.length === 32) return k;
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString('hex'), { mode: 0o600 });
  console.log(`DB_ENCRYPTION_KEY not set: created a development key at ${f}`);
  return k;
}
let KEY = null;

// layout: iv (12) | auth tag (16) | ciphertext. The table and id are bound in as AAD, so a
// ciphertext copied onto another row (or table) fails to decrypt.
function seal(plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.isBuffer(plain) ? plain : Buffer.from(plain, 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
function openRaw(blob, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, blob.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
const open = (blob, aad) => openRaw(blob, aad).toString('utf8');

// ---------- database ----------
let pool = null;
const q = (text, params) => pool.query(text, params);

// null-prototype objects: an id like "constructor" or "__proto__" from a request must not find Object.prototype members
const empty = () => Object.fromEntries(COLLECTIONS.map((t) => [t, Object.create(null)]));
let db = empty();
const written = Object.fromEntries(COLLECTIONS.map((t) => [t, new Map()])); // id -> JSON last persisted
let jwtSecret = null;
let vapidKeys = null; // { publicKey, privateKey } for Web Push (env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY win)

async function load() {
  db = empty();
  for (const t of COLLECTIONS) {
    written[t].clear();
    const { rows } = await q(`SELECT id, data FROM ${t} ORDER BY seq`) // insertion order, like the in-memory objects
    for (const row of rows) {
      const json = open(row.data, `${t}:${row.id}`);
      db[t][row.id] = JSON.parse(json);
      written[t].set(row.id, json);
    }
  }
}

async function init() {
  if (pool) return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Create a free Neon project (neon.tech), copy its connection string and set it as DATABASE_URL.');
  KEY = getMasterKey();
  r2Setup();
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 5,
    keepAlive: true,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000, // a sleeping Neon compute needs a moment to wake up
    ...(SCHEMA ? { options: `-c search_path=${SCHEMA}` } : {}),
  });
  // Neon closes idle connections; without this handler that would crash the process.
  pool.on('error', (e) => console.error('Postgres connection error (it will reconnect):', e.message));
  if (SCHEMA) {
    await new Pool({ connectionString: url, max: 1 }).query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  }

  await q('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BYTEA NOT NULL)');
  for (const t of COLLECTIONS)
    await q(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, data BYTEA NOT NULL, updated_at BIGINT NOT NULL, seq BIGSERIAL)`);
  // Uploaded images (profile pictures, banners, custom emoji). Read and written straight from the
  // database, encrypted like everything else.
  await q('CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data BYTEA NOT NULL, created_at BIGINT NOT NULL)');
  // Message attachments. Bytes and metadata are both sealed. For DMs the bytes are already ciphertext
  // from the browser, so they are encrypted twice.
  await q('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, data BYTEA NOT NULL, meta BYTEA NOT NULL, attached INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)');

  // size of the stored (sealed) bytes, used for the R2 storage limit
  await q('ALTER TABLE images ADD COLUMN IF NOT EXISTS size BIGINT NOT NULL DEFAULT 0');
  await q('ALTER TABLE files ADD COLUMN IF NOT EXISTS size BIGINT NOT NULL DEFAULT 0');

  // Refuse to start with the wrong key instead of silently producing a broken database.
  const check = (await q('SELECT value FROM meta WHERE key = $1', ['keycheck'])).rows[0];
  if (check) {
    let ok = false;
    try { ok = open(check.value, 'meta:keycheck') === 'aduna'; } catch {}
    if (!ok) throw new Error('Cannot decrypt the database: DB_ENCRYPTION_KEY is wrong, or it is not the key this database was created with.');
  } else {
    await q('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['keycheck', seal('aduna', 'meta:keycheck')]);
  }

  // session signing secret
  if (process.env.JWT_SECRET) jwtSecret = process.env.JWT_SECRET;
  else {
    let row = (await q('SELECT value FROM meta WHERE key = $1', ['jwtsecret'])).rows[0];
    if (!row) {
      await q('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['jwtsecret', seal(crypto.randomBytes(32).toString('hex'), 'meta:jwtsecret')]);
      row = (await q('SELECT value FROM meta WHERE key = $1', ['jwtsecret'])).rows[0];
    }
    jwtSecret = open(row.value, 'meta:jwtsecret');
  }

  // Web Push signing keys: from the environment, else generated once and kept (encrypted) in the database.
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) vapidKeys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  else {
    let row = (await q('SELECT value FROM meta WHERE key = $1', ['vapid'])).rows[0];
    if (!row) {
      const k = require('web-push').generateVAPIDKeys();
      await q('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', ['vapid', seal(JSON.stringify(k), 'meta:vapid')]);
      row = (await q('SELECT value FROM meta WHERE key = $1', ['vapid'])).rows[0];
    }
    vapidKeys = JSON.parse(open(row.value, 'meta:vapid'));
  }

  await load();
}

// Write every changed record in a single transaction. Flushes never overlap.
let flushChain = Promise.resolve();
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const run = flushChain.then(doFlush);
  flushChain = run.catch(() => {});
  return run;
}

async function doFlush() {
  if (!pool) return;
  const at = Date.now();
  const ups = {}, dels = {}; // per collection
  const pending = [];        // [collection, id, json | null], applied to `written` after commit
  for (const t of COLLECTIONS) {
    const u = { ids: [], data: [] };
    for (const [id, rec] of Object.entries(db[t])) {
      const json = JSON.stringify(rec);
      if (written[t].get(id) === json) continue;
      u.ids.push(id); u.data.push(seal(json, `${t}:${id}`));
      pending.push([t, id, json]);
    }
    const d = [...written[t].keys()].filter((id) => !(id in db[t]));
    for (const id of d) pending.push([t, id, null]);
    if (u.ids.length) ups[t] = u;
    if (d.length) dels[t] = d;
  }
  if (!pending.length) return;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [t, u] of Object.entries(ups))
      await c.query(
        `INSERT INTO ${t} (id, data, updated_at) SELECT x.id, x.data, $3 FROM unnest($1::text[], $2::bytea[]) AS x(id, data)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`, [u.ids, u.data, at]);
    for (const [t, ids] of Object.entries(dels)) await c.query(`DELETE FROM ${t} WHERE id = ANY($1::text[])`, [ids]);
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally { c.release(); }
  // only mark records as persisted once the transaction has committed
  for (const [t, id, json] of pending) json === null ? written[t].delete(id) : written[t].set(id, json);
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    flush().catch((e) => {
      console.error('Failed to save database (will retry):', e.message);
      saveTimer = setTimeout(() => { saveTimer = null; save(); }, 3000); // nothing is lost: unsaved records are re-sent
    });
  }, 150);
}

// ---------- blob storage: Cloudflare R2 (optional) ----------
// Images and attachments can live in a Cloudflare R2 bucket instead of Postgres, which keeps the Neon
// database small. The bytes are sealed (AES-256-GCM) before they are uploaded, so R2 only holds ciphertext.
// The Postgres row stays as the index (id, timestamps, attached flag) with an EMPTY `data` column; a row
// whose data is non-empty is stored in Postgres, so old rows keep working after you switch R2 on.
// Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET to enable it.
// R2_ENDPOINT overrides the URL (used by the tests).
let r2 = null;
let clipsR2 = null; // the clips bucket (see makeClipsBucket); public videos, so these bytes are NOT sealed
function r2Setup() {
  const { R2_BUCKET, CLIPS_R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID, R2_ENDPOINT } = process.env;
  if (!R2_BUCKET && !CLIPS_R2_BUCKET) return;
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !(R2_ACCOUNT_ID || R2_ENDPOINT))
    throw new Error('R2_BUCKET or CLIPS_R2_BUCKET is set, but R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are also needed.');
  const { AwsClient } = require('aws4fetch');
  const client = new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
  const host = (R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/$/, '');
  if (CLIPS_R2_BUCKET) clipsR2 = makeClipsBucket(client, `${host}/${CLIPS_R2_BUCKET}/`);
  if (!R2_BUCKET) return;
  const base = `${host}/${R2_BUCKET}/`;
  const call = async (method, key, body) => {
    const r = await client.fetch(base + key, { method, body });
    if (!r.ok && !(method === 'DELETE' && r.status === 404)) throw new Error(`R2 ${method} ${key} failed: ${r.status}`);
    return r;
  };
  r2 = {
    put: (key, buf) => call('PUT', key, buf),
    get: async (key) => { const r = await client.fetch(base + key); if (r.status === 404) return null; if (!r.ok) throw new Error(`R2 GET ${key} failed: ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
    del: (key) => call('DELETE', key),
  };
}
// The clips bucket. The app uploads straight to it through a short-lived signed link, so the video never passes through this
// server; afterwards the server only looks at the object (size, type, first bytes). R2's signed links cannot cap the size of an
// upload, which is why every upload is checked (and deleted if it is too big) once it is finished.
function makeClipsBucket(client, base) {
  const ok = (r, what) => { if (!r.ok) throw new Error(`R2 ${what} failed: ${r.status}`); return r; };
  return {
    // a link the app can PUT the file to for `ttlSec` seconds (nothing else: one key, one method)
    async presignPut(key, ttlSec = 600) {
      const u = new URL(base + key);
      u.searchParams.set('X-Amz-Expires', String(ttlSec));
      return (await client.sign(new Request(u, { method: 'PUT' }), { aws: { signQuery: true } })).url;
    },
    // { size, type } or null when there is no such object
    async head(key) {
      const r = await client.fetch(base + key, { method: 'HEAD' });
      if (r.status === 404) return null;
      ok(r, `HEAD ${key}`);
      return { size: Number(r.headers.get('content-length')) || 0, type: String(r.headers.get('content-type') || '').toLowerCase().split(';')[0].trim() };
    },
    // the first `n` bytes of an object (or null when it is missing)
    async first(key, n) {
      const r = await client.fetch(base + key, { headers: { Range: `bytes=0-${n - 1}` } });
      if (r.status === 404) return null;
      ok(r, `GET ${key}`);
      return Buffer.from(await r.arrayBuffer()).subarray(0, n);
    },
    async del(key) {
      const r = await client.fetch(base + key, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`R2 DELETE ${key} failed: ${r.status}`);
    },
    // the whole object (or null when it is missing). Only for the screening of a clip that already passed the size check; `max` is a second
    // safety so that a surprise object can never fill this server's memory.
    async get(key, max = 16 * 1024 * 1024) {
      const r = await client.fetch(base + key);
      if (r.status === 404) return null;
      ok(r, `GET ${key}`);
      if (Number(r.headers.get('content-length')) > max) throw new Error(`R2 GET ${key}: object is bigger than ${max} bytes`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max) throw new Error(`R2 GET ${key}: object is bigger than ${max} bytes`);
      return buf;
    },
  };
}
// Storage limit: new uploads are refused once the bytes held in R2 would pass STORAGE_LIMIT_GB
// (default 4: clips have their own 5 GB, and together they stay under R2's 10 GB free tier; 0 turns the limit off). Read on every upload.
const limitBytes = () => {
  const gb = process.env.STORAGE_LIMIT_GB === undefined || process.env.STORAGE_LIMIT_GB === '' ? 4 : Number(process.env.STORAGE_LIMIT_GB);
  return Number.isFinite(gb) && gb > 0 ? gb * 1024 ** 3 : 0;
};
async function r2BytesUsed() {
  const { rows } = await q(`SELECT (SELECT COALESCE(SUM(size), 0) FROM images WHERE octet_length(data) = 0)
                          + (SELECT COALESCE(SUM(size), 0) FROM files WHERE octet_length(data) = 0) AS n`);
  return Number(rows[0].n);
}
async function checkRoom(bytes) {
  const max = limitBytes();
  if (!r2 || !max) return;
  if ((await r2BytesUsed()) + bytes > max) {
    const e = new Error('Storage is full');
    e.code = 'STORAGE_FULL';
    throw e;
  }
}
const NOBYTES = Buffer.alloc(0);
// store sealed bytes: returns what goes in the Postgres `data` column
async function putBlob(key, sealed) { if (!r2) return sealed; await r2.put(key, sealed); return NOBYTES; }
// read sealed bytes back for a row whose `data` column is `inline`
async function getBlob(key, inline) { return inline && inline.length ? inline : (r2 ? r2.get(key) : null); }
// delete the R2 objects behind rows that were removed from Postgres (best effort: an orphan object is harmless)
async function dropBlobs(keys) {
  if (!r2) return;
  await Promise.all(keys.map((k) => r2.del(k).catch((e) => console.error('R2 cleanup failed:', e.message))));
}

// ---------- images ----------
const imageId = () => crypto.randomBytes(16).toString('hex'); // unguessable: the id is the access token for the URL
async function putImage(buf) {
  const iid = imageId();
  const sealed = seal(buf, `images:${iid}`);
  await checkRoom(sealed.length);
  const data = await putBlob(`images/${iid}`, sealed);
  await q('INSERT INTO images (id, data, created_at, size) VALUES ($1, $2, $3, $4)', [iid, data, Date.now(), sealed.length]);
  return iid;
}
async function getImage(iid) {
  if (!/^[0-9a-f]{32}$/.test(String(iid))) return null;
  const row = (await q('SELECT data FROM images WHERE id = $1', [iid])).rows[0];
  if (!row) return null;
  const sealed = await getBlob(`images/${iid}`, row.data);
  return sealed ? openRaw(sealed, `images:${iid}`) : null;
}
async function deleteImages(ids) {
  const v = (ids || []).filter((x) => /^[0-9a-f]{32}$/.test(String(x)));
  if (!v.length) return;
  const { rows } = await q('DELETE FROM images WHERE id = ANY($1::text[]) RETURNING id, octet_length(data) AS n', [v]);
  await dropBlobs(rows.filter((r) => r.n === 0).map((r) => `images/${r.id}`));
}
const deleteImage = (iid) => (iid ? deleteImages([iid]) : Promise.resolve());
// remove images no user points at any more (e.g. left behind by a crash between write and save)
async function pruneImages(keep) {
  const { rows } = await q('SELECT id FROM images');
  await deleteImages(rows.map((r) => r.id).filter((x) => !keep.has(x)));
}

// ---------- attachments ----------
const FILE_ID = /^[0-9a-f]{32}$/;
async function putFile(buf, meta) {
  const fid = imageId();
  const sealed = seal(buf, `files:${fid}`);
  await checkRoom(sealed.length);
  const data = await putBlob(`files/${fid}`, sealed);
  await q('INSERT INTO files (id, data, meta, attached, created_at, size) VALUES ($1, $2, $3, 0, $4, $5)',
    [fid, data, seal(JSON.stringify(meta), `filemeta:${fid}`), Date.now(), sealed.length]);
  return fid;
}
async function fileMeta(fid) {
  if (!FILE_ID.test(String(fid))) return null;
  const row = (await q('SELECT meta, attached FROM files WHERE id = $1', [fid])).rows[0];
  return row ? { ...JSON.parse(open(row.meta, `filemeta:${fid}`)), attached: !!row.attached } : null;
}
async function getFileBytes(fid) {
  if (!FILE_ID.test(String(fid))) return null;
  const row = (await q('SELECT data FROM files WHERE id = $1', [fid])).rows[0];
  if (!row) return null;
  const sealed = await getBlob(`files/${fid}`, row.data);
  return sealed ? openRaw(sealed, `files:${fid}`) : null;
}
const validIds = (ids) => (ids || []).filter((f) => FILE_ID.test(String(f)));
async function markAttached(ids) {
  const v = validIds(ids);
  if (v.length) await q('UPDATE files SET attached = 1 WHERE id = ANY($1::text[])', [v]);
}
// returns the ids that were removed
async function deleteFiles(ids) {
  const v = validIds(ids);
  if (!v.length) return [];
  const { rows } = await q('DELETE FROM files WHERE id = ANY($1::text[]) RETURNING id, octet_length(data) AS n', [v]);
  await dropBlobs(rows.filter((r) => r.n === 0).map((r) => `files/${r.id}`));
  return rows.map((r) => r.id);
}
// delete files past their age limit (attached or not); returns the ids that were removed
// Files up to thresholdBytes are kept smallMs, bigger ones only largeMs.
async function expireFiles({ smallMs, largeMs, thresholdBytes }) {
  const now = Date.now();
  const { rows } = await q('SELECT id FROM files WHERE (size > $1 AND created_at < $2) OR (size <= $1 AND created_at < $3)',
    [thresholdBytes, now - largeMs, now - smallMs]);
  return deleteFiles(rows.map((r) => r.id));
}
// remove files no message points at, once they are old enough that an in-flight send can't need them
async function pruneFiles(keep, minAgeMs = 3600_000) {
  const { rows } = await q('SELECT id FROM files WHERE created_at < $1', [Date.now() - minAgeMs]);
  await deleteFiles(rows.map((r) => r.id).filter((x) => !keep.has(x)));
}

const id = () => crypto.randomBytes(8).toString('hex');
const inviteCode = () => crypto.randomBytes(4).toString('hex');

// Small sealed values kept in the meta table (the JWT secret and VAPID keys use the same table). The key is part of what is
// authenticated, so a row cannot be swapped for another. Used for the rate-limit state, which has usernames and addresses in it.
async function getMeta(key) {
  const row = (await q('SELECT value FROM meta WHERE key = $1', [key])).rows[0];
  if (!row) return null;
  try { return open(row.value, 'meta:' + key); } catch { return null; } // unreadable (other key): treated as absent
}
async function setMeta(key, value) {
  await q('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, seal(String(value), 'meta:' + key)]);
}

// flush pending writes on shutdown (Render sends SIGTERM on every deploy)
let closing = false;
const closeHooks = new Set(); // async functions that run first when the server shuts down (the rate limits save themselves here)
async function close() {
  if (closing || !pool) return;
  closing = true;
  for (const h of closeHooks) { try { await h(); } catch (e) { console.error('Shutdown step failed:', e.message); } }
  try { await flush(); } catch (e) { console.error('Final save failed:', e.message); }
  try { await pool.end(); } catch {}
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { close().finally(() => process.exit(0)); });

module.exports = {
  get db() { return db; },
  get jwtSecret() { return jwtSecret; },
  get vapid() { return vapidKeys; },
  init, close, save, flush, reload: load, id, inviteCode, query: q, getMeta, setMeta, closeHooks,
  putImage, getImage, deleteImage, pruneImages, putFile, fileMeta, getFileBytes, markAttached, deleteFiles, expireFiles, pruneFiles,
  get usingR2() { return !!r2; },
  get clipsR2() { return clipsR2; },
  r2BytesUsed,
  storageLimitBytes: limitBytes,
  _seal: seal, _open: open,
};
