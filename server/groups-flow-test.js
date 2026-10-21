// Encrypted group chats and group calls end to end (needs TEST_DATABASE_URL like the other DB tests): node server/groups-flow-test.js
// The server never opens a wrap or a message, so the test uses opaque base64 strings where a browser would put real ciphertext.
const assert = require('assert');
const { rawDb, cleanup } = require('./test-env');
process.env.CALL_RING_MS = '8000';
const { httpServer, ready } = require('./index');
const { io: connect } = require('socket.io-client');
const store = require('./db');

const blob = { salt: 'a', iv: 'b', data: 'c' };
let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const once = (s, ev, ms = 15000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timed out waiting for ' + ev)), ms); s.once(ev, (x) => { clearTimeout(t); res(x); }); });
const quiet = (s, ev, ms = 400) => new Promise((res, rej) => { const f = () => rej(new Error('unexpected ' + ev)); s.once(ev, f); setTimeout(() => { s.off(ev, f); res(); }, ms); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the server allows 8 acknowledged events per 5 s per connection: wait when a connection has used 7
const sent = new WeakMap();
const ack = async (s, ev, p) => {
  let arr = (sent.get(s) || []).filter((t) => Date.now() - t < 5000);
  if (arr.length >= 7) { await sleep(5000 - (Date.now() - arr[0]) + 100); arr = arr.filter((t) => Date.now() - t < 5000); }
  arr.push(Date.now()); sent.set(s, arr);
  return new Promise((res) => s.emit(ev, p, res));
};
const step = (m) => console.log('✓', m);
const reg = async (u) => { const r = await call('/register', { method: 'POST', body: { username: u, email: u + '@example.com', password: 'password123', publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x' + u, y: 'y' + u }), encPrivKey: blob } }); assert.strictEqual(r.status, 200, 'register ' + u); return r; };
const sock = async (token) => { const s = connect(base, { auth: { token }, extraHeaders: { origin: base } }); await once(s, 'connect'); return s; };
const roller = async (token) => { let s = await sock(token), n = 0; return { get raw() { return s; }, ack: async (ev, p) => { if (n++ >= 6) { s.close(); s = await sock(token); n = 1; } return ack(s, ev, p); }, close: () => s.close() }; };
const befriend = async (a, b) => {
  const r = await call('/friends/request', { method: 'POST', token: a.token, body: { username: b.user.username } }); assert.strictEqual(r.status, 200, 'friend request');
  assert.strictEqual((await call(`/friends/${a.user.id}/accept`, { method: 'POST', token: b.token })).status, 200, 'accept');
};
const wrap = (tag) => ({ ciphertext: Buffer.from('wrapped-' + tag).toString('base64'), iv: 'aXYxMjM0NTY3OA==', pk: 'fp' + tag });
const wraps = (ids, tag = 'k') => Object.fromEntries(ids.map((id) => [id, wrap(tag + id.slice(0, 4))]));
const nameEnc = (t) => ({ ciphertext: Buffer.from('name-' + t).toString('base64'), iv: 'aXYxMjM0NTY3OA==' });
const ct = (t) => ({ ciphertext: Buffer.from('msg-' + t).toString('base64'), iv: 'aXYxMjM0NTY3OA==' });

ready.then(() => httpServer.listen(0, async () => {
  try {
    base = 'http://127.0.0.1:' + httpServer.address().port;
    const A = await reg('gf_alice'), B = await reg('gf_bob'), C = await reg('gf_carol'), D = await reg('gf_dave'), E = await reg('gf_erin');
    const id = (x) => x.user.id;
    await befriend(A, B); await befriend(A, C); await befriend(A, D); await befriend(B, D);

    // ================= creating =================
    const mk = (who, members, extra = {}) => call('/groups', { method: 'POST', token: who.token, body: { members, nameEnc: nameEnc('Trip'), wraps: wraps([id(who), ...members]), ...extra } });
    assert.strictEqual((await mk(A, [id(B)])).status, 400, 'two people is a DM, not a group');
    assert.strictEqual((await mk(A, [id(B), id(E)])).status, 400, 'only friends can be added');
    assert.strictEqual((await mk(A, [id(B), id(B)])).status, 400, 'duplicates');
    assert.strictEqual((await mk(A, [id(B), id(A)])).status, 400, 'not yourself');
    assert.strictEqual((await mk(A, [id(B), id(C)], { wraps: wraps([id(A), id(B)]) })).status, 400, 'wraps must cover everyone');
    assert.strictEqual((await mk(A, [id(B), id(C)], { nameEnc: { ciphertext: 'My Trip!', iv: 'x' } })).status, 400, 'a name that is not base64 is refused');
    assert.strictEqual((await call('/groups', { method: 'POST', body: {} })).status, 401);
    const sa0 = await sock(A.token), sb0 = await sock(B.token), sd0 = await sock(D.token);
    const gotB = once(sb0, 'group:update');
    let r = await mk(A, [id(B), id(C)]);
    assert.strictEqual(r.status, 200); const G = r.group.id;
    assert.deepStrictEqual(r.group.members.map((m) => m.id).sort(), [id(A), id(B), id(C)].sort());
    assert.strictEqual(r.group.epoch, 1); assert.strictEqual(r.group.ownerId, id(A));
    const upd = await gotB;
    assert.strictEqual(upd.id, G, 'members hear about a new group live');
    assert.deepStrictEqual(Object.keys(upd.keys), ['1']); assert.deepStrictEqual(upd.keys[1].wrap, wrap('k' + id(B).slice(0, 4)), 'each person receives their own wrap only');
    assert.ok(!JSON.stringify(upd).includes(wrap('k' + id(C).slice(0, 4)).ciphertext), 'and never another member\'s');
    assert.strictEqual(upd.keys[1].by, id(A));
    assert.strictEqual(upd.keys[1].byKey, A.user.publicKey, 'the wrapper\'s public key is included so the wrap can be opened later');
    step('a group is created by a member with friends only; each member gets only their own wrap, live');

    // visibility
    assert.strictEqual((await call('/groups/' + G, { token: D.token })).status, 404, 'a non-member cannot even see that it exists');
    assert.strictEqual((await call(`/groups/${G}/messages`, { token: D.token })).status, 404);
    assert.strictEqual((await call('/groups', { token: D.token })).groups.length, 0);
    assert.strictEqual((await call('/groups', { token: B.token })).groups.length, 1);
    step('non-members cannot see the group or its messages');

    // ================= messages =================
    const sc0 = await sock(C.token);
    let m = once(sb0, 'group:message'), m2 = once(sc0, 'group:message');
    r = await ack(sa0, 'group:send', { groupId: G, ...ct('hello'), epoch: 1 });
    assert.deepStrictEqual(r, { ok: true });
    const msg1 = await m; await m2;
    assert.strictEqual(msg1.from, id(A)); assert.strictEqual(msg1.epoch, 1); assert.strictEqual(msg1.group, G);
    assert.strictEqual(Buffer.from(msg1.ciphertext, 'base64').toString(), 'msg-hello', 'the server just relays what it was given');
    await quiet(sd0, 'group:message');
    assert.ok((await ack(sd0, 'group:send', { groupId: G, ...ct('x'), epoch: 1 })).error, 'a non-member cannot send');
    assert.strictEqual((await ack(sa0, 'group:send', { groupId: G, ...ct('stale'), epoch: 7 })).error, 'This group just changed. Try again.', 'a message sealed with the wrong epoch is refused');
    assert.ok((await ack(sa0, 'group:send', { groupId: G, ciphertext: '', iv: 'x', epoch: 1 })).error);
    assert.ok((await ack(sa0, 'group:send', { groupId: G, ciphertext: 'x'.repeat(13000), iv: 'x', epoch: 1 })).error);
    assert.ok((await ack(sa0, 'group:send', { groupId: { $ne: 1 }, ...ct('x'), epoch: 1 })).error, 'hostile id');
    const hist = await call(`/groups/${G}/messages`, { token: C.token });
    assert.deepStrictEqual(hist.messages.map((x) => x.id), [msg1.id]);
    step('messages: relayed to members only, epoch must be current, bad payloads refused, history for members');

    // reply, reaction, edit, delete
    const sb = await roller(B.token);
    m = once(sa0, 'group:message');
    await sb.ack('group:send', { groupId: G, ...ct('re'), epoch: 1, replyTo: msg1.id });
    const reply = await m; assert.strictEqual(reply.replyTo, msg1.id);
    let ru = once(sa0, 'reaction:update');
    assert.deepStrictEqual(await sb.ack('reaction:toggle', { kind: 'group', messageId: msg1.id, emoji: '👍' }), { ok: true });
    const rx = await ru; assert.strictEqual(rx.kind, 'group'); assert.deepStrictEqual(rx.reactions['👍'], [id(B)]);
    assert.strictEqual((await ack(sd0, 'reaction:toggle', { kind: 'group', messageId: msg1.id, emoji: '👍' })).error, 'Forbidden', 'outsiders cannot react');
    const ed = once(sb0, 'message:edited');
    assert.deepStrictEqual(await ack(sa0, 'message:edit', { kind: 'group', messageId: msg1.id, ...ct('hello2'), epoch: 1 }), { ok: true });
    const edited = await ed; assert.strictEqual(edited.kind, 'group'); assert.ok(edited.message.editedAt);
    assert.strictEqual((await sb.ack('message:edit', { kind: 'group', messageId: msg1.id, ...ct('hax'), epoch: 1 })).error, 'Forbidden', 'only the author edits');
    assert.ok((await ack(sa0, 'message:edit', { kind: 'group', messageId: msg1.id, ...ct('x'), epoch: 2 })).error, 'an edit keeps the epoch the message was written with');
    assert.strictEqual((await sb.ack('message:delete', { kind: 'group', messageId: msg1.id })).error, 'Forbidden', 'only the author deletes');
    const del = once(sb0, 'message:deleted');
    assert.deepStrictEqual(await ack(sa0, 'message:delete', { kind: 'group', messageId: msg1.id }), { ok: true });
    const dd = await del; assert.deepStrictEqual([dd.kind, dd.messageId, dd.groupId], ['group', msg1.id, G]);
    step('replies, reactions, edits (author, same epoch) and deletes (author) work for members only');

    // files
    const up = await fetch(base + `/api/files?kind=group&target=${G}`, { method: 'POST', headers: { Authorization: 'Bearer ' + A.token, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('sealed-bytes-from-the-browser') });
    assert.strictEqual(up.status, 200); const fileId = (await up.json()).id;
    const upOut = await fetch(base + `/api/files?kind=group&target=${G}`, { method: 'POST', headers: { Authorization: 'Bearer ' + D.token, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') });
    assert.strictEqual(upOut.status, 403, 'outsiders cannot upload into a group');
    assert.strictEqual((await fetch(base + '/api/files/' + fileId, { headers: { Authorization: 'Bearer ' + C.token } })).status, 404, 'not attached yet: only the uploader can read it');
    m = once(sc0, 'group:message');
    assert.deepStrictEqual(await ack(sa0, 'group:send', { groupId: G, ...ct('file'), epoch: 1, files: [fileId] }), { ok: true });
    const fm = await m; assert.deepStrictEqual(fm.files, [fileId]);
    assert.strictEqual((await fetch(base + '/api/files/' + fileId, { headers: { Authorization: 'Bearer ' + C.token } })).status, 200, 'members can read attached files');
    assert.strictEqual((await fetch(base + '/api/files/' + fileId, { headers: { Authorization: 'Bearer ' + D.token } })).status, 404, 'outsiders cannot');
    assert.ok((await ack(sa0, 'group:send', { groupId: G, ...ct('again'), epoch: 1, files: [fileId] })).error, 'a file can only be used once');
    step('files: group uploads, members read, outsiders do not');

    // ================= membership =================
    // add Dave (A's friend): epoch 2
    assert.strictEqual((await call(`/groups/${G}/members`, { method: 'POST', token: B.token, body: { add: [id(E)], baseEpoch: 1, nameEnc: nameEnc('T'), wraps: wraps([id(A), id(B), id(C), id(E)]) } })).status, 400, 'you can only add your own friends');
    assert.strictEqual((await call(`/groups/${G}/members`, { method: 'POST', token: A.token, body: { add: [id(D)], baseEpoch: 0, nameEnc: nameEnc('T'), wraps: wraps([id(A), id(B), id(C), id(D)]) } })).status, 409, 'a stale view is refused');
    assert.strictEqual((await call(`/groups/${G}/members`, { method: 'POST', token: A.token, body: { add: [id(D)], baseEpoch: 1, nameEnc: nameEnc('T'), wraps: wraps([id(A), id(B), id(C)]) } })).status, 400, 'wraps must include the newcomer');
    assert.strictEqual((await call(`/groups/${G}/members`, { method: 'POST', token: A.token, body: { add: [id(B)], baseEpoch: 1, nameEnc: nameEnc('T'), wraps: wraps([id(A), id(B), id(C)]) } })).status, 400, 'already a member');
    const dUpd = once(sd0, 'group:update');
    r = await call(`/groups/${G}/members`, { method: 'POST', token: A.token, body: { add: [id(D)], baseEpoch: 1, nameEnc: nameEnc('T2'), wraps: wraps([id(A), id(B), id(C), id(D)], 'e2') } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.group.epoch, 2); assert.strictEqual(r.group.nameEnc.epoch, 2);
    const dv = await dUpd;
    assert.deepStrictEqual(Object.keys(dv.keys), ['2'], 'the newcomer has no key for what was said before they came');
    const dHist = await call(`/groups/${G}/messages`, { token: D.token });
    assert.ok(dHist.messages.every((x) => x.epoch === 1), 'old messages are still sealed with an epoch the newcomer cannot open');
    assert.deepStrictEqual(Object.keys((await call('/groups/' + G, { token: B.token })).group.keys).sort(), ['1', '2'], 'existing members keep both');
    assert.strictEqual((await ack(sa0, 'group:send', { groupId: G, ...ct('old'), epoch: 1 })).error, 'This group just changed. Try again.');
    assert.deepStrictEqual(await ack(sa0, 'group:send', { groupId: G, ...ct('new'), epoch: 2 }), { ok: true });
    step('adding someone starts a new epoch: the newcomer reads only what comes after');

    // rename (current epoch only)
    assert.strictEqual((await call('/groups/' + G, { method: 'PATCH', token: D.token, body: { epoch: 1, nameEnc: nameEnc('x') } })).status, 409);
    r = await call('/groups/' + G, { method: 'PATCH', token: D.token, body: { epoch: 2, nameEnc: nameEnc('Renamed') } });
    assert.strictEqual(r.status, 200); assert.strictEqual(Buffer.from(r.group.nameEnc.ciphertext, 'base64').toString(), 'name-Renamed');
    assert.strictEqual((await call('/groups/' + G, { method: 'PATCH', token: E.token, body: { epoch: 2, nameEnc: nameEnc('x') } })).status, 404);
    step('rename works for members at the current epoch');

    // kick: owner only
    assert.strictEqual((await call(`/groups/${G}/kick`, { method: 'POST', token: B.token, body: { userId: id(C), baseEpoch: 2, nameEnc: nameEnc('K'), wraps: wraps([id(A), id(B), id(D)]) } })).status, 403, 'only the owner removes people');
    assert.strictEqual((await call(`/groups/${G}/kick`, { method: 'POST', token: A.token, body: { userId: id(A), baseEpoch: 2, nameEnc: nameEnc('K'), wraps: wraps([id(B), id(C), id(D)]) } })).status, 403, 'not yourself (leave instead)');
    const gone = once(sc0, 'group:removed');
    r = await call(`/groups/${G}/kick`, { method: 'POST', token: A.token, body: { userId: id(C), baseEpoch: 2, nameEnc: nameEnc('K'), wraps: wraps([id(A), id(B), id(D)], 'e3') } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.group.epoch, 3);
    assert.strictEqual((await gone).groupId, G, 'the removed person is told');
    assert.strictEqual((await call('/groups/' + G, { token: C.token })).status, 404);
    assert.strictEqual((await call(`/groups/${G}/messages`, { token: C.token })).status, 404);
    for (const k of Object.values(store.db.groups[G].keys)) assert.ok(!(id(C) in k.wraps), 'no wrap for the removed member is kept in any epoch');
    const sa = await roller(A.token);
    m = once(sb0, 'group:message');
    assert.deepStrictEqual(await sa.ack('group:send', { groupId: G, ...ct('secret'), epoch: 3 }), { ok: true }); await m;
    await quiet(sc0, 'group:message');
    assert.ok((await ack(sc0, 'group:send', { groupId: G, ...ct('x'), epoch: 3 })).error, 'the removed member cannot send');
    step('removing someone: owner only, new epoch without them, they lose access and every wrap');

    // rekey (same people, new key)
    r = await call(`/groups/${G}/rekey`, { method: 'POST', token: D.token, body: { baseEpoch: 3, nameEnc: nameEnc('R'), wraps: wraps([id(A), id(B), id(D)], 'e4') } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.group.epoch, 4); assert.deepStrictEqual(r.group.members.map((x) => x.id).sort(), [id(A), id(B), id(D)].sort());
    assert.strictEqual((await call(`/groups/${G}/rekey`, { method: 'POST', token: C.token, body: { baseEpoch: 4, nameEnc: nameEnc('R'), wraps: wraps([id(A), id(B), id(D)]) } })).status, 404);
    step('a member can refresh the key for the same people');

    // ================= calls =================
    const sd = await roller(D.token);
    const incB = once(sb0, 'gcall:incoming'), stateA = once(sa0, 'group:call');
    r = await ack(sa0, 'gcall:join', { groupId: G, video: false });
    assert.ok(r.ok && r.callId && r.peers.length === 0 && r.video === false);
    const inc = await incB; assert.deepStrictEqual([inc.groupId, inc.from, inc.video, inc.callId], [G, id(A), false, r.callId]);
    const st = await stateA; assert.deepStrictEqual(st.call.users, [id(A)]);
    assert.strictEqual((await call('/groups/' + G, { token: B.token })).group.call.users[0], id(A), 'the group view says a call is running');
    step('starting a call rings the other members and tells the group');

    assert.ok((await ack(sc0, 'gcall:join', { groupId: G })).error, 'the removed member cannot join');
    const incLate = await (async () => { const s = connect(base, { auth: { token: B.token }, extraHeaders: { origin: base } }); const p = once(s, 'gcall:incoming'); const v = await p; s.close(); return v; })(); // a real client listens before it connects
    assert.strictEqual(incLate.groupId, G, 'a device that connects while the call is still ringing is rung too');
    const joinB = await ack(sb0, 'gcall:join', { groupId: G });
    assert.deepStrictEqual(joinB.peers, [id(A)], 'the joiner is told who to connect to');
    // signalling: only between people on the call, encrypted payloads only
    let sig = once(sa0, 'gcall:signal');
    sb0.emit('gcall:signal', { groupId: G, to: id(A), data: { ciphertext: 'c2ln', iv: 'aXY=' } });
    const sg = await sig; assert.deepStrictEqual([sg.from, sg.groupId, sg.data.ciphertext], [id(B), G, 'c2ln']);
    const sdSock = sd.raw; // Dave is in the group but not on the call
    sb0.emit('gcall:signal', { groupId: G, to: id(D), data: { ciphertext: 'c2ln', iv: 'aXY=' } });
    await quiet(sdSock, 'gcall:signal');
    sb0.emit('gcall:signal', { groupId: G, to: id(A), data: { sdp: 'v=0 plain text' } });
    await quiet(sa0, 'gcall:signal');
    sd.raw.emit('gcall:signal', { groupId: G, to: id(A), data: { ciphertext: 'c2ln', iv: 'aXY=' } });
    await quiet(sa0, 'gcall:signal');
    step('signalling is relayed only between people on the call, and only as ciphertext');

    // one call at a time, across kinds
    const call1 = await ack(sd.raw, 'gcall:join', { groupId: G });
    assert.ok(call1.ok && call1.peers.length === 2);
    const G2 = (await mk(D, [id(A), id(B)])).group.id;
    assert.strictEqual((await sd.ack('gcall:join', { groupId: G2 })).error, 'You are already on a call', 'one call at a time');
    const dm = await ack(sa0, 'call:invite', { to: id(B), video: false });
    assert.strictEqual(dm.error, 'You are already on a call', 'a 1:1 call cannot start while you are on a group call');
    const dm2 = await ack(sb0, 'call:invite', { to: id(A) });
    assert.ok(dm2.error, 'and nobody can ring someone who is on a group call');
    step('one call at a time across 1:1 and group calls');

    // leaving; removal ends your call; the last leaver logs it
    const lb = once(sa0, 'gcall:left');
    sb0.emit('gcall:leave', { groupId: G });
    assert.strictEqual((await lb).userId, id(B));
    const ended = once(sd.raw, 'gcall:ended'), logD = once(sd.raw, 'call:log', 4000);
    // A (owner) removes D while D is still on the call
    r = await call(`/groups/${G}/kick`, { method: 'POST', token: A.token, body: { userId: id(D), baseEpoch: 4, nameEnc: nameEnc('K2'), wraps: wraps([id(A), id(B)], 'e5') } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await ended).reason, 'removed', 'being removed from the group ends your part in the call');
    const logA = once(sa0, 'call:log');
    sa0.emit('gcall:leave', { groupId: G });
    const rec = await logA;
    assert.deepStrictEqual([rec.convo, rec.group, rec.a, rec.b, rec.outcome, rec.video], ['g:' + G, true, id(A), null, 'completed', false]);
    assert.ok(rec.people >= 3, 'the record counts the people who were on it');
    const hist2 = await call(`/groups/${G}/calls`, { token: B.token });
    assert.deepStrictEqual(hist2.calls.map((x) => x.id), [rec.id], 'members can load the call history');
    assert.strictEqual((await call(`/groups/${G}/calls`, { token: D.token })).status, 404);
    assert.strictEqual((await call('/groups/' + G, { token: A.token })).group.call, null, 'no call running any more');
    step('leaving, removal during a call, and the finished call is logged for the group');

    // a dropped connection leaves the call
    const sa2 = await sock(A.token), sb2 = await sock(B.token);
    await ack(sa2, 'gcall:join', { groupId: G });
    const incB2 = await ack(sb2, 'gcall:join', { groupId: G });
    assert.deepStrictEqual(incB2.peers, [id(A)]);
    const left = once(sb2, 'gcall:left'); sa2.close();
    assert.strictEqual((await left).userId, id(A), 'a dropped connection leaves the call');
    sb2.close(); await new Promise((r2) => setTimeout(r2, 200));
    assert.strictEqual((await call('/groups/' + G, { token: B.token })).group.call, null);
    step('a dropped connection leaves the call, and an empty call ends');

    // ================= leaving, ownership, deleting =================
    assert.strictEqual((await call(`/groups/${G}/leave`, { method: 'POST', token: A.token, body: { baseEpoch: 99, nameEnc: nameEnc('L'), wraps: wraps([id(B)]) } })).status, 409);
    // G has A (owner) and B: A leaves, so only one remains and the group is deleted
    r = await call(`/groups/${G}/leave`, { method: 'POST', token: A.token, body: { baseEpoch: store.db.groups[G].epoch, nameEnc: nameEnc('L'), wraps: {} } });
    assert.deepStrictEqual([r.status, r.deleted], [200, true], 'a group with one person left is deleted');
    assert.ok(!store.db.groups[G] && !Object.values(store.db.gmsgs).some((x) => x.group === G), 'with its messages');
    assert.strictEqual(Object.values(store.db.calllog).filter((x) => x.convo === 'g:' + G).length, 0, 'and its call history');
    // G2: Dave owns it with Alice and Bob; the owner leaves and ownership passes on
    const sdq = await roller(D.token);
    r = await call(`/groups/${G2}/leave`, { method: 'POST', token: D.token, body: { baseEpoch: 1, nameEnc: nameEnc('L'), wraps: wraps([id(A), id(B)], 'l') } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(store.db.groups[G2].ownerId, id(A), 'ownership passes to the longest-standing member');
    assert.strictEqual((await call('/groups/' + G2, { token: D.token })).status, 404);
    assert.strictEqual((await call('/groups/' + G2, { method: 'DELETE', token: B.token })).status, 403, 'only the owner deletes');
    assert.strictEqual((await call('/groups/' + G2, { method: 'DELETE', token: A.token })).status, 200);
    assert.ok(!store.db.groups[G2]);
    step('leaving: ownership passes on, a group of one is deleted with everything in it, only the owner deletes');

    // ================= presence and privacy =================
    const G3 = (await mk(A, [id(B), id(D)])).group.id;
    const pres = await call('/presence', { token: B.token });
    assert.ok(id(D) in pres.presence, 'people in a group with you show up in presence');
    await rawDb().then((all) => {
      // even the ciphertext the browsers sent is sealed again by the server before it is stored
      for (const needle of [ct('secret').ciphertext, ct('hello2').ciphertext, nameEnc('Renamed').ciphertext, wrap('e2' + id(A).slice(0, 4)).ciphertext]) assert.ok(!all.includes(needle), 'client ciphertext ' + needle + ' is not stored as it was sent');
    });
    step('presence covers group members; group data is sealed at rest');

    [sa0, sb0, sc0, sd0, sa, sb, sd, sdq].forEach((s) => s.close());
    console.log('\ngroups-flow-test: all passed');
  } catch (e) { console.error('FAILED:', e); process.exitCode = 1; }
  finally { httpServer.close(); await cleanup(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
}));
