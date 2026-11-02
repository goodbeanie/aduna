// Saved messages and reminders ("save for later", "remind me in an hour" in a message's right-click menu).
// Kept on this device only (localStorage), one list per account. A saved message is a small snapshot (who, where, a short
// piece of the text) so it can still be read after the original scrolls away or is deleted.
export const HOUR = 3_600_000;
export const EVENT = 'aduna:saved-changed';
const MAX_SAVED = 200, MAX_REMINDERS = 50, MAX_TEXT = 300;

const key = (kind, uid) => `aduna_${kind}_${uid}`;
function read(kind, uid) {
  if (!uid) return [];
  try { const v = JSON.parse(localStorage.getItem(key(kind, uid)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function write(kind, uid, list) {
  if (!uid) return false;
  try { localStorage.setItem(key(kind, uid), JSON.stringify(list)); } catch { return false; } // private mode / storage full
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* no window */ }
  return true;
}

// A snapshot of a message: { id, convo, convoTitle, author, text, at }
export const snapshot = (m, { convo, convoTitle, author, text }) => ({
  id: m.id, convo: convo || '', convoTitle: convoTitle || '', author: author || 'Unknown', at: m.createdAt || Date.now(),
  text: String(text || '').slice(0, MAX_TEXT) || 'Attachment',
});

// ---- saved ----
export const listSaved = (uid) => read('saved', uid);
export const isSaved = (uid, id) => listSaved(uid).some((s) => s.id === id);
export function toggleSaved(uid, snap) { // returns true when the message is saved afterwards, null when it could not be stored
  const list = listSaved(uid);
  const has = list.some((s) => s.id === snap.id);
  const next = has ? list.filter((s) => s.id !== snap.id) : [{ ...snap, savedAt: Date.now() }, ...list].slice(0, MAX_SAVED);
  return write('saved', uid, next) ? !has : null;
}
export const removeSaved = (uid, id) => write('saved', uid, listSaved(uid).filter((s) => s.id !== id));

// ---- reminders ----
export const listReminders = (uid) => read('reminders', uid).sort((a, b) => a.due - b.due);
export const reminderFor = (uid, id) => listReminders(uid).find((r) => r.id === id) || null;
export function addReminder(uid, snap, ms = HOUR) { // one reminder per message: asking again moves it to an hour from now
  const rest = listReminders(uid).filter((r) => r.id !== snap.id);
  return write('reminders', uid, [...rest, { ...snap, due: Date.now() + ms }].slice(-MAX_REMINDERS));
}
export const cancelReminder = (uid, id) => write('reminders', uid, listReminders(uid).filter((r) => r.id !== id));
export function takeDue(uid, now = Date.now()) { // the reminders whose time has come; they are removed from the list
  const all = listReminders(uid);
  const due = all.filter((r) => r.due <= now);
  if (due.length) write('reminders', uid, all.filter((r) => r.due > now));
  return due;
}

export const whenIn = (ts, now = Date.now()) => {
  const mins = Math.max(1, Math.round((ts - now) / 60000));
  return mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h' + (mins % 60 ? ' ' + (mins % 60) + ' min' : '');
};
