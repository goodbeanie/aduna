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
async function createPlan(fetchImpl = fetch, fresh = false) {
  const token = await credits.ppToken(fetchImpl);
  const rid = (name) => name + (fresh ? '-' + crypto.randomUUID() : ''); // `fresh`: new request ids, so PayPal makes a new product and plan instead of replaying an old answer
  const prod = await ppFetch(fetchImpl, token, 'POST', '/v1/catalogs/products',
    { name: PLAN.name, description: '10 GB of file storage on Aduna', type: 'DIGITAL', category: 'SOFTWARE' }, { 'PayPal-Request-Id': rid('aduna-storage-product-1') });
  if (!prod.ok || !prod.j.id) throw new Error(`PayPal product setup failed (${prod.status}): ${prod.j.message || 'no id'}`);
  const plan = await ppFetch(fetchImpl, token, 'POST', '/v1/billing/plans', {
    product_id: prod.j.id, name: PLAN.name + ' (monthly)', description: '10 GB of file storage, billed every month', status: 'ACTIVE',
    billing_cycles: [{ frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: (PLAN.cents / 100).toFixed(2), currency_code: PLAN.currency.toUpperCase() } } }],
    payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 3 },
  }, { 'PayPal-Request-Id': rid('aduna-storage-plan-1') });
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
  if (!r.ok || !link?.href || !SUB_ID.test(String(r.j.id || ''))) throw Object.assign(new Error(`PayPal subscription failed (${r.status}): ${r.j.message || 'no approval link'}`), { status: r.status });
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

// ---------- Card on file (PayPal Vault) ----------
// The card is typed into PayPal's own card fields and PayPal keeps it. Aduna stores only the vault id PayPal hands back, plus the card
// network's reference for the first payment, and charges that saved card once a month (renewDue). Aduna never sees a card number.
// u.storageSub for a card on file: { kind: 'vault', status, vaultId, netRef, amountCents, dueAt, nextChargeAt, failures, lastCaptureId, since, paidThrough, syncedAt }
//   dueAt = the day this month's bill belongs to; nextChargeAt = when we try next (later than dueAt after a declined payment).
const RETRY_MS = 3 * DAY;        // a declined payment is tried again after this long
const MAX_FAILURES = 3;          // ...and the plan ends after this many declines in a row
const VAULT_ID = /^[0-9a-zA-Z_-]{3,100}$/;
const money = (cents) => (cents / 100).toFixed(2);
const isVault = (u) => !!rec(u) && rec(u).kind === 'vault';
const amountOk = (cents) => Number.isInteger(cents) && cents >= PLAN.cents && cents <= Math.round(PLAN.cents * 1.5); // price + at most the tax the server adds

// the same day next calendar month (the 31st becomes the last day of a shorter month)
function addMonth(ms) {
  const d = new Date(ms), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

// First payment: the order the card fields pay. The price (and the tax, where Aduna collects it) is set here, never by the browser.
// store_in_vault asks PayPal to keep the card once the payment goes through.
async function createVaultOrder({ user, buyer = {}, fetchImpl = fetch }) {
  const q = TAX.quote(buyer, PLAN.cents);
  if (!q.ok) throw Object.assign(new Error(q.error), { forBuyer: true });
  const total = PLAN.cents + q.tax, cur = PLAN.currency.toUpperCase();
  const token = await credits.ppToken(fetchImpl);
  const r = await ppFetch(fetchImpl, token, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: PLAN.id,
      custom_id: `storage|${user.id}|${total}`,
      description: PLAN.name + ' (monthly)',
      amount: q.tax
        ? { currency_code: cur, value: money(total), breakdown: { item_total: { currency_code: cur, value: money(PLAN.cents) }, tax_total: { currency_code: cur, value: money(q.tax) } } }
        : { currency_code: cur, value: money(PLAN.cents) },
    }],
    payment_source: { card: {
      // TEMPORARY SANDBOX TEST: store_in_vault removed to see whether it is what makes PayPal answer 422 at confirm-payment-source.
      // Without it PayPal does not keep the card, so there is no monthly renewal until it goes back in.
      attributes: { verification: { method: 'SCA_WHEN_REQUIRED' } }, // 3-D Secure when the bank asks for it
      // No stored_credential ("first recurring payment") block here: it is suspected of making PayPal's card fields reject the card.
      // The monthly charge works without it; it links back to the first payment only when PayPal returns a reference.
    } },
  }, { 'PayPal-Request-Id': crypto.randomUUID() });
  if (!r.ok || !SUB_ID.test(String(r.j.id || ''))) throw new Error(`PayPal checkout failed (${r.status}): ${r.j.message || 'no order id'}`);
  return { orderId: r.j.id, totalCents: total };
}

