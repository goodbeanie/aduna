// Switches: a creator turns a whole part of Aduna off for the public (/admin > Switches), and back on. Admins and creators are never affected,
// so they can still open the part, test it and fix it while it is closed. Pure logic (no database, no express): index.js passes in db().switches.
//
// This is not features.js. A feature is built behind a check and goes public with a release; a switch is a kill switch for something that is already live.
// Everything is ON unless a switch has been turned off, so a missing, damaged or unknown record means on, and a brand new switch changes nothing.
// To add a switch: add a line to REGISTRY, then check it where the thing happens:
//   server:  app.post(path, switchOpen('my-switch'), ...)   (index.js: a 503 { code: 'feature_off' } for anyone it is closed for)
//            or switchClosed('my-switch', req.user) inside a handler
//   client:  show the message the server sends instead of the thing (the views that carry `paused: true`)
const REGISTRY = [
  {
    id: 'payments',
    name: 'Payments',
    desc: 'The Payments page, buying credits, and the checkout for the Plus storage plan. Nobody can start a new payment while it is off.',
    keeps: 'Money that is already on its way is still credited, a saved card is still charged for its monthly renewal, and people can still cancel a plan.',
    paused: 'Payments are paused right now. Please try again later.',
  },
];

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const known = (id) => typeof id === 'string' && REGISTRY.some((s) => s.id === id);
const entry = (id) => REGISTRY.find((s) => s.id === id) || null;

// Is the switch turned off? Only a record that says `on: false` counts.
function isOff(records, id) {
  return known(id) && has(records, id) && !!records[id] && records[id].on === false;
}

// Is the thing closed for this person? `admin` says whether the person is an admin or creator (only an explicit true is let through).
const closed = (records, id, admin) => admin !== true && isOff(records, id);

// The ids that are turned off, in registry order.
const offIds = (records) => REGISTRY.filter((s) => isOff(records, s.id)).map((s) => s.id);

// The words a closed person is shown.
const pausedMessage = (id) => (entry(id) ? entry(id).paused : 'This is paused right now. Please try again later.');

// Turns one switch on or off. Turning it to what it already is changes nothing (and keeps who turned it off, and when).
// Returns { ok: true, changed, on } or { ok: false, status, error }.
function set(records, id, on, by, at) {
  if (!known(id)) return { ok: false, status: 404, error: 'Unknown switch' };
  if (typeof on !== 'boolean') return { ok: false, status: 400, error: 'Say whether it should be on or off' };
  if (!isOff(records, id) === on) return { ok: true, changed: false, on };
  records[id] = { id, on, at: Number.isFinite(at) ? at : Date.now(), by: String(by || '').slice(0, 60) };
  return { ok: true, changed: true, on };
}

// Every switch with where it stands, for /admin.
function list(records) {
  return REGISTRY.map((s) => {
    const r = has(records, s.id) && records[s.id] ? records[s.id] : null;
    return { id: s.id, name: s.name, desc: s.desc, keeps: s.keeps || '', on: !isOff(records, s.id), at: r && Number.isFinite(r.at) ? r.at : null, by: r && r.by ? String(r.by) : null };
  });
}

module.exports = { REGISTRY, known, isOff, closed, offIds, pausedMessage, set, list };
