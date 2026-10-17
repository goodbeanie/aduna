// Validates uploaded images without trusting the client: checks the real file signature and reads
// the pixel dimensions from the header. Only PNG, JPEG and WebP are accepted (no SVG, which can
// carry scripts). Returns { mime, width, height } or null if the bytes are not a valid image.

function pngInfo(b) {
  if (b.length < 24 || !b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegInfo(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let m = b[i + 1];
    while (m === 0xff && i + 2 < b.length) { i++; m = b[i + 1]; } // fill bytes
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // no length field
    if (m === 0xd9 || m === 0xda) return null; // end / start of scan before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSOF = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (isSOF) {
      if (i + 9 > b.length) return null;
      return { mime: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpInfo(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') { // lossy
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L') { // lossless
    if (b[20] !== 0x2f) return null;
    const [b1, b2, b3, b4] = [b[21], b[22], b[23], b[24]];
    return { mime: 'image/webp', width: 1 + (b1 | ((b2 & 0x3f) << 8)), height: 1 + ((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10)) };
  }
  if (kind === 'VP8X') { // extended
    return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  const info = pngInfo(buf) || jpegInfo(buf) || webpInfo(buf);
  return info && info.width > 0 && info.height > 0 ? info : null;
}

// GIFs (custom emoji only). Walks the block structure, so a file that is truncated or not really a
// GIF is rejected, and returns a cleaned copy: comment, plain-text and unknown application
// extensions are dropped (they can carry hidden text or tracking data). Frames, palette and
// timing are kept. Returns { buf, width, height, frames } or null.
function cleanGif(b, maxFrames = 150) {
  if (!Buffer.isBuffer(b) || b.length < 14) return null;
  const sig = b.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  const width = b.readUInt16LE(6), height = b.readUInt16LE(8);
  if (!width || !height) return null;
  let pos = 13;
  if (b[10] & 0x80) pos += 3 * (1 << ((b[10] & 7) + 1));
  if (pos >= b.length) return null;
  const parts = [b.subarray(0, pos)];
  const skipSubBlocks = (p) => { // returns the position after the terminator, or -1
    while (p < b.length) { const n = b[p]; if (n === 0) return p + 1; p += 1 + n; }
    return -1;
  };
  let frames = 0;
  for (;;) {
    if (pos >= b.length) return null; // no trailer: truncated
    const t = b[pos];
    if (t === 0x3b) break;
    if (t === 0x21) {
      const label = b[pos + 1];
      let end;
      let keep = label === 0xf9;
      if (label === 0xff) {
        if (b[pos + 2] !== 11 || pos + 14 > b.length) return null;
        const id = b.toString('latin1', pos + 3, pos + 14);
        keep = id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0';
        end = skipSubBlocks(pos + 2);
      } else end = skipSubBlocks(pos + 2);
      if (end < 0) return null;
      if (keep) parts.push(b.subarray(pos, end));
      pos = end;
    } else if (t === 0x2c) {
      if (pos + 10 > b.length) return null;
      let p = pos + 10;
      if (b[pos + 9] & 0x80) p += 3 * (1 << ((b[pos + 9] & 7) + 1));
      p += 1; // LZW minimum code size
      const end = skipSubBlocks(p);
      if (end < 0) return null;
      if (++frames > maxFrames) return null;
      parts.push(b.subarray(pos, end));
      pos = end;
    } else return null;
  }
  if (!frames) return null;
  parts.push(Buffer.from([0x3b]));
  return { buf: Buffer.concat(parts), width, height, frames };
}

module.exports = { sniffImage, cleanGif };