// The card fields paid the order: capture it (the money moves), check what PayPal says, and keep the vault id for the monthly charge.
// Safe to call twice (the webhook or a second tab may capture first: then the order is just read).
async function captureVaultOrder({ user, orderId, fetchImpl = fetch, now = Date.now() }) {
  if (!SUB_ID.test(String(orderId || ''))) throw new Error('Bad order');
  const token = await credits.ppToken(fetchImpl);
  let r = await ppFetch(fetchImpl, token, 'POST', `/v2/checkout/orders/${orderId}/capture`, {}, { 'PayPal-Request-Id': 'scap-' + orderId });
  if (!r.ok && (r.j.details || []).some((x) => x.issue === 'ORDER_ALREADY_CAPTURED')) r = await ppFetch(fetchImpl, token, 'GET', `/v2/checkout/orders/${orderId}`);
  if (!r.ok) throw new Error(`PayPal capture failed (${r.status}): ${r.j.message || r.j.name || 'unknown'}`);
  const pu = (r.j.purchase_units || [])[0] || {}, cap = (pu.payments?.captures || [])[0];
  const [tag, uid, totalStr] = String(pu.custom_id || cap?.custom_id || '').split('|');
  if (tag !== 'storage' || uid !== user.id) return { status: 'mismatch' };
  if (!cap || cap.status !== 'COMPLETED') return { status: 'pending' };
  const cents = Math.round(Number(cap.amount?.value) * 100);
  if (!amountOk(cents) || cents !== Number(totalStr) || String(cap.amount?.currency_code).toUpperCase() !== PLAN.currency.toUpperCase()) {
    console.error('Storage: PayPal capture', cap.id, 'amount does not match the plan; not activating');
    return { status: 'failed' };
  }
  const old = rec(user) || {};
  if (old.kind === 'vault' && old.lastCaptureId === cap.id) return { status: 'active', saved: !!old.vaultId, changed: false };
  const vault = r.j.payment_source?.card?.attributes?.vault;
  const saved = !!vault && vault.status === 'VAULTED' && VAULT_ID.test(String(vault.id || ''));
  const ref = r.j.payment_source?.card?.stored_credential?.previous_network_transaction_reference;
  const netRef = ref && typeof ref.id === 'string' ? Object.fromEntries(['id', 'date', 'network', 'acquirer_reference_number'].filter((k) => typeof ref[k] === 'string').map((k) => [k, ref[k]])) : null;
  const { paypalId, ...rest } = old; // an older PayPal Subscriptions record must not be synced against any more
  user.storageSub = {
    ...rest, kind: 'vault',
    status: saved ? 'active' : 'cancelled', // paid but PayPal did not keep the card: the month is theirs, there is nothing to renew
    vaultId: saved ? vault.id : null, netRef, amountCents: cents,
    dueAt: addMonth(now), nextChargeAt: saved ? addMonth(now) : null, failures: 0, lastCaptureId: cap.id,
    since: old.since || now, paidThrough: Math.max(Number(old.paidThrough) || 0, now) + PAID_FOR_MS, syncedAt: now,
  };
  return { status: 'active', saved, changed: true };
}

