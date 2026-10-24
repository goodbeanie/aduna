// Aduna AI Coder: pure logic (no Electron, no network) so it can be tested with plain `node ai/agent-test.js`.
'use strict';
const path = require('path');

// Coding models on Ollama, lowest to highest memory need. vramGB = rough video memory the model wants to run fast
// (weights + working memory); sizeGB = download size. These are estimates: the real numbers depend on the card and the context size.
const MODELS = [
  { tag: 'qwen2.5-coder:1.5b',    tier: 'Tiny',   vramGB: 2,  sizeGB: 1.0, note: 'Runs on almost any PC. Fine for small scripts if you keep requests short and clear.' },
  { tag: 'qwen2.5-coder:3b',      tier: 'Small',  vramGB: 3,  sizeGB: 1.9, note: 'Good for simple tools and single-file programs on 4 GB cards.' },
  { tag: 'qwen2.5-coder:7b',      tier: 'Medium', vramGB: 6,  sizeGB: 4.7, note: 'The best starting point for 6\u20138 GB cards. Handles most small apps.' },
  { tag: 'qwen2.5-coder:14b',     tier: 'Large',  vramGB: 10, sizeGB: 9.0, note: 'Noticeably better at multi-file projects. Wants a 10\u201312 GB card.' },
  { tag: 'deepseek-coder-v2:16b', tier: 'Large',  vramGB: 11, sizeGB: 8.9, note: 'Strong all-round coder; fast for its size. Wants about 12 GB.' },
  { tag: 'devstral:24b',          tier: 'XL',     vramGB: 16, sizeGB: 14,  note: 'Built for agentic coding. Wants a 16 GB card.' },
  { tag: 'qwen3-coder:30b',       tier: 'XL',     vramGB: 20, sizeGB: 19,  note: 'Very capable and quick for its size. Wants 20\u201324 GB.' },
  { tag: 'qwen2.5-coder:32b',     tier: 'XXL',    vramGB: 24, sizeGB: 20,  note: 'The strongest option here. Wants a 24 GB card.' },
];

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/:]{0,100}$/;
const BLOCKED_EXT = /\.(exe|dll|bat|cmd|ps1|psm1|vbs|vbe|wsf|lnk|msi|scr|com|jar|reg|hta|cpl)$/i;
const TEXT_EXT = /\.(js|mjs|cjs|json|html|htm|css|md|txt|py|ts|tsx|jsx|svg|csv|yml|yaml|xml|sh)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build']);
const RUN_ALLOWED = { node: 'node', python: 'python', python3: 'python3', py: 'py' };

// Context window and reply budget scale with the card: small cards get a small window so the model's working memory still fits.
function ctxFor(vramGB) {
  const v = Number(vramGB) || 0;
  const numCtx = v >= 16 ? 16384 : v >= 8 ? 12288 : 8192;
  return { numCtx, numPredict: Math.floor(numCtx / 3), snapshotCap: Math.floor(numCtx * 1.4) };
}

const SYSTEM_PROMPT = [
  'You are an expert software engineer inside an automated build loop on the user\'s Windows PC.',
  'Build exactly what the user asks for, prove it works with an automated test, and keep fixing it until the test passes.',
  '',
  'RULES',
  '- Use plain JavaScript for Node.js 20 with NO npm packages, no installs and no internet, unless the user asks for another language.',
  '- Web pages are fine. Put the logic in its own .js file that works in the browser and in Node (end it with: if (typeof module !== "undefined") module.exports = { ... };) so the test can load it.',
  '- Always include a test script named test.js that uses only node:assert and node:fs and exits with a non-zero code when anything is wrong. For web pages, also check that the HTML points at the right files and elements.',
  '- Always write COMPLETE files. Never write "..." or "rest of file unchanged". If a file you need to change is shown as truncated, rewrite it completely.',
  '- Paths are relative to the project folder. Never use absolute paths or "..".',
  '- If tests fail, fix the cause in the code. Do not weaken or delete the test to make it pass.',
  '',
  'REPLY FORMAT: only these blocks, no other commentary:',
  '<file path="relative/path.ext">',
  'complete file content',
  '</file>',
  '(one <file> block for every file you create or change)',
  '<run>node test.js</run>',
  '(exactly one command that runs the tests; allowed programs: node, python)',
  '<done>One or two plain sentences telling the user what you built and how to use it.</done>',
  '(only after the test run has passed)',
].join('\n');

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

