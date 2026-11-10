// Feature gating: a new feature is built behind a check, deployed, and stays creator-only until the RELEASE that contains it is published.
// Pure logic (no database, no express): index.js passes in db().releases and calls these.
//
// There is no separate switch. For one feature:
//   - it is declared in REGISTRY below, in code, because a switch only means something where the code that checks it exists:
//       server: featureOn('my-feature', req.user)  or the needFeature('my-feature') route guard (a plain 404 when it is not on for that person)
//       client: hasFeature(me, 'my-feature')        (client/src/features.js)
//   - in /admin > Releases a creator ticks which features a release contains (the release's `features` list)
//   - while no PUBLISHED release lists it, only creator accounts can use it ('testing'); the moment a release that lists it is published, everybody can ('live')
//   - taking that release back to a draft takes the feature away from everyone but creators again
//   - a creator can also press Test on a release in /admin: while testing, that creator has exactly what everybody will have once the release is
//     published (the live features plus the ones that release lists) and none of the other unreleased ones. Stop testing goes back to all of them.
// A release can also name its features in server/releases-pending.json (`features: ['my-feature']`), so they are ticked from the start.
// To add a feature: add a line here, build it behind the check, deploy, test it on a creator account, then publish the release.
const REGISTRY = [
  { id: 'promoted-items', name: 'Promoted marketplace items', desc: 'Creators pay credits to feature their sticker packs and emoji in the Shop. (Planned: not built yet.)' },
  { id: 'sponsored-card', name: 'Sponsored card', desc: 'One clearly labelled, static “Sponsored” card at the bottom of the Shop. Needs ADS_JSON set on the server.' },
  { id: 'rewarded-ads', name: 'Watch an ad for credits', desc: 'An opt-in “Watch a sponsor, earn credits” button on the Quests tab, with a daily cap. Needs ADS_JSON set on the server.' },
  { id: 'vc-screenshare', name: 'Voice channel screen share', desc: 'Share your screen in a voice channel, and watch other people’s shares.' },
  { id: 'screenshare-zoom', name: 'Zoom while sharing your screen', desc: 'Aduna desktop app: a shortcut (changeable in Settings > Voice & Video) zooms the shared screen in on your cursor, and scrolling zooms further.' },
];

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const known = (id) => typeof id === 'string' && REGISTRY.some((f) => f.id === id);

// Only known ids, once each, in the order given. Anything else (unknown, wrong type, prototype names) is dropped.
function cleanIds(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) if (known(id) && !out.includes(id)) out.push(id);
  return out;
}

// ids that every account can use right now: the ones a PUBLISHED release lists
function liveIds(releases) {
  const live = new Set();
  for (const r of Object.values(releases || {})) {
    if (r && r.status === 'public' && Array.isArray(r.features)) for (const id of r.features) if (known(id)) live.add(id);
  }
  return live;
}

// can this person use the feature right now? `creator` says whether the person is a creator account (only an explicit true counts).
// `only` is a creator's TEST MODE (see testSet): a Set of the feature ids of the one release they are testing. In test mode a creator has what everybody
// has once that release is published (the live features plus that release's), and none of the other unreleased ones.
function enabled(releases, id, creator, only) {
  if (!known(id)) return false;
  if (liveIds(releases).has(id)) return true;
  if (creator !== true) return false;
  return only instanceof Set ? only.has(id) : true;
}

// the feature ids of release `releaseId` as a Set, for a creator who is testing it; null when there is no such release (no test mode)
function testSet(releases, releaseId) {
  const r = releases && typeof releaseId === 'string' && has(releases, releaseId) ? releases[releaseId] : null;
  return r ? new Set(cleanIds(r.features)) : null;
}

// what one person is told: { id: 'live' | 'testing' } ('testing' only ever appears for creators: a registered feature no published release has yet)
function forUser(releases, creator, only) {
  const live = liveIds(releases), out = {};
  for (const f of REGISTRY) {
    if (live.has(f.id)) out[f.id] = 'live';
    else if (creator === true && (!(only instanceof Set) || only.has(f.id))) out[f.id] = 'testing';
  }
  return out;
}

// every feature with where it stands, for the release editor in /admin
function list(releases) {
  const live = liveIds(releases);
  return REGISTRY.map((f) => ({ id: f.id, name: f.name, desc: f.desc, state: live.has(f.id) ? 'live' : 'testing' }));
}

// One-time move from the old Features tab (records { id, state }): a feature that was 'live' there stays live by being listed on the newest
// published release, then the old records are removed. Returns { moved: [ids], to: releaseId | null }. Safe to run on every start.
function migrateLegacy(records, releases) {
  if (!records || typeof records !== 'object') return { moved: [], to: null };
  const keys = Object.keys(records);
  if (!keys.length) return { moved: [], to: null };
  const ids = cleanIds(keys.filter((k) => records[k] && records[k].state === 'live'));
  let to = null;
  if (ids.length) {
    const newest = Object.values(releases || {}).filter((r) => r && r.status === 'public')
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)))[0];
    if (newest) { newest.features = cleanIds([...(newest.features || []), ...ids]); to = newest.id; }
  }
  for (const k of keys) delete records[k];
  return { moved: to ? ids : [], to };
}

module.exports = { REGISTRY, known, cleanIds, liveIds, enabled, testSet, forUser, list, migrateLegacy };
