// Run: node server/lounge-test.js
const assert = require('assert');
const L = require('./lounge');

const step = (m) => console.log('ok -', m);
const server = { id: 's1', channels: [{ id: 'c1', name: 'general' }, { id: 'c2', name: 'rules' }, { id: 'c3', name: 'Gaming', type: 'voice' }] };
const ok = (input, s = server) => { const r = L.clean(input, s); assert.ok(r.value, 'expected a lounge, got: ' + r.error); return r.value; };
const no = (input, why, s = server) => { const r = L.clean(input, s); assert.ok(r.error && !r.value, why + ' (got ' + JSON.stringify(r) + ')'); return r.error; };

{
  const v = ok({});
  assert.deepStrictEqual(v, { enabled: false, template: 'custom', tagline: '', look: L.DEFAULT_LOOK, sections: [] }, 'an empty request is a hidden, empty lounge with the default look');
  for (const bad of [null, undefined, 'x', 7, [], [{}]]) no(bad, 'the settings must be an object: ' + JSON.stringify(bad));
  assert.strictEqual(ok({ enabled: 'true' }).enabled, false, 'only a real true turns it on');
  assert.strictEqual(ok({ enabled: true }).enabled, true);
  step('lounge: defaults, and what the settings must be');
}

{
  assert.strictEqual(ok({ template: 'magazine' }).template, 'magazine');
  for (const bad of ['Magazine', 'nope', 7, null, {}]) no({ template: bad }, 'unknown template: ' + JSON.stringify(bad));
  const v = ok({ tagline: '  News first,\u0000 giveaways\n and more  ' });
  assert.strictEqual(v.tagline, 'News first,  giveaways  and more', 'control characters (line breaks too) become spaces in a one-line field, and it is trimmed');
  no({ tagline: 'x'.repeat(L.LIMITS.tagline + 1) }, 'tagline too long');
  no({ tagline: 5 }, 'tagline must be text');
  assert.strictEqual(ok({ tagline: '\u{1F600}'.repeat(L.LIMITS.tagline) }).tagline.length, L.LIMITS.tagline * 2, 'length counts characters, not UTF-16 units');
  step('lounge: template and tagline');
}

{
  const v = ok({ look: { accent: '#FF66CC', background: 'mesh', cards: 'outline', font: 'serif', banner: 'short', title: 'right' } });
  assert.deepStrictEqual(v.look, { accent: '#ff66cc', background: 'mesh', cards: 'outline', font: 'serif', banner: 'short', title: 'right' });
  assert.deepStrictEqual(ok({ look: { title: 'left' } }).look, { ...L.DEFAULT_LOOK, title: 'left' }, 'what is not sent keeps its default');
  assert.strictEqual(ok({ look: { accent: 'auto' } }).look.accent, 'auto');
  for (const look of [{ accent: 'red' }, { accent: '#fff' }, { accent: '#ff66cc;background:url(x)' }, { accent: 7 }, { background: 'neon' }, { cards: 'Glass' },
    { font: 'Comic Sans' }, { banner: 'huge' }, { title: 'top' }, { title: null }, 'x', [], 7]) {
    no({ look }, 'a bad look is refused: ' + JSON.stringify(look));
  }
  step('lounge: the look (accent, background, cards, font, banner height, title left / centre / right)');
}

{
  const v = ok({ sections: [
    { id: 'abcd1234', type: 'buttons', items: [{ label: 'Read the rules', channelId: 'c2' }, { label: 'Our site', url: 'https://example.com/hi?x=1' }, { label: '', channelId: 'c1' }] },
    { type: 'about', heading: 'About', text: 'Line one\nLine two' },
    { type: 'live' }, { type: 'members', enabled: false },
    { type: 'channels', channelIds: ['c1', 'c2', 'c1', 'gone', 7] },
    { type: 'links', items: [{ label: 'Wiki', url: 'https://wiki.example.com' }] },
    { type: 'announcement', text: 'Movie night Friday' },
    { type: 'text', text: 'one' }, { type: 'text', text: 'two' },
  ] });
  assert.deepStrictEqual(v.sections.map((x) => x.type), ['buttons', 'about', 'live', 'members', 'channels', 'links', 'announcement', 'text', 'text'], 'the order is kept: that is how the owner arranges the page');
  assert.strictEqual(v.sections[0].id, 'abcd1234', 'a good id is kept');
  assert.ok(v.sections.every((x) => /^[a-z0-9]{4,16}$/.test(x.id)) && new Set(v.sections.map((x) => x.id)).size === v.sections.length, 'every section has its own id');
  assert.deepStrictEqual(v.sections[0].items, [{ label: 'Read the rules', channelId: 'c2' }, { label: 'Our site', url: 'https://example.com/hi?x=1' }], 'blank rows are dropped');
  assert.strictEqual(v.sections[1].text, 'Line one\nLine two', 'a text block keeps its line breaks');
  assert.strictEqual(v.sections[3].enabled, false, 'a section can be switched off and stay where it is');
  assert.strictEqual(v.sections[2].enabled, true);
  assert.deepStrictEqual(v.sections[4].channelIds, ['c1', 'c2'], 'unknown and repeated channels drop out of a widget');
  step('lounge: sections keep their order, ids and switches; blank and unknown entries drop out');
}

