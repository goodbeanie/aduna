'use strict';
// Storage plan: files are free, but the shared pool for everybody's attachments is small (STORAGE_LIMIT_GB, see db.js).
//
//   * Free: no limit per person. When the shared pool is full, an upload pushes out the oldest files of other free people (makeRoom).
//   * Storage plan (billed monthly by Stripe, price in PLAN below): the person gets 10 GB of their own. Their files are not part of the
//     shared pool, are never pushed out and never expire while the plan runs (plus a grace period after it ends). When the 10 GB is
//     full the upload is refused with code 'storage_full' and the app lets them pick files to delete (GET /api/storage/files).
//
// Money: the price and plan live on the server; the browser never names an amount. A person only counts as a subscriber after Stripe
// itself said so (the server fetches the checkout session from Stripe, or Stripe's signed webhook arrives), and only for the period paid.
// No Express or database imports here, so server/storage-stripe-test.js can test it with fakes.

const REG = require('./regions');
const credits = require('./credits');

const PRICES = require('./stripeprices'); // attaches the products you made in the Stripe dashboard (off unless STRIPE_PRODUCTS or STRIPE_PRICES is set)

const GB = 1024 ** 3, DAY = 86_400_000;
// cadCents is what a Canadian buyer pays each month in CAD, cents what a US buyer pays in USD (REG.priceIn).
const PLAN = { id: 'storage10', name: 'Aduna Plus', cents: 359, cadCents: 499, currency: 'usd', bytes: 10 * GB };
const GRACE_MS = 14 * DAY;       // after a plan ends its files are kept this long before the normal clean-up applies to them again
const PAID_FOR_MS = 32 * DAY;    // one payment covers a month plus a little slack for a late webhook
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
// u.storageSub: see Stripe Billing below
const rec = (u) => (u && u.storageSub && typeof u.storageSub === 'object' ? u.storageSub : null);
// Accounts that have Plus for good without paying (the Aduna creator accounts). index.js registers the check with setLifetime();
// the default is nobody, so server/storage-test.js is unaffected.
let lifetime = () => false;
const setLifetime = (fn) => { lifetime = typeof fn === 'function' ? fn : () => false; };
const hasLifetime = (u) => { try { return !!lifetime(u); } catch { return false; } };
// has paid and the paid time has not run out ('cancelled' keeps the plan until the month that was paid for ends)
const isSubscriber = (u, now = Date.now()) => {
  if (hasLifetime(u)) return true;
  const s = rec(u);
  return !!s && s.status !== 'ended' && s.status !== 'pending' && Number(s.paidThrough) > now;
};
// files are safe from the shared pool's clean-up: while subscribed and for GRACE_MS afterwards
const isProtected = (u, now = Date.now()) => {
  if (hasLifetime(u)) return true;
  const s = rec(u);
  return !!s && s.status !== 'pending' && Number(s.paidThrough) > 0 && now < Number(s.paidThrough) + GRACE_MS;
};
const protectedIds = (db, now = Date.now()) => Object.values((db && db.users) || {}).filter((u) => isProtected(u, now)).map((u) => u.id);

