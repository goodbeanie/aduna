// Link previews: the title, description and picture of a web page, for the card under a message that contains a link.
// The server fetches the page, so this is only used where the server may see the link anyway (channel messages), or in a DM when the SENDER
// switched "link previews in DMs" on (the result is then embedded in the encrypted message; see client/src/linkpreview.js).
// No Express and no database in here: tested by linkpreview-test.js with a fake network.
//
// What keeps this from being a way to aim the server at things it should not reach:
//  - http and https only, no user:password, only the default ports, at most 2000 characters, at most 3 redirects (each one checked again);
//  - the host name must resolve to PUBLIC addresses only, and that check happens inside the lookup the connection itself uses, so a name that
//    answers differently the second time (DNS rebinding) still cannot reach a private address;
//  - 6 s, 400 KB of page (we stop at </head>), only HTML; pictures 3 MB, only PNG, JPEG, GIF or WebP checked by their first bytes (never SVG);
//  - a picture is only fetched if a page we previewed named it, and it is passed on from here, so the readers never contact the site;
//  - answers are cached, a failing page is not hammered, and the whole server makes at most 120 outside requests a minute.
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { isPrivateAddress } = require('./botfetch');

const LIMITS = {
  urlLen: 2000,
  timeoutMs: 6000,
  maxHtml: 400 * 1024,
  maxImage: 3 * 1024 * 1024,
  redirects: 3,
  cacheMs: 60 * 60_000,
  failMs: 10 * 60_000,
  cacheMax: 500,
  imageCacheMax: 40,
  imageCacheBytes: 24 * 1024 * 1024,
  advertMax: 3000,
  globalPerMin: 120,
  title: 160,
  desc: 300,
  site: 60,
};

// Addresses we never connect to. isPrivateAddress (shared with the bot fetcher) covers the common ranges; this list adds the rest, and refuses
// every IPv4-mapped and NAT64 IPv6 address (including the hex spelling ::ffff:7f00:1 that a dotted-quad check misses).
const blockV4 = new net.BlockList(); // two lists: Node compares an IPv4 address as if it were IPv4-mapped IPv6, so one shared list would block every IPv4 address
const blockV6 = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blockV4.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blockV6.addSubnet(a, bits, 'ipv6');
function blockedAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateAddress(ip) || blockV4.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return isPrivateAddress(ip) || blockV6.check(ip, 'ipv6');
  return true;
}

// the normalised URL, or null if it is not one we are willing to fetch
function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > LIMITS.urlLen) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const bare = u.hostname.replace(/^\[|\]$/g, '');
  if (!bare) return null;
  if (net.isIP(bare)) { if (blockedAddress(bare)) return null; } // Node does not call our lookup for an address, so it is judged here ("http://127.0.0.1", "http://2130706433" and "http://0x7f.1" all become 127.0.0.1)
  else if (!bare.includes('.')) return null; // "localhost", "intranet": no dot, not a public name
  u.hash = '';
  return u.toString();
}

// Used as the connection's own lookup: refuses to hand back anything that is not a public address.
function publicLookup(lookupImpl = dns.lookup) {
  return (hostname, options, cb) => {
    const done = typeof options === 'function' ? options : cb;
    const bare = String(hostname).replace(/^\[|\]$/g, '');
    const check = (err, addrs) => {
      if (err) return done(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIPv6(addrs) ? 6 : 4 }];
      if (!list.length || list.some((a) => blockedAddress(a.address))) return done(Object.assign(new Error('That address is not public'), { code: 'EPRIVATE' }));
      if (options && typeof options === 'object' && options.all) return done(null, list);
      return done(null, list[0].address, list[0].family);
    };
    if (net.isIP(bare)) return check(null, [{ address: bare, family: net.isIPv6(bare) ? 6 : 4 }]);
    lookupImpl(hostname, { all: true }, check);
  };
}

function decodeBody(buf, contentType) {
  const cs = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1] || 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function clean(s, max) {
  const t = decodeEntities(String(s || '')).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim(); // control and bidi-override characters out
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '\u2026' : t;
}