{
  const v = ok({ sections: [{ type: 'buttons', items: [{ label: 'Gone', channelId: 'deleted' }] }] });
  assert.deepStrictEqual(v.sections[0].items, [], 'a button for a deleted channel is left out, the save still works');
  no({ sections: [{ type: 'about' }, { type: 'about' }] }, 'a second "about" section');
  no({ sections: [{ type: 'live' }, { type: 'live' }] }, 'a second "live" section');
  no({ sections: Array.from({ length: L.LIMITS.text + 1 }, () => ({ type: 'text' })) }, 'too many text blocks');
  no({ sections: Array.from({ length: L.LIMITS.sections + 1 }, () => ({ type: 'text' })) }, 'too many sections');
  no({ sections: [{ type: 'carousel' }] }, 'unknown type');
  no({ sections: [{}] }, 'no type');
  no({ sections: ['about'] }, 'a section must be an object');
  no({ sections: 'about' }, 'sections must be a list');
  no({ sections: [{ type: 'about', text: 'x'.repeat(L.LIMITS.body + 1) }] }, 'text too long');
  no({ sections: [{ type: 'announcement', text: 'x'.repeat(L.LIMITS.announcement + 1) }] }, 'announcement too long');
  no({ sections: [{ type: 'about', heading: 'x'.repeat(L.LIMITS.heading + 1) }] }, 'heading too long');
  no({ sections: [{ type: 'buttons', items: Array.from({ length: L.LIMITS.buttons + 1 }, () => ({ label: 'a', channelId: 'c1' })) }] }, 'too many buttons');
  no({ sections: [{ type: 'links', items: Array.from({ length: L.LIMITS.links + 1 }, () => ({ label: 'a', url: 'https://a.com' })) }] }, 'too many links');
  no({ sections: [{ type: 'channels', channelIds: Array.from({ length: L.LIMITS.channels + 1 }, (_, i) => 'c' + i) }] }, 'too many channels');
  step('lounge: structure and size limits');
}

{
  const link = (u) => ({ sections: [{ type: 'links', items: [{ label: 'x', url: u }] }] });
  ok(link('https://example.com'));
  for (const bad of ['http://example.com', 'javascript:alert(1)', 'data:text/html,hi', '//example.com', 'example.com', 'https://', 'https://a b.com', 'https://a.com/"onmouseover=', "https://a.com/'x", 'https://a.com/<script>',
    'ftp://a.com', '', undefined, 7, 'https://' + 'a'.repeat(L.LIMITS.url)]) {
    no(link(bad), 'a link must be https and plain: ' + JSON.stringify(bad));
  }
  no({ sections: [{ type: 'buttons', items: [{ label: 'x' }] }] }, 'a button needs a channel or a link');
  no({ sections: [{ type: 'buttons', items: [{ label: 'x', url: 'javascript:alert(1)' }] }] }, 'a button link must be https');
  no({ sections: [{ type: 'links', items: [{ label: 'x'.repeat(L.LIMITS.label + 1), url: 'https://a.com' }] }] }, 'label too long');
  step('lounge: only https links, no markup or script in them');
}

{
  const again = ok(ok({ enabled: true, tagline: 'hi', sections: [{ type: 'about', text: 'a' }, { type: 'live' }] }));
  assert.strictEqual(again.sections.length, 2, 'cleaning what is already clean changes nothing');
  const v = ok({ sections: [{ id: 'same1234', type: 'text' }, { id: 'same1234', type: 'text' }, { id: 'bad id!', type: 'text' }] });
  assert.strictEqual(new Set(v.sections.map((x) => x.id)).size, 3, 'repeated or malformed ids are replaced');
  assert.ok(!('x' in ok({ x: 1, sections: [] })), 'only the known fields are kept');
  step('lounge: idempotent, ids stay unique, only known fields are stored');
}

console.log('lounge tests passed');