// Plus always has the plan's 10 GB. On top of that a person MAY set an upload limit of their own (u.plusLimit, bytes, between 1 GB and the
// plan's 10 GB): uploads stop when they reach it. Nothing asks them; null = no limit of their own. Saved with POST /api/storage/limit.
const MIN_LIMIT_BYTES = 1 * GB;
const plusLimitOf = (u) => (u && typeof u.plusLimit === 'number' && u.plusLimit >= MIN_LIMIT_BYTES ? Math.min(u.plusLimit, PLAN.bytes) : null);
// the limit uploads are checked against: the plan, or the person's own smaller limit
const effectiveLimit = (u) => { const m = plusLimitOf(u); return m !== null && m < PLAN.bytes ? m : PLAN.bytes; };

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
  if (store.vmRoom && (await store.vmRoom(bytes))) return []; // the upload goes to the VM's disk instead, so nobody's files are removed
  const { rows } = await store.query(
    "SELECT id, size FROM files WHERE octet_length(data) = 0 AND loc <> 'vm' AND NOT (owner = ANY($1::text[])) ORDER BY created_at ASC LIMIT 5000",
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

// ---------- Stripe Billing ----------
// Stripe takes the card and charges it every month; Aduna never sees card details and keeps only Stripe's customer and subscription ids.
// Stripe tells us what happened with a signed webhook (handleEvent). When the person comes back from checkout, confirmSession asks Stripe
// directly so the plan shows up without waiting for the webhook.
// u.storageSub = { status: 'active' | 'past_due' | 'cancelled' | 'ended', customerId, subscriptionId, amountCents, currency, country, region, tax, since, paidThrough, syncedAt }
const STRIPE_ID = /^[A-Za-z0-9_]{3,100}$/;
const SLACK_MS = 3 * DAY;        // the plan outlasts the period Stripe billed by this much, so a late webhook does not cut it short
// the price, plus at most the tax the server added, in the currency that was paid
const amountOk = (cents, cur = 'usd') => { const base = REG.priceIn(PLAN, cur); return !!base && Number.isInteger(cents) && cents >= base && cents <= Math.round(base * 1.75); };

// What the /payments page lists: every storage payment, newest first. Kept on the person, not in storageSub, so resetting a plan does not erase it.
function logPayment(user, { id, cents, at, renewal = false, currency = 'usd', country = '', region = '', tax = 0 }) {
  const list = Array.isArray(user.storagePayments) ? user.storagePayments : (user.storagePayments = []);
  if (list.some((p) => p.id === id)) return;
  list.unshift({ id, cents, at, renewal, currency, country, region, tax });
  if (list.length > 60) list.length = 60;
}

// Starts the subscription and returns where to send the buyer to pay. The price comes from PLAN, never from the browser. Stripe asks for the
// billing address on its own page and adds the tax to every monthly charge (Stripe Tax).
async function createCheckout({ user, buyer = {}, origin, fetchImpl = fetch }) {
  const where = REG.resolve(buyer);
  if (!where.ok) throw Object.assign(new Error(where.error), { forBuyer: true });
  const base = REG.priceIn(PLAN, where.currency);
  // your own "Aduna PLUS" monthly price from Stripe when STRIPE_PRODUCTS / STRIPE_PRICES attach one (server/stripeprices.js), else an inline price
  const priceId = await PRICES.priceFor({ item: PLAN, currency: where.currency, base, recurring: true, request: (m, p) => credits.stripeRequest(m, p, null, fetchImpl) });
  const params = {
    mode: 'subscription',
    ...PRICES.line(0, { priceId, currency: where.currency, cents: base, name: PLAN.name + ' (monthly)', recurring: true }),
    ...credits.STRIPE_TAX,
    success_url: `${origin}/app?storage=paid&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/app?storage=cancelled`,
    client_reference_id: user.id,
    'metadata[kind]': 'storage',
    'metadata[userId]': user.id,
    'metadata[country]': where.country,
    'subscription_data[metadata][userId]': user.id,
  };
  if (user.email) params.customer_email = user.email;
  return { url: (await credits.createSession(params, fetchImpl)).url };
}

// A subscription checkout session that Stripe says was paid: the person has the plan for the month that was paid.
// Returns 'changed' (plan started), 'same' (already applied), 'unpaid' (not paid yet) or 'bad' (not ours, or the amount is wrong).
function applySession(u, session, now = Date.now()) {
  const meta = session?.metadata || {};
  if (session?.mode !== 'subscription' || meta.kind !== 'storage' || meta.userId !== u.id) return 'bad';
  if (session.payment_status !== 'paid') return 'unpaid';
  const cur = String(session.currency).toLowerCase(), cents = session.amount_total;
  const { country = '', region = '' } = meta;
  const base = REG.priceIn(PLAN, cur), paidTax = Number(session.total_details?.amount_tax) || 0;
  // a session made before Stripe Tax carries its own total; otherwise the price, plus the tax Stripe added on top of it
  const expected = meta.total !== undefined ? Number(meta.total) : cents === base ? base : base + paidTax;
  if (!amountOk(cents, cur) || cents !== expected || (!!country && REG.currencyOf(country) !== cur) || !STRIPE_ID.test(String(session.customer || '')) || !STRIPE_ID.test(String(session.subscription || ''))) {
    console.error('Storage: Stripe session', session.id, 'does not match the plan; not activating');
    return 'bad';
  }
  if ((u.storagePayments || []).some((p) => p.id === session.id)) return 'same';
  const old = rec(u) || {};
  const tax = meta.total !== undefined ? Number(meta.tax) || 0 : paidTax;
  const payerCountry = String(session.customer_details?.address?.country || '').toUpperCase();
  const where = { country: /^[A-Z]{2}$/.test(payerCountry) ? payerCountry : country, region: region || String(session.customer_details?.address?.state || '').toUpperCase().slice(0, 3) };
  u.storageSub = {
    status: 'active', customerId: session.customer, subscriptionId: session.subscription,
    amountCents: cents, currency: cur, country: where.country, region: where.region, tax,
    since: old.since || now, paidThrough: Math.max(Number(old.paidThrough) || 0, now) + PAID_FOR_MS, syncedAt: now,
  };
  logPayment(u, { id: session.id, cents, at: now, currency: cur, country: where.country, region: where.region, tax });
  return 'changed';
}

// The buyer is back from Stripe: ask Stripe what became of the checkout (never trust the browser), and apply it.
async function confirmSession({ user, sessionId, fetchImpl = fetch, now = Date.now() }) {
  if (!STRIPE_ID.test(String(sessionId || ''))) throw new Error('Bad session');
  const r = await credits.stripeRequest('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`, null, fetchImpl);
  if (!r.ok) throw new Error(`Stripe session lookup failed (${r.status})`);
  if (r.j.metadata?.userId !== user.id) return { status: 'mismatch' };
  const out = applySession(user, r.j, now);
  if (out === 'changed') return { status: 'active', changed: true };
  return { status: out === 'same' ? 'active' : out === 'unpaid' ? 'pending' : 'failed' };
}

// Refreshes a plan from Stripe when its paid time is nearly up (a webhook may have been missed).
async function syncSubscription({ user, fetchImpl = fetch, now = Date.now() }) {
  const s = rec(user);
  if (!s || !s.subscriptionId || !['active', 'past_due'].includes(s.status)) return false;
  if (now < Number(s.paidThrough) - SLACK_MS || now - Number(s.syncedAt || 0) < 3600_000) return false;
  s.syncedAt = now;
  const r = await credits.stripeRequest('GET', `/subscriptions/${encodeURIComponent(s.subscriptionId)}`, null, fetchImpl);
  if (!r.ok) return true;
  const sub = r.j, until = Number(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end) * 1000; // the field moved between API versions
  if (sub.status === 'active') {
    if (Number.isFinite(until)) s.paidThrough = Math.max(Number(s.paidThrough) || 0, until + SLACK_MS);
    s.status = sub.cancel_at_period_end ? 'cancelled' : 'active';
  } else if (['canceled', 'unpaid', 'incomplete_expired'].includes(sub.status)) end(user, now);
  return true;
}

function end(u, now) {
  const s = rec(u);
  if (!s) return;
  s.status = 'ended';
  s.paidThrough = Math.min(Number(s.paidThrough) || 0, now); // the grace period for the files starts now
}

// No more charges; the plan stays until the month that was paid for ends.
async function cancelSubscription({ user, fetchImpl = fetch, now = Date.now() }) {
  const s = rec(user);
  if (!s || !s.subscriptionId || !['active', 'past_due'].includes(s.status)) return { ok: false, error: 'You do not have a plan to cancel' };
  const r = await credits.stripeRequest('POST', `/subscriptions/${encodeURIComponent(s.subscriptionId)}`, { cancel_at_period_end: 'true' }, fetchImpl);
  const already = r.j.error?.code === 'resource_missing' || /canceled/i.test(String(r.j.error?.message || '')); // cancelled at Stripe already
  if (!r.ok && !already) throw new Error(`Stripe cancel failed (${r.status}): ${r.j.error?.message || 'unknown'}`);
  s.status = 'cancelled'; s.syncedAt = now;
  return { ok: true };
}

// Stripe's own page where the person updates their card or cancels. The portal has to be switched on in the Stripe dashboard first.
async function portalUrl({ user, origin, fetchImpl = fetch }) {
  const s = rec(user);
  if (!s || !STRIPE_ID.test(String(s.customerId || ''))) return null;
  const r = await credits.stripeRequest('POST', '/billing_portal/sessions', { customer: s.customerId, return_url: `${origin}/app?storage=portal` }, fetchImpl);
  if (!r.ok || !r.j.url) throw new Error(`Stripe portal failed (${r.status}): ${r.j.error?.message || 'no url'}`);
  return r.j.url;
}

const periodEnd = (invoice) => { const t = Number(invoice?.lines?.data?.[0]?.period?.end); return Number.isFinite(t) && t > 0 ? t * 1000 : null; };

// One verified Stripe webhook event. Returns the id of the person whose plan changed, or null (also for events that are not about the
// storage plan: credit packs are handled in server/credits.js). The caller saves.
async function handleEvent(ev, db, now = Date.now(), fetchImpl = fetch) {
  const type = String(ev?.type || ''), obj = ev?.data?.object || {};
  const byCustomer = (id) => (STRIPE_ID.test(String(id || '')) ? Object.values(db.users || {}).find((u) => rec(u) && rec(u).customerId === id) : null);
  if (type === 'checkout.session.completed') {
    const u = obj.mode === 'subscription' ? db.users?.[obj.metadata?.userId] : null;
    return u && applySession(u, obj, now) === 'changed' ? u.id : null;
  }
  let u = null;
  if (type.startsWith('invoice.') || type.startsWith('customer.subscription.') || (type === 'charge.refunded' && obj.refunded)) u = byCustomer(obj.customer);
  else if (type === 'charge.dispute.created' && STRIPE_ID.test(String(obj.charge || ''))) { // a dispute names the charge, not the customer
    const r = await credits.stripeRequest('GET', `/charges/${encodeURIComponent(obj.charge)}`, null, fetchImpl);
    u = r.ok ? byCustomer(r.j.customer) : null;
  }
  if (!u) return null;
  const s = rec(u);
  if (type === 'invoice.paid') {
    if (obj.billing_reason === 'subscription_create' || !(obj.amount_paid > 0)) return null; // the first month is applySession's
    const until = periodEnd(obj);
    s.paidThrough = Math.max(Number(s.paidThrough) || 0, until ? until + SLACK_MS : now + PAID_FOR_MS);
    if (s.status === 'past_due') s.status = 'active';
    s.syncedAt = now;
    logPayment(u, { id: obj.id, cents: obj.amount_paid, at: now, renewal: true, currency: s.currency, country: s.country || '', region: s.region || '', tax: Number(s.tax) || 0 });
    return u.id;
  }
  if (type === 'invoice.payment_failed') { if (s.status === 'active') s.status = 'past_due'; return u.id; }
  if (type === 'customer.subscription.updated') {
    if (obj.id !== s.subscriptionId) return null; // an older subscription of theirs
    if (['canceled', 'unpaid', 'incomplete_expired'].includes(obj.status)) end(u, now);
    else if (obj.cancel_at_period_end) { if (s.status === 'active' || s.status === 'past_due') s.status = 'cancelled'; }
    else if (obj.status === 'active' && s.status === 'cancelled') s.status = 'active'; // they changed their mind in the portal
    else if (obj.status === 'past_due' && s.status === 'active') s.status = 'past_due';
    else return null;
    return u.id;
  }
  if (type === 'customer.subscription.deleted') { if (obj.id !== s.subscriptionId) return null; end(u, now); return u.id; }
  if (type === 'charge.refunded' || type === 'charge.dispute.created') { end(u, now); return u.id; }
  return null;
}

// ---------- routes ----------
// d: { auth, ah, db() -> store.db, save(), store, notify(uid, view), fileLabels() -> Map(id -> { name, type, where }), filesGone(ids),
//      fetchImpl?, now?, freeBudget? (server/storage-budget.js: the free people's own limit) }
function register(app, d) {
  const nowMs = () => (d.now ? d.now() : Date.now());

  async function viewOf(u) {
    const now = nowMs(), s = rec(u), sub = isSubscriber(u, now);
    const pay = credits.purchasesEnabled();
    const open = !d.paymentsOpen || d.paymentsOpen(u); // false while a creator has Payments switched off for this person
    const used = await d.store.userFileBytes(u.id);
    const cap = !sub && d.freeBudget ? d.freeBudget.limitBytes() : null; // a free person's own limit (null: none, or the cap is not switched on)
    return {
      plan: PLAN,
      subscriber: sub,
      lifetime: hasLifetime(u),
      status: s ? s.status : 'none',
      currency: (s && s.currency) || 'usd', // what this person pays in (USD until they have bought in CAD)
      paidThrough: s && s.paidThrough ? s.paidThrough : null,
      renews: sub && !!s && s.status === 'active',
      used,
      limit: sub ? PLAN.bytes : null, // Plus: the plan's 10 GB. free: see freeLimit
      uploadLimit: sub ? plusLimitOf(u) : null, // Plus: the optional upload limit the person set for themselves (null: none)
      freeLimit: cap,                 // bytes a free person may keep (null: no limit of their own)
      readOnly: cap !== null && used > cap, // over it: new attachments are refused until files are deleted or the person upgrades (their files are kept)
      purchases: pay && open,
      paused: pay && !open, // a creator has Payments switched off (/admin > Switches): Get storage says "paused"
      provider: pay ? 'stripe' : null,
      regions: pay ? REG.publicInfo() : null,
    };
  }
  const plusSeen = new Map(); // uid -> whether the Plus badge was last shown; other people's profiles refresh only when it changes
  const push = (uid) => {
    const u = d.db().users[uid];
    if (!u || !d.notify) return Promise.resolve();
    const plus = isSubscriber(u, nowMs());
    const prev = plusSeen.get(uid);
    if (d.userChanged && prev !== plus && !(prev === undefined && !plus)) { try { d.userChanged(uid); } catch (e) { console.error('Plus badge update failed:', e.message); } }
    plusSeen.set(uid, plus);
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
    try { if (credits.purchasesEnabled() && await syncSubscription({ user: req.user, fetchImpl: d.fetchImpl, now: nowMs() })) d.save(); }
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

  // A Plus person sets an optional upload limit: body { gb: null } for none, or { gb: 5 } for 5 GB. Between 1 GB and the plan's 10 GB.
  app.post('/api/storage/limit', d.auth, d.ah(async (req, res) => {
    if (!isSubscriber(req.user, nowMs())) return res.status(403).json({ error: 'Setting an upload limit is part of Plus' });
    const gb = req.body ? req.body.gb : undefined;
    if (gb === null) req.user.plusLimit = null;
    else {
      const n = Number(gb);
      if (!Number.isFinite(n) || n < MIN_LIMIT_BYTES / GB || n > PLAN.bytes / GB) return res.status(400).json({ error: `Pick an upload limit between 1 and ${PLAN.bytes / GB} GB, or none` });
      req.user.plusLimit = Math.round(n * GB);
    }
    d.save();
    push(req.user.id);
    res.json(await viewOf(req.user));
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
    if (!credits.purchasesEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 5)) return;
    if (hasLifetime(req.user)) return res.status(409).json({ error: 'Aduna Plus is already on for this account' });
    if (isSubscriber(req.user, nowMs()) && rec(req.user) && rec(req.user).status === 'active') return res.status(409).json({ error: 'You already have the storage plan' });
    const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    try { res.json({ url: (await createCheckout({ user: req.user, buyer: req.body, origin, fetchImpl: d.fetchImpl })).url }); }
    catch (e) {
      if (e.forBuyer) return res.status(400).json({ error: e.message });
      console.error(e.message); res.status(502).json({ error: 'Could not start checkout. Try again later.' });
    }
  }));

  // Back from Stripe to /app?storage=paid&session_id=...: the app posts the id here and the SERVER asks Stripe.
  app.post('/api/storage/confirm', d.auth, d.ah(async (req, res) => {
    if (!credits.purchasesEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 10)) return;
    try {
      const r = await confirmSession({ user: req.user, sessionId: req.body?.sessionId, fetchImpl: d.fetchImpl, now: nowMs() });
      if (r.status === 'mismatch') return res.status(400).json({ error: 'That payment belongs to another account' });
      if (r.changed) { d.save(); push(req.user.id); }
      res.json({ status: r.status, ...(await viewOf(req.user)) });
    } catch (e) { console.error(e.message); res.status(502).json({ error: 'We could not confirm your plan yet. If Stripe charged you, it will show up shortly.' }); }
  }));

  // Stripe's page for updating the card or cancelling.
  app.post('/api/storage/portal', d.auth, d.ah(async (req, res) => {
    if (!credits.purchasesEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 5)) return;
    const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    try {
      const url = await portalUrl({ user: req.user, origin, fetchImpl: d.fetchImpl });
      if (!url) return res.status(400).json({ error: 'You do not have a plan to manage' });
      res.json({ url });
    } catch (e) { console.error(e.message); res.status(502).json({ error: 'Could not open your billing page. Try again later.' }); }
  }));

  app.post('/api/storage/cancel', d.auth, d.ah(async (req, res) => {
    if (!credits.purchasesEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 5)) return;
    try {
      const r = await cancelSubscription({ user: req.user, fetchImpl: d.fetchImpl, now: nowMs() });
      if (!r.ok) return res.status(400).json({ error: r.error });
      d.save(); push(req.user.id);
      res.json(await viewOf(req.user));
    } catch (e) { console.error(e.message); res.status(502).json({ error: 'Could not cancel with Stripe. Try again later.' }); }
  }));

  return { push, viewOf };
}

module.exports = {
  PLAN, GRACE_MS, PAID_FOR_MS, isSubscriber, hasLifetime, setLifetime, isProtected, protectedIds, plusLimitOf, effectiveLimit, overQuota, pickOldest, makeRoom,
  createCheckout, confirmSession, syncSubscription, cancelSubscription, portalUrl, applySession, handleEvent, register,
};
