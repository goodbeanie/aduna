// Server automod without a server: node server/automod-test.js
const assert = require('assert');
const A = require('./automod');
const T = 1_700_000_000_000, MIN = 60_000, DAY = 86_400_000;
const step = (s) => console.log('ok -', s);

const server = (over = {}) => ({ id: 's1', inviteCode: 'mine', roles: [{ id: 'r1' }], channels: [{ id: 'c1' }], ...over });
const on = (patch = {}) => {
  const cfg = A.defaults();
  cfg.enabled = true;
  return Object.assign(cfg, patch);
};
const rules = (cfg, name, patch) => { cfg.rules[name] = { ...cfg.rules[name], on: true, ...patch }; return cfg; };

// settings are checked and tidied
let r = A.clean({ enabled: true, words: ['  Foo  ', 'foo', 'bar baz', ''] }, server());
assert.deepStrictEqual(r.value.words, ['foo', 'bar baz'], 'words are lowercased, tidied and not doubled');
assert.ok(A.clean({ words: 'nope' }, server()).error);
assert.ok(A.clean({ words: ['***'] }, server()).error, 'a word needs a letter or number');
assert.ok(A.clean({ words: ['x'.repeat(41)] }, server()).error);
assert.ok(A.clean({ rules: { caps: { percent: 10 } } }, server()).error);
assert.ok(A.clean({ rules: { links: { allow: ['not a site'] } } }, server()).error);
assert.deepStrictEqual(A.clean({ rules: { links: { allow: ['https://www.Example.com/page'] } } }, server()).value.rules.links.allow, ['example.com']);
assert.deepStrictEqual(A.clean({ exemptRoles: ['r1', 'gone'], exemptChannels: ['c1', 'x'] }, server()).value.exemptRoles, ['r1'], 'a role that does not exist is dropped');
assert.deepStrictEqual(A.clean({ exemptChannels: ['c1', 'x'] }, server()).value.exemptChannels, ['c1']);
assert.ok(A.clean({ strikes: { ladder: [{ at: 2, action: 'timeout', minutes: 0 }] } }, server()).error);
assert.ok(A.clean({ strikes: { ladder: [{ at: 2, action: 'ban' }] } }, server()).error, 'there is no ban step');
assert.ok(A.clean({ strikes: { ladder: [{ at: 2, action: 'kick' }, { at: 2, action: 'timeout', minutes: 5 }] } }, server()).error);
r = A.clean({ strikes: { ladder: [{ at: 5, action: 'kick' }, { at: 2, action: 'timeout', minutes: 5 }] } }, server());
assert.deepStrictEqual(r.value.strikes.ladder.map((l) => l.at), [2, 5], 'steps are put in order');
assert.strictEqual(A.clean({}, server()).value.enabled, false, 'automod is off until it is switched on');
assert.strictEqual(A.clean({}, server()).value.logChannel, null, 'no log channel by default');
assert.strictEqual(A.clean({ logChannel: 'c1' }, server()).value.logChannel, 'c1');
assert.strictEqual(A.clean({ logChannel: 'gone' }, server()).value.logChannel, null, 'a channel that does not exist is dropped');
assert.strictEqual(A.clean({ logChannel: 'v1' }, server({ channels: [{ id: 'v1', type: 'voice' }] })).value.logChannel, null, 'a voice channel cannot take the log');
step('settings are validated');

// banned words
let cfg = on({ words: ['badword', 'kill yourself', 'spam*', '*tard', 'ass'] });
const hit = (text, c = cfg) => A.screen(c, text, { key: 'k', now: T });
assert.strictEqual(hit('this is fine'), null);
assert.strictEqual(hit('you BADWORD').rule, 'words');
assert.strictEqual(hit('badwords everywhere').what, 'badword', 'a plural counts');
assert.strictEqual(hit('badword!').what, 'badword', 'punctuation next to a word does not hide it');
assert.strictEqual(hit('b4dw0rd').what, 'badword', 'number swaps are read');
assert.strictEqual(hit('baaaadword').what, 'badword', 'stretched letters are shortened');
assert.strictEqual(hit('badwoooord').what, 'badword');
assert.strictEqual(hit('badwordz'), null, 'a different word is not a plural');
assert.strictEqual(hit('b a d w o r d').what, 'badword', 'spaced out letters are joined');
assert.strictEqual(hit('b.a.d.w.o.r.d').what, 'badword');
assert.strictEqual(hit('kill  yourself').what, 'kill yourself', 'a phrase matches');
assert.strictEqual(hit('killyourself').what, 'kill yourself', 'a phrase run together matches');
assert.strictEqual(hit('kill the process, yourself included'), null, 'words apart are not a phrase');
assert.strictEqual(hit('spammer').what, 'spam*', 'a trailing * matches the start of a word');
assert.strictEqual(hit('so retard').what, '*tard', 'a leading * matches the end of a word');
assert.strictEqual(hit('tardy'), null, 'the * only opens one side');
assert.strictEqual(hit('class'), null, 'a short word only matches as a whole word');
assert.strictEqual(hit('you ass').what, 'ass');
assert.strictEqual(A.screen(on({ words: ['дурак'] }), 'ты ДУРАК', {}).what, 'дурак', 'other alphabets work');
assert.strictEqual(A.screen(on({ words: ['cafe'] }), 'a café', {}).what, 'cafe', 'accents are ignored');
cfg.rules.words.on = false;
assert.strictEqual(hit('badword'), null, 'a rule that is off does nothing');
assert.strictEqual(A.screen({ ...cfg, enabled: false }, 'badword', {}), null, 'automod off does nothing');
step('banned words');

