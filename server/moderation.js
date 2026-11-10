// Moderation tools for the admin page: warnings, mutes, timed suspensions and IP bans. Pure logic, like appropriate.js: index.js does the saving,
// the signing-out, the pushing to the person's app and the admin log. Every function takes `now` so the tests can set the time.
//
//   u.warnings  = [{ id, at, by, reason, seenAt? }]  a warning the person has to read; seenAt is set when they press "I understand"
//   u.mute      = { at, by, reason, until, auto? }   cannot send messages (channels, DMs, groups) until `until`
//   u.suspended = { at, by, reason, until? }         locked out; no `until` = until an admin lifts it (until is new, older records still work)
//   IP bans     = [{ id, rule, reason, by, at, until|null }]  kept in meta "ipbans" (see createIpBans); a rule is one address or an IPv4 range (1.2.3.0/24)
//
// Warnings count for 90 days. The 3rd active warning is a 24 hour mute and the 5th a 7 day suspension (ESCALATION); an admin can do either by hand too.
// `by` is the id of the admin who did it, or null when the escalation did it.
const crypto = require('crypto');

const HOUR = 3600_000, DAY = 24 * HOUR;
const LIMITS = {
  reason: 300, keep: 50, windowDays: 90,
  maxMuteHours: 24 * 30, maxSuspendHours: 24 * 365,
  maxIpBanHours: 24 * 365 * 5, defaultIpBanHours: 24 * 30, maxIpBans: 500,
  largeRange: 16, smallestRange: 8, // a range wider than /16 needs a second confirmation; wider than /8 is never allowed
};
const ESCALATION = [ // highest first; a rule fires when a new warning makes the active count equal to `warnings`
  { warnings: 5, type: 'suspend', hours: 24 * 7 },
  { warnings: 3, type: 'mute', hours: 24 },
];

const clean = (s, n = LIMITS.reason) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const hoursOf = (v, max) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= max ? n : null; };
const newId = () => crypto.randomBytes(6).toString('hex');

// "3 hours", "2 days": how long is left, for the messages people read
function left(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return m + (m === 1 ? ' minute' : ' minutes');
  const h = Math.round(m / 60);
  if (h < 48) return h + (h === 1 ? ' hour' : ' hours');
  const d = Math.round(h / 24);
  return d + ' days';
}

// ---------- warnings ----------
const warningsOf = (u) => (u && Array.isArray(u.warnings) ? u.warnings : []);
const activeWarnings = (u, now) => warningsOf(u).filter((w) => now - w.at < LIMITS.windowDays * DAY);
const pendingWarnings = (u) => warningsOf(u).filter((w) => !w.seenAt);

// Adds a warning. Returns { warning, count, escalation } where escalation is null or { type: 'mute'|'suspend', hours, reason } for the caller to apply.
function warn(u, { by, reason, now }) {
  const text = clean(reason);
  if (!text) return { error: 'Write what the warning is for' };
  const w = { id: newId(), at: now, by: by || null, reason: text };
  u.warnings = [...warningsOf(u), w].slice(-LIMITS.keep);
  const count = activeWarnings(u, now).length;
  const rule = ESCALATION.find((r) => r.warnings === count);
  return { warning: w, count, escalation: rule ? { type: rule.type, hours: rule.hours, reason: `Automatic: ${count} warnings in ${LIMITS.windowDays} days` } : null };
}
function retractWarning(u, id) {
  const before = warningsOf(u).length;
  u.warnings = warningsOf(u).filter((w) => w.id !== id);
  if (!u.warnings.length) delete u.warnings;
  return before !== (u.warnings || []).length;
}
// "I understand": every warning they were shown counts as read. Returns how many were open.
function acknowledge(u, now) {
  const open = pendingWarnings(u);
  for (const w of open) w.seenAt = now;
  return open.length;
}

// ---------- mutes and suspensions ----------
const muted = (u, now) => !!(u && u.mute && u.mute.until > now);
const suspendedNow = (u, now) => !!(u && u.suspended && (!u.suspended.until || u.suspended.until > now));

