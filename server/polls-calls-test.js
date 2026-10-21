// Polls in channels and call history in DMs, end to end (needs TEST_DATABASE_URL like the other DB tests): node server/polls-calls-test.js
const assert = require('assert');
const { rawDb, cleanup } = require('./test-env');
process.env.CALL_RING_MS = '600';
const { httpServer, ready } = require('./index');
const { io: connect } = require('socket.io-client');
const store = require('./db');

const blob = { salt: 'a', iv: 'b', data: 'c' };
let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const once = (s, ev, ms = 3000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timed out waiting for ' + ev)), ms); s.once(ev, (x) => { clearTimeout(t); res(x); }); });
const ack = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const step = (m) => console.log('✓', m);
const reg = async (u) => { const r = await call('/register', { method: 'POST', body: { username: u, email: u + '@example.com', password: 'password123', publicKey: 'pk' + u, encPrivKey: blob } }); assert.strictEqual(r.status, 200, 'register ' + u); return r; };
// the server allows 8 socket events per 5 s per connection, so each section takes fresh connections
const sock = async (token) => { const s = connect(base, { auth: { token }, extraHeaders: { origin: base } }); await once(s, 'connect'); return s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// a connection that swaps itself for a fresh one every 6 events, to stay under that limit when a section fires many
const roller = async (token) => { let s = await sock(token), n = 0; return { ack: async (ev, p) => { if (n++ >= 6) { s.close(); s = await sock(token); n = 1; } return ack(s, ev, p); }, close: () => s.close() }; };

ready.then(() => httpServer.listen(0, async () => {
  try {
    base = 'http://127.0.0.1:' + httpServer.address().port;
    const alice = await reg('pc_alice'), bob = await reg('pc_bob'), carol = await reg('pc_carol');
    const sv = await call('/servers', { method: 'POST', token: alice.token, body: { name: 'Polls' } });
    const chan = sv.server.channels[0].id;
    await call('/servers/join', { method: 'POST', token: bob.token, body: { code: sv.server.inviteCode } });
    const ann = await call('/servers/' + sv.server.id + '/channels', { method: 'POST', token: alice.token, body: { name: 'news', type: 'announcements' } });
    assert.strictEqual(ann.status, 200);
    const annId = ann.channel ? ann.channel.id : ann.server.channels.find((c) => c.type === 'announcements').id;

    // ================= polls =================
    let sa = await sock(alice.token), sb = await sock(bob.token), sc = await sock(carol.token);
    const newMsg = once(sb, 'message:new');
    let r = await ack(sa, 'message:send', { channelId: chan, content: '', poll: { question: ' Pizza  tonight? ', options: ['Yes', 'No', '  '], multi: false } });
    assert.deepStrictEqual(r, { ok: true }, 'a poll can be sent with no text');
    const m1 = await newMsg;
    assert.ok(m1.poll && m1.poll.question === 'Pizza tonight?' && m1.poll.options.length === 2 && m1.poll.closesAt === null && m1.poll.closed === false);
    assert.deepStrictEqual(m1.poll.options.map((o) => o.votes), [[], []]);
    const hist = await call(`/channels/${chan}/messages`, { token: bob.token });
    assert.deepStrictEqual(hist.messages.find((m) => m.id === m1.id).poll, m1.poll, 'history carries the poll');
    step('a poll is posted with no text, cleaned by the server, delivered live and in history');

    // voting
    let upd = once(sa, 'poll:update');
    assert.deepStrictEqual(await ack(sb, 'poll:vote', { messageId: m1.id, options: ['o0'] }), { ok: true });
    let u = await upd; assert.strictEqual(u.messageId, m1.id); assert.strictEqual(u.channelId, chan);
    assert.deepStrictEqual(u.poll.options.map((o) => o.votes), [[bob.user.id], []], 'everyone in the channel sees the new tally');
    upd = once(sa, 'poll:update'); await ack(sb, 'poll:vote', { messageId: m1.id, options: ['o1'] }); u = await upd;
    assert.deepStrictEqual(u.poll.options.map((o) => o.votes), [[], [bob.user.id]], 'changing the vote moves it');
    upd = once(sa, 'poll:update'); await ack(sb, 'poll:vote', { messageId: m1.id, options: [] }); u = await upd;
    assert.deepStrictEqual(u.poll.options.map((o) => o.votes), [[], []], 'an empty list takes it back');
    assert.ok((await ack(sb, 'poll:vote', { messageId: m1.id, options: ['o0', 'o1'] })).error, 'single choice takes one');
    assert.ok((await ack(sb, 'poll:vote', { messageId: m1.id, options: ['zzz'] })).error, 'unknown option');
    assert.deepStrictEqual(store.db.messages[m1.id].poll.options.map((o) => o.votes), [[], []], 'refused votes change nothing');
    step('voting: tallies reach the channel live, change, take back, refused votes change nothing');

    // who may vote
    assert.strictEqual((await ack(sc, 'poll:vote', { messageId: m1.id, options: ['o0'] })).error, 'Forbidden', 'a non-member cannot vote');
    const plain = await ack(sa, 'message:send', { channelId: chan, content: 'just text' });
    assert.ok(plain.ok);
    const textMsg = Object.values(store.db.messages).find((m) => m.content === 'just text');
    assert.strictEqual((await ack(sb, 'poll:vote', { messageId: textMsg.id, options: ['o0'] })).error, 'Forbidden', 'a message without a poll');
    sa.close(); sb.close(); sc.close();
    const rbob = await roller(bob.token);
    for (const id of ['nope', '__proto__', 'constructor', 5, null, {}, undefined]) assert.ok((await rbob.ack('poll:vote', { messageId: id, options: ['o0'] })).error, 'refused id ' + JSON.stringify(id));
    rbob.close();
    step('only members can vote, and only on real polls');

    // bad polls
    const ra0 = await roller(alice.token);
    const bad = (poll) => ra0.ack('message:send', { channelId: chan, content: '', poll });
    const before = Object.keys(store.db.messages).length;
    for (const poll of ['x', 5, [], { options: ['a', 'b'] }, { question: 'q', options: ['only'] }, { question: 'q', options: ['a', 'A'] }, { question: 'q', options: Array.from({ length: 11 }, (_, i) => 'o' + i) }, { question: 'q', options: ['a', 'b'], hours: 0 }, { question: 'x'.repeat(301), options: ['a', 'b'] }]) {
      assert.ok((await bad(poll)).error, 'refused: ' + JSON.stringify(poll).slice(0, 60));
    }
    assert.strictEqual(Object.keys(store.db.messages).length, before, 'refused polls leave no message behind');
    assert.ok((await ra0.ack('message:send', { channelId: annId, content: '', poll: { question: 'q', options: ['a', 'b'] } })).error, 'polls are for text channels, not announcements');
    assert.ok((await ra0.ack('message:send', { channelId: chan, content: '' })).error, 'an empty message without a poll is still refused');
    step('malformed polls are refused and leave nothing behind; announcements cannot hold a poll');
    ra0.close();

    // multiple choice + timed + ending
    sa = await sock(alice.token); sb = await sock(bob.token);
    const mm = once(sb, 'message:new');
    await ack(sa, 'message:send', { channelId: chan, content: 'Pick any', poll: { question: 'Toppings?', options: ['Ham', 'Olives', 'Pineapple'], multi: true, hours: 1 } });
    const m2 = await mm; assert.strictEqual(m2.content, 'Pick any'); assert.ok(m2.poll.multi);
    assert.ok(Math.abs(m2.poll.closesAt - (Date.now() + 3600_000)) < 60_000, 'closes in about an hour');
    assert.ok((await ack(sb, 'poll:vote', { messageId: m2.id, options: ['o0', 'o2'] })).ok, 'multiple choice takes several');
    assert.deepStrictEqual(store.db.messages[m2.id].poll.options.map((o) => o.votes.length), [1, 0, 1]);
    store.db.messages[m2.id].poll.closesAt = Date.now() - 1; // time is up
    assert.strictEqual((await ack(sb, 'poll:vote', { messageId: m2.id, options: ['o1'] })).error, 'This poll has ended', 'no votes after the time is up');
    assert.deepStrictEqual(store.db.messages[m2.id].poll.options.map((o) => o.votes.length), [1, 0, 1], 'results are frozen');
    step('multiple choice, a time limit that is enforced on the server');

    const m3p = once(sb, 'message:new');
    await ack(sa, 'message:send', { channelId: chan, content: '', poll: { question: 'Close me', options: ['a', 'b'] } });
    const m3 = await m3p;
    assert.strictEqual((await ack(sb, 'poll:close', { messageId: m3.id })).error, 'Forbidden', 'a member who did not post it (and cannot manage messages) cannot end it');
    const closed = once(sb, 'poll:update');
    assert.ok((await ack(sa, 'poll:close', { messageId: m3.id })).ok, 'the author can end it');
    const cu = await closed; assert.strictEqual(cu.poll.closed, true); assert.strictEqual(cu.poll.closedBy, alice.user.id);
    assert.strictEqual((await ack(sb, 'poll:vote', { messageId: m3.id, options: ['o0'] })).error, 'This poll has ended');
    assert.ok((await ack(sa, 'poll:close', { messageId: m3.id })).error, 'cannot end twice');
    // the server owner may end someone else's poll
    const m4p = once(sa, 'message:new');
    await ack(sb, 'message:send', { channelId: chan, content: '', poll: { question: "Bob's poll", options: ['a', 'b'] } });
    const m4 = await m4p;
    assert.ok((await ack(sa, 'poll:close', { messageId: m4.id })).ok, 'someone who can manage messages (the owner) may end any poll');
    step('ending a poll: author or message managers only; no votes afterwards; once');

    // editing and deleting a poll message (fresh connections: the earlier ones are near the per-connection event limit)
    sa.close(); sb.close(); sa = await sock(alice.token); sb = await sock(bob.token);
    assert.ok((await ack(sb, 'message:edit', { kind: 'channel', messageId: m4.id, content: 'with a note' })).ok);
    assert.ok((await ack(sb, 'message:edit', { kind: 'channel', messageId: m4.id, content: '' })).ok, 'a poll message may have empty text');
    assert.strictEqual(store.db.messages[m4.id].poll.question, "Bob's poll", 'editing the text never touches the poll');
    assert.ok((await ack(sb, 'message:edit', { kind: 'channel', messageId: textMsg.id, content: 'x' })).error, 'not your message');
    await store.flush();
    assert.ok((await ack(sb, 'message:delete', { kind: 'channel', messageId: m4.id })).ok);
    assert.strictEqual((await ack(sa, 'poll:vote', { messageId: m4.id, options: ['o0'] })).error, 'Forbidden', 'a deleted poll is gone');
    step('a poll message can be edited (text only) and deleted');
    sa.close(); sb.close();

    // ================= call history =================
    await call('/friends/request', { method: 'POST', token: alice.token, body: { username: 'pc_bob' } });
    assert.strictEqual((await call(`/friends/${alice.user.id}/accept`, { method: 'POST', token: bob.token })).status, 200);
    await call('/friends/request', { method: 'POST', token: carol.token, body: { username: 'pc_bob' } });
    assert.strictEqual((await call(`/friends/${carol.user.id}/accept`, { method: 'POST', token: bob.token })).status, 200);
    const ids = [alice.user.id, bob.user.id].sort().join(':');
    const callsOf = async (tok, other) => (await call(`/dms/${other}/calls`, { token: tok })).calls;
    assert.deepStrictEqual(await callsOf(alice.token, bob.user.id), [], 'no calls yet');

    // answered, hung up by the caller
    let ca = await sock(alice.token), cb = await sock(bob.token);
    let inc = once(cb, 'call:incoming');
    const inv = await ack(ca, 'call:invite', { to: bob.user.id, video: true }); assert.ok(inv.ok);
    await inc;
    const accepted = once(ca, 'call:accepted');
    assert.ok((await ack(cb, 'call:accept', { callId: inv.callId })).ok); await accepted;
    await sleep(1200);
    const logA = once(ca, 'call:log'), logB = once(cb, 'call:log');
    await ack(ca, 'call:hangup', { callId: inv.callId });
    const [ra, rb] = await Promise.all([logA, logB]);
    assert.deepStrictEqual(ra, rb, 'both people get the same record, live');
    assert.deepStrictEqual(Object.keys(ra).sort(), ['a', 'answeredAt', 'b', 'convo', 'endedAt', 'id', 'outcome', 'seconds', 'startedAt', 'video'], 'only call metadata, nothing else');
    assert.strictEqual(ra.outcome, 'completed'); assert.strictEqual(ra.video, true); assert.strictEqual(ra.a, alice.user.id); assert.strictEqual(ra.b, bob.user.id);
    assert.ok(ra.seconds >= 1 && ra.seconds <= 4, 'length measured from pick-up, got ' + ra.seconds);
    assert.ok(ra.startedAt <= ra.answeredAt && ra.answeredAt < ra.endedAt);
    assert.deepStrictEqual(await callsOf(alice.token, bob.user.id), [ra]); assert.deepStrictEqual(await callsOf(bob.token, alice.user.id), [ra], 'the same history from either side');
    step('an answered call is logged for both people with its length, live and through the history route');

    // declined
    inc = once(cb, 'call:incoming'); const inv2 = await ack(ca, 'call:invite', { to: bob.user.id }); await inc;
    let l = once(ca, 'call:log'); await ack(cb, 'call:decline', { callId: inv2.callId }); let rec = await l;
    assert.strictEqual(rec.outcome, 'declined'); assert.strictEqual(rec.video, false); assert.strictEqual(rec.seconds, 0); assert.strictEqual(rec.answeredAt, null);
    // cancelled by the caller while ringing
    inc = once(cb, 'call:incoming'); const inv3 = await ack(ca, 'call:invite', { to: bob.user.id }); await inc;
    l = once(cb, 'call:log'); await ack(ca, 'call:hangup', { callId: inv3.callId }); rec = await l;
    assert.strictEqual(rec.outcome, 'cancelled');
    step('declined and cancelled calls are logged');
    ca.close(); cb.close(); await sleep(200); // let the server see the disconnects before the next section counts connections

    // nobody picks up
    ca = await sock(alice.token); cb = await sock(bob.token);
    inc = once(cb, 'call:incoming'); await ack(ca, 'call:invite', { to: bob.user.id }); await inc;
    l = once(cb, 'call:log', 3000); rec = await l;
    assert.strictEqual(rec.outcome, 'missed', 'ring timeout (600 ms in tests) is a missed call');
    // the caller loses connection while it rings
    inc = once(cb, 'call:incoming'); await ack(ca, 'call:invite', { to: bob.user.id }); await inc;
    l = once(cb, 'call:log'); ca.close(); rec = await l;
    assert.strictEqual(rec.outcome, 'cancelled', 'the caller vanishing while it rings counts as cancelled');
    // a connection that drops mid-call is still a call that happened
    await sleep(200); ca = await sock(alice.token);
    inc = once(cb, 'call:incoming'); const inv5 = await ack(ca, 'call:invite', { to: bob.user.id }); await inc;
    const acc5 = once(ca, 'call:accepted'); await ack(cb, 'call:accept', { callId: inv5.callId }); await acc5;
    l = once(cb, 'call:log'); ca.close(); rec = await l;
    assert.strictEqual(rec.outcome, 'completed');
    step('missed, caller-vanished and dropped-mid-call calls are logged correctly');
    cb.close();

    // order, isolation, access
    const list = await callsOf(alice.token, bob.user.id);
    assert.deepStrictEqual(list.map((x) => x.outcome), ['completed', 'declined', 'cancelled', 'missed', 'cancelled', 'completed']);
    assert.ok(list.every((x, i) => i === 0 || list[i - 1].endedAt <= x.endedAt), 'oldest first');
    assert.deepStrictEqual(await callsOf(carol.token, bob.user.id), [], "a call between two people is not in anyone else's history with them");
    assert.deepStrictEqual(await callsOf(carol.token, alice.user.id), []);
    assert.strictEqual((await call('/dms/nobody-here/calls', { token: alice.token })).status, 404);
    assert.strictEqual((await call(`/dms/${bob.user.id}/calls`)).status, 401, 'login required');
    step('history is oldest-first, private to the two people, and needs a login');

    // pruning and storage
    for (let i = 0; i < 205; i++) store.db.calllog['fake' + i] = { id: 'fake' + i, convo: ids, a: alice.user.id, b: bob.user.id, video: false, outcome: 'missed', startedAt: i, answeredAt: null, endedAt: i + 1, seconds: 0 };
    ca = await sock(alice.token); cb = await sock(bob.token);
    inc = once(cb, 'call:incoming'); await ack(ca, 'call:invite', { to: bob.user.id }); await inc;
    l = once(cb, 'call:log'); await l;
    const kept = Object.values(store.db.calllog).filter((x) => x.convo === ids);
    assert.strictEqual(kept.length, 200, 'a conversation keeps its newest 200 records');
    assert.ok(!store.db.calllog.fake0 && store.db.calllog.fake204, 'the oldest are dropped first');
    ca.close(); cb.close();
    await store.flush();
    assert.ok(!(await rawDb()).includes('"outcome"'), 'call records are sealed in the database like everything else');
    step('call history is capped per conversation and encrypted at rest');

    console.log('\npolls-calls-test: all passed');
    await cleanup(); process.exit(0);
  } catch (e) { console.error(e); await cleanup(); process.exit(1); }
}));
