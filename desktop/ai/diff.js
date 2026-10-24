// A small line diff, so the AI (and the person) can see WHAT an attempt changed instead of two whole files.
// lineDiff(before, after) -> { text, added, removed, same }. text is "@@ line N" blocks with "- old" / "+ new" lines, clipped to `maxLines`.
// Pure logic: no Electron, no files.
'use strict';

const MAX_CELLS = 2_000_000; // lines x lines; a bigger rewrite is just described as a rewrite

function split(s) { s = String(s == null ? '' : s).replace(/\r\n/g, '\n'); return s === '' ? [] : s.replace(/\n$/, '').split('\n'); }

// the edit script between two line arrays: [{ op: ' '|'-'|'+', line, a (1-based line in before), b (1-based line in after) }]
function script(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ma = a.slice(lo, ea), mb = b.slice(lo, eb);
  const out = [];
  for (let i = 0; i < lo; i++) out.push({ op: ' ', line: a[i], a: i + 1, b: i + 1 });
  if (ma.length * mb.length > MAX_CELLS) {
    ma.forEach((l, i) => out.push({ op: '-', line: l, a: lo + i + 1, b: lo + 1 }));
    mb.forEach((l, i) => out.push({ op: '+', line: l, a: lo + 1, b: lo + i + 1 }));
  } else {
    const n = ma.length, m = mb.length, w = m + 1;
    const t = new Uint32Array((n + 1) * w); // t[i*w+j] = LCS length of ma[i..] and mb[j..]
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = ma[i] === mb[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) { out.push({ op: ' ', line: ma[i], a: lo + i + 1, b: lo + j + 1 }); i++; j++; }
      else if (i < n && (j === m || t[(i + 1) * w + j] >= t[i * w + j + 1])) { out.push({ op: '-', line: ma[i], a: lo + i + 1, b: lo + j + 1 }); i++; } // removals before additions, like a normal diff
      else { out.push({ op: '+', line: mb[j], a: lo + i + 1, b: lo + j + 1 }); j++; }
    }
  }
  for (let k = ea; k < a.length; k++) out.push({ op: ' ', line: a[k], a: k + 1, b: k + 1 + (eb - ea) });
  return out;
}

const clipLine = (l, n) => (l.length > n ? l.slice(0, n - 1) + '\u2026' : l);

function lineDiff(before, after, o = {}) {
  const maxLines = o.maxLines || 30, width = o.width || 110;
  const s = script(split(before), split(after));
  let added = 0, removed = 0;
  for (const e of s) { if (e.op === '+') added++; else if (e.op === '-') removed++; }
  if (!added && !removed) return { text: '', added: 0, removed: 0, same: true };
  const lines = [];
  let open = false, shown = 0, hidden = 0;
  for (const e of s) {
    if (e.op === ' ') { open = false; continue; }
    if (shown >= maxLines) { hidden++; continue; }
    if (!open) { lines.push('@@ line ' + (e.op === '-' ? e.a : e.b)); open = true; }
    lines.push(e.op + ' ' + clipLine(e.line, width)); shown++;
  }
  if (hidden) lines.push(`\u2026 ${hidden} more changed line${hidden === 1 ? '' : 's'}`);
  return { text: lines.join('\n'), added, removed, same: false };
}

module.exports = { lineDiff, split };
