'use strict';
// Storage plan: files are free, but the shared pool for everybody's attachments is small (STORAGE_LIMIT_GB, see db.js).
//
//   * Free: no limit per person. When the shared pool is full, an upload pushes out the oldest files of other free people (makeRoom).
//   * Storage plan ($4.99 a month, billed by PayPal Subscriptions): the person gets 10 GB of their own. Their files are not part of the
//     shared pool, are never pushed out and never expire while the plan runs (plus a grace period after it ends). When the 10 GB is
//     full the upload is refused with code 'storage_full' and the app lets them pick files to delete (GET /api/storage/files).
//
// Money: the price and plan live on the server; the browser never names an amount. A person only counts as a subscriber after PayPal
// itself said so (the server fetches the subscription from PayPal, or PayPal's signed webhook arrives), and only for the period paid.
// No Express or database imports here, so server/storage-test.js can test it with fakes.

const crypto = require('crypto');
const TAX = require('./tax');
const credits = require('./credits');

const GB = 1024 ** 3, DAY = 86_400_000;
const PLAN = { id: 'storage10', name: 'Aduna Storage', cents: 499, currency: 'usd', bytes: 10 * GB };
const GRACE_MS = 14 * DAY;       // after a plan ends its files are kept this long before the normal clean-up applies to them again
const PAID_FOR_MS = 32 * DAY;    // one payment covers a month plus a little slack for a late webhook
const SUB_ID = /^[A-Za-z0-9-]{8,40}$/;
const FILE_ID = /^[0-9a-f]{32}$/;

// What to call a file in the list: photo, video, audio, or else its extension (zip, html, ...). '' when nothing is known.
function kindOf(mime, ext) {
  const m = String(mime || '').toLowerCase(), e = String(ext || '').toLowerCase();
  if (m.startsWith('image/')) return 'photo';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return e || '';
}
// ---------- who has a plan ----------
// u.storageSub = { status: 'pending' | 'active' | 'past_due' | 'cancelled' | 'ended', paypalId, since, paidThrough, syncedAt }
const rec = (u) => (u && u.storageSub && typeof u.storageSub === 'object' ? u.storageSub : null);
// has paid and the paid time has not run out ('cancelled' keeps the plan until the month that was paid for ends)
const isSubscriber = (u, now = Date.now()) => {
  const s = rec(u);
  return !!s && s.status !== 'ended' && s.status !== 'pending' && Number(s.paidThrough) > now;
};
// files are safe from the shared pool's clean-up: while subscribed and for GRACE_MS afterwards
const isProtected = (u, now = Date.now()) => {
  const s = rec(u);
  return !!s && s.status !== 'pending' && Number(s.paidThrough) > 0 && now < Number(s.paidThrough) + GRACE_MS;
};
const protectedIds = (db, now = Date.now()) => Object.values((db && db.users) || {}).filter((u) => isProtected(u, now)).map((u) => u.id);

// null when `add` more bytes fit in the plan; otherwise how far over it would be
const overQuota = (used, add, limit = PLAN.bytes) => (used + add > limit ? { used, limit, needed: used + add - limit } : null);
// the oldest files whose sizes add up to at least `needed` (what the cleanup window ticks first)
function pickOldest(files, needed) {
  const out = [];
  let sum = 0;
  for (const f of [...files].sort((a, b) => a.createdAt - b.createdAt)) {
    if (sum >= needed) break;
    out.push(f); sum += f.size;
  }
  return out; // all of them when even that is not enough: the window then asks for more
}

