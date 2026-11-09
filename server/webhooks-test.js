// Webhook rules (webhooks.js): tokens, GitHub signatures, how GitHub events and generic JSON become messages, and the records.
// No database, no Express: node server/webhooks-test.js
const assert = require('assert');
const crypto = require('crypto');
const W = require('./webhooks');
const step = (m) => console.log('\u2713', m);

const sign = (raw, secret) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

// ----- the secret address -----
{
  const t = W.newToken();
  assert.ok(W.validToken(t) && t.length === 43, 'a token is 43 URL-safe characters (256 bits)');
  assert.notStrictEqual(W.newToken(), t, 'every token is new');
  const hook = { tokenHash: W.tokenHash(t) };
  assert.strictEqual(W.tokenMatches(hook, t), true);
  assert.strictEqual(W.tokenMatches(hook, W.newToken()), false, 'another token does not match');
  assert.strictEqual(W.tokenMatches(hook, t.slice(1) + 'A'), false);
  for (const bad of ['', 'short', null, undefined, 42, t + 'x', t.replace(/./, '*')]) assert.strictEqual(W.tokenMatches(hook, bad), false, 'junk never matches: ' + String(bad));
  assert.strictEqual(W.tokenMatches({}, t), false, 'a record without a hash never matches');
  assert.strictEqual(W.tokenMatches(null, t), false);
  assert.ok(!JSON.stringify(hook).includes(t), 'only the hash is kept');
  assert.ok(W.newSecret().length >= 30, 'a GitHub secret is long enough to be strong');
  step('tokens: 256 random bits, only the hash is kept, junk never matches');
}

// ----- GitHub signature -----
{
  const raw = Buffer.from('{"zen":"Keep it logically awesome."}');
  const good = sign(raw, 'topsecret');
  assert.strictEqual(W.verifyGithubSignature(raw, good, 'topsecret'), true);
  assert.strictEqual(W.verifyGithubSignature(raw, good.toUpperCase().replace('SHA256=', 'sha256='), 'topsecret'), true, 'hex case does not matter');
  assert.strictEqual(W.verifyGithubSignature(raw, good, 'other'), false, 'wrong secret');
  assert.strictEqual(W.verifyGithubSignature(Buffer.from(raw.toString() + ' '), good, 'topsecret'), false, 'one changed byte');
  assert.strictEqual(W.verifyGithubSignature(raw, '', 'topsecret'), false, 'no header');
  assert.strictEqual(W.verifyGithubSignature(raw, 'sha1=' + good.slice(7, 47), 'topsecret'), false, 'the old sha1 header is not accepted');
  assert.strictEqual(W.verifyGithubSignature(raw, good.slice(0, -2), 'topsecret'), false, 'short signature');
  assert.strictEqual(W.verifyGithubSignature(raw.toString(), good, 'topsecret'), false, 'must be the raw bytes, not parsed text');
  assert.strictEqual(W.verifyGithubSignature(raw, good, ''), false, 'no secret on record');
  assert.strictEqual(W.verifyGithubSignature(raw, good, undefined), false);
  step('github signature: HMAC-SHA256 of the raw bytes; wrong secret, changed body, sha1, short, text and missing secret all refused');
}

