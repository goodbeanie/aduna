// Poll rules without a database: node server/polls-test.js
const assert = require('assert');
const P = require('./polls');
const step = (m) => console.log('✓', m);
const make = (o = {}) => P.cleanPoll({ question: 'Pizza?', options: ['Yes', 'No'], ...o }).poll;

// ---- creating ----
{
  const { poll } = P.cleanPoll({ question: '  Where   to   eat? ', options: ['  Tacos ', 'Ramen', '', '   '], multi: true, hours: 2 }, 1000);
  assert.strictEqual(poll.question, 'Where to eat?', 'whitespace tidied');
  assert.deepStrictEqual(poll.options.map((o) => [o.id, o.text, o.votes.length]), [['o0', 'Tacos', 0], ['o1', 'Ramen', 0]], 'blank rows dropped, ids assigned by us');
  assert.strictEqual(poll.multi, true); assert.strictEqual(poll.closesAt, 1000 + 2 * 3600_000); assert.strictEqual(poll.closed, false);
  assert.strictEqual(make().closesAt, null, 'no duration = open until closed');
  assert.strictEqual(make({ multi: 'yes' }).multi, false, 'only a real true turns on multiple choice');
  step('a poll is cleaned: whitespace, blank options, our own option ids, optional duration');
}
{
  const bad = (o, re) => { const r = P.cleanPoll(o); assert.ok(r.error && !r.poll, JSON.stringify(o)); if (re) assert.ok(re.test(r.error), r.error); };
  for (const x of [null, undefined, 'poll', 5, [], true]) bad(x);
  bad({ options: ['a', 'b'] }, /question/); bad({ question: '   ', options: ['a', 'b'] }, /question/); bad({ question: 7, options: ['a', 'b'] });
  bad({ question: 'x'.repeat(301), options: ['a', 'b'] }, /300/);
  bad({ question: 'q', options: ['only'] }, /at least 2/); bad({ question: 'q', options: ['a', '  ', ''] }, /at least 2/); bad({ question: 'q' }); bad({ question: 'q', options: 'ab' });
  bad({ question: 'q', options: Array.from({ length: 11 }, (_, i) => 'o' + i) }, /at most 10/);
  bad({ question: 'q', options: Array.from({ length: 51 }, (_, i) => 'o' + i) });
  bad({ question: 'q', options: ['a', 'b'.repeat(101)] }, /100/);
  bad({ question: 'q', options: ['a', 5] }); bad({ question: 'q', options: ['a', null] }); bad({ question: 'q', options: ['a', { toString: () => 'b' }] });
  bad({ question: 'q', options: ['Same', 'same'] }, /different/); bad({ question: 'q', options: ['Same', ' same '] }, /different/);
  for (const h of [0, -1, 0.5, 721, NaN, Infinity, '2', {}, []]) bad({ question: 'q', options: ['a', 'b'], hours: h }, /hour/);
  assert.ok(P.cleanPoll({ question: 'q', options: Array.from({ length: 10 }, (_, i) => 'o' + i) }).poll, 'exactly 10 options is fine');
  assert.ok(P.cleanPoll({ question: 'q', options: ['a', 'b'], hours: 720 }).poll && P.cleanPoll({ question: 'q', options: ['a', 'b'], hours: 1 }).poll, '1 hour and 30 days are the limits');
  const r = P.cleanPoll({ question: 'q', options: ['a', 'b'], votes: ['x'], closed: true, extra: 1, __proto__: { x: 1 } });
  assert.strictEqual(r.poll.closed, false); assert.ok(!('extra' in r.poll) && !('votes' in r.poll), 'nothing else a client sends is kept');
  assert.ok(!r.poll.options.some((o) => o.votes.length), 'no pre-filled votes');
  step('bad polls are refused: shape, question, option count/length/duplicates, duration; nothing extra is kept');
}

