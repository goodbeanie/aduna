// Group chat keys and names. Pure (no React, no network): client/scripts/groupkeys-test.mjs tests it in Node.
// The rules this follows are in server/groups.js: one AES key per epoch, wrapped for every member with their pairwise ECDH key.
import { newGroupKey, wrapGroupKey, unwrapGroupKey, encryptWithKey, decryptWithKey, rosterFingerprint } from './crypto.js';

export const NAME_MAX = 50;

// The group name is sealed with the epoch key as a small JSON envelope: { n: name, r: roster fingerprint }.
// `r` says which people (and which identity keys) the epoch was made for, so any member can notice a changed key later.
// `keepRoster` (a fingerprint string) is used by a rename: the epoch was made for the same people as before, so the old fingerprint stays.
// Otherwise a rename would hide that someone's identity key changed since the epoch was made.
export async function sealName(key, name, members, keepRoster) {
  return encryptWithKey(key, JSON.stringify({ n: String(name || '').trim().slice(0, NAME_MAX), r: typeof keepRoster === 'string' ? keepRoster : await rosterFingerprint(members) }));
}

// { n, r } or null when it cannot be opened (we do not hold that epoch's key)
export async function openName(key, nameEnc) {
  if (!key || !nameEnc) return null;
  try {
    const o = JSON.parse(await decryptWithKey(key, nameEnc.ciphertext, nameEnc.iv));
    return o && typeof o.n === 'string' ? { n: o.n, r: typeof o.r === 'string' ? o.r : '' } : null;
  } catch { return null; }
}

// A new epoch for `members` (everyone who will be in the group, each { id, publicKey }, ourselves included).
// Returns what the server wants in a request: { key, nameEnc, wraps } (key stays here; nameEnc and wraps are uploaded).
export async function makeEpoch({ privKey, members, name }) {
  for (const m of members) if (!m.publicKey) throw new Error(`${m.displayName || 'Someone'} has not set up encryption yet`);
  const key = await newGroupKey();
  const wraps = {};
  for (const m of members) wraps[m.id] = await wrapGroupKey(privKey, m.publicKey, key);
  return { key, nameEnc: await sealName(key, name, members), wraps };
}

// Opens every epoch key we hold a wrap for. `view` is a group as the server sent it (view.keys: epoch -> { by, byKey, wrap }).
// Epochs we cannot open (made before we joined, or wrapped for an identity key we no longer have) are simply missing from the map.
// `have` is the map we already opened; it is reused so each wrap is only opened once.
export async function openKeys(privKey, view, have = new Map()) {
  const out = new Map(have);
  for (const [ep, k] of Object.entries(view.keys || {})) {
    const n = Number(ep);
    if (out.has(n)) continue;
    try { out.set(n, await unwrapGroupKey(privKey, k.byKey, k.wrap)); } catch { /* not for us */ }
  }
  return out;
}

// The name to show: the sealed one, or the other members' names when the group has none (or we cannot read it).
export function titleOf(group, meId) {
  const n = group.name;
  if (n) return n;
  const others = (group.members || []).filter((m) => m.id !== meId).map((m) => m.displayName).filter(Boolean);
  if (!others.length) return 'Group';
  return others.length <= 3 ? others.join(', ') : others.slice(0, 3).join(', ') + ` +${others.length - 3}`;
}

// Does this group need a fresh epoch because somebody's identity key is not the one the current epoch was made for?
// Only a member who can read the current epoch can tell (the fingerprint is inside the sealed name).
export async function staleRoster(view, currentName) {
  if (!currentName || !currentName.r) return false;
  return (await rosterFingerprint(view.members)) !== currentName.r;
}
