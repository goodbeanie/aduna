// Unsafe link protection, the server's half, with a fake network: node server/linksafe-test.js
'use strict';
const assert = require('assert');
const L = require('./linksafe');
const ok = (m) => console.log('✓', m);

(async () => {
  // ---- cleanDomain
  assert.strictEqual(L.cleanDomain('https://Evil.Example/path?x=1'), 'evil.example');
  assert.strictEqual(L.cleanDomain('*.evil.example'), 'evil.example');
  assert.strictEqual(L.cleanDomain('evil.example:8080'), 'evil.example');
  assert.strictEqual(L.cleanDomain('user:pw@evil.example/a'), 'evil.example');
  assert.strictEqual(L.cleanDomain('1.2.3.4'), '1.2.3.4');
  for (const bad of ['com', '', '   ', 'a b.example', '999.1.1.1', null, undefined, 'x'.repeat(300) + '.example']) assert.strictEqual(L.cleanDomain(bad), null, String(bad));
  ok('cleanDomain keeps real domains and refuses bare endings and junk');

  // ---- hostOf, blockedBy
  assert.strictEqual(L.hostOf('https://Sub.Evil.Example./x'), 'sub.evil.example');
  assert.strictEqual(L.hostOf('ftp://evil.example'), '');
  assert.strictEqual(L.hostOf('javascript:alert(1)'), '');
  const set = L.domainSet(['evil.example', 'https://Bad.Test/x', 'com', 'nope nope'], { 'obj.example': {}, junk: 1 });
  assert.deepStrictEqual([...set].sort(), ['bad.test', 'evil.example', 'obj.example']);
  assert.strictEqual(L.blockedBy('login.evil.example', set), 'evil.example');
  assert.strictEqual(L.blockedBy('evil.example', set), 'evil.example');
  assert.strictEqual(L.blockedBy('notevil.example', set), null);
  assert.strictEqual(L.blockedBy('example', set), null);
  assert.strictEqual(L.domainSet(null, undefined, 5).size, 0);
  ok('domains are cleaned, merged from lists and objects, and matched with their subdomains');

  // ---- cleanUrls
  const many = Array.from({ length: 40 }, (_, i) => 'https://a' + i + '.example/');
  assert.strictEqual(L.cleanUrls(many).length, L.MAX_URLS);
  assert.deepStrictEqual(L.cleanUrls(['https://x.example/', 'https://x.example/', 'ftp://x', 'javascript:1', 5, '', 'https://y.example/' + 'a'.repeat(3000)]), ['https://x.example/']);
  assert.deepStrictEqual(L.cleanUrls('nope'), []);
  ok('cleanUrls keeps a few distinct http(s) addresses and drops everything else');

  // ---- Safe Browsing with a fake network
  let calls = 0, mode = 'ok', t = 1_000_000;
  const fetchImpl = async (url, opts) => {
    calls++;
    assert.ok(String(url).startsWith('https://safebrowsing.googleapis.com/v4/threatMatches:find?key='));
    const body = JSON.parse(opts.body);
    assert.ok(body.threatInfo.threatEntries.length >= 1);
    if (mode === 'down') throw new Error('network down');
    if (mode === '500') return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ matches: [{ threatType: 'SOCIAL_ENGINEERING', threat: { url: 'https://bad.example/x' } }, { threatType: 'MALWARE', threat: { url: 'https://worse.example/' } }] }) };
  };
  const off = L.createSafeBrowsing({ fetchImpl });
  assert.strictEqual(off.enabled, false);
  assert.deepStrictEqual(await off.check(['https://bad.example/x']), { ok: false, threats: new Map() });
  assert.strictEqual(calls, 0, 'no key, no network');

  const sb = L.createSafeBrowsing({ key: 'K', fetchImpl, now: () => t, restMs: 60_000 });
  assert.strictEqual(sb.enabled, true);
  let r = await sb.check(['https://bad.example/x', 'https://fine.example/', 'https://worse.example/']);
  assert.ok(r.ok);
  assert.strictEqual(r.threats.get('https://bad.example/x'), 'phishing');
  assert.strictEqual(r.threats.get('https://worse.example/'), 'malware');
  assert.ok(!r.threats.has('https://fine.example/'));
  assert.strictEqual(calls, 1);
  r = await sb.check(['https://bad.example/x', 'https://fine.example/']);
  assert.ok(r.ok && r.threats.get('https://bad.example/x') === 'phishing');
  assert.strictEqual(calls, 1, 'answers (clean ones too) are remembered');
  t += 31 * 60_000;
  await sb.check(['https://bad.example/x']);
  assert.strictEqual(calls, 2, 'and asked again after they expire');

  // a failure never blocks anything, and the lookup then rests
  mode = 'down';
  r = await sb.check(['https://new1.example/']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.threats.size, 0);
  const before = calls;
  r = await sb.check(['https://new2.example/']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls, before, 'resting: no new request');
  t += 61_000; mode = '500';
  assert.strictEqual((await sb.check(['https://new3.example/'])).ok, false, 'an error status is also "no verdict"');
  t += 61_000; mode = 'ok';
  assert.strictEqual((await sb.check(['https://bad.example/x'])).ok, true, 'it comes back after the rest');
  ok('Safe Browsing: threats named, answers cached, failures say "no verdict" and rest for a minute');

  // ---- checkUrls: the blocklist first, then the lookup for the rest
  const domains = L.domainSet(['evil.example']);
  mode = 'ok'; t += 31 * 60_000; calls = 0;
  const sb2 = L.createSafeBrowsing({ key: 'K', fetchImpl, now: () => t });
  let out = await L.checkUrls({ urls: ['https://login.evil.example/a', 'https://bad.example/x', 'https://fine.example/'], domains, safeBrowsing: sb2 });
  assert.deepStrictEqual(out.results, [
    { url: 'https://login.evil.example/a', level: 'block', reason: 'listed', domain: 'evil.example' },
    { url: 'https://bad.example/x', level: 'block', reason: 'phishing' },
    { url: 'https://fine.example/', level: 'ok' },
  ]);
  assert.strictEqual(out.lookup, true);
  assert.strictEqual(calls, 1, 'the listed one never leaves the server');

  out = await L.checkUrls({ urls: ['https://login.evil.example/a', 'https://x.example/'], domains, safeBrowsing: L.createSafeBrowsing({}) });
  assert.strictEqual(out.lookup, false);
  assert.strictEqual(out.results[0].level, 'block');
  assert.strictEqual(out.results[1].level, 'ok');
  out = await L.checkUrls({ urls: ['https://x.example/'], domains: new Set(), safeBrowsing: null });
  assert.deepStrictEqual(out, { results: [{ url: 'https://x.example/', level: 'ok' }], lookup: false });
  ok('checkUrls: listed domains are blocked without a network call; the rest go to the lookup when it is on');

  console.log('\nlinksafe (server): all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
