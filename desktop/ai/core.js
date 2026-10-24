// Aduna AI bot builder: the model catalog and small text helpers (no Electron, no network, no files).
'use strict';

// Coding models on Ollama, lowest to highest memory need. vramGB = rough video memory the model wants to run fast
// (weights + working memory); sizeGB = download size. These are estimates: the real numbers depend on the card and the context size.
const MODELS = [
  { tag: 'qwen2.5-coder:1.5b',    tier: 'Tiny',   vramGB: 2,  sizeGB: 1.0, note: 'Runs on almost any PC. Fine for small bots if you keep requests short and clear.' },
  { tag: 'qwen2.5-coder:3b',      tier: 'Small',  vramGB: 3,  sizeGB: 1.9, note: 'Good for simple bots on 4 GB cards.' },
  { tag: 'qwen2.5-coder:7b',      tier: 'Medium', vramGB: 6,  sizeGB: 4.7, note: 'The best starting point for 6\u20138 GB cards. Handles most bots.' },
  { tag: 'qwen2.5-coder:14b',     tier: 'Large',  vramGB: 10, sizeGB: 9.0, note: 'Noticeably better at bots with several commands. Wants a 10\u201312 GB card.' },
  { tag: 'deepseek-coder-v2:16b', tier: 'Large',  vramGB: 11, sizeGB: 8.9, note: 'Strong all-round coder; fast for its size. Wants about 12 GB.' },
  { tag: 'devstral:24b',          tier: 'XL',     vramGB: 16, sizeGB: 14,  note: 'Built for agentic coding. Wants a 16 GB card.' },
  { tag: 'qwen3-coder:30b',       tier: 'XL',     vramGB: 20, sizeGB: 19,  note: 'Very capable and quick for its size. Wants 20\u201324 GB.' },
  { tag: 'qwen2.5-coder:32b',     tier: 'XXL',    vramGB: 24, sizeGB: 20,  note: 'The strongest option here. Wants a 24 GB card.' },
];

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/:]{0,100}$/;

// Context window and reply budget scale with the card: small cards get a small window so the model's working memory still fits.
function ctxFor(vramGB) {
  const v = Number(vramGB) || 0;
  const numCtx = v >= 16 ? 16384 : v >= 8 ? 12288 : 8192;
  return { numCtx, numPredict: Math.floor(numCtx / 3), snapshotCap: Math.floor(numCtx * 1.4) };
}

// The best model for this card: the biggest one in the catalog that fits in video memory. If the card can't be read, stay small.
function pickModel(vramGB, installed) {
  const v = Number(vramGB);
  let fits = MODELS.filter((m) => m.vramGB <= (v > 0 ? v : 3));
  if (!fits.length) fits = [MODELS[0]];
  const model = fits[fits.length - 1];
  return { model, installed: (installed || []).indexOf(model.tag) >= 0 };
}

function stripThinking(text) { return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, ''); }

function unfence(s) {
  const body = s.replace(/^(\r?\n)+/, '');
  const t = body.trim();
  if (t.startsWith('```') && t.endsWith('```') && t.length > 6) {
    const lines = t.split(/\r?\n/);
    lines.shift();
    if (/^```\s*$/.test(lines[lines.length - 1])) lines.pop();
    return lines.join('\n').replace(/\s+$/, '') + '\n';
  }
  return body.replace(/\s+$/, '') + '\n';
}

const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; };
const tail = (s, n) => { s = String(s || ''); return s.length > n ? '\u2026' + s.slice(-n) : s; };

module.exports = { MODELS, MODEL_NAME_RE, ctxFor, pickModel, stripThinking, unfence, clip, tail };
