// Unsent message drafts, one per conversation ('c:<channelId>' or 'd:<userId>').
// Kept in memory only, on purpose: direct messages are end-to-end encrypted, so a draft is never written to disk or
// sent anywhere. A draft lasts until you send it, clear it, or close the page.
import { useSyncExternalStore } from 'react';

const store = new Map();
const listeners = new Set();
let version = 0;

function emit() { version += 1; listeners.forEach((l) => l()); }

export const getDraft = (key) => (key && store.get(key)) || '';
export const hasDraft = (key) => !!key && store.has(key);

// Saves the text for a conversation. Empty (or only spaces) removes the draft.
export function setDraft(key, text) {
  if (!key) return;
  const t = String(text || '');
  if (!t.trim()) { if (store.delete(key)) emit(); return; }
  if (store.get(key) === t) return;
  const isNew = !store.has(key);
  store.set(key, t);
  if (isNew) emit(); // listeners only show a "Draft" tag, so more typing in an existing draft must not re-render the app
}

export const clearDrafts = () => { if (store.size) { store.clear(); emit(); } }; // on sign-out

// Re-renders the component when a draft appears or goes away, so a list can show its "Draft" tag.
export function useDrafts() {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => version);
}
