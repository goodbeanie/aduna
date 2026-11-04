// Profile tests (username cooldown, links, logo avatar): node server/profile-test.js
const os = require('os'), path = require('path'), fs = require('fs'), assert = require('assert');
const { webcrypto: crypto } = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aduna-'));
const { cleanup } = require('./test-env');
const { httpServer, ready } = require('./index');
let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const blob = { salt: 'a', iv: 'b', data: 'c' };
const reg = (username, email = username + '@example.com') => call('/register', { method: 'POST', body: { username, email, password: 'password123', publicKey: 'pk' + username, encPrivKey: blob } });
ready.then(() => httpServer.listen(0, async () => {
  base = 'http://127.0.0.1:' + httpServer.address().port;
  try {
    const a = await reg('alice_x'), b = await reg('bob_x');
    const t = a.token;
    // links
    let r = await call('/me', { method: 'PATCH', token: t, body: { links: [{ label: 'Twitter', url: 'twitter.com/alice' }, { label: '', url: 'https://www.github.com/alice' }] } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.links[0].url, 'https://twitter.com/alice'); assert.strictEqual(r.user.links[1].label, 'github.com'); console.log('✓ links saved + normalised');
    r = await call('/me', { method: 'PATCH', token: t, body: { links: [{ url: 'javascript:alert(1)' }] } });
    assert.strictEqual(r.status, 400); console.log('✓ javascript: link rejected');
    r = await call('/me', { method: 'PATCH', token: t, body: { links: Array(6).fill({ url: 'a.com' }) } });
    assert.strictEqual(r.status, 400); console.log('✓ >5 links rejected');
    // logo avatar
    r = await call('/me', { method: 'PATCH', token: t, body: { avatarLogo: true } });
    assert.strictEqual(r.user.avatarLogo, true); console.log('✓ logo avatar flag');
    // name font and gradient
    r = await call('/me', { method: 'PATCH', token: t, body: { nameFont: 'serif', nameGradient: { colors: ['#FF7A59', '#6a88ff'], angle: 90 } } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.nameFont, 'serif'); assert.deepStrictEqual(r.user.nameGradient, { colors: ['#ff7a59', '#6a88ff'], angle: 90 }); console.log('✓ name font + gradient saved');
    r = await call('/users/' + a.user.id, { token: b.token });
    if (r.status === 200) { assert.strictEqual(r.user.nameFont, 'serif'); assert.ok(r.user.nameGradient); console.log('✓ other people see the name style'); }
    r = await call('/me', { method: 'PATCH', token: t, body: { nameFont: 'comic-sans', nameGradient: { colors: ['#ff0000'], angle: 0 } } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.nameFont, 'serif'); assert.strictEqual(r.user.nameGradient.colors.length, 2); console.log('✓ bad font / gradient ignored, saved ones kept');
    r = await call('/me', { method: 'PATCH', token: t, body: { displayName: 'Alice' } });
    assert.strictEqual(r.user.nameFont, 'serif'); console.log('✓ an unrelated update keeps the name style');
    r = await call('/me', { method: 'PATCH', token: t, body: { nameFont: null, nameGradient: null } });
    assert.strictEqual(r.user.nameFont, null); assert.strictEqual(r.user.nameGradient, null); console.log('✓ name font + gradient can be taken off');
    // username: bad, taken, ok, cooldown
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'a!' } }); assert.strictEqual(r.status, 400); console.log('✓ bad username rejected');
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'BOB_X' } }); assert.strictEqual(r.status, 409); console.log('✓ taken username rejected (case-insensitive)');
    // line 36 gave the account a real display name ("Alice"); put it back to the default (= the username) so "the display name follows a rename" is what is tested
    r = await call('/me', { method: 'PATCH', token: t, body: { displayName: 'alice_x' } }); assert.strictEqual(r.user.displayName, 'alice_x');
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'alice_new' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.username, 'alice_new'); assert.strictEqual(r.user.displayName, 'alice_new'); assert.ok(r.user.usernameChangedAt); console.log('✓ username changed, default display name followed it');
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'alice_again' } });
    assert.strictEqual(r.status, 429); assert.ok(r.availableAt); console.log('✓ 2nd change blocked by cooldown, availableAt =', r.availableAt);
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'alice_new', displayName: 'Alice' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.displayName, 'Alice'); console.log('✓ unchanged username during cooldown does not error');
    // login works with new name, not old
    r = await call('/login', { method: 'POST', body: { username: 'alice_new', password: 'password123' } }); assert.strictEqual(r.status, 200); console.log('✓ can log in with new username');
    r = await call('/login', { method: 'POST', body: { username: 'alice_x', password: 'password123' } }); assert.strictEqual(r.status, 401); console.log('✓ old username no longer logs in');
    // old name is free for others right away
    r = await reg('alice_x', 'alice_x_2@example.com'); assert.strictEqual(r.status, 200); console.log('✓ old username is free for others (a new account needs its own email since v19)');
    // cooldown expiry (rewind the stored timestamp by 8 days)
    const store = require('./db');
    store.db.users[a.user.id].usernameChangedAt -= 8 * 24 * 3600 * 1000;
    r = await call('/me', { method: 'PATCH', token: t, body: { username: 'alice_two' } }); assert.strictEqual(r.status, 200); console.log('✓ allowed again after 7 days');
    // ---- pronouns, favorite games, profile song ----
    r = await call('/me', { method: 'PATCH', token: t, body: { pronouns: '  she/her  ' } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.pronouns, 'she/her'); console.log('✓ pronouns saved (trimmed)');
    r = await call('/me', { method: 'PATCH', token: t, body: { pronouns: 'x'.repeat(25) } });
    assert.strictEqual(r.status, 400); console.log('✓ pronouns over 24 characters rejected');
    r = await call('/me', { method: 'PATCH', token: t, body: { pronouns: 42 } });
    assert.strictEqual(r.status, 400); console.log('✓ pronouns must be text');
    r = await call('/me', { method: 'PATCH', token: t, body: { displayName: 'Alice' } });
    assert.strictEqual(r.user.pronouns, 'she/her'); console.log('✓ an unrelated update keeps the pronouns');

    r = await call('/me', { method: 'PATCH', token: t, body: { games: ['Hades', '  Celeste ', '', 'hades', { name: 'Hollow Knight' }] } });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.user.games.map((x) => x.name), ['Hades', 'Celeste', 'Hollow Knight']); console.log('✓ games saved: blanks dropped, repeats kept once, order kept');
    assert.deepStrictEqual(r.user.games.map((x) => x.app), [1145360, 504230, 367520]); console.log('✓ games from the list get their Steam picture id');
    r = await call('/me', { method: 'PATCH', token: t, body: { games: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } });
    assert.strictEqual(r.status, 400); console.log('✓ more than 6 games rejected');
    r = await call('/me', { method: 'PATCH', token: t, body: { games: ['y'.repeat(41)] } });
    assert.strictEqual(r.status, 400); console.log('✓ a game name over 40 characters rejected');
    r = await call('/me', { method: 'PATCH', token: t, body: { games: 'Hades' } });
    assert.strictEqual(r.status, 400); console.log('✓ games must be a list');
    r = await call('/me', { method: 'PATCH', token: t, body: { games: ['<b>Hades</b>'] } });
    assert.strictEqual(r.status, 200); assert.ok(!/[<>]/.test(r.user.games[0].name)); console.log('✓ angle brackets removed from a game name');
    r = await call('/me', { method: 'PATCH', token: t, body: { games: [{ name: 'Some Steam Game', app: 12345 }, { name: 'Homemade', app: -5 }, { name: 'Other', app: 'x' }] } });
    assert.deepStrictEqual(r.user.games, [{ name: 'Some Steam Game', app: 12345 }, { name: 'Homemade', app: 0 }, { name: 'Other', app: 0 }]); console.log('✓ a game found through search keeps its id; a bad id is dropped');
    r = await call('/me', { method: 'PATCH', token: t, body: { games: ['Hades', 'Celeste'] } });
    assert.deepStrictEqual(r.user.games.map((x) => x.name), ['Hades', 'Celeste']);
    r = await call('/me', { method: 'PATCH', token: t, body: { songTitle: 'Nope' } });
    assert.strictEqual(r.status, 400); console.log('✓ a song title needs a song first');

    const wav = (secs, rate = 8000) => { // a silent 8-bit mono WAV: only the header is real
      const n = secs * rate, h = Buffer.alloc(44);
      h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + n, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
      h.write('data', 36, 'latin1'); h.writeUInt32LE(n, 40);
      return Buffer.concat([h, Buffer.alloc(n, 128)]);
    };
    const putSong = async (token, body, type = 'audio/wav', title) => {
      const rr = await fetch(base + '/api/me/song' + (title ? '?title=' + encodeURIComponent(title) : ''), { method: 'PUT', headers: { 'Content-Type': type, Authorization: 'Bearer ' + token }, body });
      return { status: rr.status, ...(await rr.json().catch(() => ({}))) };
    };
    assert.strictEqual((await putSong(t, Buffer.alloc(200, 7))).status, 400); console.log('✓ bytes that are not audio rejected (the header is not trusted)');
    assert.strictEqual((await putSong(t, wav(1), 'image/png')).status, 400); console.log('✓ a non-audio content type rejected');
    assert.strictEqual((await putSong(t, wav(40))).status, 400); console.log('✓ a WAV over 30 seconds rejected');
    r = await putSong(t, wav(2), 'audio/wav', 'My Jam');
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.deepStrictEqual([r.user.song.title, r.user.song.mime, /^[0-9a-f]{32}$/.test(r.user.song.id)], ['My Jam', 'audio/wav', true]); console.log('✓ song uploaded');
    const song1 = r.user.song;
    let g = await fetch(base + '/api/songs/' + song1.id);
    assert.strictEqual(g.status, 200); assert.strictEqual(g.headers.get('content-type'), 'audio/wav'); assert.strictEqual(g.headers.get('accept-ranges'), 'bytes');
    assert.strictEqual((await g.arrayBuffer()).byteLength, 44 + 16000); console.log('✓ song served whole, with Accept-Ranges');
    g = await fetch(base + '/api/songs/' + song1.id, { headers: { Range: 'bytes=0-9' } });
    assert.strictEqual(g.status, 206); assert.strictEqual(g.headers.get('content-range'), 'bytes 0-9/16044'); assert.strictEqual((await g.arrayBuffer()).byteLength, 10); console.log('✓ Range request answered with 206 (Safari needs this)');
    g = await fetch(base + '/api/songs/' + song1.id, { headers: { Range: 'bytes=-4' } });
    assert.strictEqual(g.status, 206); assert.strictEqual(g.headers.get('content-range'), 'bytes 16040-16043/16044'); console.log('✓ suffix Range works');
    g = await fetch(base + '/api/songs/' + song1.id, { headers: { Range: 'bytes=99999-' } });
    assert.strictEqual(g.status, 416); console.log('✓ unsatisfiable Range gets 416');
    assert.strictEqual((await fetch(base + '/api/songs/' + 'z'.repeat(32))).status, 404);
    assert.strictEqual((await fetch(base + '/api/songs/' + 'a'.repeat(32))).status, 404); console.log('✓ unknown song ids give 404');
    r = await call('/me', { method: 'PATCH', token: t, body: { songTitle: '  Better Title ' } });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual([r.user.song.id, r.user.song.title], [song1.id, 'Better Title']); console.log('✓ song renamed without a new upload');
    r = await call('/users/' + a.user.id, { token: b.token });
    if (r.status === 200) { assert.strictEqual(r.user.pronouns, 'she/her'); assert.deepStrictEqual(r.user.games.map((x) => x.name), ['Hades', 'Celeste']); assert.strictEqual(r.user.song.id, song1.id); console.log('✓ other people see pronouns, games and the song'); }
    r = await putSong(t, wav(1), 'audio/wav');
    assert.strictEqual(r.status, 200); assert.notStrictEqual(r.user.song.id, song1.id); assert.strictEqual(r.user.song.title, 'My song');
    const song2 = r.user.song;
    await store.flush();
    assert.strictEqual((await fetch(base + '/api/songs/' + song1.id)).status, 404); console.log('✓ a new song replaces the old one and deletes its bytes (untitled = "My song")');
    r = await call('/me/song', { method: 'DELETE', token: t });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.user.song, null);
    await store.flush();
    assert.strictEqual((await fetch(base + '/api/songs/' + song2.id)).status, 404);
    r = await call('/me', { method: 'PATCH', token: t, body: { pronouns: '', games: [] } });
    assert.deepStrictEqual([r.user.pronouns, r.user.games, r.user.song], ['', [], null]); console.log('✓ song removed; pronouns and games can be cleared');
    console.log('ALL PASSED');
  } catch (e) { console.error('FAIL', e); process.exitCode = 1; }
  await cleanup();
  process.exit();
}));