// Pulls <file>, <run> and <done> blocks out of a model reply. Tolerant of think-blocks, code fences and quote style.
function parseResponse(raw) {
  const text = stripThinking(raw);
  const files = [];
  const re = /<file\s+path\s*=\s*(["'])(.+?)\1\s*>\r?\n?([\s\S]*?)<\/file>/gi;
  let m;
  while ((m = re.exec(text))) files.push({ path: m[2].trim(), content: unfence(m[3]) });
  const rest = text.replace(re, '');
  const run = /<run>([\s\S]*?)<\/run>/i.exec(rest);
  const done = /<done>([\s\S]*?)<\/done>/i.exec(rest);
  return { files, run: run ? run[1].trim() : null, done: done ? (done[1].trim() || 'Done.') : null };
}

// A path the model asked to write, resolved inside the project folder, or null if it would escape or is off-limits.
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 200 || rel.includes('\0')) return null;
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\') || rel.startsWith('/')) return null;
  const r = path.resolve(root);
  const abs = path.resolve(r, rel);
  if (abs === r || !abs.startsWith(r + path.sep)) return null;
  const parts = path.relative(r, abs).split(path.sep);
  if (parts.some((p) => p === '.git' || p === 'node_modules')) return null;
  if (BLOCKED_EXT.test(abs)) return null;
  return abs;
}

function tokenize(s) {
  const out = []; let cur = '', q = null, has = false;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === '\'') { q = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else cur += ch;
  }
  if (q) return null;
  if (cur || has) out.push(cur);
  return out;
}

// The only commands the loop will run: node / python with plain arguments. No shell, so no pipes, redirects or chaining.
function parseCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s || s.length > 300 || /[&|;<>`$()%^\r\n]/.test(s)) return null;
  const toks = tokenize(s);
  if (!toks || !toks.length) return null;
  const exe = RUN_ALLOWED[toks[0].toLowerCase().replace(/\.exe$/, '')];
  if (!exe) return null;
  const args = toks.slice(1);
  for (const a of args) {
    if (/^(-e|-p|-c|--eval|--print|--input-type(=.*)?)$/.test(a)) return null; // no inline code, only files
    if (path.isAbsolute(a) || /^[A-Za-z]:/.test(a) || /(^|[\\/])\.\.([\\/]|$)/.test(a)) return null;
  }
  return { exe, args };
}

const looksLikeBinary = (buf) => buf.includes(0);

// Reads the project folder into [{path, content, truncated}], small files first, within a total character budget.
function readProject(dir, fs, cap) {
  const found = [];
  (function walk(d, depth) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4 && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full, depth + 1); }
      else if (e.isFile() && TEXT_EXT.test(e.name)) {
        try { const st = fs.statSync(full); if (st.size <= 400000) found.push({ full, size: st.size }); } catch { /* skip */ }
      }
    }
  })(dir, 0);
  found.sort((a, b) => a.size - b.size);
  const files = [];
  let used = 0;
  const perFile = Math.max(2000, Math.floor(cap / 2));
  for (const f of found) {
    if (used >= cap) { files.push({ path: path.relative(dir, f.full).split(path.sep).join('/'), content: '', omitted: true }); continue; }
    let buf; try { buf = fs.readFileSync(f.full); } catch { continue; }
    if (looksLikeBinary(buf)) continue;
    let content = buf.toString('utf8');
    const room = Math.min(perFile, cap - used);
    let truncated = false;
    if (content.length > room) { content = content.slice(0, room); truncated = true; }
    used += content.length;
    files.push({ path: path.relative(dir, f.full).split(path.sep).join('/'), content, truncated });
  }
  return files;
}

function renderSnapshot(files) {
  if (!files.length) return 'The project folder is empty.';
  return files.map((f) => f.omitted
    ? `--- ${f.path} (not shown: too much code to fit; ask to see it only if you must change it) ---`
    : `--- ${f.path}${f.truncated ? ' (TRUNCATED: rewrite this file completely if you change it)' : ''} ---\n${f.content}`).join('\n');
}

function tail(s, n) { s = String(s || ''); return s.length > n ? '\u2026' + s.slice(-n) : s; }

function buildUserPrompt({ request, files, lastResult, passed, first }) {
  const parts = ['REQUEST:\n' + request, '', 'PROJECT FILES:\n' + renderSnapshot(files)];
  if (lastResult) parts.push('', 'RESULT OF YOUR LAST STEP:\n' + lastResult);
  parts.push('');
  if (first && !files.length) parts.push('Write the code and a test.js, then run the test.');
  else if (first) parts.push('Make the change the request asks for, update test.js to cover it, then run the test.');
  else if (passed === true) parts.push('The test passed. If the request is now fully satisfied, reply with only a <done> block. If anything is missing, add it, extend the test, and run it again.');
  else parts.push('Fix the problem, then run the test again.');
  return parts.join('\n');
}

function projectName(request, now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  const slug = String(request || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'project';
  return `${slug}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

module.exports = { MODELS, MODEL_NAME_RE, SYSTEM_PROMPT, ctxFor, parseResponse, safeJoin, parseCommand, readProject, renderSnapshot, buildUserPrompt, projectName, tail, BLOCKED_EXT };
