// Checks the Discord-style message formatting in src/Markdown.jsx. Run from the client folder: node scripts/markdown-test.mjs
// (the file is bundled with esbuild, which ships with vite, then rendered with react-dom/server)
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.markdown-test-bundle.mjs');
await build({
  entryPoints: [path.join(here, '../src/Markdown.jsx')], outfile: out, bundle: true, format: 'esm', platform: 'node',
  jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
});
let renderMarkdown;
try { ({ renderMarkdown } = await import(pathToFileURL(out).href)); } finally { fs.rmSync(out, { force: true }); }

const ctx = {
  atomRe: /<:([a-z0-9_]{2,32}):([0-9a-f]{16})>|(?<![\w<@])@everyone(?![\w])/g,
  atom: (m) => (m[2] ? React.createElement('span', { className: 'emo' }, m[1]) : m[0]),
};
const html = (t) => renderToStaticMarkup(React.createElement(React.Fragment, null, renderMarkdown(t, ctx)));
const A = (href, shown = href) => `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${shown}</a>`;
let n = 0;
const is = (input, want) => { assert.equal(html(input), want, JSON.stringify(input)); n++; };
const has = (input, part) => { assert.ok(html(input).includes(part), JSON.stringify(input) + ' -> ' + html(input) + ' should contain ' + part); n++; };
const no = (input, part) => { assert.ok(!html(input).includes(part), JSON.stringify(input) + ' -> ' + html(input) + ' should not contain ' + part); n++; };

// ---- links: the case from the screenshot, a bare domain, now links like the https one
is('aduna.onrender.com', A('https://aduna.onrender.com', 'aduna.onrender.com'));
is('https://www.youtube.com/shorts/Ghw2EYjkkrw', A('https://www.youtube.com/shorts/Ghw2EYjkkrw'));
is('see aduna.onrender.com.', 'see ' + A('https://aduna.onrender.com', 'aduna.onrender.com') + '.');
is('www.example.com/a?b=1#c', A('https://www.example.com/a?b=1#c', 'www.example.com/a?b=1#c'));
is('(https://x.com/a_(b))', '(' + A('https://x.com/a_(b)') + ')');
is('<https://x.com/a>', A('https://x.com/a'));
is('youtu.be/abc123', A('https://youtu.be/abc123', 'youtu.be/abc123'));
is('http://localhost:3000/app', A('http://localhost:3000/app'));
has('aduna.onrender.com/app', 'href="https://aduna.onrender.com/app"');
// ordinary text that only looks a bit like an address stays text
for (const t of ['install.sh', 'Node.js and e.g. this', 'done.No problem', 'main.cc', 'a.b', 'v1.2.3', 'me@example.com', 'file.md']) no(t, '<a ');
no('javascript:alert(1)', '<a ');
no('<script>alert(1)</script>', '<script>');
has('<script>alert(1)</script>', '&lt;script&gt;');
// a masked link can not hide where it goes: the address stays visible
has('[click](https://evil.example.com)', '[click](');

// ---- inline styles
is('**bold**', '<strong>bold</strong>');
is('*it*', '<em>it</em>');
is('_it_', '<em>it</em>');
is('__under__', '<u>under</u>');
is('~~gone~~', '<s>gone</s>');
is('***both***', '<strong><em>both</em></strong>');
is('a **b** c *d* e', 'a <strong>b</strong> c <em>d</em> e');
is('**bold *and italic* too**', '<strong>bold <em>and italic</em> too</strong>');
is('__*mix*__', '<u><em>mix</em></u>');
is('snake_case_word and __init__', 'snake_case_word and <u>init</u>');
is('2 * 3 * 4', '2 * 3 * 4');
is('a || b || c', 'a || b || c');
is('**not closed', '**not closed');
is('\\*not italic\\*', '*not italic*');
is('`a*b*c`', '<code class="md-code">a*b*c</code>');
is('``a ` b``', '<code class="md-code">a ` b</code>');
is('**https://x.com/a_b_c**', '<strong>' + A('https://x.com/a_b_c') + '</strong>');
is('_https://x.com/a_b_c_', '<em>' + A('https://x.com/a_b_c') + '</em>');
has('||secret||', 'class="spoiler"');
has('||secret||', '>secret</span>');
is('<:cat_face:0123456789abcdef> **hi**', '<span class="emo">cat_face</span> <strong>hi</strong>');
is('**<:cat_face:0123456789abcdef>**', '<strong><span class="emo">cat_face</span></strong>');
is('@everyone **now**', '@everyone <strong>now</strong>');

// ---- blocks
is('```js\nconst a = 1;\n```', '<pre class="md-pre" data-lang="js"><code>const a = 1;</code></pre>');
is('```\nplain **not bold**\n```', '<pre class="md-pre"><code>plain **not bold**</code></pre>');
is('```one line```', '<pre class="md-pre"><code>one line</code></pre>');
is('before\n```\ncode\n```\nafter', 'before<pre class="md-pre"><code>code</code></pre>after');
is('``````', '``````');
is('> one\n> two', '<blockquote class="md-quote">one\ntwo</blockquote>');
is('> quote\nnot quote', '<blockquote class="md-quote">quote</blockquote>not quote');
is('>>> a\nb\n**c**', '<blockquote class="md-quote">a\nb\n<strong>c</strong></blockquote>');
is('>nope', '&gt;nope');
is('# Big', '<div class="md-h md-h1" role="heading" aria-level="1">Big</div>');
is('### Small **x**', '<div class="md-h md-h3" role="heading" aria-level="3">Small <strong>x</strong></div>');
is('#nope and #### nope', '#nope and #### nope');
is('-# tiny', '<div class="md-sub">tiny</div>');
is('hello\n# Head\nbye', 'hello<div class="md-h md-h1" role="heading" aria-level="1">Head</div>bye');
is('- a\n- **b**', '<ul class="md-list"><li>a</li><li><strong>b</strong></li></ul>');
is('* a\n* b', '<ul class="md-list"><li>a</li><li>b</li></ul>');
is('1. a\n2. b', '<ol class="md-list" start="1"><li>a</li><li>b</li></ol>');
is('3. a\n4. b', '<ol class="md-list" start="3"><li>a</li><li>b</li></ol>');
is('- a\n  - nested', '<ul class="md-list"><li>a</li><li style="margin-left:20px">nested</li></ul>');
is('- a\n1. b', '<ul class="md-list"><li>a</li></ul><ol class="md-list" start="1"><li>b</li></ol>');
is('-5 degrees', '-5 degrees');
is('plain\n\ntext', 'plain\n\ntext');
is('\\# not a header', '# not a header');

// ---- safety: nothing from the message becomes markup, and deeply nested markers stop at a depth limit
is('<b>x</b> & "q"', '&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot;');
html('*'.repeat(500) + 'a' + '*'.repeat(500));
html('_'.repeat(900) + '**'.repeat(300) + '||'.repeat(200) + '`'.repeat(100));
html('aduna.com '.repeat(200));
const t0 = Date.now();
html(('**a ' + '_b ' + '~~c ').repeat(200));
assert.ok(Date.now() - t0 < 1500, 'a 2000 character worst case renders quickly');

console.log(`markdown tests passed (${n} checks)`);
