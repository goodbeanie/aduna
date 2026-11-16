// Developer themes through the real server: node server/devthemes-flow-test.js (needs TEST_DATABASE_URL, see test-env.js)
// Write a CSS theme with pictures, send it for review, get it verified, use it, and lose the verification when anything changes.
process.env.ADMIN_USERNAMES = 'thememod'; // read when the server module loads, so set first
const assert = require('assert');
const zlib = require('zlib');
const { cleanup } = require('./test-env');
const { httpServer, ready, store } = require('./index');
let base;
const step = (m) => console.log('✓', m);
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
async function putImage(p, buf, token, type = 'image/png') {
  const r = await fetch(base + '/api' + p, { method: 'PUT', headers: { 'Content-Type': type, Authorization: 'Bearer ' + token }, body: buf });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const getRaw = async (p) => { const r = await fetch(base + '/api' + p); return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '', text: await r.text() }; };
const reg = async (name) => {
  const r = await call('/register', { method: 'POST', body: { username: name, email: name + '@example.com', password: 'password123', publicKey: 'k', encPrivKey: { salt: 'a', iv: 'b', data: 'c' } } });
  assert.strictEqual(r.status, 200, 'register ' + JSON.stringify(r));
  return r;
};
function crc32(buf) { let crc = 0xffffffff; for (const byte of buf) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
let marker = 0;
function makePng(w, h) { // a different picture every time (the marker), so no two uploads are the same bytes
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0m' + ++marker, 'latin1')), chunk('IDAT', zlib.deflateSync(Buffer.alloc((w * 3 + 1) * h, 0x7f))), chunk('IEND', Buffer.alloc(0))]);
}
const SEED = { dark: true, bg: '#1b1f2a', accent: '#ff7a90' };
const CSS = ':root { --bg: #101018; } .sidebar { background: url("bg.png") center / cover; } .msg { border-radius: 14px; }';

(async () => {
  await ready;
  await new Promise((r) => httpServer.listen(0, r));
  base = 'http://127.0.0.1:' + httpServer.address().port;
  const dev = await reg('themedev'), other = await reg('themefan'), mod = await reg('thememod');
  const T = (u) => u.token;

  // ---- a developer account first ----
  let r = await call('/devthemes', { method: 'POST', token: T(dev), body: { name: 'Neon Rain', seed: SEED, css: CSS } });
  assert.strictEqual(r.status, 403); assert.strictEqual(r.code, 'not_developer');
  assert.strictEqual((await call('/devthemes/mine', { token: T(dev) })).status, 403);
  assert.strictEqual((await call('/developer/join', { method: 'POST', body: { accept: true }, token: T(dev) })).status, 200);
  step('themes are written from a developer account');

  // ---- write one, with a picture ----
  r = await call('/devthemes', { method: 'POST', token: T(dev), body: { name: 'Neon Rain', description: 'Cyberpunk', seed: SEED, css: CSS } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  let t = r.theme; const id = t.id;
  assert.deepStrictEqual([t.status, t.images.length, !!t.key], ['draft', 0, true]);
  assert.strictEqual((await call('/devthemes', { method: 'POST', token: T(dev), body: { name: 'Bad', seed: SEED, css: '@import url(x.css);' } })).status, 400, 'bad CSS is refused on save');
  assert.strictEqual((await call('/devthemes', { method: 'POST', token: T(dev), body: { name: 'Bad', seed: SEED, css: 'a{background:url(https://evil.example/x.png)}' } })).status, 400, 'outside pictures are refused');
  assert.strictEqual((await call(`/devthemes/${id}/submit`, { method: 'POST', token: T(dev) })).status, 400, 'the CSS uses bg.png, which is not uploaded yet');
  assert.strictEqual((await putImage(`/devthemes/${id}/images/Bg.PNG`, makePng(8, 8), T(dev))).status, 400, 'picture names are lower case');
  assert.strictEqual((await putImage(`/devthemes/${id}/images/bg.png`, Buffer.from('not an image'), T(dev))).status, 400, 'not a picture');
  assert.strictEqual((await putImage(`/devthemes/${id}/images/bg.png`, makePng(2401, 2), T(dev))).status, 400, 'over 2400 px');
  assert.strictEqual((await putImage(`/devthemes/${id}/images/bg.png`, makePng(8, 8), T(other))).status, 403, 'only developers');
  r = await putImage(`/devthemes/${id}/images/bg.png`, makePng(8, 8), T(dev));
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.deepStrictEqual(r.theme.images.map((p) => [p.name, p.width, p.height]), [['bg.png', 8, 8]]);
  assert.ok(!JSON.stringify(r.theme).includes('imageId'), 'the author is not handed storage ids');
  t = r.theme;
  step('the CSS and the pictures are checked as they are saved');

  // ---- the draft is only visible with the author\'s private key ----
  assert.strictEqual((await getRaw(`/devthemes/${id}/css`)).status, 404, 'no key, no draft');
  assert.strictEqual((await getRaw(`/devthemes/${id}/css?k=wrong`)).status, 404);
  let css = await getRaw(`/devthemes/${id}/css?k=${t.key}`);
  assert.strictEqual(css.status, 200); assert.ok(css.type.startsWith('text/css')); assert.ok(css.cache.includes('no-cache'));
  const m = /url\("\/api\/images\/([^"]+)"\)/.exec(css.text);
  assert.ok(m && css.text.includes('border-radius: 14px') && css.text.includes('--bg: #101018'), 'the CSS is served with its picture address: ' + css.text);
  assert.strictEqual((await fetch(base + '/api/images/' + m[1])).status, 200, 'and the picture loads');
  assert.strictEqual((await call(`/devthemes/${id}`, { token: T(other) })).status, 404, 'nobody else can look a draft up');
  assert.strictEqual((await call(`/devthemes/${id}/use`, { method: 'POST', token: T(other) })).status, 404, 'nor use it');
  assert.deepStrictEqual((await call('/devthemes', { token: T(other) })).themes, [], 'nor browse it');
  step('a draft is served only with the private preview key');

  // ---- review ----
  r = await call(`/devthemes/${id}/submit`, { method: 'POST', token: T(dev) });
  assert.strictEqual(r.status, 200, JSON.stringify(r)); assert.strictEqual(r.theme.status, 'pending');
  assert.strictEqual((await call(`/devthemes/${id}/submit`, { method: 'POST', token: T(dev) })).status, 400, 'already waiting');
  assert.strictEqual((await call('/admin/devthemes', { token: T(dev) })).status, 404, 'the queue is for admins');
  assert.strictEqual((await call(`/admin/devthemes/${id}/review`, { method: 'POST', token: T(dev), body: { action: 'approve' } })).status, 404, 'so is the decision');
  r = await call('/admin/devthemes', { token: T(mod) });
  assert.deepStrictEqual(r.themes.map((x) => [x.id, x.developer, x.status, x.images]), [[id, 'themedev', 'pending', 1]]);
  const seen = await call(`/admin/devthemes/${id}`, { token: T(mod) });
  assert.ok(seen.css === CSS && seen.hash && seen.key && seen.images[0].url.startsWith('/api/images/') && seen.developer === 'themedev', 'the admin reads the CSS and sees the pictures');
  assert.strictEqual((await getRaw(`/devthemes/${id}/css?k=${seen.key}`)).status, 200, 'and can preview it');
  r = await call(`/admin/devthemes/${id}/review`, { method: 'POST', token: T(mod), body: { action: 'approve', hash: 'stale' } });
  assert.strictEqual(r.status, 409, 'an admin can only approve what they opened');
  r = await call(`/admin/devthemes/${id}/review`, { method: 'POST', token: T(mod), body: { action: 'approve', hash: seen.hash } });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual((await call('/devthemes/mine', { token: T(dev) })).themes[0].status, 'approved');
  step('submit, queue, read, stale hash refused, approve');

  // ---- verified: public ----
  r = await call('/devthemes', { token: T(other) });
  assert.deepStrictEqual(r.themes.map((x) => [x.id, x.name, x.cover, x.author.displayName, x.mine]), [[id, 'Neon Rain', 'bg.png', 'themedev', false]]);
  assert.ok(!JSON.stringify(r).includes('border-radius'), 'the list carries no CSS');
  const v = r.themes[0].v;
  css = await getRaw(`/devthemes/${id}/css?v=${v}`);
  assert.strictEqual(css.status, 200); assert.ok(css.cache.includes('immutable'), 'a verified theme at its own version is cached for good');
  assert.ok((await getRaw(`/devthemes/${id}/css`)).cache.includes('no-cache'), 'without the version it is always checked');
  r = await call(`/devthemes/${id}/use`, { method: 'POST', token: T(other) }); assert.strictEqual(r.theme.uses, 1);
  r = await call(`/devthemes/${id}/use`, { method: 'POST', token: T(other) }); assert.strictEqual(r.theme.uses, 1, 'one use per person');
  r = await call(`/devthemes/${id}/use`, { method: 'POST', token: T(dev) }); assert.strictEqual(r.theme.uses, 1, 'the author does not count');
  assert.strictEqual((await call(`/devthemes/${id}/report`, { method: 'POST', token: T(dev) })).status, 400, 'no reporting your own');
  assert.strictEqual((await call(`/devthemes/${id}/report`, { method: 'POST', token: T(other) })).status, 200);
  assert.strictEqual((await call('/devthemes?q=neon', { token: T(other) })).themes.length, 1); assert.strictEqual((await call('/devthemes?q=zzz', { token: T(other) })).themes.length, 0);
  step('a verified theme is listed, served to everyone and counted once per person');

  // ---- any change takes the verification away ----
  const before = (await call('/devthemes/mine', { token: T(dev) })).themes[0];
  r = await call(`/devthemes/${id}`, { method: 'PATCH', token: T(dev), body: { css: CSS + ' .x { color: red }' } });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.theme.status, 'draft', 'a changed theme is a draft again');
  assert.notStrictEqual(r.theme.key, before.key, 'and its preview key changes');
  assert.deepStrictEqual((await call('/devthemes', { token: T(other) })).themes, [], 'it leaves the gallery');
  assert.strictEqual((await getRaw(`/devthemes/${id}/css`)).status, 404, 'its stylesheet stops being served');
  assert.strictEqual((await getRaw(`/devthemes/${id}/css?k=${before.key}`)).status, 404, 'the old preview key stops working');
  assert.strictEqual((await getRaw(`/devthemes/${id}/css?k=${r.theme.key}`)).status, 200);
  assert.strictEqual((await call('/developer/join', { method: 'POST', body: { accept: true }, token: T(other) })).status, 200);
  assert.strictEqual((await call(`/devthemes/${id}`, { method: 'PATCH', token: T(other), body: { css: 'a{}' } })).status, 404, 'only the author edits');
  assert.strictEqual((await call(`/devthemes/${id}`, { method: 'PATCH', token: T(dev), body: { css: 'a{position:fixed}' } })).status, 400, 'edits are checked too');
  // replacing a picture counts as a change too
  await call(`/devthemes/${id}/submit`, { method: 'POST', token: T(dev) });
  r = await call(`/admin/devthemes/${id}/review`, { method: 'POST', token: T(mod), body: { action: 'approve', hash: (await call(`/admin/devthemes/${id}`, { token: T(mod) })).hash } });
  assert.strictEqual(r.status, 200);
  const oldPic = (await call(`/admin/devthemes/${id}`, { token: T(mod) })).images[0].url.split('/').pop();
  r = await putImage(`/devthemes/${id}/images/bg.png`, makePng(9, 9), T(dev));
  assert.strictEqual(r.status, 200); assert.strictEqual(r.theme.status, 'draft', 'a new picture lapses it');
  assert.ok(!(await store.getImage(oldPic)), 'and the replaced picture is deleted');
  step('editing the CSS or replacing a picture lapses the verification, the gallery entry and the preview key');

  // ---- the admin read it, then the developer changed it ----
  await call(`/devthemes/${id}/submit`, { method: 'POST', token: T(dev) });
  const opened = await call(`/admin/devthemes/${id}`, { token: T(mod) });
  await call(`/devthemes/${id}`, { method: 'PATCH', token: T(dev), body: { css: CSS + ' .y { color: blue }' } });
  r = await call(`/admin/devthemes/${id}/review`, { method: 'POST', token: T(mod), body: { action: 'approve', hash: opened.hash } });
  assert.strictEqual(r.status, 409, 'the admin approved something that is no longer there'); assert.strictEqual((await call('/devthemes/mine', { token: T(dev) })).themes[0].status, 'draft');
  step('a theme changed after the admin opened it cannot be approved');

  // ---- rejection ----
  await call(`/devthemes/${id}/submit`, { method: 'POST', token: T(dev) });
  const o2 = await call(`/admin/devthemes/${id}`, { token: T(mod) });
  r = await call(`/admin/devthemes/${id}/review`, { method: 'POST', token: T(mod), body: { action: 'reject', hash: o2.hash, note: 'Hides the message box' } });
  assert.strictEqual(r.status, 200);
  t = (await call('/devthemes/mine', { token: T(dev) })).themes[0];
  assert.deepStrictEqual([t.status, t.note], ['rejected', 'Hides the message box']);
  assert.strictEqual((await call(`/devthemes/${id}/submit`, { method: 'POST', token: T(dev) })).status, 400, 'a rejected theme must change first');
  assert.deepStrictEqual((await call('/devthemes', { token: T(other) })).themes, []);
  // approved, then revoked
  await call(`/devthemes/${id}`, { method: 'PATCH', token: T(dev), body: { css: CSS } });
  await call(`/devthemes/${id}/submit`, { method: 'POST', token: T(dev) });
  const o3 = await call(`/admin/devthemes/${id}`, { token: T(mod) });
  assert.strictEqual((await call(`/admin/devthemes/${id}/review`, { method: 'POST', token: T(mod), body: { action: 'approve', hash: o3.hash } })).status, 200);
  assert.strictEqual((await call('/devthemes', { token: T(other) })).themes.length, 1);
  assert.strictEqual((await call(`/admin/devthemes/${id}/review`, { method: 'POST', token: T(mod), body: { action: 'revoke' } })).status, 200);
  assert.deepStrictEqual((await call('/devthemes', { token: T(other) })).themes, [], 'revoked: gone from the gallery');
  assert.strictEqual((await getRaw(`/devthemes/${id}/css`)).status, 404);
  step('reject with a note, resubmit after a change, revoke');

  // ---- limits and deleting ----
  const ids = [id];
  for (let i = 1; i < 5; i++) { r = await call('/devthemes', { method: 'POST', token: T(dev), body: { name: 'Theme ' + i, seed: SEED, css: 'a{}' } }); assert.strictEqual(r.status, 200, JSON.stringify(r)); ids.push(r.theme.id); }
  assert.strictEqual((await call('/devthemes', { method: 'POST', token: T(dev), body: { name: 'Sixth', seed: SEED, css: 'a{}' } })).status, 400, 'five themes at most');
  const pic = (await call(`/admin/devthemes/${id}`, { token: T(mod) })).images[0].url.split('/').pop();
  assert.ok(await store.getImage(pic));
  assert.strictEqual((await call(`/devthemes/${id}`, { method: 'DELETE', token: T(other) })).status, 404, 'only the author deletes');
  assert.strictEqual((await call(`/devthemes/${id}/images/bg.png`, { method: 'DELETE', token: T(dev) })).status, 200);
  assert.ok(!(await store.getImage(pic)), 'a removed picture is deleted');
  assert.strictEqual((await call(`/devthemes/${id}`, { method: 'DELETE', token: T(dev) })).status, 200);
  assert.strictEqual((await call(`/admin/devthemes/${id}`, { token: T(mod) })).status, 404);
  for (let i = 1; i < 5; i++) assert.strictEqual((await call(`/devthemes/${ids[i]}`, { method: 'DELETE', token: T(dev) })).status, 200);
  assert.strictEqual((await call('/devthemes/mine', { token: T(dev) })).themes.length, 0);
  step('five themes at most, pictures are deleted with their theme');

  console.log('\ndevthemes-flow-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { httpServer.close(); await cleanup(); process.exit(process.exitCode || 0); });