function setMute(u, { by, reason, hours, now, auto }) {
  const text = clean(reason), h = hoursOf(hours, LIMITS.maxMuteHours);
  if (!text) return { error: 'Write the reason (the person will see it)' };
  if (!h) return { error: `Hours must be more than 0 and at most ${LIMITS.maxMuteHours}` };
  u.mute = { at: now, by: by || null, reason: text, until: now + Math.round(h * HOUR), ...(auto ? { auto: true } : {}) };
  return { mute: u.mute };
}
// hours is optional: without it the suspension lasts until an admin lifts it (what the admin page did before)
function setSuspension(u, { by, reason, hours, now }) {
  let until;
  if (hours !== undefined && hours !== null && hours !== '') {
    const h = hoursOf(hours, LIMITS.maxSuspendHours);
    if (!h) return { error: `Hours must be more than 0 and at most ${LIMITS.maxSuspendHours}` };
    until = now + Math.round(h * HOUR);
  }
  u.suspended = { at: now, by: by || null, reason: clean(reason), ...(until ? { until } : {}) };
  return { suspended: u.suspended };
}

// Who is due: mutes and timed suspensions that ran out. Returns { unmute: [id], unsuspend: [id] }; the caller removes them.
function expired(users, now) {
  const out = { unmute: [], unsuspend: [] };
  for (const u of Object.values(users || {})) {
    if (u.mute && !(u.mute.until > now)) out.unmute.push(u.id);
    if (u.suspended && u.suspended.until && u.suspended.until <= now) out.unsuspend.push(u.id);
  }
  return out;
}

// Why this person cannot send right now (an error message for the app), or null when they can.
function sendBlock(u, now) {
  if (!u) return null;
  if (muted(u, now)) return `You are muted for ${left(u.mute.until - now)}${u.mute.reason ? ': ' + u.mute.reason : ''}`;
  if (pendingWarnings(u).length) return 'Please read the warning from the moderators first (reload Aduna to see it)';
  return null;
}

// What the person's own app gets: null when there is nothing to show.
function view(u, now) {
  const pending = pendingWarnings(u).map((w) => ({ id: w.id, at: w.at, reason: w.reason }));
  const mute = muted(u, now) ? { reason: u.mute.reason, until: u.mute.until } : null;
  return pending.length || mute ? { pending, mute } : null;
}
// What an admin sees on a person's page. byName turns an admin id into a name.
function adminView(u, now, byName = (x) => x) {
  return {
    warnings: warningsOf(u).slice().reverse().map((w) => ({ id: w.id, at: w.at, by: w.by ? byName(w.by) : null, reason: w.reason, seenAt: w.seenAt || null, counts: now - w.at < LIMITS.windowDays * DAY })),
    activeWarnings: activeWarnings(u, now).length,
    mute: muted(u, now) ? { reason: u.mute.reason, until: u.mute.until, by: u.mute.by ? byName(u.mute.by) : null, auto: !!u.mute.auto } : null,
    suspendedUntil: u.suspended && u.suspended.until ? u.suspended.until : null,
  };
}

// ---------- IP bans ----------
function normalizeIp(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7); // an IPv4 address that arrived inside an IPv6 socket
  return s;
}
function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    n = n * 256 + Number(part);
  }
  return n;
}
const intToIpv4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

// One address ("1.2.3.4"), an IPv4 range ("1.2.3.0/24") or one exact IPv6 address. Returns null when it is none of these.
function parseRule(text) {
  const [addr, bits, extra] = String(text == null ? '' : text).trim().split('/');
  if (extra !== undefined || !addr) return null;
  const ip = normalizeIp(addr);
  const base = ipv4ToInt(ip);
  if (base === null) {
    if (bits !== undefined || !/^[0-9a-f:]{2,45}$/.test(ip) || !ip.includes(':')) return null;
    return { kind: 'exact', text: ip, ip };
  }
  const prefix = bits === undefined ? 32 : /^\d{1,2}$/.test(bits) ? Number(bits) : NaN;
  if (!(prefix >= 0 && prefix <= 32)) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(base / size) * size;
  return { kind: 'v4', prefix, start, end: start + size - 1, text: prefix === 32 ? intToIpv4(start) : intToIpv4(start) + '/' + prefix };
}
function ruleMatches(rule, ip) {
  if (rule.kind === 'exact') return rule.ip === ip;
  const n = ipv4ToInt(ip);
  return n !== null && n >= rule.start && n <= rule.end;
}

