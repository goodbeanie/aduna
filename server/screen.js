// Clip screening: the automatic checks a clip passes before it goes live. No Express and no database, so screen-test.js can test it alone.
//
// Three checks, each switched on by what is configured (see settings()):
//   1. Content   : a few frames of the video, plus the cover picture, go to OpenAI's moderation endpoint (omni-moderation-latest, free):
//                  scores for sexual content / nudity, graphic violence and violence. Needs OPENAI_API_KEY.
//   2. Music     : the soundtrack goes to AudD, which says whether it recognises a commercial recording. Needs AUDD_API_TOKEN.
//   3. Re-posts  : a tiny picture fingerprint (dHash) of each sampled frame is kept on the clip record, and a new clip is compared with
//                  clips other people have posted and with clips a moderator removed. Needs nothing but ffmpeg (no outside service).
// Frames and sound are cut out with ffmpeg (the ffmpeg-static package, or FFMPEG_PATH, or ffmpeg on the PATH).
//
// What this is NOT: it does not recognise a film, show or game it has never seen (that takes a content-ID service such as Audible Magic
// or Pex), and a moderation score is a guess, not a verdict. That is why a middling score holds the clip for a moderator instead of
// deleting it; only a confident score on more than one frame (or on the cover picture) rejects it.
//
// A clip ends up as one of three verdicts (decide()): 'pass' (goes live), 'review' (hidden until a moderator looks) or 'block' (rejected).
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MB = 1024 * 1024;
const SEVERITY = { pass: 0, review: 1, block: 2 };

// What the moderation endpoint is asked about. `graded` categories (plain violence) are far noisier than the other two (a tackle, a
// cartoon, a boxing match), so they need a much higher score before anyone is bothered.
const CATEGORIES = [
  { key: 'sexual', label: 'nudity or sexual content', graded: false },
  { key: 'violence/graphic', label: 'graphic violence', graded: false },
  { key: 'violence', label: 'violence', graded: true },
];

function num(v, d, min, max) {
  if (v === undefined || v === null || String(v).trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : d;
}
const choice = (v, allowed, d) => { const s = String(v ?? '').trim().toLowerCase(); return allowed.includes(s) ? s : d; };

function settings(env = process.env) {
  const openaiKey = String(env.OPENAI_API_KEY || '').trim();
  const auddToken = String(env.AUDD_API_TOKEN || '').trim();
  const off = choice(env.CLIP_SCREEN, ['on', 'off'], 'on') === 'off';
  const musicAction = choice(env.CLIP_COPYRIGHT_ACTION, ['block', 'review', 'off'], 'block');
  const dupeAction = choice(env.CLIP_DUPES_ACTION, ['block', 'review', 'off'], 'review');
  const review = num(env.CLIP_SCREEN_REVIEW, 0.5, 0.05, 0.99);
  const block = Math.max(review, num(env.CLIP_SCREEN_BLOCK, 0.85, 0.05, 1));
  return {
    on: !off && !!(openaiKey || auddToken),     // nothing is screened until at least one outside service has a key
    moderation: !off && !!openaiKey,
    music: !off && !!auddToken && musicAction !== 'off',
    dupes: dupeAction !== 'off',
    openaiKey, auddToken, musicAction, dupeAction, review, block,
    frames: Math.round(num(env.CLIP_SCREEN_FRAMES, 6, 3, 12)),
    onError: choice(env.CLIP_SCREEN_FAIL, ['review', 'open'], 'review'), // when a check could not finish: hold the clip, or let it through
    timeoutMs: num(env.CLIP_SCREEN_TIMEOUT_S, 60, 10, 300) * 1000,
    concurrency: Math.round(num(env.CLIP_SCREEN_CONCURRENCY, 1, 1, 4)), // clips screened at the same time (ffmpeg is heavy on a small server)
    ffmpeg: String(env.FFMPEG_PATH || '').trim(),
  };
}

// ---------- picture fingerprints ----------
// ffmpeg hands over each sampled frame shrunk to 9x8 grey pixels (72 bytes). dHash: for every row, is each pixel darker than its right
// neighbour? 8 rows x 8 answers = 64 bits, written as 16 hex characters. The same picture re-encoded, resized or lightly cropped gives
// nearly the same bits; two different pictures differ in about half of them.
const popcount8 = (n) => { let c = 0; for (let x = n; x; x >>= 1) c += x & 1; return c; };
function dhash(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 72) return null;
  const out = Buffer.alloc(8);
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (raw[y * 9 + x] < raw[y * 9 + x + 1] ? 1 : 0);
    out[y] = byte;
  }
  return out.toString('hex');
}
const validHash = (h) => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h);
const byteAt = (h, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16);
function distance(a, b) { let d = 0; for (let i = 0; i < 8; i++) d += popcount8(byteAt(a, i) ^ byteAt(b, i)); return d; }
// a blank or almost-flat picture (black screen, fade, solid colour) looks like every other one, so it says nothing
function flat(h) { let n = 0; for (let i = 0; i < 8; i++) n += popcount8(byteAt(h, i)); return n < 7 || n > 57; }

