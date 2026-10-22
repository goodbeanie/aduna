// A few things the service worker (public/sw.js) needs to know but cannot read itself: it has no localStorage and no page to ask while
// the app is closed. The page writes them here (IndexedDB, which both can read) whenever they change.
//   look: { dark, bg, accent, serverThemes } = the person's OWN theme colours and whether they let servers recolour things.
// Used to draw the notification picture in the app theme (DMs) or the server theme (server notifications, unless opted out).
const DB = 'aduna-sw', STORE = 'kv';
function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
let last = '';
export async function saveLook(look) {
  try {
    const json = JSON.stringify(look);
    if (json === last) return;
    last = json;
    const db = await open();
    await new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(look, 'look'); t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close();
  } catch { /* private mode / no IndexedDB: notifications fall back to the default look */ }
}