// ---------- the shared pool ----------
// Makes room for `bytes` in the shared pool by removing the oldest files of people without a plan. Removes nothing when even all of
// them would not be enough (then the upload is refused, as before). Returns the ids that were removed.
async function makeRoom({ store, bytes, protect = [] }) {
  const max = store.storageLimitBytes();
  if (!store.usingR2 || !max) return [];
  const used = await store.poolBytesUsed();
  if (used + bytes <= max) return [];
  const { rows } = await store.query(
    'SELECT id, size FROM files WHERE octet_length(data) = 0 AND NOT (owner = ANY($1::text[])) ORDER BY created_at ASC LIMIT 5000',
    [protect.map(String)]);
  const take = [];
  let freed = 0;
  for (const r of rows) {
    if (used - freed + bytes <= max) break;
    take.push(r.id); freed += Number(r.size);
  }
  if (used - freed + bytes > max) throw Object.assign(new Error('Storage is full'), { code: 'STORAGE_FULL' });
  return store.deleteFiles(take);
}

// ---------- PayPal Subscriptions ----------
async function ppFetch(fetchImpl, token, method, path, body, headers = {}) {
  const r = await fetchImpl(credits.ppBase() + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({})); // cancel answers 204 with no body
  return { ok: r.ok, status: r.status, j };
}

// One-time setup at PayPal: a product and a monthly plan at PLAN.cents. Fixed request ids make a second run return the same ones.
async function createPlan(fetchImpl = fetch) {
  const token = await credits.ppToken(fetchImpl);
  const prod = await ppFetch(fetchImpl, token, 'POST', '/v1/catalogs/products',
    { name: PLAN.name, description: '10 GB of file storage on Aduna', type: 'DIGITAL', category: 'SOFTWARE' }, { 'PayPal-Request-Id': 'aduna-storage-product-1' });
  if (!prod.ok || !prod.j.id) throw new Error(`PayPal product setup failed (${prod.status}): ${prod.j.message || 'no id'}`);
  const plan = await ppFetch(fetchImpl, token, 'POST', '/v1/billing/plans', {
    product_id: prod.j.id, name: PLAN.name + ' (monthly)', description: '10 GB of file storage, billed every month', status: 'ACTIVE',
    billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: (PLAN.cents / 100).toFixed(2), currency_code: PLAN.currency.toUpperCase() } } }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 3 },
  }, { 'PayPal-Request-Id': 'aduna-storage-plan-1' });
  if (!plan.ok || !plan.j.id) throw new Error(`PayPal plan setup failed (${plan.status}): ${plan.j.message || 'no id'}`);
  return plan.j.id;
}

