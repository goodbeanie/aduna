import React, { useState } from 'react';

// Discord-style message formatting, rendered as React elements (never as HTML strings, so nothing in a message can inject markup).
//
//   inline:  **bold**  *italic* or _italic_  __underline__  ~~strike~~  ||spoiler||  `code`  ``code``  \* escapes
//            links: https://example.com, www.example.com, example.com/path (common domain endings), <https://no-preview.example>
//   blocks:  ```fenced code```   > quote   >>> quote to the end   # / ## / ### headers   -# small text   - or * lists   1. numbered lists
//
// Emoji tokens, @mentions and @everyone are handed in by the caller (ctx.atomRe + ctx.atom) so this file has no other imports.
// Masked links like [text](url) are left out on purpose: they let a message show one address and open another.

// ---------- links ----------
// Endings that are safe to link without a path. The short, everyday-word ones (.to .so .me .it .in .sh .cc ...) only link
// when there is a /path after them, so "done.No" or "install.sh" in normal chat is not turned into a link.
const STRONG_TLD = 'com|net|org|io|gg|dev|tv|xyz|info|gov|edu|uk|de|fr|nl|ru|jp|au|ly|fm|cloud|online|site|tech|biz|club|live|link|games|ws|eu|se|dk|fi|br|cn|kr|nz|ie|mx|za|sg|hk|tw|vn|tk|ink|wiki|world|store|shop|blog|news|space|fun|top|vip|pro|mobi|asia|team|zone|gl|ca';
const WEAK_TLD = 'be|to|so|me|us|it|in|no|at|id|ch|es|ar|co|ai|im|ac|ph|th|sh|cc|pl|app|page';
const HOST = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+';
const BARE_RE = new RegExp(
  '(?<![\\w@./:\\\\-])(?:'
  + HOST + '(?:' + STRONG_TLD + ')(?![\\w-])(?::\\d{2,5})?(?:[/?#][^\\s<]*)?'
  + '|'
  + HOST + '(?:' + WEAK_TLD + ')(?![\\w-])(?::\\d{2,5})?/[^\\s<]*'
  + ')', 'gi');