// ----- GitHub events -> messages -----
const repo = { full_name: 'acme/web' }, sender = { login: 'octo' };
{
  const push = {
    ref: 'refs/heads/main', repository: repo, sender, compare: 'https://github.com/acme/web/compare/a...b',
    commits: [
      { id: 'abcdef1234567', message: 'Fix bug\n\nlong body', author: { username: 'octo' } },
      { id: '1234567abcdef', message: 'Hi @everyone <@0123456789abcdef>', author: { name: 'Bo' } },
    ],
  };
  const g = W.githubEvent('push', push);
  assert.ok(g.text.startsWith('**octo** pushed 2 commits to `main` in **acme/web**'), g.text);
  assert.ok(g.text.includes('- `abcdef1` Fix bug \u2014 octo'), 'only the first line of a commit message, with the short id');
  assert.ok(g.text.includes('Hi \\@everyone \\<\\@0123456789abcdef\\>'), 'pings and mention tokens in a commit message are escaped: ' + g.text);
  assert.ok(!g.text.includes('<@0123456789abcdef>'));
  assert.ok(g.text.endsWith('<https://github.com/acme/web/compare/a...b>'), 'the link is wrapped so it does not become a big card');
  assert.strictEqual(g.summary.event, 'push'); assert.strictEqual(g.summary.branch, 'main'); assert.strictEqual(g.summary.sender, 'octo'); assert.strictEqual(g.summary.repo, 'acme/web');
  assert.deepStrictEqual(g.summary.commits[0], { id: 'abcdef1', message: 'Fix bug', author: 'octo' });

  const one = W.githubEvent('push', { ...push, commits: [push.commits[0]] });
  assert.ok(one.text.includes('pushed 1 commit to'), 'singular');
  const many = W.githubEvent('push', { ...push, commits: Array.from({ length: 8 }, (_, i) => ({ id: 'abcdef' + i + '0', message: 'c' + i, author: { username: 'o' } })) });
  assert.strictEqual(many.text.split('\n').filter((l) => l.startsWith('- ')).length, 5, 'five commits are listed');
  assert.ok(many.text.includes('and 3 more'), many.text);
  assert.strictEqual(many.summary.commits.length, 8, 'a bot gets up to ten');
  assert.ok(W.githubEvent('push', { ...push, forced: true }).text.includes('(force push)'));
  assert.ok(W.githubEvent('push', { ref: 'refs/heads/old', deleted: true, repository: repo, sender, commits: [] }).text.includes('deleted branch `old`'));
  assert.ok(W.githubEvent('push', { ref: 'refs/tags/v1', created: true, repository: repo, sender, commits: [] }).text.includes('created tag `v1`'));
  assert.strictEqual(W.githubEvent('push', { ref: 'refs/heads/x', repository: repo, sender, commits: [] }), null, 'a push with nothing in it is not shown');
  step('github push: commits listed (first line, short id), pings escaped, link wrapped, more than five summarised, deletes and tags');
}
{
  const pr = (action, extra = {}) => ({ action, repository: repo, sender, pull_request: { number: 7, title: 'Add *thing*', html_url: 'https://github.com/acme/web/pull/7', head: { ref: 'feat' }, base: { ref: 'main' }, merged: false, ...extra } });
  const opened = W.githubEvent('pull_request', pr('opened'));
  assert.strictEqual(opened.text, '**octo** opened pull request #7 in **acme/web**: Add \\*thing\\*\n`feat` \u2192 `main`\n<https://github.com/acme/web/pull/7>');
  assert.strictEqual(opened.summary.number, 7); assert.strictEqual(opened.summary.title, 'Add *thing*', 'a bot gets the title as it was, not escaped');
  assert.ok(W.githubEvent('pull_request', pr('closed', { merged: true })).text.includes('merged pull request #7'));
  assert.ok(W.githubEvent('pull_request', pr('closed')).text.includes('closed pull request #7'));
  assert.ok(W.githubEvent('pull_request', pr('ready_for_review')).text.includes('marked ready for review'));
  assert.strictEqual(W.githubEvent('pull_request', pr('labeled')), null, 'labels, assignments and the like are not shown');
  assert.strictEqual(W.githubEvent('pull_request', pr('synchronize')), null);

  const review = (state) => ({ action: 'submitted', repository: repo, sender, pull_request: { number: 7, title: 'T' }, review: { state, body: 'Looks good', html_url: 'https://github.com/acme/web/pull/7#r1' } });
  assert.ok(W.githubEvent('pull_request_review', review('APPROVED')).text.includes('approved pull request #7'));
  assert.ok(W.githubEvent('pull_request_review', review('changes_requested')).text.includes('requested changes on pull request #7'));
  assert.ok(W.githubEvent('pull_request_review', review('approved')).text.includes('> Looks good'));
  assert.strictEqual(W.githubEvent('pull_request_review', review('dismissed')), null);
  step('github pull requests and reviews: opened, merged, closed, ready; labels and syncs stay quiet');
}
{
  const issue = (action) => ({ action, repository: repo, sender, issue: { number: 3, title: 'Crash on start', html_url: 'https://github.com/acme/web/issues/3' } });
  assert.strictEqual(W.githubEvent('issues', issue('opened')).text, '**octo** opened issue #3 in **acme/web**: Crash on start\n<https://github.com/acme/web/issues/3>');
  assert.ok(W.githubEvent('issues', issue('closed')).text.includes('closed issue #3'));
  assert.strictEqual(W.githubEvent('issues', issue('labeled')), null);

  const long = 'word '.repeat(100);
  const c = W.githubEvent('issue_comment', { action: 'created', repository: repo, sender, issue: { number: 3, title: 'Crash on start' }, comment: { body: long, html_url: 'https://github.com/acme/web/issues/3#c1' } });
  const quote = c.text.split('\n').find((l) => l.startsWith('> '));
  assert.ok(quote && quote.length <= 205 && quote.endsWith('\u2026'), 'a long comment is cut to a short quote');
  assert.strictEqual(W.githubEvent('issue_comment', { action: 'edited', repository: repo, sender, issue: { number: 3, title: 'x' }, comment: { body: 'x' } }), null, 'edits are not shown');
  step('github issues and comments: opened, closed, quoted comment cut short');
}
{
  const rel = W.githubEvent('release', { action: 'published', repository: repo, sender, release: { tag_name: 'v1.2.0', name: 'Big one', html_url: 'https://github.com/acme/web/releases/tag/v1.2.0' } });
  assert.ok(rel.text.startsWith('\u{1F680} **acme/web** released `v1.2.0` \u2014 Big one'), rel.text);
  assert.ok(W.githubEvent('release', { action: 'published', repository: repo, sender, release: { tag_name: 'v2-rc', prerelease: true } }).text.includes('pre-released'));
  assert.strictEqual(W.githubEvent('release', { action: 'created', repository: repo, sender, release: { tag_name: 'v1' } }), null, 'only a published release is shown');
  assert.strictEqual(W.githubEvent('star', { action: 'created', repository: { ...repo, stargazers_count: 12 }, sender }).text, '\u2B50 **octo** starred **acme/web** (12 stars)');
  assert.ok(W.githubEvent('star', { action: 'created', repository: { ...repo, stargazers_count: 1 }, sender }).text.endsWith('(1 star)'));
  assert.strictEqual(W.githubEvent('star', { action: 'deleted', repository: repo, sender }), null);
  assert.ok(W.githubEvent('fork', { repository: repo, sender, forkee: { full_name: 'octo/web', html_url: 'https://github.com/octo/web' } }).text.includes('forked **acme/web**'));
  const wf = (conclusion) => ({ action: 'completed', repository: repo, sender, workflow_run: { name: 'CI', conclusion, head_branch: 'main', html_url: 'https://github.com/acme/web/actions/runs/1' } });
  assert.strictEqual(W.githubEvent('workflow_run', wf('failure')).text, '\u274C Workflow **CI** failed on `main` in **acme/web**\n<https://github.com/acme/web/actions/runs/1>');
  assert.ok(W.githubEvent('workflow_run', wf('success')).text.startsWith('\u2705'));
  assert.strictEqual(W.githubEvent('workflow_run', wf('skipped')), null, 'skipped runs stay quiet');
  assert.ok(W.githubEvent('ping', { zen: 'x', repository: repo, sender }).text.includes('GitHub is now connected to **acme/web**'));
  assert.strictEqual(W.githubEvent('watch', { repository: repo, sender }), null, 'events Aduna does not show');
  assert.strictEqual(W.githubEvent('push', null), null); assert.strictEqual(W.githubEvent('push', 'x'), null);
  step('github releases, stars, forks, workflow runs, ping; the rest is ignored');
}

