// Warnings, mutes, timed suspensions and IP bans through the real server (needs TEST_DATABASE_URL like the other DB tests): node server/moderation-flow-test.js
// The rules themselves are in moderation-test.js; this checks the routes, the send checks in channels, DMs and groups, the sweep and the IP ban check.
const assert = require('assert');
const { cleanup } = require('./test-env');
process.env.RESEND_API_KEY = 're_test_not_real'; // verification on (NODE_ENV=test keeps mail in mailer.outbox), so a creator account must prove its email
process.env.ADMIN_USERNAMES = 'mod_admin';       // read when the server module loads, so set first
process.env.CREATOR_EMAILS = 'mod_creator@example.com';
delete process.env.IP_BAN;
const mailer = require('./mailer');
const { httpServer, ready, moderationSweep } = require('./index');
const { io: connect } = require('socket.io-client');
const store = require('./db');

const blob = { salt: 'a', iv: 'b', data: 'c' };
let base;
async function call(p, { method = 'GET', body, token, headers } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const once = (s, ev, ms = 8000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timed out waiting for ' + ev)), ms); s.once(ev, (x) => { clearTimeout(t); res(x); }); });
const waitFor = (s, ev, pred, ms = 8000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timed out waiting for ' + ev)), ms); const f = (x) => { if (pred(x)) { clearTimeout(t); s.off(ev, f); res(x); } }; s.on(ev, f); });

const reg = async (name) => {
  const email = name + '@example.com', mark = mailer.outbox.length;
  const r = await call('/register', { method: 'POST', body: { username: name, email, password: 'password123', publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x' + name, y: 'y' + name }), encPrivKey: blob } });
  assert.strictEqual(r.status, 200, 'register ' + name + ' ' + JSON.stringify(r));
  const m = mailer.outbox.slice(mark).find((x) => x.to === email);
  const code = m && (/\b(\d{6})\b/.exec(m.subject) || [])[1];
  const v = await call('/me/verify-email', { method: 'POST', token: r.token, body: { code } });
  assert.strictEqual(v.status, 200, 'verify ' + name + ' ' + JSON.stringify(v));
  return r;
};
const sock = async (token, headers) => { const s = connect(base, { auth: { token }, extraHeaders: { origin: base, ...(headers || {}) } }); await once(s, 'connect'); return s; };
// every attempt uses its own connection (the server allows only a few acknowledged events per connection)
const emit = async (token, ev, p) => { const s = await sock(token); try { return await new Promise((res) => s.emit(ev, p, res)); } finally { s.close(); } };
const befriend = async (a, b) => {
  assert.strictEqual((await call('/friends/request', { method: 'POST', token: a.token, body: { username: b.user.username } })).status, 200, 'friend request');
  assert.strictEqual((await call(`/friends/${a.user.id}/accept`, { method: 'POST', token: b.token })).status, 200, 'accept');
};
const wrap = (tag) => ({ ciphertext: Buffer.from('wrapped-' + tag).toString('base64'), iv: 'aXYxMjM0NTY3OA==', pk: 'fp' + tag });
const wraps = (ids) => Object.fromEntries(ids.map((id) => [id, wrap('k' + id.slice(0, 4))]));
const ct = (t) => ({ ciphertext: Buffer.from('msg-' + t).toString('base64'), iv: 'aXYxMjM0NTY3OA==' });

ready.then(() => httpServer.listen(0, async () => {
  try {
    base = 'http://127.0.0.1:' + httpServer.address().port;
    const admin = await reg('mod_admin'), creator = await reg('mod_creator');
    const alice = await reg('mod_alice'), bob = await reg('mod_bob'), carol = await reg('mod_carol'), dan = await reg('mod_dan');
    const id = (x) => x.user.id;
    await befriend(alice, bob); await befriend(alice, carol);
    const sv = (await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Alice Place' } })).server;
    const chan = sv.channels[0].id;
    const gid = (await call('/groups', { method: 'POST', token: alice.token, body: { members: [id(bob), id(carol)], nameEnc: ct('g'), wraps: wraps([id(alice), id(bob), id(carol)]) } })).group.id;
    const sendAll = async (who) => ({
      channel: await emit(who.token, 'message:send', { channelId: chan, content: 'hi ' + Math.random() }),
      dm: await emit(who.token, 'dm:send', { to: id(bob), ...ct('dm') }),
      group: await emit(who.token, 'group:send', { groupId: gid, ...ct('grp'), epoch: 1 }),
    });
    const okAll = (r) => assert.ok(r.channel.ok && r.dm.ok && r.group.ok, JSON.stringify(r));
    const blockedAll = (r, re) => { for (const k of ['channel', 'dm', 'group']) assert.match(String(r[k].error), re, k + ' should be refused: ' + JSON.stringify(r[k])); };
    okAll(await sendAll(alice));
    step('a person with no warnings sends in a channel, a DM and a group');

    // ---------- only admins, and only on people they may act on ----------
    assert.strictEqual((await call(`/admin/users/${id(bob)}/warn`, { method: 'POST', token: alice.token, body: { reason: 'x' } })).status, 404, 'not an admin: a plain 404');
    assert.strictEqual((await call(`/admin/users/${id(admin)}/warn`, { method: 'POST', token: admin.token, body: { reason: 'x' } })).status, 400, 'not yourself');
    assert.strictEqual((await call(`/admin/users/${id(creator)}/warn`, { method: 'POST', token: admin.token, body: { reason: 'x' } })).status, 403, 'never a creator');
    assert.strictEqual((await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: admin.token, body: { reason: '   ' } })).status, 400, 'a warning needs a reason');
    step('warn is admin-only and refuses yourself, creators and an empty reason');

    // ---------- warn: pushed live, blocks sending until "I understand" ----------
    const live = await sock(alice.token);
    const pushed = waitFor(live, 'user:update', (u) => u.modState && u.modState.pending && u.modState.pending.length === 1);
    let r = await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: admin.token, body: { reason: 'Please stop spamming the lounge' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.deepStrictEqual([r.moderation.activeWarnings, r.escalation], [1, null]);
    assert.strictEqual((await pushed).modState.pending[0].reason, 'Please stop spamming the lounge', 'their open app hears about it at once');
    live.close();
    r = await call('/me', { token: alice.token });
    assert.strictEqual(r.user.modState.pending.length, 1, 'their own view carries it');
    assert.ok(!JSON.stringify((await call(`/users/${id(alice)}`, { token: bob.token }))).includes('spamming'), 'other people never see it');
    blockedAll(await sendAll(alice), /read the warning/);
    assert.ok((await emit(bob.token, 'message:send', { channelId: (await call('/servers', { method: 'POST', token: bob.token, body: { name: 'Bob Place' } })).server.channels[0].id, content: 'bob is fine' })).ok, 'other people are not affected');
    step('a warning reaches their app live and blocks channels, DMs and groups until it is read');

    // ---------- "I understand" ----------
    r = await call('/me/warnings/ack', { method: 'POST', token: alice.token });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.modState, null);
    assert.strictEqual((await call('/me/warnings/ack', { method: 'POST', token: alice.token })).status, 200, 'pressing it twice is fine');
    assert.strictEqual((await call('/me/warnings/ack', { method: 'POST' })).status, 401, 'needs a signed-in person');
    okAll(await sendAll(alice));
    r = await call(`/admin/users/${id(alice)}`, { token: admin.token });
    assert.ok(r.user.moderation.warnings[0].seenAt, 'the admin sees that it was read');
    step('"I understand" clears the screen and sending works again');

    // ---------- escalation: the 3rd warning is a 24 hour mute ----------
    await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: admin.token, body: { reason: 'second' } });
    r = await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: admin.token, body: { reason: 'third' } });
    assert.deepStrictEqual(r.escalation, { type: 'mute', hours: 24 }, JSON.stringify(r));
    assert.ok(r.moderation.mute && r.moderation.mute.auto && Math.abs(r.moderation.mute.until - (Date.now() + 24 * 3600_000)) < 60_000);
    await call('/me/warnings/ack', { method: 'POST', token: alice.token });
    blockedAll(await sendAll(alice), /muted for 24 hours: Automatic: 3 warnings/);
    assert.ok((await call('/me', { token: alice.token })).user.modState.mute, 'the person sees why and until when');
    assert.strictEqual((await call('/admin/users?q=mod_alice', { token: admin.token })).users[0].muted, true, 'the people list shows it');
    step('the 3rd warning mutes for 24 hours; reading the warning does not lift it');

    // ---------- unmute, and a manual mute ----------
    assert.strictEqual((await call(`/admin/users/${id(alice)}/unmute`, { method: 'POST', token: admin.token })).status, 200);
    okAll(await sendAll(alice));
    assert.strictEqual((await call(`/admin/users/${id(alice)}/mute`, { method: 'POST', token: admin.token, body: { reason: '', hours: 2 } })).status, 400, 'a mute needs a reason');
    for (const hours of [0, -1, 'abc', 24 * 31, undefined]) assert.strictEqual((await call(`/admin/users/${id(alice)}/mute`, { method: 'POST', token: admin.token, body: { reason: 'x', hours } })).status, 400, 'bad hours: ' + hours);
    assert.strictEqual((await call(`/admin/users/${id(alice)}/mute`, { method: 'POST', token: admin.token, body: { reason: 'flooding', hours: 2 } })).status, 200);
    blockedAll(await sendAll(alice), /muted for 2 hours: flooding/);
    assert.strictEqual((await call(`/admin/users/${id(alice)}/unmute`, { method: 'POST', token: admin.token })).status, 200);
    step('unmute and a manual mute, with the hours checked');

    // ---------- take a warning back ----------
    const w = (await call(`/admin/users/${id(carol)}/warn`, { method: 'POST', token: admin.token, body: { reason: 'oops, wrong person' } })).moderation.warnings[0];
    assert.strictEqual((await call('/me', { token: carol.token })).user.modState.pending.length, 1);
    assert.strictEqual((await call(`/admin/users/${id(carol)}/warnings/${w.id}`, { method: 'DELETE', token: admin.token })).status, 200);
    assert.strictEqual((await call('/me', { token: carol.token })).user.modState, null, 'a warning taken back leaves their screen');
    assert.strictEqual((await call(`/admin/users/${id(carol)}/warnings/${w.id}`, { method: 'DELETE', token: admin.token })).status, 404, 'already gone');
    step('an admin can take a warning back');

    // ---------- the 5th warning is a 7 day suspension ----------
    await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: admin.token, body: { reason: 'fourth' } });
    r = await call(`/admin/users/${id(alice)}/warn`, { method: 'POST', token: admin.token, body: { reason: 'fifth' } });
    assert.deepStrictEqual(r.escalation, { type: 'suspend', hours: 168 }, JSON.stringify(r));
    assert.strictEqual((await call('/me', { token: alice.token })).status, 401, 'signed out everywhere');
    r = await call('/login', { method: 'POST', body: { username: 'mod_alice', password: 'password123' } });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.code, 'suspended');
    r = await call(`/admin/users/${id(alice)}`, { token: admin.token });
    assert.ok(Math.abs(r.user.moderation.suspendedUntil - (Date.now() + 7 * 24 * 3600_000)) < 60_000);
    assert.strictEqual((await call(`/admin/users/${id(alice)}/unsuspend`, { method: 'POST', token: admin.token })).status, 200);
    step('the 5th warning suspends for 7 days and signs them out');

    // ---------- timed suspensions and the sweep ----------
    for (const hours of [0, -5, 'abc', 24 * 366]) assert.strictEqual((await call(`/admin/users/${id(bob)}/suspend`, { method: 'POST', token: admin.token, body: { reason: 'x', hours } })).status, 400, 'bad hours: ' + hours);
    r = await call(`/admin/users/${id(bob)}/suspend`, { method: 'POST', token: admin.token, body: { reason: 'cool off', hours: 6 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(Math.abs(r.user.suspended.until - (Date.now() + 6 * 3600_000)) < 60_000);
    assert.deepStrictEqual(await moderationSweep(), { unmuted: 0, unsuspended: 0, ipBansDropped: 0 }, 'nothing is due yet');
    assert.strictEqual((await call('/me', { token: bob.token })).status, 401);
    store.db.users[id(bob)].suspended.until = Date.now() - 1000; // six hours "pass"
    await call(`/admin/users/${id(carol)}/mute`, { method: 'POST', token: admin.token, body: { reason: 'quiet please', hours: 1 } });
    store.db.users[id(carol)].mute.until = Date.now() - 1000;
    const sw = await moderationSweep();
    assert.deepStrictEqual([sw.unsuspended, sw.unmuted], [1, 1], JSON.stringify(sw));
    assert.strictEqual(store.db.users[id(bob)].suspended, undefined); assert.strictEqual(store.db.users[id(carol)].mute, undefined);
    assert.strictEqual((await call('/login', { method: 'POST', body: { username: 'mod_bob', password: 'password123' } })).status, 200, 'they can sign in again');
    r = await call(`/admin/users/${id(dan)}`, { token: admin.token });
    await call(`/admin/users/${id(dan)}/suspend`, { method: 'POST', token: admin.token, body: { reason: 'until lifted' } });
    store.db.users[id(dan)].suspended.at -= 1e9;
    assert.deepStrictEqual((await moderationSweep()).unsuspended, 0, 'a suspension without hours never ends by itself');
    assert.strictEqual((await call(`/admin/users/${id(dan)}/unsuspend`, { method: 'POST', token: admin.token })).status, 200);
    const log = (await call('/admin/log', { token: admin.token })).log.map((e) => e.action);
    for (const a of ['warn', 'mute', 'unmute', 'suspend', 'unsuspend', 'retract warning']) assert.ok(log.includes(a), 'the log has: ' + a);
    step('timed suspensions and mutes end by themselves; one without hours does not');

    // ---------- IP bans: creator accounts only ----------
    assert.strictEqual((await call('/admin/ip-bans', { token: admin.token })).status, 403, 'an admin who is not a creator');
    assert.strictEqual((await call('/admin/ip-bans', { token: carol.token })).status, 404, 'a normal person'); // (alice and dan were signed out by their suspensions above)
    r = await call('/admin/ip-bans', { token: creator.token });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.bans, []); assert.strictEqual(r.enabled, true); assert.strictEqual(r.yourIp, '127.0.0.1');
    const ban = (b) => call('/admin/ip-bans', { method: 'POST', token: creator.token, body: b });
    assert.strictEqual((await ban({ rule: '127.0.0.1', reason: 'oops' })).code, 'own_ip', 'cannot ban your own connection');
    assert.strictEqual((await ban({ rule: '127.0.0.0/24', reason: 'oops' })).code, 'own_ip', 'nor a range that contains it');
    assert.strictEqual((await ban({ rule: 'not an address', reason: 'x' })).status, 400);
    assert.strictEqual((await ban({ rule: '203.0.113.9', reason: '' })).status, 400, 'needs a reason');
    assert.strictEqual((await ban({ rule: '203.0.0.0/8', reason: 'x' })).code, 'large_range', 'a wide range needs a second confirmation');
    assert.strictEqual((await ban({ rule: '0.0.0.0/0', reason: 'x', confirmLarge: true })).status, 400, 'never everybody');
    r = await ban({ rule: '203.0.113.0/24', reason: 'scraper', hours: 5 });
    assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.bans.length, 1); assert.strictEqual(r.bans[0].by, 'mod_creator');
    assert.ok((await store.getMeta('ipbans')).includes('203.0.113.0/24'), 'saved, so a restart keeps it');
    const from = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
    r = await call('/me', { token: carol.token, ...from('203.0.113.77') });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.code, 'ip_banned');
    assert.strictEqual((await fetch(base + '/', { headers: { 'X-Forwarded-For': '203.0.113.77' } })).status, 403, 'pages too');
    assert.strictEqual((await call('/me', { token: carol.token, ...from('203.0.114.1') })).status, 200, 'next door is fine');
    assert.strictEqual((await fetch(base + '/healthz', { headers: { 'X-Forwarded-For': '203.0.113.77' } })).status, 200, 'the host health check is never blocked');
    const blocked = connect(base, { auth: { token: carol.token }, extraHeaders: { origin: base, 'X-Forwarded-For': '203.0.113.77' } });
    assert.strictEqual((await once(blocked, 'connect_error')).message, 'blocked', 'no live connection either'); blocked.close();
    step('a banned range blocks pages, the API and live connections, and nothing else');

    process.env.IP_BAN = 'off';
    assert.strictEqual((await call('/me', { token: carol.token, ...from('203.0.113.77') })).status, 200, 'IP_BAN=off is the way back in');
    assert.strictEqual((await call('/admin/ip-bans', { token: creator.token })).enabled, false);
    delete process.env.IP_BAN;
    assert.strictEqual((await call('/me', { token: carol.token, ...from('203.0.113.77') })).status, 403);
    const banId = (await call('/admin/ip-bans', { token: creator.token })).bans[0].id;
    assert.strictEqual((await call('/admin/ip-bans/nope', { method: 'DELETE', token: creator.token })).status, 404);
    assert.strictEqual((await call('/admin/ip-bans/' + banId, { method: 'DELETE', token: admin.token })).status, 403, 'only a creator lifts it');
    r = await call('/admin/ip-bans/' + banId, { method: 'DELETE', token: creator.token });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.bans, []);
    assert.strictEqual((await call('/me', { token: carol.token, ...from('203.0.113.77') })).status, 200, 'lifted');
    assert.ok(!(await store.getMeta('ipbans')).includes('203.0.113'), 'and the saved list follows');
    const logs = (await call('/admin/log', { token: admin.token })).log.map((e) => e.action);
    assert.ok(logs.includes('ip ban') && logs.includes('lift ip ban'));
    step('the kill switch, lifting a ban, and the log');

    console.log('\nmoderation-flow-test: all passed');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; } finally { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); }
}));