// { url, title, description, site, image } from the start of an HTML page. Every field may be empty.
function parseHtml(html, baseUrl) {
  const meta = {};
  for (const tag of String(html).match(/<meta\s[^>]*>/gi) || []) {
    const attrs = {};
    tag.replace(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g, (_m, k, a, b, c) => { attrs[k.toLowerCase()] = a ?? b ?? c ?? ''; return ''; });
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && meta[key] === undefined) meta[key] = attrs.content;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const host = new URL(baseUrl).hostname.replace(/^www\./, '');
  let image = meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] || meta['twitter:image'] || meta['twitter:image:src'] || '';
  try { image = image ? normalizeUrl(new URL(decodeEntities(image).trim(), baseUrl).toString()) || '' : ''; } catch { image = ''; }
  return {
    url: baseUrl,
    title: clean(meta['og:title'] || meta['twitter:title'] || titleTag, LIMITS.title),
    description: clean(meta['og:description'] || meta['twitter:description'] || meta.description, LIMITS.desc),
    site: clean(meta['og:site_name'] || host, LIMITS.site),
    image,
  };
}

function sniffImage(b) {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function createPreviewer({ httpImpl = { http, https }, lookup = dns.lookup, now = Date.now, limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const pageCache = new Map();   // url -> { at, result }
  const imageCache = new Map();  // url -> { at, type, body }
  const adverts = new Map();     // image url -> time a previewed page named it
  const inflight = new Map();
  let imageBytes = 0;
  let calls = [];
  const connLookup = publicLookup(lookup);

  const allowCall = () => {
    const t = now();
    calls = calls.filter((x) => t - x < 60_000);
    if (calls.length >= L.globalPerMin) return false;
    calls.push(t);
    return true;
  };

  // One GET, redirects followed by hand. Resolves { status, type, body } and never rejects.
  function get(url, { accept, maxBytes, stopAt }) {
    return new Promise((resolve) => {
      let hops = 0, finished = false;
      const finish = (r) => { if (!finished) { finished = true; resolve(r); } };
      const go = (target) => {
        const safe = normalizeUrl(target);
        if (!safe) return finish({ status: 0, error: 'That link cannot be previewed' });
        const lib = safe.startsWith('https:') ? httpImpl.https : httpImpl.http;
        const req = lib.get(safe, {
          lookup: connLookup,
          timeout: L.timeoutMs,
          headers: { 'User-Agent': 'AdunaLinkPreview/1.0 (+link preview for a chat message)', Accept: accept, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
        }, (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (++hops > L.redirects) return finish({ status, error: 'Too many redirects' });
            let next; try { next = new URL(res.headers.location, safe).toString(); } catch { return finish({ status, error: 'Bad redirect' }); }
            return go(next);
          }
          const enc = String(res.headers['content-encoding'] || '').toLowerCase();
          let stream = res;
          if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
          else if (enc && enc !== 'identity') { res.destroy(); return finish({ status, error: 'Unsupported encoding' }); }
          const type = String(res.headers['content-type'] || '').toLowerCase();
          const declared = Number(res.headers['content-length']);
          if (!enc && Number.isFinite(declared) && declared > maxBytes && stopAt === undefined) { res.destroy(); return finish({ status, type, error: 'Too large' }); }
          const chunks = []; let total = 0, text = '';
          const stop = (extra) => { stream.destroy(); res.destroy(); finish({ status, type, body: Buffer.concat(chunks), ...extra }); };
          stream.on('data', (c) => {
            if (finished) return;
            total += c.length;
            if (total > maxBytes) {
              if (stopAt === undefined) return stop({ error: 'Too large' });
              chunks.push(c.subarray(0, c.length - (total - maxBytes))); return stop({ truncated: true });
            }
            chunks.push(c);
            if (stopAt) { text = (text + c.toString('latin1')).slice(-64); if (/<\/head>|<body[\s>]/i.test(text)) stop({ truncated: true }); }
          });
          stream.on('end', () => finish({ status, type, body: Buffer.concat(chunks) }));
          stream.on('error', () => finish({ status, type, error: 'Could not read that page' }));
        });
        req.on('timeout', () => { req.destroy(); finish({ status: 0, error: `No answer within ${L.timeoutMs / 1000} seconds` }); });
        req.on('error', (e) => finish({ status: 0, error: e && e.code === 'EPRIVATE' ? 'That address is not public' : 'Could not reach that site' }));
      };
      go(url);
    });
  }

  async function fetchPage(url) {
    if (!allowCall()) return { ok: false, error: 'Too many previews right now, try again in a minute' };
    const r = await get(url, { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', maxBytes: L.maxHtml, stopAt: '</head>' });
    if (r.error || !r.body) return { ok: false, error: r.error || 'No preview', fail: r.status > 0 };
    if (r.status < 200 || r.status >= 300) return { ok: false, error: `The site answered ${r.status}`, fail: true };
    if (!/^(text\/html|application\/xhtml)/.test(r.type)) return { ok: false, error: 'Not a web page', fail: true };
    const p = parseHtml(decodeBody(r.body, r.type), url);
    if (!p.title && !p.description && !p.image) return { ok: false, error: 'This page has nothing to show', fail: true };
    if (p.image) { adverts.delete(p.image); adverts.set(p.image, now()); while (adverts.size > L.advertMax) adverts.delete(adverts.keys().next().value); }
    return { ok: true, preview: p };
  }

  // preview(rawUrl) -> { ok: true, preview } or { ok: false, error }. Never throws.
  async function preview(raw) {
    const url = normalizeUrl(raw);
    if (!url) return { ok: false, error: 'That link cannot be previewed' };
    const hit = pageCache.get(url);
    if (hit && now() - hit.at < (hit.result.ok ? L.cacheMs : L.failMs)) return hit.result;
    if (inflight.has(url)) return inflight.get(url);
    const p = fetchPage(url).then((result) => {
      if (result.ok || result.fail) { // a page that answered is remembered (good or bad); a network failure is not
        if (pageCache.size >= L.cacheMax) pageCache.delete(pageCache.keys().next().value);
        pageCache.set(url, { at: now(), result: { ok: result.ok, error: result.error, preview: result.preview } });
      }
      return result.ok ? { ok: true, preview: result.preview } : { ok: false, error: result.error };
    }).catch(() => ({ ok: false, error: 'No preview' })).finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }

  // image(rawUrl) -> { ok: true, type, body } or { ok: false }. Only for pictures a previewed page named.
  async function image(raw) {
    const url = normalizeUrl(raw);
    if (!url || !adverts.has(url)) return { ok: false };
    const hit = imageCache.get(url);
    if (hit && now() - hit.at < L.cacheMs) return { ok: true, type: hit.type, body: hit.body };
    if (inflight.has('img:' + url)) return inflight.get('img:' + url);
    const p = (async () => {
      if (!allowCall()) return { ok: false };
      const r = await get(url, { accept: 'image/png,image/jpeg,image/webp,image/gif;q=0.9', maxBytes: L.maxImage });
      if (r.error || !r.body || r.status < 200 || r.status >= 300) return { ok: false };
      const type = sniffImage(r.body);
      if (!type) return { ok: false };
      imageBytes += r.body.length;
      imageCache.set(url, { at: now(), type, body: r.body });
      while (imageCache.size > L.imageCacheMax || imageBytes > L.imageCacheBytes) {
        const k = imageCache.keys().next().value; imageBytes -= imageCache.get(k).body.length; imageCache.delete(k);
      }
      return { ok: true, type, body: r.body };
    })().catch(() => ({ ok: false })).finally(() => inflight.delete('img:' + url));
    inflight.set('img:' + url, p);
    return p;
  }

  return { preview, image, clear: () => { pageCache.clear(); imageCache.clear(); adverts.clear(); imageBytes = 0; } };
}

module.exports = { LIMITS, blockedAddress, normalizeUrl, publicLookup, parseHtml, decodeEntities, clean, sniffImage, createPreviewer };