// ----- what a stranger controls is cleaned -----
{
  const hostile = (title, url = 'https://github.com/acme/web/issues/1') => W.githubEvent('issues', { action: 'opened', repository: { full_name: 'a_b/*c*' }, sender: { login: 'ev\u202eil' }, issue: { number: 1, title, html_url: url } });
  assert.ok(hostile('Hello\u202eworld\u0007!').text.includes('Hello world !'), 'bidi overrides and control characters are replaced');
  assert.ok(!/[\u202a-\u202e\u0000-\u0008]/.test(hostile('x\u202ey').text), 'none left anywhere');
  const t = hostile('<@0123456789abcdef> <stk:abc> @everyone `code` |spoiler| ~~s~~ **b** __u__').text;
  assert.ok(!/(^|[^\\])<(@|stk:)/.test(t) && !t.includes('**b**') && !t.includes('~~s~~') && !t.includes('__u__'), 'markdown and tokens are escaped: ' + t);
  assert.ok(t.includes('\\@everyone'), '@everyone is escaped');
  assert.ok(hostile('x').text.includes('**a\\_b/\\*c\\***'), 'the repository name is escaped too');
  assert.ok(!hostile('x', 'http://evil.example/x').text.includes('<http'), 'only https addresses are shown');
  assert.ok(!hostile('x', 'javascript:alert(1)').text.includes('javascript'), 'never a script address');
  assert.ok(!hostile('x', 'not a url').text.includes('<'), 'nor a broken one');
  const big = hostile('x'.repeat(5000));
  assert.ok(big.text.length < 400, 'a huge title is cut');
  assert.ok(big.summary.title.length <= 150, 'and what a bot gets is cut too');
  const lines = W.githubEvent('issues', { action: 'opened', repository: repo, sender, issue: { number: 1, title: 'one\ntwo\r\nthree' } }).text.split('\n');
  assert.strictEqual(lines.length, 1, 'line breaks in a title cannot start a new message line');
  assert.ok(W.esc('a*b_c') === 'a\\*b\\_c' && W.line('  a   b  ') === 'a b');
  step('stranger text: bidi and control characters out, markdown / mention / sticker tokens escaped, https links only, lengths capped');
}

