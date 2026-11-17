// Developer theme rules (no database): node server/devthemes-test.js
const assert = require('assert');
const d = require('./devthemes');
const step = (m) => console.log('✓', m);

const SEED = { dark: true, bg: '#1b1f2a', accent: '#ff7a90' };
const ok = (css, avail = null) => { const r = d.lintCss(css, avail); assert.ok(r.ok, `should pass: ${css} -> ${r.error}`); return r.ok; };
const bad = (css, why, avail = null) => { const r = d.lintCss(css, avail); assert.ok(r.error, `should fail (${why}): ${css}`); return r.error; };

// ---- what a theme may do: restyle everything ----
ok('.sidebar { background: #123; border-radius: 12px; } :root { --bg: #101018; --ink: #ff0; }');
ok('@media (max-width: 600px) { .msg { padding: 2px } } @keyframes glow { from { opacity: .5 } to { opacity: 1 } } .x { animation: glow 2s infinite }');
ok('.a:hover > .b::before { content: "\\201C"; } [data-theme="server"] .c { color: red }');
ok('body { background: url("bg.png") center / cover; } .x { background-image: url(images/tile.webp) }', new Set(['bg.png', 'tile.webp']));
assert.deepStrictEqual(ok('a{background:url(./images/Bg.PNG)} b{background:url("bg.png")}').used, ['bg.png']);
step('any selector, variables, media queries, animations and the theme\'s own pictures are allowed');

// ---- what is refused: anything that loads or runs something from outside, or covers the app ----
bad('@import url("x.css");', 'import');
bad('@font-face { font-family: x; src: local(a) }', 'font-face');
bad('@namespace url(x);', 'unknown at-rule');
bad('a { background: url("https://evil.example/x.png") }', 'remote url');
bad('a { background: url(//evil.example/x.png) }', 'protocol-relative url');
bad('a { background: url(data:image/png;base64,AAAA) }', 'data url');
bad('a { background: url("../secret.png") }', 'path out');
bad('a { background: url("/api/images/abc") }', 'any other address');
bad('a { background: image-set("bg.png" 1x) }', 'image-set');
bad('a { background: src("x") }', 'src()');
bad('a { width: expression(alert(1)) }', 'expression');
bad('a { behavior: url(x.htc) }', 'behavior');
bad('a { -moz-binding: url(x) }', 'moz-binding');
bad('a { background: javascript:alert(1) }', 'javascript address');
bad('a { c\\6flor: red }', 'backslash escape outside a string');
bad('a { position: fixed; top: 0 }', 'fixed');
bad('a { position:FIXED }', 'fixed, any case');
bad('a { z-index: 9999 }', 'z-index');
bad('a { content: "' + 'x'.repeat(41) + '" }', 'long string');
bad('a { content: "no end', 'open string');
bad('/* open comment a { }', 'open comment');
bad('a { color: red ', 'open brace');
bad('a { color: red } }', 'stray brace');
bad('a { background: url("bg.png") }', 'picture not uploaded', new Set());
bad('x'.repeat(d.LIMITS.css + 1), 'too long');
bad('a { b: "\\zz" }', 'bad escape in a string');
assert.ok(d.lintCss('a { z-index: 20; position: sticky; position: absolute }').ok, 'z-index 20 and sticky/absolute are fine');
step('imports, fonts, outside addresses, scripts, escapes, fixed overlays, huge z-index, long text and missing pictures are refused');

// ---- text inside strings or comments never looks like CSS to the checks ----
ok('a::before { content: "@import"; } /* @import url(x); */ b { color: red }');
step('strings and comments are read as such');

// ---- served CSS: comments gone, every picture address points at the theme\'s own picture ----
assert.strictEqual(d.render('/* hi */ a{background:url( "bg.png" )} b{background:url(images/t.jpg)}', (n) => '/api/images/' + n),
  '  a{background:url("/api/images/bg.png")} b{background:url("/api/images/t.jpg")}');
