// Unit tests for server/turn.js (no database, no network). Run: node server/turn-test.js
const assert = require('assert');
const crypto = require('crypto');
const { createIce, coturnCredentials, hasRelay, cleanServers } = require('./turn');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ' + name); };
const relayOf = (r) => r.iceServers.filter((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));

(async () => {
  await t('nothing configured: only STUN, relay false, warns once in production', async () => {
    const warns = [];
    const ice = createIce({ env: { NODE_ENV: 'production' }, warn: (m) => warns.push(m) });
    const a = await ice.forUser('u1'); await ice.forUser('u2');
    assert.strictEqual(a.relay, false); assert.strictEqual(a.mode, 'none');
    assert.ok(a.iceServers.length >= 1 && a.iceServers.every((s) => [].concat(s.urls).every((u) => u.startsWith('stun:'))));
    assert.strictEqual(warns.length, 1);
    const quiet = []; await createIce({ env: {}, warn: (m) => quiet.push(m) }).forUser('x');
    assert.strictEqual(quiet.length, 0, 'no warning outside production');
  });

  await t('coturn secret: username is expiry:user, password is base64 HMAC-SHA1', async () => {
    const now = 1_700_000_000_000;
    const c = coturnCredentials('s3cret', 'user-7', 3600, now);
    assert.strictEqual(c.username, (1_700_000_000 + 3600) + ':user-7');
    assert.strictEqual(c.credential, crypto.createHmac('sha1', 's3cret').update(c.username).digest('base64'));
    const ice = createIce({ env: { TURN_URLS: 'turn:t.example.com:3478?transport=udp, turns:t.example.com:443?transport=tcp', TURN_SECRET: 's3cret', TURN_TTL_SECONDS: '3600' }, now: () => now });
    const r = await ice.forUser('user-7');
    assert.strictEqual(r.relay, true); assert.strictEqual(r.mode, 'coturn');
    const [turn] = relayOf(r);
    assert.deepStrictEqual(turn.urls, ['turn:t.example.com:3478?transport=udp', 'turns:t.example.com:443?transport=tcp']);
    assert.strictEqual(turn.username, c.username); assert.strictEqual(turn.credential, c.credential);
    const other = relayOf(await ice.forUser('someone-else'))[0];
    assert.notStrictEqual(other.username, turn.username, 'credentials are per user');
  });

  await t('default lifetime outlasts a long call (24 h) and a bad TTL falls back', async () => {
    assert.strictEqual(createIce({ env: {} }).ttl, 86400);
    assert.strictEqual(createIce({ env: { TURN_TTL_SECONDS: 'abc' } }).ttl, 86400);
    assert.strictEqual(createIce({ env: { TURN_TTL_SECONDS: '-5' } }).ttl, 86400);
  });

  await t('static username/password', async () => {
    const r = await createIce({ env: { TURN_URLS: 'turn:x.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' } }).forUser('a');
    assert.strictEqual(r.mode, 'static'); assert.strictEqual(r.relay, true);
    assert.strictEqual(relayOf(r)[0].username, 'u'); assert.strictEqual(relayOf(r)[0].credential, 'p');
  });

  await t('old ICE_SERVERS json still works; broken entries are dropped', async () => {
    const env = { ICE_SERVERS: JSON.stringify([{ urls: 'turn:a.example.com', username: 'u', credential: 'p' }, { urls: 'turn:nologin.example.com' }, { urls: 'http://evil' }, null]) };
    const r = await createIce({ env }).forUser('a');
    assert.strictEqual(r.mode, 'json'); assert.strictEqual(r.relay, true);
    assert.strictEqual(relayOf(r).length, 1);
    assert.ok(!JSON.stringify(r).includes('nologin') && !JSON.stringify(r).includes('evil'));
    const junk = await createIce({ env: { ICE_SERVERS: 'not json' } }).forUser('a');
    assert.strictEqual(junk.relay, false); assert.strictEqual(junk.mode, 'none');
  });

  await t('cleanServers / hasRelay', async () => {
    assert.strictEqual(hasRelay([{ urls: 'stun:a' }]), false);
    assert.strictEqual(hasRelay([{ urls: ['turn:a'], username: 'u', credential: 'p' }]), true);
    assert.strictEqual(hasRelay([{ urls: 'turn:a', username: 'u' }]), false);
    assert.deepStrictEqual(cleanServers('x'), []);
    assert.deepStrictEqual(cleanServers([{ urls: 'stun:a' }]), [{ urls: ['stun:a'] }]);
  });

  await t('cloudflare: asks the API once, caches, sends token + ttl, keeps provider STUN', async () => {
    let calls = 0, seen = null, clock = 1_000_000;
    const fetchFn = async (url, opts) => {
      calls++; seen = { url, opts };
      return { ok: true, json: async () => ({ iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'cfu', credential: 'cfp' },
      ] }) };
    };
    const ice = createIce({ env: { CF_TURN_KEY_ID: 'KEY1', CF_TURN_API_TOKEN: 'TOK' }, fetchFn, now: () => clock });
    const [a, b] = await Promise.all([ice.forUser('a'), ice.forUser('b')]);
    assert.strictEqual(calls, 1, 'concurrent requests share one API call');
    assert.strictEqual(a.mode, 'cloudflare'); assert.strictEqual(a.relay, true); assert.strictEqual(b.relay, true);
    assert.strictEqual(seen.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/KEY1/credentials/generate-ice-servers');
    assert.strictEqual(seen.opts.headers.Authorization, 'Bearer TOK');
    assert.deepStrictEqual(JSON.parse(seen.opts.body), { ttl: 86400 });
    assert.ok(!JSON.stringify(a).includes('TOK'), 'the API token never reaches the browser');
    const stunUrls = a.iceServers.flatMap((s) => [].concat(s.urls)).filter((u) => u.startsWith('stun:'));
    assert.strictEqual(new Set(stunUrls).size, stunUrls.length, 'no duplicate STUN entries');
    clock += 3600 * 1000; await ice.forUser('a'); assert.strictEqual(calls, 1, 'still cached after 1 h');
    clock += 12 * 3600 * 1000; await ice.forUser('a'); assert.strictEqual(calls, 2, 'refreshed after half the lifetime');
  });

  await t('cloudflare failing: stale credentials are reused, otherwise STUN only; never throws', async () => {
    let ok = true, clock = 0; const warns = [];
    const fetchFn = async () => ok ? { ok: true, json: async () => ({ iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'p' } }) } : { ok: false, status: 500 };
    const ice = createIce({ env: { CF_TURN_KEY_ID: 'K', CF_TURN_API_TOKEN: 'T' }, fetchFn, now: () => clock, warn: (m) => warns.push(m) });
    assert.strictEqual((await ice.forUser('a')).relay, true, 'a single object (not a list) is accepted');
    ok = false; clock += 13 * 3600 * 1000;
    assert.strictEqual((await ice.forUser('a')).relay, true, 'stale set reused');
    assert.ok(warns.length >= 1);
    const fresh = createIce({ env: { CF_TURN_KEY_ID: 'K', CF_TURN_API_TOKEN: 'T' }, fetchFn: async () => { throw new Error('boom'); } });
    const r = await fresh.forUser('a');
    assert.strictEqual(r.relay, false); assert.ok(r.iceServers.length >= 1);
    const empty = createIce({ env: { CF_TURN_KEY_ID: 'K', CF_TURN_API_TOKEN: 'T' }, fetchFn: async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: ['stun:x'] }] }) }) });
    assert.strictEqual((await empty.forUser('a')).relay, false, 'a reply without relay credentials is not trusted');
  });

  await t('cloudflare wins over the other settings', async () => {
    const ice = createIce({ env: { CF_TURN_KEY_ID: 'K', CF_TURN_API_TOKEN: 'T', TURN_URLS: 'turn:a', TURN_SECRET: 's' } });
    assert.strictEqual(ice.mode(), 'cloudflare');
  });

  console.log(`\n${n} groups passed`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