// ----- generic webhooks -----
{
  assert.strictEqual(W.genericText({ content: 'Deploy **done**' }).text, 'Deploy **done**', 'the sender\u2019s own formatting is kept');
  assert.strictEqual(W.genericText({ text: 'a' }).text, 'a'); assert.strictEqual(W.genericText({ message: 'b' }).text, 'b');
  assert.strictEqual(W.genericText({ content: 1, text: 'x' }).text, 'x', 'the first field that is a string');
  const t = W.genericText({ content: 'hi <@0123456789abcdef> @everyone @here <stk:abc>' }).text;
  assert.ok(!t.includes('<@0') && !t.includes('<stk:') && !/@everyone|@here/.test(t), 'pings and sticker tokens are defused: ' + JSON.stringify(t));
  assert.ok(t.replace(/\u200b/g, '').includes('<@0123456789abcdef> @everyone @here'), 'but the text still reads the same');
  assert.strictEqual(W.genericText({ content: 'x'.repeat(5000) }).text.length, 2000, 'cut to the message limit');
  for (const bad of [null, [], 'text', 5, {}, { content: '   ' }, { content: 5 }]) assert.ok(W.genericText(bad).error, 'refused: ' + JSON.stringify(bad));
  const d = W.genericData({ content: 'hi', n: 3, deep: { a: [1, 2] } });
  assert.deepStrictEqual(d.json, { content: 'hi', n: 3, deep: { a: [1, 2] } }); assert.strictEqual(d.text, 'hi'); assert.strictEqual(d.source, 'webhook');
  assert.strictEqual(W.genericData({ blob: 'x'.repeat(40_000) }).json, null, 'JSON that is too big is not handed to a bot');
  assert.strictEqual(W.genericData({ n: 1 }).text, '', 'a bot can get data without any message text');
  step('generic webhooks: own formatting kept, pings defused, field names, limits, data for bots');
}

