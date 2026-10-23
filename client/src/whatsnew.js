// "What's new": the list of what each update added, the on/off switch, and which update this device has already been told about.
//
// To announce an update: add a release at the TOP of RELEASES (newest first) with a new unique `id`. Each person sees the popup once,
// the next time they open Aduna after that release reaches them, unless they turned it off in Settings > What's new.
export const RELEASES = [
  {
    id: '2026.10.23',
    date: '2026-10-23',
    title: 'What’s new in Aduna',
    items: [
      { title: 'New Features popup', text: 'After an update, Aduna now tells you what was added. You can turn this off in Settings > What’s new.' },
      { title: 'Credits shop', text: 'Spend your credits on profile badges.' },
    ],
  },
];

const SEEN = 'aduna_whatsnew_seen'; // id of the newest release this device has been shown
const OFF = 'aduna_whatsnew_off'; // '1' when the person turned the popup off
const MAX_SHOWN = 3; // after a long break, show the latest few releases rather than a wall of them

export const latestRelease = () => RELEASES[0] || null;

export function whatsNewEnabled() {
  try { return localStorage.getItem(OFF) !== '1'; } catch { return true; }
}
export function setWhatsNewEnabled(on) {
  try { if (on) localStorage.removeItem(OFF); else localStorage.setItem(OFF, '1'); } catch { /* private mode */ }
}

export function markWhatsNewSeen() {
  const r = latestRelease();
  if (!r) return;
  try { localStorage.setItem(SEEN, r.id); } catch { /* private mode */ }
}

// The releases this device has not seen yet, newest first. [] when there is nothing to show or the popup is turned off.
// While it is off the newest release is still marked as seen, so turning it back on later does not replay old updates.
export function unseenReleases() {
  const latest = latestRelease();
  if (!latest) return [];
  if (!whatsNewEnabled()) { markWhatsNewSeen(); return []; }
  let seen = null;
  try { seen = localStorage.getItem(SEEN); } catch { /* private mode */ }
  if (seen === latest.id) return [];
  // No record yet (first run of this feature) or an id we do not know: announce only the newest release.
  const at = seen ? RELEASES.findIndex((r) => r.id === seen) : -1;
  return at > 0 ? RELEASES.slice(0, Math.min(at, MAX_SHOWN)) : [latest];
}