// ---- voting ----
{
  const p = make();
  assert.deepStrictEqual(P.castVote(p, 'u1', ['o0']), { ok: true });
  assert.deepStrictEqual(p.options.map((o) => o.votes), [['u1'], []]);
  P.castVote(p, 'u1', ['o1']); assert.deepStrictEqual(p.options.map((o) => o.votes), [[], ['u1']], 'changing your vote moves it, never doubles it');
  P.castVote(p, 'u2', ['o1']); P.castVote(p, 'u1', ['o1']); assert.deepStrictEqual([...p.options[1].votes].sort(), ['u1', 'u2'], 'voting the same again changes nothing');
  P.castVote(p, 'u1', []); assert.deepStrictEqual(p.options.map((o) => o.votes), [[], ['u2']], 'an empty list takes the vote back');
  assert.ok(P.castVote(p, 'u3', ['o0', 'o1']).error, 'single choice takes one option'); assert.deepStrictEqual(p.options.map((o) => o.votes), [[], ['u2']], 'a refused vote changes nothing');
  assert.ok(P.castVote(p, 'u3', ['nope']).error); assert.ok(P.castVote(p, 'u3', ['o0', 'nope']).error); assert.deepStrictEqual(p.options[0].votes, [], 'one bad id voids the whole vote');
  for (const bad of ['o0', null, undefined, {}, [5], [null], [['o0']], Array.from({ length: 11 }, () => 'o0')]) assert.ok(P.castVote(p, 'u3', bad).error, 'refused: ' + JSON.stringify(bad));
  assert.ok(P.castVote({}, 'u', ['o0']).error && P.castVote(null, 'u', ['o0']).error && P.castVote(undefined, 'u', []).error, 'not a poll');
  assert.ok(P.castVote(p, 'u3', ['constructor']).error && P.castVote(p, 'u3', ['__proto__']).error, 'option ids are matched exactly, not by property lookup');
  step('voting: change, repeat, take back, single choice, unknown option voids the vote, hostile input');
}
{
  const p = make({ multi: true });
  P.castVote(p, 'u1', ['o0', 'o1', 'o0']); assert.deepStrictEqual(p.options.map((o) => o.votes), [['u1'], ['u1']], 'multiple choice takes several, repeats counted once');
  P.castVote(p, 'u1', ['o1']); assert.deepStrictEqual(p.options.map((o) => o.votes), [[], ['u1']], 'the new list replaces the old');
  step('multiple choice: several options at once, replaced as a whole');
}

// ---- ending ----
{
  const t0 = 10_000;
  const p = P.cleanPoll({ question: 'q', options: ['a', 'b'], hours: 1 }, t0).poll;
  assert.ok(!P.isEnded(p, t0 + 3599_000)); assert.ok(P.isEnded(p, t0 + 3600_000), 'ends exactly at closesAt');
  assert.deepStrictEqual(P.castVote(p, 'u1', ['o0'], t0 + 1000), { ok: true });
  assert.strictEqual(P.castVote(p, 'u2', ['o0'], t0 + 3600_000).error, 'This poll has ended', 'no votes after the time is up, and no timer is needed');
  assert.strictEqual(p.options[0].votes.length, 1);
  assert.strictEqual(P.castVote(p, 'u1', [], t0 + 3600_000).error, 'This poll has ended', 'not even taking a vote back');
  const q = make();
  assert.ok(!P.isEnded(q)); assert.deepStrictEqual(P.closePoll(q, 'owner', 5), { ok: true });
  assert.ok(P.isEnded(q) && q.closed && q.closedBy === 'owner' && q.closedAt === 5);
  assert.ok(P.castVote(q, 'u1', ['o0']).error, 'closed by hand: no more votes'); assert.ok(P.closePoll(q, 'owner').error, 'cannot close twice');
  assert.ok(P.closePoll(p, 'owner', t0 + 4000_000).error, 'a poll that timed out is already over');
  assert.ok(!P.isEnded(null) && !P.isEnded(undefined));
  step('ending: by time (no timer needed) and by hand; both stop all votes; cannot end twice');
}
assert.strictEqual(P.pollPreview(make({ question: 'Pizza?' })), 'Poll: Pizza?'); assert.strictEqual(P.pollPreview(undefined), '');
console.log('\nAll poll checks passed.');
