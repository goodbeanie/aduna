// Theme gallery routes end to end (needs TEST_DATABASE_URL like the other DB tests): node server/themes-test.js
const assert = require('assert');
const { rawDb, cleanup } = require('./test-env');
const { httpServer, ready } = require('./index');
const store = require('./db');

const blob = { salt: 'a', iv: 'b', data: 'c' };
let base;
async function call(p, { method = 'GET', body, token } = {}) {
  const r = await fetch(base + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const step = (m) => console.log('✓', m);
const reg = async (u) => { const r = await call('/register', { method: 'POST', body: { username: u, email: u + '@example.com', password: 'password123', publicKey: 'pk' + u, encPrivKey: blob } }); assert.strictEqual(r.status, 200, JSON.stringify(r)); return r; };
const seed = (accent) => ({ dark: true, bg: '#1b1f2a', accent });

ready.then(() => httpServer.listen(0, async () => {
  try {
    base = 'http://127.0.0.1:' + httpServer.address().port;
    const ann = await reg('th_ann'), bob = await reg('th_bob'), cy = await reg('th_cy'), dee = await reg('th_dee'), eve = await reg('th_eve');

    assert.strictEqual((await call('/themes')).status, 401, 'the gallery needs a login');
    let r = await call('/themes', { method: 'PUT', token: ann.token, body: { name: 'Night Owl', description: 'Dark blue, pink accent', seed: seed('#ff7a90') } });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const owl = r.theme;
    assert.ok(owl.mine && owl.uses === 0 && owl.author.id === ann.user.id && !('ownerId' in owl) && !('reports' in owl));
    step('a theme is published and comes back without owner id or reports');

    // refused
    for (const [why, body] of [['unreadable', { name: 'Glare', seed: { dark: true, bg: '#ffffff', accent: '#000000' } }], ['bad colours', { name: 'Bad', seed: { dark: true, bg: 'url(x)', accent: '#ff0000' } }],
      ['no name', { name: ' ', seed: seed('#00ff88') }], ['link', { name: 'evil.com', seed: seed('#00ff88') }], ['blocked word', { name: 'porn pink', seed: seed('#00ff88') }]]) {
      const x = await call('/themes', { method: 'PUT', token: ann.token, body }); assert.strictEqual(x.status, 400, why); assert.ok(x.error, why);
    }
    assert.strictEqual((await call('/themes', { method: 'PUT', token: ann.token, body: { name: 'Owl again', seed: seed('#FF7A90') } })).status, 429, 'same colours twice from one person');
    assert.strictEqual((await call('/themes', { method: 'PUT', token: bob.token, body: { name: 'Owl bob', seed: seed('#ff7a90') } })).status, 200, 'another person may');
    step('unreadable, malformed, unnamed, linked and filtered themes are refused; duplicates from one person are refused');

    // gallery + use counting
    r = await call('/themes?sort=popular', { token: cy.token });
    assert.strictEqual(r.themes.length, 2); assert.strictEqual(r.more, false);
    assert.strictEqual((await call('/themes?q=night', { token: cy.token })).themes.length, 1);
    assert.strictEqual((await call('/themes?mode=light', { token: cy.token })).themes.length, 0);
    r = await call(`/themes/${owl.id}/use`, { method: 'POST', token: cy.token }); assert.strictEqual(r.theme.uses, 1);
    r = await call(`/themes/${owl.id}/use`, { method: 'POST', token: cy.token }); assert.strictEqual(r.theme.uses, 1, 'one use per person');
    r = await call(`/themes/${owl.id}/use`, { method: 'POST', token: ann.token }); assert.strictEqual(r.theme.uses, 1, 'the author does not count');
    r = await call(`/themes/${owl.id}/use`, { method: 'POST', token: dee.token }); assert.strictEqual(r.theme.uses, 2);
    assert.strictEqual((await call('/themes?sort=popular', { token: eve.token })).themes[0].id, owl.id, 'most used first');
    assert.strictEqual((await call('/themes/zzzz/use', { method: 'POST', token: cy.token })).status, 404);
    assert.strictEqual((await call('/themes/__proto__/use', { method: 'POST', token: cy.token })).status, 404);
    step('browse, search, filter, sort; a use is counted once per person and never for the author');

    // mine, delete
    r = await call('/themes/mine', { token: ann.token }); assert.deepStrictEqual(r.themes.map((t) => t.id), [owl.id]);
    assert.strictEqual((await call(`/themes/${owl.id}`, { method: 'DELETE', token: bob.token })).status, 403, 'only the author deletes');

    // reports: three established accounts hide it; new accounts do not
    for (const u of [bob, cy, dee, eve]) store.db.users[u.user.id].createdAt = Date.now(); // brand new
    for (const u of [bob, cy, dee]) assert.strictEqual((await call(`/themes/${owl.id}/report`, { method: 'POST', token: u.token })).status, 200);
    assert.strictEqual((await call('/themes', { token: eve.token })).themes.some((t) => t.id === owl.id), true, 'three NEW accounts cannot hide it');
    assert.strictEqual((await call(`/themes/${owl.id}/report`, { method: 'POST', token: ann.token })).status, 400, 'you cannot report your own theme');
    for (const u of [bob, cy, dee]) store.db.users[u.user.id].createdAt = 0; // now established
    assert.strictEqual((await call(`/themes/${owl.id}/report`, { method: 'POST', token: eve.token })).status, 200);
    assert.strictEqual((await call('/themes', { token: eve.token })).themes.some((t) => t.id === owl.id), false, 'hidden once enough established accounts agree');
    assert.strictEqual((await call(`/themes/${owl.id}/use`, { method: 'POST', token: eve.token })).status, 404, 'a hidden theme cannot be used');
    assert.strictEqual((await call('/themes/mine', { token: ann.token })).themes.length, 0);
    step('reports hide a theme only when enough established accounts agree; hidden themes cannot be listed or used');

    // the rest: the author deletes; nothing leaks to the database in the clear that should not be
    const mine = (await call('/themes', { method: 'PUT', token: ann.token, body: { name: 'Fresh', seed: seed('#00ff88') } })).theme;
    assert.deepStrictEqual(await call(`/themes/${mine.id}`, { method: 'DELETE', token: ann.token }), { status: 200, ok: true });
    assert.strictEqual((await call('/themes', { token: eve.token })).themes.some((t) => t.id === mine.id), false);
    assert.ok(!(await rawDb()).includes('Fresh'), 'themes are encrypted at rest like every other record');
    step('the author can delete; themes are encrypted at rest');

    // a server owner applies a gallery theme through the normal server theme (unchanged rules)
    const sv = await call('/servers', { method: 'POST', token: bob.token, body: { name: 'Look' } });
    r = await call('/servers/' + sv.server.id, { method: 'PATCH', token: bob.token, body: { theme: seed('#00ff88') } });
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.server.theme, seed('#00ff88'));
    assert.strictEqual((await call('/servers/' + sv.server.id, { method: 'PATCH', token: bob.token, body: { theme: { dark: true, bg: '#1b1f2a', accent: 'red' } } })).status, 400);
    step('a server owner applies a gallery theme with the existing server theme setting');

    console.log('\nthemes-test: all passed');
    await cleanup(); process.exit(0);
  } catch (e) { console.error(e); await cleanup().catch(() => {}); process.exit(1); }
}));