assert.strictEqual(d.render('a{content:"url(x)"}', () => 'NO'), 'a{content:"url(x)"}', 'text in a string is not a picture');
assert.strictEqual(d.render('a { b: "x', () => ''), null, 'broken CSS is not served');
step('render swaps picture names for the served addresses and nothing else');

// ---- names and the seed ----
let r = d.checkTheme({ name: 'Neon Rain', description: 'Cyberpunk', seed: SEED, css: 'a{color:red}' });
assert.ok(r.value && r.value.name === 'Neon Rain' && r.value.css === 'a{color:red}');
assert.ok(d.checkTheme({ name: 'x', seed: SEED }).error, 'name too short');
assert.ok(d.checkTheme({ name: 'Visit http://x.io', seed: SEED }).error, 'no links in names');
assert.ok(d.checkTheme({ name: 'Neon', seed: { dark: true, bg: 'red', accent: '#fff' } }).error, 'bad colours');
assert.ok(d.checkTheme({ name: 'Neon', seed: SEED, css: '@import "x";' }).error, 'CSS is checked on save');
assert.deepStrictEqual(d.checkTheme({ css: 'b{}' }, { current: { name: 'Neon' } }).value, { css: 'b{}' }, 'an edit only changes the fields it carries');
step('names, descriptions, colours and CSS are checked on save');

// ---- verification: drafts, review, and lapsing when anything changes ----
const mk = () => ({ id: 't1', ownerId: 'u1', name: 'Neon Rain', description: '', seed: SEED, css: 'a{background:url("bg.png")}', images: [{ name: 'bg.png', imageId: 'img1', width: 10, height: 10, bytes: 100 }], createdAt: 1, updatedAt: 1 });
let t = mk();
assert.strictEqual(d.statusOf(t), 'draft'); assert.ok(!d.isApproved(t));
assert.strictEqual(d.submitProblem(t), null);
t.submitted = { at: 5, hash: d.verifyHash(t) };
assert.strictEqual(d.statusOf(t), 'pending'); assert.ok(d.submitProblem(t));
assert.ok(d.review(t, { action: 'approve', hash: 'stale', by: 'a', at: 6 }).status === 409, 'the admin must approve what they read');
assert.ok(d.review(mk(), { action: 'approve', hash: d.verifyHash(mk()), by: 'a', at: 6 }).error, 'a draft that was never sent cannot be approved');
assert.ok(d.review(t, { action: 'maybe', hash: d.verifyHash(t) }).error, 'unknown action');
assert.ok(d.review(t, { action: 'approve', hash: d.verifyHash(t), by: 'a', at: 6 }).ok);
assert.strictEqual(d.statusOf(t), 'approved'); assert.ok(d.isApproved(t));
step('draft -> pending -> approved, and an admin can only decide on exactly what they opened');

for (const [what, change] of [['the CSS', (x) => { x.css += ' b{color:red}'; }], ['the name', (x) => { x.name = 'Other'; }], ['the colours', (x) => { x.seed = { ...SEED, accent: '#00ff00' }; }],
  ['a picture', (x) => { x.images = [{ ...x.images[0], imageId: 'img2' }]; }], ['a new picture', (x) => { x.images = [...x.images, { name: 'b.png', imageId: 'i3', width: 1, height: 1, bytes: 1 }]; }]]) {
  const x = JSON.parse(JSON.stringify(t)); change(x);
  assert.strictEqual(d.statusOf(x), 'draft', 'changing ' + what + ' lapses the verification'); assert.ok(!d.isApproved(x));
  assert.ok(d.adminList([x], { u1: { username: 'dev' } }, 'all', '')[0].lapsed, 'the admin list marks it lapsed (' + what + ')');
}
assert.ok(!d.isApproved({ ...t, hidden: true }), 'a hidden (reported) theme is not served');
step('changing the CSS, name, colours or any picture lapses the verification by itself');