// Starts a subscription and returns where to send the buyer to approve it on PayPal. The price comes from the plan; the tax the buyer
// owes (only where Aduna is set up to collect it, server/tax.js) is added as the plan's tax for this subscription only.
async function createSubscription({ user, buyer = {}, origin, planId, fetchImpl = fetch }) {
  const q = TAX.quote(buyer, PLAN.cents);
  if (!q.ok) throw Object.assign(new Error(q.error), { forBuyer: true });
  const token = await credits.ppToken(fetchImpl);
  const r = await ppFetch(fetchImpl, token, 'POST', '/v1/billing/subscriptions', {
    plan_id: planId,
    custom_id: user.id,
    application_context: {
      brand_name: 'Aduna', user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING',
      payment_method: { payer_selected: 'PAYPAL', payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED' },
      return_url: `${origin}/app?storage=paypal`, cancel_url: `${origin}/app?storage=cancelled`,
    },
    ...(q.tax ? { plan: { taxes: { percentage: String(q.rate), inclusive: false } } } : {}),
  }, { 'PayPal-Request-Id': crypto.randomUUID(), Prefer: 'return=representation' });
  const link = (r.j.links || []).find((l) => l.rel === 'approve');
  if (!r.ok || !link?.href || !SUB_ID.test(String(r.j.id || ''))) throw new Error(`PayPal subscription failed (${r.status}): ${r.j.message || 'no approval link'}`);
  let host = '';
  try { host = new URL(link.href).hostname; } catch { /* handled below */ }
  if (!/(^|\.)paypal\.com$/.test(host)) throw new Error('PayPal subscription failed: unexpected approval address');
  return { url: link.href, subscriptionId: r.j.id };
}

// An ACTIVE subscription at PayPal: the person has the plan until the next bill is due (plus a few days of slack).
function applyActive(u, sub, now = Date.now()) {
  const old = rec(u) || {};
  const next = Date.parse(sub?.billing_info?.next_billing_time);
  u.storageSub = {
    ...old,
    status: 'active',
    paypalId: sub.id,
    since: old.since || now,
    paidThrough: Math.max(Number(old.paidThrough) || 0, Number.isFinite(next) ? next + 3 * DAY : now + PAID_FOR_MS),
    syncedAt: now,
  };
}

// The buyer is back from PayPal: ask PayPal what became of the subscription (never trust the browser), and apply it.
async function confirmSubscription({ user, subscriptionId, fetchImpl = fetch, now = Date.now() }) {
  const token = await credits.ppToken(fetchImpl);
  const r = await ppFetch(fetchImpl, token, 'GET', `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
  if (!r.ok) throw new Error(`PayPal subscription lookup failed (${r.status})`);
  if (r.j.custom_id !== user.id) return { status: 'mismatch' };
  if (r.j.status === 'ACTIVE') { applyActive(user, { ...r.j, id: r.j.id || subscriptionId }, now); return { status: 'active', changed: true }; }
  if (r.j.status === 'APPROVAL_PENDING' || r.j.status === 'APPROVED') return { status: 'pending' }; // the webhook finishes it
  return { status: 'failed' };
}

// Refreshes a plan from PayPal when its paid time is nearly up (a webhook may have been missed).
async function syncSubscription({ user, fetchImpl = fetch, now = Date.now() }) {
  const s = rec(user);
  if (!s || !s.paypalId || !['active', 'past_due'].includes(s.status)) return false;
  if (now < Number(s.paidThrough) - 3 * DAY || now - Number(s.syncedAt || 0) < 3600_000) return false;
  s.syncedAt = now;
  const token = await credits.ppToken(fetchImpl);
  const r = await ppFetch(fetchImpl, token, 'GET', `/v1/billing/subscriptions/${encodeURIComponent(s.paypalId)}`);
  if (!r.ok) return true;
  if (r.j.status === 'ACTIVE') applyActive(user, { ...r.j, id: s.paypalId }, now);
  else if (r.j.status === 'CANCELLED') s.status = 'cancelled';
  else if (r.j.status === 'SUSPENDED' || r.j.status === 'EXPIRED') end(user, now);
  return true;
}

function end(u, now) {
  const s = rec(u);
  if (!s) return;
  s.status = 'ended';
  s.paidThrough = Math.min(Number(s.paidThrough) || 0, now); // the grace period for the files starts now
}

async function cancelSubscription({ user, fetchImpl = fetch, now = Date.now() }) {
  const s = rec(user);
  if (!s || !s.paypalId || !['active', 'past_due'].includes(s.status)) return { ok: false, error: 'You do not have a plan to cancel' };
  const token = await credits.ppToken(fetchImpl);
  const r = await ppFetch(fetchImpl, token, 'POST', `/v1/billing/subscriptions/${encodeURIComponent(s.paypalId)}/cancel`, { reason: 'Cancelled by the customer' });
  const already = (r.j.details || []).some((x) => x.issue === 'SUBSCRIPTION_STATUS_INVALID'); // cancelled in PayPal already
  if (!r.ok && !already) throw new Error(`PayPal cancel failed (${r.status}): ${r.j.message || r.j.name || 'unknown'}`);
  s.status = 'cancelled'; s.syncedAt = now; // keeps the plan until the month that was paid for ends
  return { ok: true };
}

// One verified PayPal webhook event. Returns the id of the person whose plan changed, or null. The caller saves.
function handleEvent(ev, db, now = Date.now()) {
  const type = String(ev?.event_type || '');
  const res = ev?.resource || {};
  const byPaypalId = (id) => (id ? Object.values(db.users || {}).find((u) => rec(u) && rec(u).paypalId === id) : null);
  if (type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
    const u = db.users?.[res.custom_id];
    if (!u || !SUB_ID.test(String(res.id || ''))) return null;
    applyActive(u, res, now);
    return u.id;
  }
  const subId = type.startsWith('PAYMENT.SALE.') ? res.billing_agreement_id : res.id;
  const u = byPaypalId(subId);
  if (!u) return null;
  const s = rec(u);
  if (type === 'PAYMENT.SALE.COMPLETED' || type === 'BILLING.SUBSCRIPTION.RENEWED') { // a monthly payment went through
    s.paidThrough = Math.max(Number(s.paidThrough) || 0, now + PAID_FOR_MS);
    if (s.status !== 'cancelled') s.status = 'active';
    return u.id;
  }
  if (type === 'BILLING.SUBSCRIPTION.CANCELLED') { s.status = 'cancelled'; return u.id; }
  if (type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') { if (s.status === 'active') s.status = 'past_due'; return u.id; }
  if (type === 'BILLING.SUBSCRIPTION.SUSPENDED' || type === 'BILLING.SUBSCRIPTION.EXPIRED' || type === 'PAYMENT.SALE.REFUNDED' || type === 'PAYMENT.SALE.REVERSED') { end(u, now); return u.id; }
  return null;
}

// ---------- routes ----------
// d: { auth, ah, db() -> store.db, save(), store, notify(uid, view), fileLabels() -> Map(id -> { name, type, where }), filesGone(ids),
//      fetchImpl?, getMeta?, setMeta?, now? }
function register(app, d) {
  const nowMs = () => (d.now ? d.now() : Date.now());
  let planMem = null;
  const planId = async () => {
    if (process.env.PAYPAL_STORAGE_PLAN_ID) return process.env.PAYPAL_STORAGE_PLAN_ID; // a plan you made yourself in the PayPal dashboard
    if (planMem) return planMem;
    const key = 'storage-plan:' + credits.ppBase();                                   // sandbox and live each get their own
    const cached = d.getMeta ? await d.getMeta(key) : null;
    if (cached) return (planMem = cached);
    const id = await createPlan(d.fetchImpl);
    if (d.setMeta) await d.setMeta(key, id);
    return (planMem = id);
  };

  async function viewOf(u) {
    const now = nowMs(), s = rec(u), sub = isSubscriber(u, now);
    const pay = credits.paypalEnabled();
    return {
      plan: { ...PLAN },
      subscriber: sub,
      status: s ? s.status : 'none',
      paidThrough: s && s.paidThrough ? s.paidThrough : null,
      renews: sub && !!s && s.status === 'active',
      used: await d.store.userFileBytes(u.id),
      limit: sub ? PLAN.bytes : null, // free: no limit of your own
      purchases: pay,
      provider: pay ? 'paypal' : null,
      tax: pay ? TAX.publicInfo() : null,
    };
  }
  const push = (uid) => {
    const u = d.db().users[uid];
    if (!u || !d.notify) return Promise.resolve();
    return viewOf(u).then((v) => d.notify(uid, v)).catch((e) => console.error('Storage push failed:', e.message));
  };

  const tries = new Map();
  const limited = (req, res, max) => {
    const t = Date.now(), arr = (tries.get(req.user.id) || []).filter((x) => t - x < 60_000);
    if (arr.length >= max) { res.status(429).json({ error: 'Too many attempts, try again in a minute' }); return true; }
    arr.push(t); tries.set(req.user.id, arr);
    return false;
  };

  app.get('/api/storage', d.auth, d.ah(async (req, res) => {
    try { if (credits.paypalEnabled() && await syncSubscription({ user: req.user, fetchImpl: d.fetchImpl, now: nowMs() })) d.save(); }
    catch (e) { console.error('Storage plan refresh failed:', e.message); }
    res.json(await viewOf(req.user));
  }));

  // the person's files, oldest first. `needed` (bytes) says how many of the oldest to tick first.
  app.get('/api/storage/files', d.auth, d.ah(async (req, res) => {
    const rows = await d.store.userFiles(req.user.id);
    const labels = d.fileLabels ? d.fileLabels() : new Map();
    const files = rows.map((r) => {
      const l = labels.get(r.id) || {};
      const name = l.name || r.fname || null;
      const mime = l.type || r.mime || '';
      const ext = (String(name || '').match(/\.([a-z0-9]{1,10})$/i) || [])[1]?.toLowerCase() || r.ext || '';
      return { id: r.id, size: r.size, createdAt: r.created_at, name, mime, ext, kind: kindOf(mime, ext), where: l.where || 'other' };
    });
    const needed = Math.max(0, Math.floor(Number(req.query.needed) || 0));
    res.json({ files, suggest: needed ? pickOldest(files, needed).map((f) => f.id) : [] });
  }));

  // delete some of your own files (never anybody else's); the messages that held them show "expired"
  app.post('/api/storage/delete', d.auth, d.ah(async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((x) => FILE_ID.test(x)))].slice(0, 500);
    if (!ids.length) return res.status(400).json({ error: 'Choose at least one file' });
    const { rows } = await d.store.query('SELECT id FROM files WHERE owner = $1 AND id = ANY($2::text[])', [req.user.id, ids]);
    const gone = await d.store.deleteFiles(rows.map((r) => r.id));
    if (gone.length && d.filesGone) d.filesGone(gone);
    push(req.user.id);
    res.json({ removed: gone.length, ...(await viewOf(req.user)) });
  }));

  app.post('/api/storage/subscribe', d.auth, d.ah(async (req, res) => {
    if (!credits.paypalEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 5)) return;
    if (isSubscriber(req.user, nowMs()) && rec(req.user).status === 'active') return res.status(409).json({ error: 'You already have the storage plan' });
    const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    try {
      const r = await createSubscription({ user: req.user, buyer: req.body, origin, planId: await planId(), fetchImpl: d.fetchImpl });
      res.json({ url: r.url });
    } catch (e) {
      if (e.forBuyer) return res.status(400).json({ error: e.message });
      console.error(e.message); res.status(502).json({ error: 'Could not start checkout. Try again later.' });
    }
  }));

  // Back from PayPal to /app?storage=paypal&subscription_id=...: the app posts the id here and the SERVER asks PayPal.
  app.post('/api/storage/confirm', d.auth, d.ah(async (req, res) => {
    if (!credits.paypalEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 10)) return;
    const id = req.body?.subscriptionId;
    if (typeof id !== 'string' || !SUB_ID.test(id)) return res.status(400).json({ error: 'Bad subscription' });
    try {
      const r = await confirmSubscription({ user: req.user, subscriptionId: id, fetchImpl: d.fetchImpl, now: nowMs() });
      if (r.status === 'mismatch') return res.status(400).json({ error: 'That subscription belongs to another account' });
      if (r.changed) { d.save(); push(req.user.id); }
      res.json({ status: r.status, ...(await viewOf(req.user)) });
    } catch (e) { console.error(e.message); res.status(502).json({ error: 'We could not confirm your plan yet. If PayPal charged you, it will show up shortly.' }); }
  }));

  app.post('/api/storage/cancel', d.auth, d.ah(async (req, res) => {
    if (!credits.paypalEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 5)) return;
    try {
      const r = await cancelSubscription({ user: req.user, fetchImpl: d.fetchImpl, now: nowMs() });
      if (!r.ok) return res.status(400).json({ error: r.error });
      d.save(); push(req.user.id);
      res.json(await viewOf(req.user));
    } catch (e) { console.error(e.message); res.status(502).json({ error: 'Could not cancel with PayPal. Try again, or cancel it in your PayPal account.' }); }
  }));

  return { push, viewOf, planId };
}

module.exports = {
  PLAN, GRACE_MS, PAID_FOR_MS, isSubscriber, isProtected, protectedIds, overQuota, pickOldest, makeRoom,
  createPlan, createSubscription, confirmSubscription, syncSubscription, cancelSubscription, applyActive, handleEvent, register,
};