const MAX_DIST = 8; // of 64 bits
function sameVideo(a, b) {
  const A = (a || []).filter((h) => validHash(h) && !flat(h));
  const B = (b || []).filter((h) => validHash(h) && !flat(h));
  if (A.length < 3 || B.length < 3) return false; // too little to go on
  const matched = A.filter((h) => B.some((g) => distance(h, g) <= MAX_DIST)).length;
  return matched >= Math.max(3, Math.ceil(A.length * 0.6));
}
// Is this a clip someone else already posted (kind 'repost'), or one a moderator took down (kind 'removed', whoever posts it)?
// Your own earlier clips do not count: people do post the same thing twice.
function findDuplicate(hashes, clips, { ownerId, selfId } = {}) {
  let repost = null;
  for (const c of clips || []) {
    if (!c || c.id === selfId || !c.screen || !Array.isArray(c.screen.hashes)) continue;
    const takedown = !!c.takedown;
    const posted = (c.state === 'live' || c.state === 'hidden') && !c.purgedAt && c.owner !== ownerId;
    if (!takedown && !posted) continue;
    if (!sameVideo(hashes, c.screen.hashes)) continue;
    if (takedown) return { kind: 'removed', clipId: c.id };
    repost = repost || { kind: 'repost', clipId: c.id };
  }
  return repost;
}

// ---------- judging the findings (pure) ----------
function levels(cfg, cat) {
  if (!cat.graded) return { review: cfg.review, block: cfg.block };
  return { review: Math.min(0.95, cfg.review + 0.25), block: 0.97 };
}
// frames: [{ cover: bool, scores: { sexual, violence, 'violence/graphic' } }]. One uncertain frame holds the clip for a person; a clip is only
// rejected outright when the score is high on at least two frames of the video (one, when the video gave fewer than three), or on the cover picture
// (which somebody chose on purpose).
function judgeImages(frames, cfg) {
  const out = { verdict: 'pass', labels: [], max: {}, frames: frames.length };
  for (const cat of CATEGORIES) out.max[cat.key] = 0;
  const video = frames.filter((f) => !f.cover);
  for (const cat of CATEGORIES) {
    const lv = levels(cfg, cat);
    const score = (f) => Number(f.scores && f.scores[cat.key]) || 0;
    for (const f of frames) out.max[cat.key] = Math.max(out.max[cat.key], score(f));
    const high = frames.filter((f) => score(f) >= lv.block);
    const middling = frames.filter((f) => score(f) >= lv.review);
    const need = video.length < 3 ? 1 : 2;
    let verdict = 'pass';
    if (high.some((f) => f.cover) || high.filter((f) => !f.cover).length >= need) verdict = 'block';
    else if (middling.length) verdict = 'review';
    if (SEVERITY[verdict] > SEVERITY[out.verdict]) { out.verdict = verdict; out.labels = [cat.label]; }
    else if (verdict !== 'pass' && verdict === out.verdict) out.labels.push(cat.label);
  }
  return out;
}