// ----- one delivery, judged -----
{
  const hook = { id: '0123456789abcdef', kind: 'github', secret: 's3cret', channelId: 'c1' };
  const body = { ref: 'refs/heads/main', repository: repo, sender, commits: [{ id: 'abcdef1', message: 'hi', author: { username: 'octo' } }], compare: 'https://github.com/acme/web/compare/a...b' };
  const raw = Buffer.from(JSON.stringify(body));
  const headers = (o = {}) => ({ 'x-hub-signature-256': sign(raw, 's3cret'), 'x-github-event': 'push', 'x-github-delivery': 'd-1', ...o });
  const seen = new W.RecentIds();
  let r = W.receive(hook, { headers: headers(), rawBody: raw, body, seen });
  assert.strictEqual(r.status, 200); assert.ok(r.text.includes('pushed 1 commit')); assert.strictEqual(r.data.source, 'github'); assert.strictEqual(r.data.event, 'push');
  r = W.receive(hook, { headers: headers(), rawBody: raw, body, seen });
  assert.deepStrictEqual([r.status, r.ignored, r.text], [200, 'duplicate delivery', undefined], 'a redelivery posts nothing twice');
  r = W.receive(hook, { headers: headers({ 'x-github-delivery': 'd-2' }), rawBody: raw, body, seen });
  assert.ok(r.text, 'another delivery id is a new delivery');
  r = W.receive({ ...hook, id: 'f'.repeat(16) }, { headers: headers(), rawBody: raw, body, seen });
  assert.ok(r.text, 'the same delivery id on another webhook is not a duplicate');

  r = W.receive(hook, { headers: headers({ 'x-hub-signature-256': sign(raw, 'wrong') }), rawBody: raw, body, seen });
  assert.strictEqual(r.status, 401); assert.ok(/application\/json/.test(r.error), 'the error says what to check');
  assert.strictEqual(W.receive(hook, { headers: headers({ 'x-hub-signature-256': undefined }), rawBody: raw, body, seen }).status, 401, 'unsigned');
  assert.strictEqual(W.receive(hook, { headers: headers(), rawBody: undefined, body, seen }).status, 401, 'no raw body (form-encoded delivery): refused with the hint');
  assert.strictEqual(W.receive(hook, { headers: headers({ 'x-hub-signature-256': sign(Buffer.from('{}'), 's3cret') }), rawBody: raw, body, seen }).status, 401, 'signature of other bytes');
  assert.strictEqual(W.receive({ ...hook, secret: '' }, { headers: headers(), rawBody: raw, body, seen }).status, 500, 'a record without a secret never accepts anything');
  assert.strictEqual(W.receive(hook, { headers: headers({ 'x-github-event': undefined }), rawBody: raw, body, seen }).status, 400, 'no event header');
  assert.strictEqual(W.receive(hook, { headers: headers({ 'x-github-event': 'Push; DROP' }), rawBody: raw, body, seen }).status, 400, 'a strange event name');
  r = W.receive(hook, { headers: headers({ 'x-github-event': 'watch', 'x-github-delivery': 'd-9' }), rawBody: raw, body, seen });
  assert.deepStrictEqual([r.status, /not shown/.test(r.ignored)], [200, true], 'events Aduna does not show are accepted and ignored, so GitHub does not mark the webhook as failing');
  r = W.receive(hook, { headers: { ...headers(), 'x-github-event': ['push'] }, rawBody: raw, body, seen });
  assert.ok(r.status === 200, 'repeated headers use the first');

  r = W.receive({ id: 'g', kind: 'generic' }, { body: { content: 'hello' } });
  assert.deepStrictEqual([r.status, r.text, r.data.source], [200, 'hello', 'webhook']);
  assert.strictEqual(W.receive({ id: 'g', kind: 'generic' }, { body: { nope: 1 } }).status, 400);
  assert.strictEqual(W.receive({ id: 'g', kind: 'generic' }, { body: undefined }).status, 400);
  step('receive: signature checked first, redeliveries ignored per webhook, bad header and event names, unshown events accepted quietly, generic bodies');
}
{
  const s = new W.RecentIds(3);
  ['a', 'b', 'c', 'd'].forEach((k) => s.add(k));
  assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((k) => s.has(k)), [false, true, true, true], 'the oldest is forgotten first');
  s.add('b'); s.add('e');
  assert.deepStrictEqual(['b', 'c', 'd', 'e'].map((k) => s.has(k)), [true, false, true, true], 'adding again refreshes it');
  step('recent deliveries: bounded memory');
}

