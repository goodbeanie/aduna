// trimImage: whatever follows the end of a PNG, JPEG or WebP is dropped; a good picture is never cut short. Needs no database.
const assert = require('assert');
const zlib = require('zlib');
const { sniffImage, trimImage } = require('./images');
const step = (m) => console.log('✓', m);

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function png(w = 4, h = 4) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// a small JPEG made of markers: SOI, APP0, SOF0 (w x h), SOS, entropy data with a stuffed FF00 and a restart marker, EOI
function jpeg(w = 8, h = 8) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]), sof, sos, Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]), Buffer.from([0xff, 0xd9])]);
}
function webp(w = 16, h = 16) { // lossless header only: enough for the signature checks and the RIFF length
  const body = Buffer.alloc(18); body.write('VP8L', 0, 'latin1'); body.writeUInt32LE(10, 4); body[8] = 0x2f; // 18 bytes: the whole file is 30, the least webpInfo accepts
  const bits = (w - 1) | ((h - 1) << 14); body.writeUInt32LE(bits >>> 0, 9);
  const riff = Buffer.concat([Buffer.from('WEBP', 'latin1'), body]);
  const head = Buffer.alloc(8); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(riff.length, 4);
  return Buffer.concat([head, riff]);
}

const payload = Buffer.from('<script>alert(1)</script>PK\x03\x04 hidden payload FFD9 IEND', 'latin1');

// PNG
{
  const p = png();
  assert.ok(sniffImage(p));
  assert.strictEqual(trimImage(p), p, 'a clean PNG comes back as the same buffer');
  const dirty = Buffer.concat([p, payload]);
  assert.ok(sniffImage(dirty), 'the picture still passes the signature check with a payload behind it');
  assert.ok(trimImage(dirty).equals(p), 'bytes after IEND are dropped');
  assert.ok(trimImage(Buffer.concat([p, Buffer.from([0])])).equals(p), 'even one byte');
  const noEnd = p.subarray(0, p.length - 12); // IEND missing: truncated, left alone
  assert.strictEqual(trimImage(noEnd), noEnd, 'a PNG with no IEND is not touched');
  const cutMid = p.subarray(0, p.length - 20);
  assert.strictEqual(trimImage(cutMid), cutMid, 'a PNG cut in the middle of a chunk is not touched');
  step('trimImage: PNG cut at IEND, clean and truncated files untouched');
}

// JPEG
{
  const j = jpeg();
  assert.ok(sniffImage(j));
  assert.strictEqual(trimImage(j), j, 'a clean JPEG comes back as the same buffer');
  assert.ok(trimImage(Buffer.concat([j, payload])).equals(j), 'bytes after the end-of-image marker are dropped, even a payload that contains FFD9 text');
  assert.ok(trimImage(Buffer.concat([j, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 4, 0, 0, 0xff, 0xd9])])).equals(j), 'a second picture glued on behind it is dropped');
  const noEnd = j.subarray(0, j.length - 2);
  assert.strictEqual(trimImage(noEnd), noEnd, 'a JPEG with no end marker is not touched');
  step('trimImage: JPEG cut at the real EOI (stuffed FF00 and restart markers skipped), truncated files untouched');
}

// WebP
{
  const w = webp();
  assert.ok(sniffImage(w));
  assert.strictEqual(trimImage(w), w, 'a clean WebP comes back as the same buffer');
  assert.ok(trimImage(Buffer.concat([w, payload])).equals(w), 'bytes past the RIFF length are dropped');
  const lie = Buffer.from(w); lie.writeUInt32LE(w.length + 500, 4);
  assert.strictEqual(trimImage(lie), lie, 'a RIFF length longer than the file is not trusted');
  step('trimImage: WebP cut at the RIFF length, a lying length left alone');
}

// everything else passes through
{
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), audio = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00 some audio bytes');
  for (const x of [gif, audio, Buffer.alloc(0), Buffer.from('hello')]) assert.strictEqual(trimImage(x), x, 'not a still picture: same buffer');
  for (const x of [null, undefined, 'text', 5, {}]) assert.strictEqual(trimImage(x), x, 'not a buffer: returned as given');
  step('trimImage: GIFs, audio, empty and non-buffers pass through untouched');
}
