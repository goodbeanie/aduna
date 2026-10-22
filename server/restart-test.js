// Rate limits and lockouts must survive a restart: node server/restart-test.js
// Starts the real server as a child process (same database schema each time), locks an account out, stops the server, starts it again and
// checks the lockout is still there. Covers a normal shutdown (SIGTERM, what Render sends on every deploy) and a hard kill (SIGKILL).
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { cleanup } = require('./test-env'); // sets DATABASE_URL, DB_SCHEMA, DB_ENCRYPTION_KEY, NODE_ENV=test: the children inherit them
const store = require('./db');

const step = (m) => console.log('✓', m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blob = { salt: 'a', iv: 'b', data: 'c' };

function startServer() {
  return new Promise((resolve, reject) => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (d) => { out += d; if (/running on port/.test(out)) resolve({ child, base: `http://127.0.0.1:${port}/api` }); };
    child.stdout.on('data', onData); child.stderr.on('data', (d) => { out += d; });
    child.on('exit', () => reject(new Error('server stopped before it was ready:\n' + out)));
    setTimeout(() => reject(new Error('server did not start in time:\n' + out)), 20_000).unref();
  });
}
const stop = (s, signal) => new Promise((resolve) => { s.child.removeAllListeners('exit'); s.child.once('exit', resolve); s.child.kill(signal); });
const call = async (s, p, body) => { const r = await fetch(s.base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
const register = (s, name) => call(s, '/register', { username: name, email: name + '@example.com', password: 'password123', publicKey: 'k', encPrivKey: blob });
const login = (s, name, password = 'password123') => call(s, '/login', { username: name, password });
async function lockOut(s, name) {
  for (let i = 0; i < 5; i++) assert.strictEqual((await login(s, name, 'wrong-password')).status, 401, 'wrong guess ' + (i + 1));
  assert.strictEqual((await login(s, name)).status, 429, 'locked, even with the right password');
}

(async () => {
  await store.init(); // so cleanup() can drop the schema at the end; the children create and use the same one
  let a = await startServer();
  await register(a, 'lou'); await register(a, 'maya'); await register(a, 'nick');
  await lockOut(a, 'lou');
  await stop(a, 'SIGTERM'); // straight away: only the shutdown save can have stored it
  step('server A: account locked out, then shut down normally right away');

  let b = await startServer();
  assert.strictEqual((await login(b, 'lou')).status, 429, 'the lockout survived the restart');
  assert.strictEqual((await login(b, 'maya')).status, 200, 'other accounts are not affected');
  step('server B (restart): the lockout is still in force, other accounts log in normally');

  await lockOut(b, 'nick');
  await sleep(6500); // the periodic save runs within 5 s of a change
  await stop(b, 'SIGKILL'); // no chance to save on the way out
  step('server B: another account locked out, then killed hard after the periodic save');

  const c = await startServer();
  assert.strictEqual((await login(c, 'nick')).status, 429, 'a hard kill after the periodic save still keeps the lockout');
  assert.strictEqual((await login(c, 'lou')).status, 429, 'and the first lockout is still there');
  assert.strictEqual((await login(c, 'maya')).status, 200);
  step('server C: both lockouts survived, even though B was killed without a shutdown');

  const row = (await store.query("SELECT value FROM meta WHERE key = 'ratelimits'")).rows[0];
  assert.ok(row, 'the state is stored');
  const raw = row.value.toString('latin1');
  assert.ok(!/lou|maya|nick|127\.0\.0\.1/.test(raw), 'usernames and addresses are sealed in the database, not readable');
  step('the saved state is encrypted at rest');
  await stop(c, 'SIGTERM');
  console.log('\nrestart-test: all passed');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; }).finally(async () => { await cleanup(); process.exit(process.exitCode || 0); });
