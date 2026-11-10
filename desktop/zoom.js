// Screen-share zoom, desktop side. While a whole screen is being shared, a global hotkey (works even when Aduna is in the background, which it
// is while you share something else) tells the page to zoom the shared picture in on the cursor; scrolling then zooms further.
//
// This file only knows three things the web page cannot: the global hotkey, where the cursor is, and the scroll wheel. The picture itself is
// zoomed by the page (client/src/sharezoom.js), so nothing here touches video.
//   - The hotkey is registered ONLY while a screen is being shared, so the key combination is free for other programs the rest of the time.
//   - The cursor position is sent (about 60 times a second) ONLY while the picture is zoomed in, as 0..1 of the shared screen.
//   - The scroll wheel comes from the optional `uiohook-napi` module, started ONLY while zoomed in. We listen for the wheel and nothing else:
//     no key press or click is read, stored or sent anywhere. Without the module the hotkey still works, only scrolling does not.
// A shared WINDOW cannot be followed (Electron cannot tell where another program's window is), so zoom is for whole-screen shares.
// Pure helpers are exported for the test (zoom-test.js); create() does the Electron work with everything passed in.

const DEFAULT_KEY = 'Control+Alt+Shift+Z'; // uncommon on purpose: it must not clash with a shortcut in the thing being shared
const WHEEL_UP_IS_NEGATIVE = true;          // libuiohook reports scrolling up / away from you as a negative rotation; flip this if it zooms the wrong way

const MODIFIER = /^(Control|Alt|Shift|Super)$/;
const STRONG = /^(Control|Alt|Super)$/;     // a hotkey needs at least one of these, so Shift + a letter (normal typing) is never taken over
const KEYNAME = /^([A-Z0-9]|F([1-9]|1\d|2[0-4])|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/;

// 'Control+Alt+Shift+Z' style: some modifiers (each once, at least one of Control / Alt / Super) and exactly one key.
function validKey(acc) {
  if (typeof acc !== 'string' || acc.length > 50) return false;
  const parts = acc.split('+');
  const key = parts.pop();
  if (!KEYNAME.test(key) || !parts.length) return false;
  if (new Set(parts).size !== parts.length || !parts.every((m) => MODIFIER.test(m))) return false;
  return parts.some((m) => STRONG.test(m));
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
// where a point (screen coordinates) is inside a display, as 0..1 of its width and height; `on` says whether it is on that display at all
function cursorIn(point, b) {
  if (!point || !b || !(b.width > 0) || !(b.height > 0)) return { x: 0.5, y: 0.5, on: false };
  const x = (point.x - b.x) / b.width, y = (point.y - b.y) / b.height;
  return { x: clamp01(x), y: clamp01(y), on: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
}

// deps: { globalShortcut, screen, send(channel, data), getPrefs(), setPrefs(patch), loadHook() -> uIOhook | null }
function create(deps) {
  const { globalShortcut, screen, send, getPrefs, setPrefs, loadHook } = deps;
  let source = null;        // the screen or window being shared: { kind: 'screen' | 'window', displayId }
  let sharing = false, registered = '', active = false, timer = null, hookRunning = false, hookBound = false;
  let hook; // undefined = not looked for yet, null = not available
  let lastSent = '';

  const keyNow = () => { const k = getPrefs().zoomKey; return validKey(k) ? k : DEFAULT_KEY; };
  const getHook = () => { if (hook === undefined) { try { hook = loadHook() || null; } catch { hook = null; } } return hook; };

  function display() {
    if (!source || source.kind !== 'screen') return null;
    const all = screen.getAllDisplays();
    return all.find((d) => String(d.id) === String(source.displayId)) || (all.length === 1 ? all[0] : null);
  }

  function register(key) {
    try { if (globalShortcut.register(key, () => { if (sharing) send('zoom:toggle', null); })) { registered = key; return true; } } catch { /* not a usable shortcut */ }
    return false;
  }
  function unregister() { if (registered) { try { globalShortcut.unregister(registered); } catch { /* already gone */ } registered = ''; } }

  function startCursor() {
    stopCursor();
    lastSent = '';
    timer = setInterval(() => {
      const d = display();
      if (!d) return;
      const n = cursorIn(screen.getCursorScreenPoint(), d.bounds);
      const s = n.x.toFixed(4) + ',' + n.y.toFixed(4);
      if (s === lastSent) return;
      lastSent = s;
      send('zoom:cursor', n);
    }, 16);
  }
  function stopCursor() { if (timer) { clearInterval(timer); timer = null; } }

  const onWheel = (e) => {
    if (!active || !e || !e.rotation) return;
    send('zoom:wheel', { dir: (e.rotation < 0) === WHEEL_UP_IS_NEGATIVE ? 1 : -1 });
  };
  function startWheel() {
    const h = getHook();
    if (!h || hookRunning) return;
    try { if (!hookBound) { h.on('wheel', onWheel); hookBound = true; } h.start(); hookRunning = true; } catch { /* no scrolling, the hotkey still works */ }
  }
  function stopWheel() { if (hookRunning && hook) { try { hook.stop(); } catch { /* already stopped */ } } hookRunning = false; }

  // The page says whether the picture is zoomed in right now: only then do we follow the cursor and listen for the wheel.
  function setActive(on) {
    on = !!on && sharing;
    if (on === active) return;
    active = on;
    if (on) { startCursor(); startWheel(); } else { stopCursor(); stopWheel(); }
  }

  // A share started: register the hotkey. Returns { ok, key } or { ok: false, reason: 'none' | 'window' | 'taken' }.
  function begin() {
    end();
    if (!source) return { ok: false, reason: 'none' };
    if (!display()) return { ok: false, reason: 'window' };
    const key = keyNow();
    if (!register(key)) return { ok: false, reason: 'taken', key };
    sharing = true;
    return { ok: true, key };
  }
  function end() { setActive(false); sharing = false; unregister(); }

  function setKey(acc) {
    if (!validKey(acc)) return { ok: false, error: 'Use Ctrl, Alt or Win together with a letter, number or F-key.' };
    if (sharing && acc !== registered) {
      const old = registered;
      unregister();
      if (!register(acc)) { if (old) register(old); return { ok: false, error: 'Another program already uses that shortcut. Try a different one.' }; }
    }
    setPrefs({ zoomKey: acc });
    return { ok: true, key: acc };
  }

  // IPC for the page; fromAduna(webContents) says whether a caller is the Aduna page.
  function ipc(ipcMain, fromAduna) {
    const guard = (fn, no) => (e, ...a) => (fromAduna(e.sender) ? fn(...a) : no);
    ipcMain.handle('zoom:get-key', guard(() => ({ key: keyNow(), def: DEFAULT_KEY, wheel: !!getHook() }), null));
    ipcMain.handle('zoom:set-key', guard((k) => setKey(String(k || '')), { ok: false, error: 'Not allowed' }));
    ipcMain.handle('zoom:begin', guard(() => begin(), { ok: false, reason: 'none' }));
    ipcMain.handle('zoom:end', guard(() => { end(); return true; }, false));
    ipcMain.handle('zoom:active', guard((on) => { setActive(on); return true; }, false));
  }

  // Remember what is being shared (called by main.js when it answers the page's getDisplayMedia request; null when a new choice is made).
  function shareSource(s) {
    source = s && typeof s.id === 'string' ? { kind: s.id.startsWith('screen:') ? 'screen' : 'window', displayId: s.display_id || '' } : null;
  }

  return { begin, end, setActive, setKey, ipc, shareSource, keyNow };
}

module.exports = { DEFAULT_KEY, validKey, cursorIn, create };
