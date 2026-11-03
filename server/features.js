// Feature releases: ship a feature switched off, test it on a creator account, then release it to everyone.
// Pure logic (no database, no express): index.js keeps the records in db().features and calls these.
//
// A feature has one of three states:
//   off      nobody sees it (the default for anything never touched)
//   testing  only creator accounts see it, so it can be tried on the real site before anyone else can
//   live     everyone sees it
// A feature only goes live from testing (test it first), and can be pulled back to testing or off at any time.
// Features are declared in REGISTRY below, in code, because a switch only means something where the code that checks it exists:
//   server: featureOn('my-feature', req.user)  or the needFeature('my-feature') route guard (a plain 404 when it is not on for that person)
//   client: hasFeature(me, 'my-feature')        (client/src/features.js)
// To add a feature: add a line here, build it behind the check, deploy, then test and release it from the Features tab on /admin.
const STATES = ['off', 'testing', 'live'];

const REGISTRY = [
  { id: 'promoted-items', name: 'Promoted marketplace items', desc: 'Creators pay credits to feature their sticker packs and emoji in the Shop. (Planned: not built yet.)' },
  { id: 'sponsored-card', name: 'Sponsored card', desc: 'One clearly labelled, static “Sponsored” card at the bottom of the Shop. Needs ADS_JSON set on the server.' },
  { id: 'rewarded-ads', name: 'Watch an ad for credits', desc: 'An opt-in “Watch a sponsor, earn credits” button on the Quests tab, with a daily cap. Needs ADS_JSON set on the server.' },
];

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const known = (id) => typeof id === 'string' && REGISTRY.some((f) => f.id === id);

// the state of one feature; anything missing, unknown or damaged is off
function stateOf(records, id) {
  const r = has(records, id) ? records[id] : null;
  return r && STATES.includes(r.state) ? r.state : 'off';
}

// can this person use the feature right now? `creator` says whether the person is a creator account.
function enabled(records, id, creator) {
  if (!known(id)) return false;
  const s = stateOf(records, id);
  return s === 'live' || (s === 'testing' && creator === true);
}

// what one person is told: { id: 'live' | 'testing' } for the features they can use ('testing' only ever appears for creators)
function forUser(records, creator) {
  const out = {};
  for (const f of REGISTRY) {
    const s = stateOf(records, f.id);
    if (s === 'live' || (s === 'testing' && creator === true)) out[f.id] = s;
  }
  return out;
}

// every feature with its state, for the admin page
function list(records) {
  return REGISTRY.map((f) => {
    const r = has(records, f.id) ? records[f.id] : null;
    return { id: f.id, name: f.name, desc: f.desc, state: stateOf(records, f.id), at: (r && r.at) || null, by: (r && r.by) || null };
  });
}

// Move one or more features to a state, all or nothing. Returns { ok: true, changed: [{ id, name, from, to }] } or { ok: false, status, error }.
// `changed` leaves out features already in that state. Nothing is written when anything is refused.
function apply(records, ids, state, by, at) {
  if (!STATES.includes(state)) return { ok: false, status: 400, error: 'state must be off, testing or live' };
  if (!Array.isArray(ids) || !ids.length) return { ok: false, status: 400, error: 'Pick at least one feature' };
  const uniq = [...new Set(ids)];
  if (uniq.length > REGISTRY.length || !uniq.every(known)) return { ok: false, status: 404, error: 'That feature does not exist' };
  const moves = uniq.map((id) => ({ id, name: REGISTRY.find((f) => f.id === id).name, from: stateOf(records, id), to: state }));
  const early = moves.filter((m) => state === 'live' && m.from === 'off');
  if (early.length) return { ok: false, status: 400, error: `Test ${early.map((m) => m.name).join(', ')} before releasing: put ${early.length === 1 ? 'it' : 'them'} in testing first` };
  const changed = moves.filter((m) => m.from !== m.to);
  for (const m of changed) records[m.id] = { id: m.id, state: m.to, at, by };
  return { ok: true, changed };
}

module.exports = { STATES, REGISTRY, known, stateOf, enabled, forUser, list, apply };