const quote = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
const nameOf = (m) => (m && m.title ? `“${quote(m.title)}”${m.artist ? ' by ' + quote(m.artist) : ''}` : 'a known recording');
const pct = (x) => Math.round((Number(x) || 0) * 100) / 100;

// findings: { mod, music, dupe, errors } as analyze() returns them. Returns what to do and what to tell people.
function decide(f, cfg) {
  let verdict = 'pass';
  const reasons = [], blocking = [], notes = [];
  const raise = (v, code, why, note) => {
    if (SEVERITY[v] > SEVERITY[verdict]) verdict = v;
    if (!reasons.includes(code)) reasons.push(code);
    if (v === 'block') blocking.push(why);
    notes.push(note);
  };
  if (f.mod && f.mod.verdict !== 'pass') {
    const top = Math.max(...CATEGORIES.map((c) => f.mod.max[c.key] || 0));
    raise(f.mod.verdict, 'content', `it looks like it contains ${f.mod.labels.join(' and ')}`, `${f.mod.verdict === 'block' ? 'Content' : 'Content (unsure)'}: ${f.mod.labels.join(', ')} (top score ${pct(top)})`);
  }
  if (f.music && f.music.match && cfg.musicAction !== 'off') {
    raise(cfg.musicAction, 'music', `it has music we recognise (${nameOf(f.music.match)}). Post it without that music, or with sound you own`, `Music: ${nameOf(f.music.match)}`);
  }
  if (f.dupe && cfg.dupeAction !== 'off') {
    const removed = f.dupe.kind === 'removed';
    raise(cfg.dupeAction, 'duplicate', removed ? 'it matches a video that was removed from Clips' : 'it matches a clip that someone else already posted',
      removed ? `Matches a clip a moderator removed (${f.dupe.clipId})` : `Matches a clip another person posted (${f.dupe.clipId})`);
  }
  const incomplete = !!(f.errors && f.errors.length);
  if (incomplete) {
    notes.push('Not fully checked: ' + f.errors.join('; '));
    if (verdict === 'pass' && cfg.onError === 'review') { verdict = 'review'; reasons.push('incomplete'); }
  }
  return {
    verdict, reasons, incomplete,
    summary: notes.join(' | ') || 'Nothing found',
    message: verdict === 'block'
      ? `This clip cannot be posted: ${blocking.join('; and ')}.`
      : verdict === 'review' ? 'Your clip is waiting for a moderator to check it before it goes live.' : '',
  };
}

// what is kept on the clip record (never shown to the person who posted it; moderators see summary and the numbers)
function record(f, d, now) {
  const mod = f.mod ? { frames: f.mod.frames } : null;
  if (mod) for (const c of CATEGORIES) mod[c.key] = pct(f.mod.max[c.key]);
  return {
    at: now, verdict: d.verdict, reasons: d.reasons, summary: d.summary,
    hashes: (f.hashes || []).slice(0, 12), mod,
    music: f.music && f.music.match ? { artist: quote(f.music.match.artist), title: quote(f.music.match.title) } : null,
    dupe: f.dupe || null, errors: (f.errors || []).slice(0, 5),
  };
}

// ---------- cutting the video up with ffmpeg ----------
function binary(cfg) {
  if (cfg && cfg.ffmpeg) return cfg.ffmpeg;
  try { const p = require('ffmpeg-static'); if (p) return p; } catch { /* the package is optional */ }
  return 'ffmpeg';
}
function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * MB, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new Error('ffmpeg is not installed'));
      if (err && err.killed) return reject(new Error('ffmpeg took too long'));
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr || '') });
    });
  });
}
const tail = (s) => String(s || '').trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 200);

// loudness and length of a 16 kHz mono WAV (finds the "data" chunk, so extra header chunks do not matter)
function pcmStats(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('latin1', 0, 4) !== 'RIFF') return { rms: 0, seconds: 0 };
  let pos = 12, data = null;
  while (pos + 8 <= wav.length) {
    const id = wav.toString('latin1', pos, pos + 4), size = wav.readUInt32LE(pos + 4);
    if (id === 'data') { data = wav.subarray(pos + 8, Math.min(wav.length, pos + 8 + size)); break; }
    pos += 8 + size + (size & 1);
  }
  if (!data || data.length < 2) return { rms: 0, seconds: 0 };
  const n = Math.floor(data.length / 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = data.readInt16LE(i * 2) / 32768; sum += s * s; }
  return { rms: Math.sqrt(sum / n), seconds: n / 16000 };
}