// file names
cfg = on({ words: ['badword', 'kill yourself'] });
assert.strictEqual(A.screenNames(cfg, ['holiday.png', 'notes.txt']), null);
assert.strictEqual(A.screenNames(cfg, ['holiday.png', 'BadWord_final.png']).what, 'badword', 'one bad name is enough');
assert.strictEqual(A.screenNames(cfg, ['b4dw0rd 2.jpg']).what, 'badword', 'name tricks are read like in messages');
assert.match(A.screenNames(cfg, ['badword.png']).reason, /file name/);
assert.strictEqual(A.screenNames(cfg, ['badword.png']).warn, true);
assert.strictEqual(A.screenNames(cfg, []), null);
assert.strictEqual(A.screenNames({ ...cfg, enabled: false }, ['badword.png']), null, 'automod off does nothing');
cfg.rules.words.on = false;
assert.strictEqual(A.screenNames(cfg, ['badword.png']), null, 'the words rule off skips names too');
step('file names');

// links and invites
cfg = rules(on(), 'links', { allow: ['example.com'] });
const link = (t, c = cfg) => A.screen(c, t, { inviteCode: 'mine', key: 'k', now: T });
assert.strictEqual(link('see https://evil.test/x').what, 'evil.test', 'with http any ending counts as a link');
assert.strictEqual(link('go to evil.com now').what, 'evil.com');
assert.strictEqual(link('go to www.evil.org/a?b=1').what, 'evil.org');
assert.strictEqual(link('https://example.com/a and docs.example.com'), null, 'allowed sites and their subdomains pass');
assert.strictEqual(link('notexample.com').what, 'notexample.com', 'a lookalike is not a subdomain');
assert.strictEqual(link('file.txt and e.g. this'), null, 'file names are not links');
assert.strictEqual(link('https://example.com@evil.com/').what, 'evil.com', 'user@host tricks are read');
cfg = rules(on(), 'invites', {});
assert.strictEqual(link('join https://aduna.dpdns.org/invite/other', cfg).what, 'other');
assert.strictEqual(link('join discord.gg/abc123', cfg).what, 'abc123');
assert.strictEqual(link('join https://aduna.dpdns.org/invite/MINE', cfg), null, 'an invite to this server is fine');
cfg = rules(rules(on(), 'invites', {}), 'links', {});
assert.strictEqual(link('https://aduna.dpdns.org/invite/mine', cfg), null, 'and it is not caught by the link rule either');
step('links and invites');

// capitals, mentions, repeats
cfg = rules(on(), 'caps', {});
const run = (t, c) => A.screen(c, t, { key: 'k', now: T });
assert.strictEqual(run('STOP SHOUTING AT EVERYONE', cfg).rule, 'caps');
assert.strictEqual(run('STOP IT', cfg), null, 'short messages are left alone');
assert.strictEqual(run('Hello there, this is a perfectly normal sentence', cfg), null);
cfg = rules(on(), 'mentions', { max: 2 });
const id = (c) => `<@${c.repeat(16)}>`;
assert.strictEqual(run(`${id('a')} ${id('b')}`, cfg), null);
assert.strictEqual(run(`${id('a')} ${id('b')} ${id('c')}`, cfg).rule, 'mentions');
assert.strictEqual(run(`@everyone @here ${id('a')}`, cfg).what, '3');
cfg = rules(on(), 'repeat', { times: 3, seconds: 30 });
const at = (t, n) => A.screen(cfg, t, { key: 'rep', now: T + n });
assert.strictEqual(at('same thing', 0), null);
assert.strictEqual(at('same   THING', 1000), null, 'case and spacing do not matter');
assert.strictEqual(at('same thing', 2000).rule, 'repeat', 'the third time is stopped');
assert.strictEqual(at('different', 3000), null);
assert.strictEqual(at('same thing', 31_000), null, 'outside the window it starts over');
assert.strictEqual(at('hi', 40_000), null);
assert.strictEqual(at('hi', 41_000), null, 'very short messages are not counted');
assert.strictEqual(at('hi', 42_000), null);
step('capitals, mentions and repeats');

