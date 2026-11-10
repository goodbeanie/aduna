// Unsafe link protection in the browser: node client/scripts/linksafe-test.mjs
import assert from 'assert';
import { analyzeLink, blockedBy, punycodeDecode, unicodeHost } from '../src/linksafe.js';
const ok = (m) => console.log('✓', m);

const none = new Set();
const level = (u, b = none) => analyzeLink(u, b).level;
const codes = (u, b = none) => analyzeLink(u, b).reasons.map((r) => r.code);

// ---- punycode
assert.strictEqual(punycodeDecode('bcher-kva'), 'bücher');
assert.strictEqual(unicodeHost('xn--bcher-kva.example'), 'bücher.example');
assert.strictEqual(unicodeHost('plain.example'), 'plain.example');
assert.strictEqual(punycodeDecode('\u00e9-'), null, 'non-ASCII in the basic part is refused');
ok('punycode is decoded the way a person would read it');

// ---- ordinary links are left alone
for (const u of [
  'https://github.com/owner/repo', 'https://aduna.onrender.com/app', 'https://accounts.google.com/signin', 'https://www.youtube.com/watch?v=abc',
  'https://steamcommunity.com/id/someone', 'https://discord.com/channels/1/2', 'https://discord.gg/abc', 'http://localhost:3000/app',
  'https://my-discord-bot.onrender.com', 'https://example.com/readme.txt', 'https://example.com/photo.png', 'https://\u4f8b\u3048.jp/',
  'https://en.wikipedia.org/wiki/Link_(rel)',
]) assert.strictEqual(level(u), 'ok', u + ' -> ' + JSON.stringify(analyzeLink(u, none)));
assert.strictEqual(level('not an address'), 'ok');
ok('ordinary links, official brand domains and honest Japanese names are not flagged');

// ---- 3. the blocklist: a hard block, covering subdomains
const list = new Set(['evil.example']);
assert.strictEqual(level('https://evil.example/x', list), 'block');
assert.strictEqual(level('https://login.evil.example/x', list), 'block');
assert.strictEqual(level('https://notevil.example/x', list), 'ok');
assert.deepStrictEqual(codes('https://a.b.evil.example', list), ['blocklist']);
assert.strictEqual(blockedBy('a.b.evil.example', list), 'evil.example');
assert.strictEqual(blockedBy('example', list), null);
assert.strictEqual(blockedBy('x.example', new Set()), null);
ok('a listed domain blocks itself and everything under it, and nothing that only looks similar');

// ---- 1. lookalike and disguised addresses
assert.ok(codes('http://192.168.1.5/login').includes('ip'));
assert.ok(codes('http://[::1]/').includes('ip'));
assert.ok(codes('https://google.com@evil.io/').includes('userinfo'));
assert.ok(codes('https://\u0430pple.com/').includes('lookalike'), 'a Cyrillic а inside "apple"');
assert.ok(codes('https://xn--pple-43d.com/').includes('lookalike'), 'the same address written as punycode');
assert.ok(codes('https://invoice.zip/a').includes('filetld'));
assert.ok(codes('https://paypal.com.evil.io/').includes('brand'));
assert.ok(codes('https://paypal-login.xyz/').includes('brand'));
assert.ok(codes('https://discord-nitro.gift/').includes('brand'));
assert.ok(codes('https://paypa1.com/').includes('brand'));
assert.ok(codes('https://disc0rd.com/').includes('brand'));
assert.ok(codes('https://steam.xyz/').includes('brand'));
for (const u of ['http://192.168.1.5/login', 'https://google.com@evil.io/', 'https://paypal.com.evil.io/']) assert.strictEqual(level(u), 'warn', u);
ok('lookalike letters, bare IPs, user@host tricks, .zip addresses and brand impersonation are warned about');

// ---- 2. known bad patterns
assert.ok(codes('https://bit.ly/abc').includes('shortener'));
assert.ok(codes('https://www.tinyurl.com/x').includes('shortener'));
assert.ok(codes('https://example.com/setup.exe').includes('download'));
assert.ok(codes('https://example.com/a/Installer.MSI?dl=1').includes('download'));
assert.ok(codes('https://example.com/report.pdf.exe').includes('download'));
assert.ok(codes('https://example.com/run%2Ebat').includes('download'), 'a percent-encoded dot does not hide the ending');
assert.strictEqual(level('https://example.com/setup.exe'), 'warn');
assert.strictEqual(analyzeLink('javascript:alert(1)', none).level, 'block');
assert.strictEqual(analyzeLink('data:text/html,<b>hi</b>', none).level, 'block');
assert.strictEqual(analyzeLink('vbscript:x', none).level, 'block');
ok('shorteners and program downloads are warned about; javascript: and data: addresses are blocked');

// ---- reasons add up, and every reason has words for the dialog
{
  const a = analyzeLink('http://1.2.3.4/a.exe', none);
  assert.strictEqual(a.level, 'warn');
  assert.ok(a.reasons.length >= 2 && a.reasons.every((r) => r.code && r.text.length > 10));
  assert.strictEqual(a.host, '1.2.3.4');
}
ok('several signs on one link are all reported');

console.log('\nlinksafe (browser): all checks passed');