const count = (s, ch) => s.split(ch).length - 1;
// "see https://x.com/a)." -> drop the sentence punctuation, keep a ")" that closes a "(" inside the address
function trimUrl(u) {
  for (;;) {
    const c = u[u.length - 1];
    if (c && /[.,;:!?'"*_~|>]/.test(c)) u = u.slice(0, -1);
    else if (c === ')' && count(u, '(') < count(u, ')')) u = u.slice(0, -1);
    else if (c === ']' && count(u, '[') < count(u, ']')) u = u.slice(0, -1);
    else return u;
  }
}

function linkNode(shown, href) {
  let ok = false;
  try { const x = new URL(href); ok = (x.protocol === 'https:' || x.protocol === 'http:') && !!x.hostname; } catch { /* not a link */ }
  if (!ok) return null;
  return { node: <a href={href} target="_blank" rel="noopener noreferrer nofollow">{shown}</a>, len: shown.length };
}

// ---------- spoiler ----------
function Spoiler({ children }) {
  const [on, setOn] = useState(false);
  if (on) return <span className="spoiler on">{children}</span>;
  return (
    <span className="spoiler" role="button" tabIndex={0} title="Click to reveal" onClick={() => setOn(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOn(true); } }}>{children}</span>
  );
}

// ---------- inline ----------
// Each pattern: a global regex + a handler (match, rec) -> { node, len? } | null. At every position the pattern that matches
// EARLIEST wins (ties go to the one listed first); a handler that returns null means "not really a match, treat it as text".
const wrap = (render) => (m, rec) => ({ node: render(rec(m[1])) });

function basePatterns() {
  return [
    { re: /\\([\\*_~`|>#\-[\]()<:@])/g, fn: (m) => ({ node: m[1] }) },
    { re: /(?<!`)``(?!`)([\s\S]+?)(?<!`)``(?!`)/g, fn: (m) => ({ node: <code className="md-code">{m[1]}</code> }) },
    { re: /(?<!`)`(?!`)([^`\n]+)`(?!`)/g, fn: (m) => ({ node: <code className="md-code">{m[1]}</code> }) },
    { re: /<(https?:\/\/[^\s<>]+)>/gi, fn: (m) => { const l = linkNode(m[1], m[1]); return l && { node: l.node, len: m[0].length }; } },
    'ATOM',
    { re: /https?:\/\/[^\s<]+/gi, fn: (m) => { const u = trimUrl(m[0]); return linkNode(u, u); } },
    { re: BARE_RE, fn: (m) => { const u = trimUrl(m[0]); return linkNode(u, 'https://' + u); } },
    { re: /\|\|(?=\S)([\s\S]*?\S)\|\|/g, fn: wrap((c) => <Spoiler>{c}</Spoiler>) },
    { re: /\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, fn: wrap((c) => <strong><em>{c}</em></strong>) },
    { re: /\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/g, fn: wrap((c) => <strong>{c}</strong>) },
    { re: /__(?=\S)([\s\S]*?\S)__(?!_)/g, fn: wrap((c) => <u>{c}</u>) },
    { re: /\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, fn: wrap((c) => <em>{c}</em>) },
    { re: /(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, fn: wrap((c) => <em>{c}</em>) },
    { re: /~~(?=\S)([\s\S]*?\S)~~/g, fn: wrap((c) => <s>{c}</s>) },
  ];
}

const MAX_DEPTH = 5;

function inline(text, pats, ctx, depth) {
  const out = [];
  const rec = (t) => (depth >= MAX_DEPTH ? t : inline(t, pats, ctx, depth + 1));
  const cache = pats.map(() => undefined); // undefined = not searched yet, null = no more matches
  let buf = '', pos = 0;
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  const add = (n) => { flush(); out.push(typeof n === 'string' ? n : React.cloneElement(n, { key: out.length })); };

  while (pos < text.length) {
    let best = null, bi = -1;
    for (let i = 0; i < pats.length; i++) {
      let c = cache[i];
      if (c === null) continue;
      if (c === undefined || c.index < pos) {
        const re = pats[i].re;
        re.lastIndex = pos;
        c = cache[i] = re.exec(text);
        if (!c) continue;
      }
      if (!best || c.index < best.index) { best = c; bi = i; }
    }
    if (!best) break;
    const res = pats[bi].fn(best, rec);
    if (!res) { buf += text.slice(pos, best.index + 1); pos = best.index + 1; continue; }
    buf += text.slice(pos, best.index);
    add(res.node);
    pos = best.index + (res.len ?? best[0].length);
  }
  buf += text.slice(pos);
  flush();
  return out;
}

// ---------- blocks ----------
const FENCE_SRC = '```(?:([A-Za-z0-9_+#.-]+)[ \\t]*\\r?\\n)?([\\s\\S]*?)```';
const RE_QUOTE_ALL = /^>>> (.*)$/;
const RE_QUOTE = /^> (.*)$|^>$/;
const RE_HEAD = /^(#{1,3}) +(\S.*)$/;
const RE_SUB = /^-# +(\S.*)$/;
const RE_LIST = /^( *)([-*]|\d{1,9}\.) +(\S.*)$/;

function blocks(seg, pats, ctx, push) {
  const lines = seg.split('\n');
  let plain = [], blockBefore = false;

  const flushPlain = (blockAfter) => {
    if (!plain.length) return;
    const run = plain; plain = [];
    if (blockBefore && run[0] === '') run.shift();
    if (blockAfter && run.length && run[run.length - 1] === '') run.pop();
    if (run.length) push(<React.Fragment>{inline(run.join('\n'), pats, ctx, 0)}</React.Fragment>);
  };
  const block = (node) => { push(node); blockBefore = true; };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    let m;

    if ((m = RE_QUOTE_ALL.exec(line))) {
      flushPlain(true);
      block(<blockquote className="md-quote">{inline([m[1], ...lines.slice(i + 1)].join('\n'), pats, ctx, 0)}</blockquote>);
      i = lines.length;
    } else if (RE_QUOTE.test(line)) {
      flushPlain(true);
      const q = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) { q.push(RE_QUOTE.exec(lines[i])[1] || ''); i++; }
      block(<blockquote className="md-quote">{inline(q.join('\n'), pats, ctx, 0)}</blockquote>);
    } else if ((m = RE_HEAD.exec(line))) {
      flushPlain(true);
      block(<div className={'md-h md-h' + m[1].length} role="heading" aria-level={m[1].length}>{inline(m[2], pats, ctx, 0)}</div>);
      i++;
    } else if ((m = RE_SUB.exec(line))) {
      flushPlain(true);
      block(<div className="md-sub">{inline(m[1], pats, ctx, 0)}</div>);
      i++;
    } else if (RE_LIST.test(line)) {
      flushPlain(true);
      const items = [];
      while (i < lines.length && RE_LIST.test(lines[i])) {
        const l = RE_LIST.exec(lines[i]);
        items.push({ level: Math.min(3, Math.floor(l[1].length / 2)), ordered: /\d/.test(l[2]), num: parseInt(l[2], 10), text: l[3] });
        i++;
      }
      // a new list starts whenever a top-level item switches between bullets and numbers
      const groups = [];
      for (const it of items) {
        const g = groups[groups.length - 1];
        if (g && (it.level > 0 || g.ordered === it.ordered)) g.items.push(it);
        else groups.push({ ordered: it.ordered, start: it.num, items: [it] });
      }
      for (const g of groups) {
        const lis = g.items.map((it, n) => <li key={n} style={it.level ? { marginLeft: it.level * 20 } : undefined}>{inline(it.text, pats, ctx, 0)}</li>);
        block(g.ordered ? <ol className="md-list" start={g.start}>{lis}</ol> : <ul className="md-list">{lis}</ul>);
      }
    } else {
      plain.push(line);
      i++;
    }
  }
  flushPlain(false);
}

// ctx: { atomRe, atom(match, key) }   atomRe is a global RegExp for the tokens the caller renders itself (emoji, mentions)
export function renderMarkdown(text, ctx) {
  const pats = basePatterns().map((p) => (p === 'ATOM' ? { re: ctx.atomRe, fn: (m) => ({ node: ctx.atom(m) }) } : p));
  const out = [];
  const push = (n) => out.push(React.cloneElement(n, { key: out.length }));

  const fence = new RegExp(FENCE_SRC, 'g');
  const segs = []; // text between code blocks, and the code blocks themselves
  let last = 0, m;
  while ((m = fence.exec(text))) {
    const body = m[2].replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (!body.trim()) continue; // "``````" stays plain text
    if (m.index > last) segs.push({ text: text.slice(last, m.index) });
    segs.push({ code: body, lang: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });

  segs.forEach((s, i) => {
    if (s.code !== undefined) {
      push(<pre className="md-pre" data-lang={s.lang || undefined}><code>{s.code}</code></pre>);
      return;
    }
    let t = s.text;
    if (i > 0 && segs[i - 1].code !== undefined) t = t.replace(/^\r?\n/, ''); // the line break right after a code block
    if (i < segs.length - 1 && segs[i + 1].code !== undefined) t = t.replace(/\r?\n$/, ''); // and the one right before it
    if (t !== '') blocks(t, pats, ctx, push);
  });
  return out;
}