// ----- records -----
{
  const server = { channels: [{ id: 't1', name: 'general', type: 'text' }, { id: 't2', name: 'old' }, { id: 'v1', name: 'Voice', type: 'voice' }, { id: 'r1', name: 'rules', type: 'rules' }] };
  const make = (input, o = {}) => W.checkHook(input, { server, botIds: ['b1'], ...o });
  assert.deepStrictEqual(make({ name: '  Deploys   bot ', channelId: 't1' }).value, { name: 'Deploys bot', kind: 'generic', botId: null, channelId: 't1' }, 'a channel without a type is a text channel; spaces tidied; kind defaults to generic');
  assert.strictEqual(make({ name: 'x', kind: 'github', channelId: 't2' }).value.kind, 'github');
  assert.strictEqual(make({ name: 'n'.repeat(100), channelId: 't1' }).value.name.length, 32, 'names are cut to 32');
  assert.strictEqual(make({ name: 'x\u202e\u0007y', channelId: 't1' }).value.name, 'x y', 'control characters are replaced');
  assert.strictEqual(make({ channelId: 't1' }).error, 'Give the webhook a name');
  assert.strictEqual(make({ name: '   ', channelId: 't1' }).error, 'Give the webhook a name');
  assert.strictEqual(make(undefined).error, 'Give the webhook a name');
  assert.ok(make({ name: 'x', kind: 'slack', channelId: 't1' }).error, 'only generic and github');
  assert.ok(make({ name: 'x', channelId: 'v1' }).error, 'not a voice channel');
  assert.ok(make({ name: 'x', channelId: 'r1' }).error, 'not a rules channel');
  assert.ok(make({ name: 'x', channelId: 'nope' }).error, 'not a channel of another server');
  assert.strictEqual(make({ name: 'x' }).error, 'Pick the channel the messages should go to', 'it has to go somewhere');
  assert.deepStrictEqual(make({ name: 'x', botId: 'b1' }).value.botId, 'b1', 'a bot alone is enough');
  assert.strictEqual(make({ name: 'x', botId: 'b2' }).error, 'That bot is not in this server');
  assert.strictEqual(make({ name: 'x', botId: 'b1', channelId: 't1' }).value.channelId, 't1', 'both: the channel gets the message and the bot gets the data');

  const current = { kind: 'generic', name: 'Old', channelId: 't1', botId: null };
  assert.deepStrictEqual(make({ name: 'New' }, { current }).value, { name: 'New' }, 'an edit changes only what is sent');
  assert.deepStrictEqual(make({ channelId: 't2' }, { current }).value, { channelId: 't2' });
  assert.ok(make({ channelId: null }, { current }).error, 'cannot remove the only destination');
  assert.deepStrictEqual(make({ channelId: null, botId: 'b1' }, { current }).value, { channelId: null, botId: 'b1' }, 'but can swap it for a bot');
  assert.ok(make({ kind: 'github' }, { current }).error, 'the kind is fixed');
  assert.ok(!make({ kind: 'generic' }, { current }).error, 'saying the same kind again is fine');
  assert.ok(make({ name: '' }, { current }).error, 'an edit cannot empty the name');
  assert.deepStrictEqual(make({}, { current }).value, {}, 'an empty edit is fine');

  const h = { id: 'h1', name: 'Deploys', kind: 'github', channelId: 't1', botId: null, tokenHash: 'HASH', secret: 'SECRET', userId: 'u1', by: 'someone', createdAt: 5, lastUsedAt: 9, uses: 3 };
  const v = W.hookView(h, server);
  assert.deepStrictEqual(Object.keys(v).sort(), ['botId', 'broken', 'channelId', 'channelName', 'createdAt', 'id', 'kind', 'lastUsedAt', 'name', 'uses']);
  assert.ok(!JSON.stringify(v).includes('HASH') && !JSON.stringify(v).includes('SECRET'), 'the token hash and the secret never leave');
  assert.deepStrictEqual([v.channelName, v.broken, v.uses], ['general', false, 3]);
  assert.strictEqual(W.hookView({ ...h, channelId: 'gone' }, server).broken, true, 'its channel was deleted and no bot takes the data: shown as broken');
  assert.strictEqual(W.hookView({ ...h, channelId: 'gone', botId: 'b1' }, server).broken, false, 'a bot still takes it');
  assert.strictEqual(W.hookView({ id: 'x', name: 'n', kind: 'generic' }, server).uses, 0);
  step('records: create and edit rules, text channels only, installed bots only, views never show the token or secret');
}

console.log('webhooks: all good');