// One monthly charge of the saved card, made by the server (the person is not there). Returns { ok, skipped?, transient?, ended? }.
async function chargeRenewal({ user, fetchImpl = fetch, now = Date.now() }) {
  const s = rec(user);
  if (!s || s.kind !== 'vault' || !s.vaultId || !['active', 'past_due'].includes(s.status) || !Number.isFinite(s.nextChargeAt) || now < s.nextChargeAt) return { ok: false, skipped: true };
  if (!amountOk(s.amountCents)) { console.error('Storage: bad stored amount for', user.id, '; not charging'); return { ok: false, skipped: true }; }
  const token = await credits.ppToken(fetchImpl);
  const cur = PLAN.currency.toUpperCase();
  // same request id for the same attempt: if we crash after PayPal charged but before saving, the retry gets the same answer, not a second charge
  let r = await ppFetch(fetchImpl, token, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: PLAN.id, custom_id: `storage|${user.id}|${s.amountCents}`, description: PLAN.name + ' (monthly)', amount: { currency_code: cur, value: money(s.amountCents) } }],
    payment_source: { card: { vault_id: s.vaultId, stored_credential: { payment_initiator: 'MERCHANT', payment_type: 'RECURRING', usage: 'SUBSEQUENT', ...(s.netRef ? { previous_network_transaction_reference: s.netRef } : {}) } } },
  }, { 'PayPal-Request-Id': `renew-${user.id}-${s.nextChargeAt}` });
  if (r.status >= 500) return { ok: false, transient: true }; // PayPal trouble, not a decline: try again at the next run, count nothing
  if (r.ok && r.j.status !== 'COMPLETED' && SUB_ID.test(String(r.j.id || ''))) r = await ppFetch(fetchImpl, token, 'POST', `/v2/checkout/orders/${r.j.id}/capture`, {}, { 'PayPal-Request-Id': 'rcap-' + r.j.id });
  if (r.status >= 500) return { ok: false, transient: true };
  const cap = r.ok ? ((r.j.purchase_units || [])[0]?.payments?.captures || [])[0] : null;
  if (cap && cap.status === 'COMPLETED' && Math.round(Number(cap.amount?.value) * 100) === s.amountCents) {
    s.status = 'active'; s.failures = 0; s.lastCaptureId = cap.id; s.syncedAt = now;
    s.paidThrough = Math.max(Number(s.paidThrough) || 0, now + PAID_FOR_MS);
    s.dueAt = addMonth(s.dueAt || now); s.nextChargeAt = s.dueAt;
    return { ok: true };
  }
  if (cap && cap.status === 'PENDING') return { ok: false, transient: true }; // PayPal is still looking at it; the same request id answers the same next time
  s.failures = (Number(s.failures) || 0) + 1;
  console.error('Storage: monthly charge declined for', user.id, `(${s.failures}/${MAX_FAILURES}):`, r.status, r.j.name || r.j.message || '');
  if (s.failures >= MAX_FAILURES) { end(user, now); s.nextChargeAt = null; await deleteVaultToken(s, fetchImpl); return { ok: false, ended: true }; }
  s.status = 'past_due'; s.nextChargeAt = now + RETRY_MS;
  return { ok: false };
}

// Charges everybody whose month is due. Returns the ids of the people whose plan changed (the caller saves and pushes).
async function renewDue({ db, fetchImpl = fetch, now = Date.now() }) {
  const changed = [];
  for (const u of Object.values((db && db.users) || {})) {
    const s = rec(u);
    if (!s || s.kind !== 'vault' || !s.vaultId || !Number.isFinite(s.nextChargeAt) || now < s.nextChargeAt) continue;
    try { const r = await chargeRenewal({ user: u, fetchImpl, now }); if (!r.skipped && !r.transient) changed.push(u.id); }
    catch (e) { console.error('Storage: monthly charge error for', u.id + ':', e.message); }
  }
  return changed;
}

// Asks PayPal to forget the saved card. Best effort: the plan is already stopped, so a failure here only leaves an unused token at PayPal.
async function deleteVaultToken(s, fetchImpl = fetch) {
  const id = s.vaultId;
  s.vaultId = null;
  if (!id || !VAULT_ID.test(id)) return;
  try {
    const token = await credits.ppToken(fetchImpl);
    const r = await ppFetch(fetchImpl, token, 'DELETE', `/v3/vault/payment-tokens/${encodeURIComponent(id)}`);
    if (!r.ok && r.status !== 404) console.error('Storage: could not delete the saved card at PayPal:', r.status);
  } catch (e) { console.error('Storage: could not delete the saved card at PayPal:', e.message); }
}

