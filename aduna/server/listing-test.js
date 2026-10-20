// Listing moderation helpers (no database): node server/listing-test.js
const assert = require('assert');
const L = require('./listing');
const step = (m) => console.log('✓', m);
const WORDS = ['nazi', 'hitler', 'porn', 'rape', 'rapist', 'nude', 'cum', 'fag', 'kys', 'killyourself', 'nigga', 'slut'];
const ok = (s) => assert.strictEqual(L.listingProblem(s, WORDS), null, JSON.stringify(s));
const bad = (s) => assert.ok(L.listingProblem(s, WORDS), 'should be refused: ' + JSON.stringify(s));

ok({ name: 'Chess Club', description: 'Friendly games, weekly tournaments and lessons.', tags: ['chess', 'games'] });
ok({ name: 'Therapist chat', description: 'A therapist run space. Scunthorpe, cucumber and Niggardly Street are fine words.', tags: [] }); // nothing matched inside other words
ok({ name: 'Cumbria hikers', description: 'We love Cumberland sausage.', tags: ['hiking'] });
step('ordinary text, including look-alike substrings, passes');

bad({ name: 'Porn hub', description: 'x', tags: [] });
bad({ name: 'N4zi fans', description: 'x', tags: [] });
bad({ name: 'fine', description: 'We post nudes here', tags: [] });
bad({ name: 'fine', description: 'go kill yourself', tags: [] });

bad({ name: 'fine', description: 'fine', tags: ['p0rn'] });
bad({ name: 'fine', description: 'fine', tags: ['kill-yourself'] });
bad({ name: 'fine', description: 'fine', tags: ['heil-hitler'] });
step('blocked words, leetspeak, split words and tags are refused');

bad({ name: 'fine', description: 'Join us at https://example.com/x', tags: [] });
bad({ name: 'fine', description: 'see www.example.org', tags: [] });
bad({ name: 'fine', description: 'discord . gg / abc', tags: [] });
bad({ name: 'fine', description: 'our site: example dot com'.replace(' dot ', '[dot]'), tags: [] });
bad({ name: 'free-nitro.gg', description: 'x', tags: [] });
ok({ name: 'fine', description: 'Version 2.0 is out! We meet at 5.30 pm.', tags: [] });
step('links in names and descriptions are refused; numbers with dots are fine');

assert.strictEqual(L.textProblem('description', 'porn', WORDS) !== null, true);
assert.strictEqual(L.textProblem('tags', ['chess'], WORDS), null);
step('single-field check');

// reports: only established accounts count
const day = 24 * 3600 * 1000, now = 100 * day;
const users = { a: { createdAt: now - 5 * day }, b: { createdAt: now - 2 * day }, c: { createdAt: now - 1000 }, d: { createdAt: now - 3 * day } };
const reps = [{ by: 'a' }, { by: 'a' }, { by: 'b' }, { by: 'c' }, { by: 'ghost' }, { by: 'd' }];
assert.strictEqual(L.countedReports(reps, users, now), 3, 'distinct, old enough, existing accounts only');
assert.strictEqual(L.countedReports([], users, now), 0);
step('report counting ignores repeats, brand-new and missing accounts');
console.log('\nAll listing checks passed.');