// strikes climb a ladder
const s = server({ automod: on() });
s.automod.strikes.ladder = [{ at: 2, action: 'timeout', minutes: 10 }, { at: 4, action: 'kick' }];
const h = { rule: 'words', what: 'x', reason: 'r', warn: true };
let out = A.strike(s, 'u1', h, T);
assert.deepStrictEqual([out.count, out.step, out.next.at], [1, null, 2]);
assert.match(A.notice(h, out), /Warning 1\. At 2 warnings you will be timed out for 10 minutes\./);
out = A.strike(s, 'u1', h, T + 1000);
assert.deepStrictEqual([out.count, out.step.action], [2, 'timeout']);
assert.match(A.notice(h, out), /timed out for 10 minutes/);
A.timeoutUser(s, 'u1', out.step.minutes, T + 1000);
assert.strictEqual(A.timeoutLeft(s, 'u1', T + 1000 + 4 * MIN), 6 * MIN, 'minutes left on the timeout');
assert.match(A.timeoutNotice(6 * MIN), /6 minutes/);
assert.strictEqual(A.timeoutLeft(s, 'u1', T + 1000 + 11 * MIN), 0, 'it ends by itself');
assert.ok(!('u1' in s.automodMutes), 'and is dropped');
out = A.strike(s, 'u1', h, T + 2000);
assert.deepStrictEqual([out.count, out.step, out.next.at], [3, null, 4], 'only the exact step fires');
out = A.strike(s, 'u1', h, T + 3000);
assert.strictEqual(out.step.action, 'kick');
assert.match(A.notice(h, out), /removed from this server/);
assert.strictEqual(A.notice({ ...h, warn: false }, null), 'Message not sent: r.', 'a rule without warnings only refuses the message');
step('strikes and timeouts');

// strikes expire, and a moderator can forgive
const e = server({ automod: on() });
A.strike(e, 'u2', h, T); A.strike(e, 'u2', h, T);
assert.strictEqual(A.strike(e, 'u2', h, T + 31 * DAY).count, 1, 'two old strikes no longer count');
assert.strictEqual(A.activeStrikes(e, 'u2', T + 31 * DAY).length, 1);
A.timeoutUser(e, 'u2', 60, T);
A.forgive(e, 'u2');
assert.strictEqual(A.activeStrikes(e, 'u2', T).length, 0);
assert.strictEqual(A.timeoutLeft(e, 'u2', T), 0);
step('strikes expire and can be forgiven');

// the line for the log channel
const at5 = { rule: 'words', what: 'x', count: 0 };
assert.strictEqual(A.logText({ ...at5, action: 'blocked' }, 'Sam', 'general'), 'Sam had a message blocked in #general (words: x).');
assert.strictEqual(A.logText({ ...at5, action: 'warned', count: 2 }, 'Sam', 'general'), 'Sam was warned in #general (words: x). Warning 2.');
assert.strictEqual(A.logText({ ...at5, action: 'timeout', count: 3 }, 'Sam', 'general', { at: 3, action: 'timeout', minutes: 10 }), 'Sam was timed out for 10 minutes in #general (words: x). Warning 3.');
assert.strictEqual(A.logText({ ...at5, action: 'kick', count: 8 }, 'Sam', 'general'), 'Sam was removed from the server after 8 warnings, in #general (words: x).');
step('log channel text');

// the log and the settings view
const l = server({ automod: on() });
for (let i = 0; i < 120; i++) A.record(l, { at: T + i, userId: 'u1', channelId: 'c1', rule: 'words', what: 'x', action: 'blocked', preview: '  some\n  long text  ' });
assert.strictEqual(l.automodLog.length, A.LIMITS.logKeep, 'the log keeps the newest entries');
assert.strictEqual(l.automodLog[0].preview, 'some long text');
A.strike(l, 'u3', h, T); A.timeoutUser(l, 'u4', 5, T);
const v = A.view(l, T, (x) => 'name-' + x);
assert.strictEqual(v.log.length, 50);
assert.strictEqual(v.log[0].at, T + 119, 'newest first');
assert.deepStrictEqual(v.strikes.map((x) => x.userId).sort(), ['u3', 'u4']);
assert.deepStrictEqual(A.view(server(), T).config, A.defaults(), 'a server without settings shows the defaults');
step('log and view');