// -> { frames: [jpeg Buffer], hashes: [hex], hasAudio, wav: Buffer|null, silent, audioSeconds }. Throws when the video cannot be read at all.
async function extract(video, seconds, cfg) {
  const bin = binary(cfg);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aduna-clip-'));
  try {
    const input = path.join(dir, 'in.mp4');
    await fs.promises.writeFile(input, video);
    const n = cfg.frames, dur = Math.max(0.5, Number(seconds) || 1);
    // n pictures spread evenly over the clip, each from the middle of its slice (the very first frame is often a black fade-in)
    const a = await run(bin, [
      '-hide_banner', '-v', 'error', '-y', '-ss', (dur / (2 * n)).toFixed(3), '-i', input, '-an',
      '-filter_complex', `[0:v]fps=${Math.min(30, n / dur).toFixed(4)},split=2[a][b];[a]scale=512:-2[f];[b]scale=9:8:flags=area,format=gray[h]`,
      '-map', '[f]', '-frames:v', String(n), '-pix_fmt', 'yuvj420p', '-q:v', '5', path.join(dir, 'f%02d.jpg'),
      '-map', '[h]', '-frames:v', String(n), '-pix_fmt', 'gray', '-f', 'rawvideo', path.join(dir, 'h.raw'),
    ], cfg.timeoutMs);
    if (a.code !== 0) throw new Error('the video could not be read: ' + tail(a.stderr));
    const names = (await fs.promises.readdir(dir)).filter((x) => /^f\d+\.jpg$/.test(x)).sort();
    const frames = await Promise.all(names.map((x) => fs.promises.readFile(path.join(dir, x))));
    if (!frames.length) throw new Error('no pictures could be taken from the video');
    const raw = await fs.promises.readFile(path.join(dir, 'h.raw')).catch(() => Buffer.alloc(0));
    const hashes = [];
    for (let i = 0; i + 72 <= raw.length; i += 72) { const h = dhash(raw.subarray(i, i + 72)); if (h) hashes.push(h); }

    // is there a soundtrack at all? (asking ffmpeg to open the file and nothing else prints the streams, then exits with an error: expected)
    const probe = await run(bin, ['-hide_banner', '-i', input], cfg.timeoutMs);
    const hasAudio = /Stream #\d+:\d+.*Audio:/.test(probe.stderr);
    let wav = null, silent = true, audioSeconds = 0;
    if (hasAudio) {
      const out = path.join(dir, 'a.wav');
      const b = await run(bin, ['-hide_banner', '-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out], cfg.timeoutMs);
      if (b.code === 0) {
        wav = await fs.promises.readFile(out).catch(() => null);
        if (wav) { const p = pcmStats(wav); silent = p.rms < 0.002; audioSeconds = p.seconds; }
      }
    }
    return { frames, hashes, hasAudio, wav, silent, audioSeconds };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- the outside services ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// -> { sexual, violence, 'violence/graphic' } scores between 0 and 1. The key never appears in an error message.
async function moderateImage(buf, type, cfg, fetchFn = globalThis.fetch) {
  const body = JSON.stringify({ model: 'omni-moderation-latest', input: [{ type: 'image_url', image_url: { url: `data:${type || 'image/jpeg'};base64,${buf.toString('base64')}` } }] });
  let status = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetchFn('https://api.openai.com/v1/moderations', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.openaiKey }, body, signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const s = j && j.results && j.results[0] && j.results[0].category_scores;
      if (!s) throw new Error('unexpected answer');
      return { sexual: Number(s.sexual) || 0, violence: Number(s.violence) || 0, 'violence/graphic': Number(s['violence/graphic']) || 0 };
    }
    status = r.status;
    if (r.status !== 429 && r.status < 500) break; // a rejected key or request will not get better by asking again
    await sleep(800 * (attempt + 1));
  }
  throw new Error('HTTP ' + status);
}
// -> { artist, title } when AudD recognises the sound, null when it does not. (AudD's free allowance is small; see render.yaml.)
async function recognizeMusic(wav, cfg, fetchFn = globalThis.fetch) {
  const form = new FormData();
  form.append('api_token', cfg.auddToken);
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
  const r = await fetchFn('https://api.audd.io/', { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json().catch(() => null);
  if (!j || j.status !== 'success') throw new Error(j && j.error && j.error.error_message ? String(j.error.error_message).slice(0, 80) : 'unexpected answer');
  return j.result ? { artist: quote(j.result.artist), title: quote(j.result.title) } : null;
}

// ---------- the whole screening ----------
let active = 0;
const waiting = [];
async function slot(max) { if (active >= max) await new Promise((r) => waiting.push(r)); active++; }
function release() { active--; const next = waiting.shift(); if (next) next(); }

const why = (e) => String((e && e.message) || e).slice(0, 120);
// input: { video: Buffer, seconds, poster: { buf, type } | null, known: { clips, ownerId, selfId } | null }.
// Returns the findings; a check that could not finish adds a line to `errors` instead of throwing.
async function analyze(input, cfg, deps = {}) {
  const d = { extract, moderateImage, recognizeMusic, ...deps };
  const f = { mod: null, music: null, dupe: null, hashes: [], errors: [] };
  let media = null;
  try { media = await d.extract(input.video, input.seconds, cfg); }
  catch (e) { f.errors.push('video: ' + why(e)); }
  if (media) f.hashes = media.hashes || [];

  if (cfg.moderation) { // the cover picture is judged too: it shows in chat before anybody presses play
    const items = [];
    if (input.poster && input.poster.buf) items.push({ cover: true, buf: input.poster.buf, type: input.poster.type });
    if (media) for (const b of media.frames) items.push({ cover: false, buf: b, type: 'image/jpeg' });
    const settled = await Promise.allSettled(items.map((it) => d.moderateImage(it.buf, it.type, cfg)));
    const scored = [];
    let failed = 0, first = '';
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') scored.push({ cover: items[i].cover, scores: s.value });
      else { failed++; first = first || why(s.reason); }
    });
    f.mod = judgeImages(scored, cfg);
    if (failed) f.errors.push(`moderation: ${failed} of ${items.length} pictures could not be checked (${first})`);
  }
  if (cfg.music && media) {
    if (!media.hasAudio || media.silent || media.audioSeconds < 2) f.music = { skipped: media.hasAudio ? 'silent or too short' : 'no sound' };
    else {
      try { f.music = { match: await d.recognizeMusic(media.wav, cfg) }; }
      catch (e) { f.errors.push('music: ' + why(e)); }
    }
  }
  if (cfg.dupes && f.hashes.length && input.known) f.dupe = findDuplicate(f.hashes, input.known.clips, input.known);
  return f;
}
// analyze() with a place in line (at most cfg.concurrency at once) and a time limit for the lot
async function screenClip(input, cfg, deps) {
  let cancelled = false, timer;
  const work = (async () => {
    await slot(cfg.concurrency);
    try { return cancelled ? null : await analyze(input, cfg, deps); }
    finally { release(); }
  })().catch((e) => ({ mod: null, music: null, dupe: null, hashes: [], errors: ['screening: ' + why(e)] }));
  const limit = new Promise((resolve) => { timer = setTimeout(() => { cancelled = true; resolve(null); }, cfg.timeoutMs); });
  const got = await Promise.race([work, limit]);
  clearTimeout(timer);
  return got || { mod: null, music: null, dupe: null, hashes: [], errors: ['screening: took too long'] };
}

module.exports = {
  CATEGORIES, settings, dhash, distance, flat, sameVideo, findDuplicate, judgeImages, decide, record,
  pcmStats, extract, moderateImage, recognizeMusic, analyze, screenClip,
};