// The list of banned addresses. `list` is what was saved last time (snapshot()); the caller saves snapshot() after every change.
function createIpBans(list) {
  let bans = [], compiled = [];
  const rebuild = () => { compiled = bans.map((b) => ({ b, rule: parseRule(b.rule) })).filter((x) => x.rule); };
  const load = (saved) => {
    bans = (Array.isArray(saved) ? saved : [])
      .filter((b) => b && typeof b.id === 'string' && parseRule(b.rule))
      .map((b) => ({ id: b.id, rule: parseRule(b.rule).text, reason: clean(b.reason), by: b.by || null, at: Number(b.at) || 0, until: b.until ? Number(b.until) : null }))
      .slice(0, LIMITS.maxIpBans);
    rebuild();
  };
  load(list);
  const live = (b, now) => !b.until || b.until > now;

  return {
    load,
    snapshot: () => bans.map((b) => ({ ...b })),
    active: (now) => bans.filter((b) => live(b, now)).map((b) => ({ ...b })),
    prune(now) { const n = bans.length; bans = bans.filter((b) => live(b, now)); if (bans.length !== n) rebuild(); return n - bans.length; },
    // the ban that covers this address, or null
    matches(ip, now) {
      const a = normalizeIp(ip);
      if (!a) return null;
      const hit = compiled.find((x) => live(x.b, now) && ruleMatches(x.rule, a));
      return hit ? { ...hit.b } : null;
    },
    // hours: undefined = 30 days, null = until lifted, a number = that long. selfIp is the admin's own address: it can never be banned by them.
    add({ rule, reason, by, hours, now, confirmLarge, selfIp }) {
      const r = parseRule(rule), text = clean(reason);
      if (!r) return { error: 'That is not an IP address or an IPv4 range like 1.2.3.0/24' };
      if (!text) return { error: 'Write the reason' };
      if (r.kind === 'v4' && r.prefix < LIMITS.smallestRange) return { error: `/${r.prefix} is far too wide (the widest allowed is /${LIMITS.smallestRange})` };
      if (r.kind === 'v4' && r.prefix < LIMITS.largeRange && confirmLarge !== true) {
        return { error: `/${r.prefix} covers ${(2 ** (32 - r.prefix)).toLocaleString('en-US')} addresses. Confirm to ban a range this wide.`, code: 'large_range' };
      }
      if (selfIp && ruleMatches(r, normalizeIp(selfIp))) return { error: 'That would ban your own connection', code: 'own_ip' };
      let until = null;
      if (hours === undefined) until = now + LIMITS.defaultIpBanHours * HOUR;
      else if (hours !== null) {
        const h = hoursOf(hours, LIMITS.maxIpBanHours);
        if (!h) return { error: `Hours must be more than 0 and at most ${LIMITS.maxIpBanHours}` };
        until = now + Math.round(h * HOUR);
      }
      bans = bans.filter((b) => b.rule !== r.text && live(b, now)); // banning the same rule again replaces the old entry (new reason, new end)
      if (bans.length >= LIMITS.maxIpBans) return { error: 'The IP ban list is full. Lift some bans first.' };
      const ban = { id: newId(), rule: r.text, reason: text, by: by || null, at: now, until };
      bans.push(ban);
      rebuild();
      return { ban: { ...ban } };
    },
    remove(id) { const n = bans.length; bans = bans.filter((b) => b.id !== id); rebuild(); return bans.length !== n; },
  };
}

module.exports = {
  LIMITS, ESCALATION, clean, left,
  warningsOf, activeWarnings, pendingWarnings, warn, retractWarning, acknowledge,
  muted, suspendedNow, setMute, setSuspension, expired, sendBlock, view, adminView,
  normalizeIp, parseRule, ruleMatches, createIpBans,
};
