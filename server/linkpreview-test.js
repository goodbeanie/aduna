// Tests for linkpreview.js with a fake network (no real connections). Run: node server/linkpreview-test.js
const assert = require('assert');
const { Readable } = require('stream');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const P = require('./linkpreview');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

// a fake http/https: routes is { url: { status, headers, body (Buffer), chunk? } }; records what was asked
function fakeNet(routes) {
  const seen = [];
  const make = (proto) => ({
    get(url, opts, cb) {
      seen.push({ url, opts, proto });
      const req = new EventEmitter();
      req.destroy = () => {};
      setImmediate(() => {
        const r = routes[url];
        if (!r) return req.emit('error', Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
        if (r.error) return req.emit('error', Object.assign(new Error('x'), { code: r.error }));
        const body = r.body || Buffer.alloc(0);
        const parts = r.chunk ? Array.from({ length: Math.ceil(body.length / r.chunk) }, (_, i) => body.subarray(i * r.chunk, (i + 1) * r.chunk)) : [body];
        const res = Readable.from(parts);
        res.statusCode = r.status || 200; res.headers = r.headers || {};
        cb(res);
      });
      return req;
    },
  });
  return { impl: { http: make('http'), https: make('https') }, seen };
}
const html = (head) => Buffer.from(`<!doctype html><html><head>${head}</head><body>${'x'.repeat(5000)}</body></html>`);

(async () => {
  // ---- normalizeUrl ----
  assert.strictEqual(P.normalizeUrl('https://example.com/a#frag'), 'https://example.com/a');
  for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'https://u:p@example.com', 'https://example.com:8080/', 'http://localhost/', 'http://intranet/', '', 'x'.repeat(2100), 'not a url', null, 42]) assert.strictEqual(P.normalizeUrl(bad), null, String(bad));
  assert.ok(P.normalizeUrl('http://93.184.216.34/'), 'a public IP literal is a fine URL');
  for (const bad of ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[64:ff9b::7f00:1]/', 'http://0.0.0.0/', 'http://192.168.0.1/']) assert.strictEqual(P.normalizeUrl(bad), null, bad + ' must be refused before any connection');
  console.log('ok: url rules');

  // ---- publicLookup: the guard that sits inside the connection ----
  const lk = (addrs) => P.publicLookup((_h, _o, cb) => cb(null, addrs));
  const run = (look, host, opts = {}) => new Promise((r) => look(host, opts, (e, a, f) => r({ e, a, f })));
  assert.ok((await run(lk([{ address: '127.0.0.1', family: 4 }]), 'evil.example')).e, 'loopback refused');
  assert.ok((await run(lk([{ address: '10.0.0.5', family: 4 }]), 'evil.example')).e, 'private refused');
  assert.ok((await run(lk([{ address: '169.254.169.254', family: 4 }]), 'evil.example')).e, 'cloud metadata refused');
  assert.ok((await run(lk([{ address: '::1', family: 6 }]), 'evil.example')).e, 'ipv6 loopback refused');
  assert.ok((await run(lk([{ address: '::ffff:7f00:1', family: 6 }]), 'evil.example')).e, 'mapped loopback (hex spelling) refused');
  assert.ok((await run(lk([{ address: '::ffff:10.0.0.1', family: 6 }]), 'evil.example')).e, 'mapped private (dotted) refused');
  assert.ok((await run(lk([{ address: '64:ff9b::a00:1', family: 6 }]), 'evil.example')).e, 'NAT64 refused');
  assert.ok(!(await run(lk([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]), 'example.com')).e, 'a public ipv6 address is allowed');
  assert.ok((await run(lk([{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.1', family: 4 }]), 'mixed.example')).e, 'one private address among public ones: refused');
  const ok = await run(lk([{ address: '93.184.216.34', family: 4 }]), 'example.com');
  assert.ok(!ok.e && ok.a === '93.184.216.34' && ok.f === 4, 'public allowed');
  const okAll = await run(lk([{ address: '93.184.216.34', family: 4 }]), 'example.com', { all: true });
  assert.deepStrictEqual(okAll.a, [{ address: '93.184.216.34', family: 4 }], 'all:true gives the list');
  assert.ok((await run(lk([]), 'empty.example')).e, 'no addresses: refused');
  assert.ok((await run(P.publicLookup(() => { throw new Error('unused'); }), '127.0.0.1')).e, 'private IP literal refused without any lookup');
  console.log('ok: connection-level address guard (incl. rebinding case)');

  // ---- parseHtml ----
  const p = P.parseHtml(`<head><title>Fallback</title>
    <meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;Best&quot; Page">
    <meta property='og:description' content='  A   long
      description  '>
    <meta property="og:site_name" content="Cartoons">
    <meta property="og:image" content="/img/cover.png?a=1&amp;b=2"></head>`, 'https://www.example.com/post/1');
  assert.strictEqual(p.title, 'Tom & Jerry\'s "Best" Page');
  assert.strictEqual(p.description, 'A long description');
  assert.strictEqual(p.site, 'Cartoons');
  assert.strictEqual(p.image, 'https://www.example.com/img/cover.png?a=1&b=2');
  const q = P.parseHtml('<title>Just a title</title><meta name="description" content="Plain">', 'https://www.example.com/x');
  assert.deepStrictEqual([q.title, q.description, q.site, q.image], ['Just a title', 'Plain', 'example.com', '']);
  assert.strictEqual(P.parseHtml('<meta property="og:image" content="javascript:alert(1)"><title>t</title>', 'https://a.example.com/').image, '', 'a javascript: image is dropped');
  assert.strictEqual(P.parseHtml('<meta property="og:image" content="http://localhost/x.png"><title>t</title>', 'https://a.example.com/').image, '', 'a localhost image is dropped');
  const longT = P.parseHtml(`<title>${'a'.repeat(500)}</title>`, 'https://a.example.com/').title;
  assert.ok(Array.from(longT).length === P.LIMITS.title && longT.endsWith('\u2026'));
  assert.strictEqual(P.clean('a\u202eb\u0000c'), 'a b c', 'bidi override and control characters become spaces');
  console.log('ok: parsing, entities, caps, unsafe images');

  // ---- sniffImage ----
  assert.strictEqual(P.sniffImage(PNG), 'image/png');
  assert.strictEqual(P.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'svg is never a preview picture');
  assert.strictEqual(P.sniffImage(Buffer.from('<html>')), null);
  console.log('ok: picture sniffing');

  // ---- preview + image through the fake network ----
  let n = fakeNet({
    'https://example.com/a': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: html('<title>Hello</title><meta property="og:image" content="https://example.com/p.png">'), chunk: 700 },
    'https://example.com/p.png': { headers: { 'content-type': 'image/png' }, body: PNG },
    'https://example.com/other.png': { headers: { 'content-type': 'image/png' }, body: PNG },
    'https://example.com/fake.png': { headers: { 'content-type': 'image/png' }, body: Buffer.from('<svg></svg>') },
    'https://example.com/go': { status: 301, headers: { location: 'https://example.com/a' } },
    'https://example.com/loop': { status: 302, headers: { location: 'https://example.com/loop' } },
    'https://example.com/priv': { status: 302, headers: { location: 'http://127.0.0.1/admin' } },
    'https://example.com/json': { headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') },
    'https://example.com/404': { status: 404, headers: { 'content-type': 'text/html' }, body: html('<title>gone</title>') },
    'https://example.com/empty': { headers: { 'content-type': 'text/html' }, body: html('') },
    'https://example.com/gz': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: zlib.gzipSync(html('<title>Zipped</title>')) },
    'https://example.com/huge': { headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><head><title>Big</title>' + 'y'.repeat(900 * 1024)), chunk: 65536 },
    'https://example.com/down': { error: 'ECONNRESET' },
  });
  let t = 1_000_000;
  const pv = P.createPreviewer({ httpImpl: n.impl, now: () => t });

  let r = await pv.preview('https://example.com/a#x');
  assert.ok(r.ok && r.preview.title === 'Hello' && r.preview.image === 'https://example.com/p.png', JSON.stringify(r));
  assert.strictEqual(typeof n.seen[0].opts.lookup, 'function', 'the guarded lookup is used for the connection');
  const calls = n.seen.length;
  await pv.preview('https://example.com/a'); assert.strictEqual(n.seen.length, calls, 'second ask comes from the cache');
  await Promise.all([pv.preview('https://example.com/gz'), pv.preview('https://example.com/gz')]);
  assert.strictEqual(n.seen.filter((s) => s.url.endsWith('/gz')).length, 1, 'two asks at once make one request');
  assert.strictEqual((await pv.preview('https://example.com/gz')).preview.title, 'Zipped', 'gzip is understood');
  console.log('ok: preview, cache, de-duplication, gzip');

  assert.strictEqual((await pv.preview('https://example.com/go')).preview.title, 'Hello', 'a redirect is followed');
  assert.ok(!(await pv.preview('https://example.com/loop')).ok, 'redirect loop stops');
  const pr = await pv.preview('https://example.com/priv');
  assert.ok(!pr.ok && !n.seen.some((s) => s.url.includes('127.0.0.1')), 'a redirect to a private address is never requested');
  assert.ok(!(await pv.preview('https://example.com/json')).ok, 'not html');
  assert.ok(!(await pv.preview('https://example.com/404')).ok, '404');
  assert.ok(!(await pv.preview('https://example.com/empty')).ok, 'nothing to show');
  assert.ok(!(await pv.preview('https://example.com/down')).ok, 'network failure');
  assert.ok(!(await pv.preview('ftp://example.com/')).ok && !(await pv.preview('http://localhost/')).ok, 'bad urls');
  const big = await pv.preview('https://example.com/huge');
  assert.ok(big.ok && big.preview.title === 'Big', 'a huge page is cut at the end of <head> without reading it all');
  console.log('ok: redirects, private redirect, non-html, errors, huge page');

  // failures are cached briefly, network failures are not
  const c404 = n.seen.filter((s) => s.url.endsWith('/404')).length;
  await pv.preview('https://example.com/404'); assert.strictEqual(n.seen.filter((s) => s.url.endsWith('/404')).length, c404, 'a failing page is not hammered');
  const cd = n.seen.filter((s) => s.url.endsWith('/down')).length;
  await pv.preview('https://example.com/down'); assert.strictEqual(n.seen.filter((s) => s.url.endsWith('/down')).length, cd + 1, 'a network failure is retried');
  t += P.LIMITS.failMs + 1; await pv.preview('https://example.com/404');
  assert.strictEqual(n.seen.filter((s) => s.url.endsWith('/404')).length, c404 + 1, 'a failure is retried after 10 minutes');
  console.log('ok: failure caching');

  // images: only those a previewed page named, only real pictures
  assert.ok((await pv.image('https://example.com/p.png')).ok, 'a named picture is served');
  const im = await pv.image('https://example.com/p.png');
  assert.ok(im.ok && im.type === 'image/png' && Buffer.compare(im.body, PNG) === 0);
  assert.ok(!(await pv.image('https://example.com/other.png')).ok, 'a picture no page named is refused');
  assert.ok(!(await pv.image('http://127.0.0.1/x.png')).ok && !(await pv.image('nonsense')).ok, 'bad or private picture urls refused');
  console.log('ok: picture proxy rules');

  // the fake .png that is really svg
  const n2 = fakeNet({
    'https://e.example.com/page': { headers: { 'content-type': 'text/html' }, body: html('<title>T</title><meta property="og:image" content="https://e.example.com/fake.png">') },
    'https://e.example.com/fake.png': { headers: { 'content-type': 'image/png' }, body: Buffer.from('<svg onload="alert(1)"></svg>') },
  });
  const pv2 = P.createPreviewer({ httpImpl: n2.impl, now: () => t });
  await pv2.preview('https://e.example.com/page');
  assert.ok(!(await pv2.image('https://e.example.com/fake.png')).ok, 'svg labelled as png is refused (checked by its bytes)');
  console.log('ok: mislabelled picture refused');

  // global limit
  const n3 = fakeNet(Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['https://l.example.com/' + i, { headers: { 'content-type': 'text/html' }, body: html('<title>t' + i + '</title>') }])));
  const pv3 = P.createPreviewer({ httpImpl: n3.impl, now: () => t, limits: { globalPerMin: 4 } });
  const res = []; for (let i = 0; i < 6; i++) res.push((await pv3.preview('https://l.example.com/' + i)).ok);
  assert.deepStrictEqual(res, [true, true, true, true, false, false], 'the server-wide limit holds');
  console.log('ok: server-wide rate limit');

  console.log('link preview tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
