// Releases: the list of what each update added (Settings > What's new, and the popup after an update).
//
// Every release is added AUTOMATICALLY as a draft, and a draft is private: only a creator account sees it, in /admin > Releases.
// It becomes public (shown to everyone in What's new) only when a creator presses Publish there.
//
// Where drafts come from (sync(), run on every server start, i.e. on every deploy):
//   1. server/releases-pending.json: the notes written for each release (id, date, title, items, desktop, android). Added by the release routine.
//   2. the update feeds (client/dist/updates/latest.yml and latest.json): a desktop or Android version that has no release yet gets a
//      draft with a plain title and no notes, so a release can never go missing; the creator writes the notes in /admin before publishing.
// Pure logic (no express, no database): index.js keeps the records in db().releases and calls these.
const fs = require('fs');
const featuresLib = require('./features'); // a release lists the feature ids it contains (see features.js): they go public when the release does

const LIMITS = { id: 40, title: 80, version: 40, itemTitle: 60, itemText: 300, items: 12 };
const ID = /^[\w.\-]{1,40}$/;

// The first two releases were written by hand in the app before this existed; they are public from the start.
const LEGACY = [
  { id: '2026.10.23.2', date: '2026-10-23', title: 'Shop, Quests and easier updates', items: [
    { title: 'Shop tab', text: 'The shop now has its own tab. Buy credits, spend them on badges and see your recent activity there.' },
    { title: 'Quests tab', text: 'Daily quests, events and the ways to earn credits moved to their own Quests tab.' },
    { title: 'Updates install themselves', text: 'The desktop app now downloads updates in the background and shows New Update [Refresh] when one is ready. The website says Refresh too.' },
  ] },
  { id: '2026.10.23', date: '2026-10-23', title: 'What’s new in Aduna', items: [
    { title: 'New Features popup', text: 'After an update, Aduna now tells you what was added. You can turn this off in Settings > What’s new.' },
    { title: 'Credits shop', text: 'Spend your credits on profile badges.' },
  ] },
];

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const today = (now) => new Date(now).toISOString().slice(0, 10);

function cleanItems(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object') continue;
    const title = clip(it.title, LIMITS.itemTitle), text = clip(it.text, LIMITS.itemText);
    if (!title && !text) continue;
    out.push({ title: title || text.slice(0, LIMITS.itemTitle), text: title ? text : '' });
    if (out.length >= LIMITS.items) break;
  }
  return out;
}

// What a creator may change: the title, the notes and which features the release contains.
function cleanEdit(b) {
  const out = {};
  if (b && b.title !== undefined) { out.title = clip(b.title, LIMITS.title); if (!out.title) return { error: 'A release needs a title' }; }
  if (b && b.items !== undefined) out.items = cleanItems(b.items);
  if (b && b.features !== undefined) out.features = featuresLib.cleanIds(b.features);
  return out;
}

const byNewest = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0));

// everyone: the public releases only, newest first
function publicList(map) {
  return Object.values(map).filter((r) => r.status === 'public').sort(byNewest).map((r) => ({ id: r.id, date: r.date, title: r.title, items: r.items || [] }));
}
// creators in /admin: everything, drafts included
function adminList(map) {
  return Object.values(map).sort(byNewest).map((r) => ({
    id: r.id, date: r.date, title: r.title, items: r.items || [], features: featuresLib.cleanIds(r.features), status: r.status === 'public' ? 'public' : 'draft',
    desktop: r.desktop || null, android: r.android || null, createdAt: r.createdAt || null, publishedAt: r.publishedAt || null, publishedBy: r.publishedBy || null,
  }));
}

// A release can go public once it says something. Returns an error text or null.
function publishProblem(r) {
  if (!r.title || !String(r.title).trim()) return 'Give the release a title first';
  if (!r.items || !r.items.length) return 'Add at least one note about what changed before publishing';
  return null;
}

// ----- reading what was released -----
function desktopVersion(dir) {
  try { const m = /^version:\s*['"]?([\w.\-+]+)['"]?\s*$/m.exec(fs.readFileSync(dir + '/latest.yml', 'utf8')); return m ? m[1] : null; } catch { return null; }
}
function androidVersion(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(dir + '/latest.json', 'utf8'));
    const v = clip(j && j.versionName, LIMITS.version);
    return v || (j && j.versionCode ? String(j.versionCode) : null);
  } catch { return null; }
}
function readPending(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}

// Add what is missing, as drafts. Never touches a release that already exists (a creator may have edited or published it).
// d: { map (db().releases), dir (the updates folder), pending (path to releases-pending.json), now }. Returns the ids that were added.
function sync(map, d) {
  const now = d.now || Date.now();
  const added = [];
  const add = (r) => { map[r.id] = { status: 'draft', createdAt: now, ...r }; added.push(r.id); };

  // 1. notes written for a release
  for (const p of readPending(d.pending)) {
    if (!p || typeof p !== 'object' || !ID.test(String(p.id || '')) || map[p.id]) continue;
    add({ id: p.id, date: isDate(p.date) ? p.date : today(now), title: clip(p.title, LIMITS.title) || 'Update ' + p.id, items: cleanItems(p.items), features: featuresLib.cleanIds(p.features),
      desktop: clip(p.desktop, LIMITS.version) || null, android: clip(p.android, LIMITS.version) || null });
  }

  // 2. a version in the feeds that no release mentions yet
  const has = (field, v) => Object.values(map).some((r) => r[field] === v);
  const desk = desktopVersion(d.dir), andr = androidVersion(d.dir);
  const needDesk = desk && !has('desktop', desk), needAndr = andr && !has('android', andr);
  if (needDesk) {
    const id = 'desktop-' + desk;
    if (!map[id]) add({ id, date: today(now), title: 'Aduna ' + desk, items: [], desktop: desk, android: needAndr ? andr : null });
  } else if (needAndr) {
    const id = 'android-' + andr;
    if (!map[id]) add({ id, date: today(now), title: 'Aduna for Android ' + andr, items: [], desktop: null, android: andr });
  }
  return added;
}

// Every deploy is a release, even when nobody wrote notes and no desktop or Android version changed (a plain website update).
// buildId: the hash of the built site (BUILD_ID in index.js). Adds ONE private draft with no notes; the creator fills it in and publishes it in /admin.
// Returns the id that was added, or null when this build already has a draft.
function syncBuild(map, buildId, now) {
  const id = 'site-' + String(buildId || '').replace(/[^\w.\-]/g, '').slice(0, 20);
  if (id === 'site-' || map[id]) return null;
  map[id] = { id, status: 'draft', createdAt: now, date: today(now), title: 'Aduna update ' + today(now), items: [], desktop: null, android: null, build: String(buildId) };
  return id;
}

// The two hand-written releases, once (index.js remembers that it did this so a later delete stays deleted).
function seedLegacy(map, now) {
  for (const r of LEGACY) if (!map[r.id]) map[r.id] = { ...r, status: 'public', createdAt: now, publishedAt: now, publishedBy: null };
}

module.exports = { LIMITS, LEGACY, cleanItems, cleanEdit, publicList, adminList, publishProblem, desktopVersion, androidVersion, readPending, sync, syncBuild, seedLegacy };
