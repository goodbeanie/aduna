// The outside-requests gate (botfetch.js), with a fake fetch and a fake DNS. No network, no database: node server/botfetch-test.js
const assert = require('assert');
const F = require('./botfetch');
const step = (m) => console.log('✓', m);

const H = ['api.github.com'];
// ----- address rules -----
{
  const ok = (u) => F.checkUrl(u, H).url, no = (u) => F.checkUrl(u, H).error;
  assert.strictEqual(ok('https://api.github.com/repos/a/b'), 'https://api.github.com/repos/a/b');
  assert.strictEqual(ok('https://API.GITHUB.COM/x#frag'), 'https://api.github.com/x', 'host lower-cased, fragment dropped');
  for (const bad of ['http://api.github.com/x', 'ftp://api.github.com/x', 'https://evil.com/x', 'https://api.github.com.evil.com/x', 'https://evil.com/?https://api.github.com/', 'https://user:pw@api.github.com/x',
    'https://api.github.com:8443/x', 'https://sub.api.github.com/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'file:///etc/passwd', 'javascript:alert(1)', '//api.github.com/x', 'api.github.com/x', '', '   ', null, undefined, 5, {}, 'https://' + 'a'.repeat(400) + '.com']) {
    assert.ok(no(bad), 'refused: ' + String(bad).slice(0, 50));
  }
  assert.strictEqual(ok('https://api.github.com:443/x'), 'https://api.github.com/x', ':443 is the https default, so it normalises away');
  step('https only, allow-list exact match, no credentials, no ports, no look-alike hosts');
}
{
  assert.deepStrictEqual(F.parseHosts(''), F.DEFAULT_HOSTS);
  assert.deepStrictEqual(F.parseHosts(undefined), F.DEFAULT_HOSTS);
  assert.deepStrictEqual(F.parseHosts('Api.GitHub.com, example.org ,nodots, bad host.com,example.org'), ['api.github.com', 'example.org']);
  assert.deepStrictEqual(F.parseHosts('localhost,127.0.0.1'), F.DEFAULT_HOSTS, 'nothing valid falls back to the default');
  for (const [ip, priv] of [['10.1.2.3', true], ['127.0.0.1', true], ['169.254.169.254', true], ['172.16.0.1', true], ['172.31.255.255', true], ['172.32.0.1', false], ['192.168.1.1', true], ['100.64.0.1', true], ['100.128.0.1', false], ['0.0.0.0', true], ['224.0.0.1', true],
    ['8.8.8.8', false], ['140.82.112.5', false], ['::1', true], ['::', true], ['fc00::1', true], ['fd12::1', true], ['fe80::1', true], ['ff02::1', true], ['::ffff:10.0.0.1', true], ['::ffff:8.8.8.8', false], ['2606:4700::1', false], ['not an ip', true]]) {
    assert.strictEqual(F.isPrivateAddress(ip), priv, ip);
  }
  step('host list parsing and private address ranges');
}

// ----- fetching -----
const res = (status, body, headers = {}) => ({ status, headers: { get: (k) => ({ 'content-type': 'application/json', ...headers })[k.toLowerCase()] ?? null }, body: null, text: async () => body });
function make(over = {}) {
  const calls = [];
  let t = 1_000_000;
  const f = F.createFetcher({
    hosts: H, token: over.token || '', now: () => t,
    lookup: over.lookup || (async () => [{ address: '140.82.112.5', family: 4 }]),
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return (over.respond || (() => res(200, '{"stars":42}')))(url, opts, calls.length); },
    limits: over.limits,
  });
  return { f, calls, tick: (ms) => { t += ms; } };
}
(async () => {
  {
    const { f, calls } = make();
    const r = await f.get('https://api.github.com/repos/a/b');
    assert.deepStrictEqual([r.ok, r.status, r.json, r.text, r.truncated, r.error], [true, 200, { stars: 42 }, '{"stars":42}', false, null], JSON.stringify(r));
    assert.strictEqual(calls[0].opts.method, 'GET');
    assert.strictEqual(calls[0].opts.redirect, 'manual');
    assert.deepStrictEqual(Object.keys(calls[0].opts.headers).sort(), ['Accept', 'User-Agent'], 'only the host chooses headers; no token unless configured');
    step('a good fetch: GET, no custom headers, parsed JSON');
  }
  {
    const { f, calls } = make({ token: 'tok123' });
    await f.get('https://api.github.com/x');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok123');
    const h2 = F.createFetcher({ hosts: ['api.github.com', 'example.org'], token: 'tok123', lookup: async () => [{ address: '93.184.216.34' }], fetchImpl: async (u, o) => { calls.push({ url: u, opts: o }); return res(200, '{}'); } });
    await h2.get('https://example.org/x');
    assert.ok(!calls[1].opts.headers.Authorization, 'the GitHub token is never sent to another host');
    step('the GitHub token goes to GitHub only');
  }
  {
    const { f, calls, tick } = make();
    await f.get('https://api.github.com/a'); await f.get('https://api.github.com/a');
    assert.strictEqual(calls.length, 1, 'second call served from the cache');
    assert.strictEqual((await f.get('https://api.github.com/a')).cached, true);
    tick(61_000); await f.get('https://api.github.com/a');
    assert.strictEqual(calls.length, 2, 'cache expires after 60 s');
    const both = await Promise.all([f.get('https://api.github.com/b'), f.get('https://api.github.com/b')]);
    assert.strictEqual(calls.length, 3, 'two at once make one call');
    assert.ok(both[0] === both[1] || both[0].json);
    step('cache for 60 s; simultaneous requests share one call');
  }
  {
    const { f, calls } = make({ respond: (url, o, n) => (n === 1 ? res(404, '{"message":"Not Found"}') : res(200, '{}')) });
    const r = await f.get('https://api.github.com/missing');
    assert.deepStrictEqual([r.ok, r.status, /404/.test(r.error)], [false, 404, true]);
    await f.get('https://api.github.com/missing');
    assert.strictEqual(calls.length, 1, 'an error answer is cached too, so a failing page is not hammered');
    const lim = make({ respond: () => res(403, '{}', { 'x-ratelimit-remaining': '0' }) });
    assert.match((await lim.f.get('https://api.github.com/r')).error, /allowance/);
    step('error answers: status, message, rate-limit wording, cached');
  }
  {
    // redirects: allowed only to another allow-listed host, at most 2
    const ok = make({ respond: (url, o, n) => (n === 1 ? res(302, '', { location: '/final' }) : res(200, '{"done":true}')) });
    assert.deepStrictEqual((await ok.f.get('https://api.github.com/start')).json, { done: true });
    assert.strictEqual(ok.calls[1].url, 'https://api.github.com/final');
    const evil = make({ respond: () => res(302, '', { location: 'https://evil.com/steal' }) });
    const r = await evil.f.get('https://api.github.com/start');
    assert.ok(!r.ok && /not on the allowed list/.test(r.error), JSON.stringify(r));
    assert.strictEqual(evil.calls.length, 1, 'the redirect target was never requested');
    const plain = make({ respond: () => res(302, '', { location: 'http://api.github.com/x' }) });
    assert.match((await plain.f.get('https://api.github.com/s')).error, /https/);
    const loop = make({ respond: () => res(302, '', { location: '/again' }) });
    assert.match((await loop.f.get('https://api.github.com/s')).error, /redirects/);
    assert.strictEqual(loop.calls.length, 3, 'one request plus two redirects, then stop');
    step('redirects: same allow-list, https only, at most 2');
  }
  {
    const priv = make({ lookup: async () => [{ address: '10.0.0.5' }] });
    assert.match((await priv.f.get('https://api.github.com/x')).error, /not public/);
    assert.strictEqual(priv.calls.length, 0);
    const mixed = make({ lookup: async () => [{ address: '140.82.112.5' }, { address: '127.0.0.1' }] });
    assert.match((await mixed.f.get('https://api.github.com/x')).error, /not public/, 'one private address among the answers is enough to refuse');
    const down = make({ lookup: async () => { throw new Error('ENOTFOUND'); } });
    assert.ok(!(await down.f.get('https://api.github.com/x')).ok);
    step('the name must resolve to public addresses only');
  }
  {
    const html = make({ respond: () => res(200, 'PNG', { 'content-type': 'image/png' }) });
    assert.match((await html.f.get('https://api.github.com/x')).error, /JSON and text/);
    const txt = make({ respond: () => res(200, 'hello', { 'content-type': 'text/plain; charset=utf-8' }) });
    const r = await txt.f.get('https://api.github.com/x');
    assert.deepStrictEqual([r.ok, r.text, r.json], [true, 'hello', null]);
    const big = make({ respond: () => res(200, '{"a":"' + 'x'.repeat(300 * 1024) + '"}') });
    const rb = await big.f.get('https://api.github.com/x');
    assert.deepStrictEqual([rb.truncated, rb.json, rb.text.length <= 16_000], [true, null, true], 'over 200 KB: cut, no json');
    const mid = make({ respond: () => res(200, JSON.stringify({ a: 'x'.repeat(40_000) })) });
    const rm = await mid.f.get('https://api.github.com/x');
    assert.deepStrictEqual([rm.json, rm.truncated, rm.text.length], [null, true, 16_000], 'json over 30 KB is not handed over; text is cut at 16,000');
    step('only JSON and text; 200 KB read limit; 16,000 chars of text; json under 30 KB');
  }
  {
    const hang = make({ respond: (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))), limits: { timeoutMs: 50 } });
    const t0 = Date.now(); const r = await hang.f.get('https://api.github.com/slow');
    assert.ok(!r.ok && /No answer within/.test(r.error) && Date.now() - t0 < 1500, JSON.stringify(r));
    await hang.f.get('https://api.github.com/slow');
    assert.strictEqual(hang.calls.length, 2, 'a network failure is not cached');
    const boom = make({ respond: () => { throw new Error('ECONNRESET'); } });
    assert.match((await boom.f.get('https://api.github.com/x')).error, /Could not reach/);
    step('timeout and network errors come back as answers, never throw');
  }
  {
    const { f, calls } = make({ limits: { globalPerMin: 3 } });
    for (let i = 0; i < 5; i++) await f.get('https://api.github.com/p' + i);
    assert.strictEqual(calls.length, 3, 'at most globalPerMin real calls a minute');
    assert.match((await f.get('https://api.github.com/p9')).error, /Too many outside requests/);
    step('the whole server makes at most 40 real calls a minute (here 3)');
  }
  {
    const { f } = make();
    for (const bad of ['https://evil.com/', null, 'x']) { const r = await f.get(bad); assert.ok(!r.ok && r.error); }
    assert.deepStrictEqual(f.hosts, H);
    assert.ok(f.check('https://api.github.com/a').url && f.check('https://nope.com/').error);
    step('get() never throws; check() is the same URL rule');
  }
  console.log('\nAll bot fetch checks passed.');
})().catch((e) => { console.error('\n✗ FAILED:', e); process.exit(1); });