t = mk(); t.submitted = { at: 5, hash: d.verifyHash(t) };
assert.ok(d.review(t, { action: 'reject', hash: d.verifyHash(t), note: 'covers the chat <b>', by: 'a', at: 6 }).ok);
assert.strictEqual(d.statusOf(t), 'rejected'); assert.ok(d.submitProblem(t), 'a rejected theme must change before it is sent again');
assert.ok(!/[<>]/.test(d.ownView(t).note) && d.ownView(t).note.includes('covers the chat'), 'the author sees the note as plain text');
t.css += ' b{color:red}'; assert.strictEqual(d.statusOf(t), 'draft'); assert.strictEqual(d.submitProblem(t), null, 'after a change it can go again');
t.css = '   '; assert.ok(d.submitProblem(t), 'empty CSS is not sent');
t = mk(); t.css = 'a{background:url("gone.png")}'; assert.ok(d.submitProblem(t), 'a picture used but not uploaded blocks sending');
t = mk(); t.submitted = { at: 5, hash: d.verifyHash(t) }; d.review(t, { action: 'approve', hash: d.verifyHash(t), by: 'a', at: 6 });
assert.ok(d.review(t, { action: 'revoke' }).ok); assert.strictEqual(d.statusOf(t), 'draft', 'revoking takes the verification (and the submission) away');
step('rejection notes, resubmitting, and revoking');

// ---- what people see ----
t = mk(); t.submitted = { at: 5, hash: d.verifyHash(t) }; d.review(t, { action: 'approve', hash: d.verifyHash(t), by: 'a', at: 6 });
const users = { u1: { id: 'u1', username: 'dev', displayName: 'Dev' } };
const pv = d.publicView(t, 'u2', users);
assert.ok(!('css' in pv) && !('images' in pv) && pv.cover === 'bg.png' && pv.author.displayName === 'Dev' && pv.mine === false && /^[0-9a-f]{12}$/.test(pv.v), 'the public view carries no CSS');
const draft = { ...mk(), id: 't2', name: 'Draft' };
const lst = d.list([t, draft, { ...t, id: 't3', hidden: true }], users, {});
assert.deepStrictEqual(lst.themes.map((x) => x.id), ['t1'], 'only verified, visible themes are listed');
assert.strictEqual(d.list([t], users, { mode: 'light' }).themes.length, 0); assert.strictEqual(d.list([t], users, { q: 'neon' }).themes.length, 1); assert.strictEqual(d.list([t], users, { q: 'nope' }).themes.length, 0);
assert.deepStrictEqual(d.adminList([t, draft], users, 'pending', '').map((x) => x.id), [], 'the queue holds only what was sent');
step('the gallery lists verified themes only, without their CSS');

const btnCss = ':root { --green: #5aa02c; --edge: #202020; } .btn { background: #6b6b6b; border: 2px solid var(--edge); color: #fff; text-transform: uppercase; padding: 40px; transition: all 1s; }'
  + ' .btn.primary { background: var(--green); background-image: url("bg.png"); } .btn.danger { background: red; } .btn:hover { background: blue; } @media (max-width: 600px) { .btn { color: pink } }';
const bl = d.publicView({ ...mk(), css: btnCss }, 'u2', users).look;
assert.deepStrictEqual(bl.btn, { background: '#6b6b6b', border: '2px solid var(--edge)', color: '#fff', 'text-transform': 'uppercase' }, 'only listed properties of the plain .btn rule');
assert.strictEqual(bl.btnPrimary.background, 'var(--green)'); assert.strictEqual(bl.btnPrimary.border, '2px solid var(--edge)'); assert.ok(!('background-image' in bl.btnPrimary), 'a picture is not passed along');
assert.deepStrictEqual(bl.vars, { '--green': '#5aa02c', '--edge': '#202020' }, 'the variables the buttons read come with them');
assert.strictEqual(d.publicView({ ...mk(), css: '.sidebar { color: red }' }, 'u2', users).look.btn, null, 'a theme that does not style buttons passes nothing');
step('the card gets the theme\'s button style, without hover, pictures or layout');

console.log('\ndevthemes-test: all passed');