// The person cancels: no more charges, the plan stays until the month that was paid for ends, and PayPal forgets the card.
async function cancelVault({ user, fetchImpl = fetch, now = Date.now() }) {
  const s = rec(user);
  if (!s || s.kind !== 'vault' || !['active', 'past_due'].includes(s.status)) return { ok: false, error: 'You do not have a plan to cancel' };
  s.status = 'cancelled'; s.nextChargeAt = null; s.syncedAt = now;
  await deleteVaultToken(s, fetchImpl);
  return { ok: true };
}

// ---------- routes ----------
// d: { auth, ah, db() -> store.db, save(), store, notify(uid, view), fileLabels() -> Map(id -> { name, type, where }), filesGone(ids),
//      fetchImpl?, getMeta?, setMeta?, now?, freeBudget? (server/storage-budget.js: the free people's own limit) }
function register(app, d) {
  const nowMs = () => (d.now ? d.now() : Date.now());
  let planMem = null;
  const planId = async (force = false) => {
    if (process.env.PAYPAL_STORAGE_PLAN_ID) return process.env.PAYPAL_STORAGE_PLAN_ID; // a plan you made yourself in the PayPal dashboard
    if (planMem && !force) return planMem;
    const key = 'storage-plan:' + credits.ppBase();                                   // sandbox and live each get their own
    const cached = !force && d.getMeta ? await d.getMeta(key) : null;
    if (cached) return (planMem = cached);
    const id = await createPlan(d.fetchImpl, force);
    if (d.setMeta) await d.setMeta(key, id);
    return (planMem = id);
  };

  async function viewOf(u) {
    const now = nowMs(), s = rec(u), sub = isSubscriber(u, now);
    const pay = credits.paypalEnabled();
    const used = await d.store.userFileBytes(u.id);
    const cap = !sub && d.freeBudget ? d.freeBudget.limitBytes() : null; // a free person's own limit (null: none, or the cap is not switched on)
    return {
      plan: { ...PLAN },
      subscriber: sub,
      lifetime: hasLifetime(u),
      status: s ? s.status : 'none',
      paidThrough: s && s.paidThrough ? s.paidThrough : null,
      renews: sub && !!s && s.status === 'active',
      used,
      limit: sub ? PLAN.bytes : null, // Plus: the plan's 10 GB. free: see freeLimit
      uploadLimit: sub ? plusLimitOf(u) : null, // Plus: the optional upload limit the person set for themselves (null: none)
      freeLimit: cap,                 // bytes a free person may keep (null: no limit of their own)
      readOnly: cap !== null && used > cap, // over it: new attachments are refused until files are deleted or the person upgrades (their files are kept)
      purchases: pay,
      provider: pay ? 'paypal' : null,
      paypalClientId: pay ? credits.ppId() : null, // public by design: the browser needs it to load PayPal's card fields
      tax: pay ? TAX.publicInfo() : null,
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
    if (!credits.paypalEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 5)) return;
    if (hasLifetime(req.user)) return res.status(409).json({ error: 'Aduna Plus is already on for this account' });
    if (isSubscriber(req.user, nowMs()) && rec(req.user) && rec(req.user).status === 'active') return res.status(409).json({ error: 'You already have the storage plan' });
    const origin = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    try {
      let r;
      try { r = await createSubscription({ user: req.user, buyer: req.body, origin, planId: await planId(), fetchImpl: d.fetchImpl }); }
      catch (e) {
        // PayPal does not know the remembered plan (404: it was made under another sandbox/live account): make a fresh one once and try again
        if (e.status !== 404 || process.env.PAYPAL_STORAGE_PLAN_ID) throw e;
        console.error('Storage plan not found at PayPal, making a new one:', e.message);
        r = await createSubscription({ user: req.user, buyer: req.body, origin, planId: await planId(true), fetchImpl: d.fetchImpl });
      }
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

  // Card on file. Step 1: the browser asks for an order, pays it in PayPal's card fields, then step 2 hands the order id back to be captured.
  app.post('/api/storage/vault/order', d.auth, d.ah(async (req, res) => {
    if (!credits.paypalEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 5)) return;
    if (hasLifetime(req.user)) return res.status(409).json({ error: 'Aduna Plus is already on for this account' });
    if (isSubscriber(req.user, nowMs()) && rec(req.user) && rec(req.user).status === 'active') return res.status(409).json({ error: 'You already have the storage plan' });
    try { res.json({ orderId: (await createVaultOrder({ user: req.user, buyer: req.body, fetchImpl: d.fetchImpl })).orderId }); }
    catch (e) {
      if (e.forBuyer) return res.status(400).json({ error: e.message });
      console.error(e.message); res.status(502).json({ error: 'Could not start checkout. Try again later.' });
    }
  }));

  app.post('/api/storage/vault/capture', d.auth, d.ah(async (req, res) => {
    if (!credits.paypalEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 10)) return;
    try {
      const r = await captureVaultOrder({ user: req.user, orderId: req.body?.orderId, fetchImpl: d.fetchImpl, now: nowMs() });
      if (r.status === 'mismatch') return res.status(400).json({ error: 'That payment belongs to another account' });
      if (r.status === 'failed') return res.status(502).json({ error: 'We could not confirm your payment. If PayPal charged you, contact support.' });
      if (r.changed) { d.save(); push(req.user.id); }
      res.json({ status: r.status, saved: r.saved, ...(await viewOf(req.user)) });
    } catch (e) { console.error(e.message); res.status(502).json({ error: 'We could not confirm your payment yet. If PayPal charged you, your plan will show up shortly.' }); }
  }));

  app.post('/api/storage/cancel', d.auth, d.ah(async (req, res) => {
    if (!credits.paypalEnabled()) return res.status(503).json({ error: 'The storage plan is not set up on this server yet' });
    if (limited(req, res, 5)) return;
    try {
      const r = isVault(req.user)
        ? await cancelVault({ user: req.user, fetchImpl: d.fetchImpl, now: nowMs() })
        : await cancelSubscription({ user: req.user, fetchImpl: d.fetchImpl, now: nowMs() });
      if (!r.ok) return res.status(400).json({ error: r.error });
      d.save(); push(req.user.id);
      res.json(await viewOf(req.user));
    } catch (e) { console.error(e.message); res.status(502).json({ error: 'Could not cancel with PayPal. Try again, or cancel it in your PayPal account.' }); }
  }));

  // Monthly charges of saved cards: once shortly after start-up, then every hour (only when index.js asks for it with runRenewals).
  let renewing = false;
  const runRenewals = async () => {
    if (renewing || !credits.paypalEnabled()) return [];
    renewing = true;
    try {
      const ids = await renewDue({ db: d.db(), fetchImpl: d.fetchImpl, now: nowMs() });
      if (ids.length) { d.save(); ids.forEach((id) => push(id)); }
      return ids;
    } catch (e) { console.error('Storage renewals failed:', e.message); return []; }
    finally { renewing = false; }
  };
  if (d.runRenewals) {
    const first = setTimeout(runRenewals, 60_000), every = setInterval(runRenewals, 3600_000);
    if (first.unref) first.unref();
    if (every.unref) every.unref();
  }

  return { push, viewOf, planId, runRenewals };
}

module.exports = {
  PLAN, GRACE_MS, PAID_FOR_MS, isSubscriber, hasLifetime, setLifetime, isProtected, protectedIds, plusLimitOf, effectiveLimit, overQuota, pickOldest, makeRoom,
  createPlan, createSubscription, confirmSubscription, syncSubscription, cancelSubscription, applyActive, handleEvent, register,
  createVaultOrder, captureVaultOrder, chargeRenewal, renewDue, cancelVault, addMonth,
};
