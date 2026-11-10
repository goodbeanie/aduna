// Zoom while sharing your screen (Aduna desktop app, whole-screen shares). The desktop app (desktop/zoom.js) owns the global hotkey, the cursor
// position and the scroll wheel; this file does the zooming itself:
//   - while NOT zoomed, nothing here runs and the normal screen-capture track is what the other people receive;
//   - on the hotkey, the captured screen is drawn into a canvas, cropped around the cursor, and the canvas's own video track replaces the
//     outgoing one (replaceTrack, so no renegotiation and no glitch); scrolling changes the zoom level;
//   - on the hotkey again, the picture eases back out and the normal track is put back.
// What you see in your own preview stays the plain screen. The pure parts (the crop, the steps, the key names) are tested in scripts/sharezoom-test.mjs.

export const DEFAULT_KEY = 'Control+Alt+Shift+Z'; // keep in step with desktop/zoom.js
export const ZOOM = { start: 2, min: 1.25, max: 6, factor: 1.2 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// one scroll step in (dir 1) or out (dir -1)
export const stepLevel = (level, dir) => clamp(level * (dir > 0 ? ZOOM.factor : 1 / ZOOM.factor), ZOOM.min, ZOOM.max);

// The part of a W x H picture to show at this zoom, centred on (cx, cy) given as 0..1 of the picture and kept inside it.
export function cropRect(W, H, cx, cy, level) {
  const l = Math.max(1, level), sw = W / l, sh = H / l;
  return { sx: clamp(cx * W - sw / 2, 0, W - sw), sy: clamp(cy * H - sh / 2, 0, H - sh), sw, sh };
}

// move `cur` toward `goal`; `speed` is per second, so it looks the same at 30 and 60 frames a second
export const ease = (cur, goal, dt, speed) => cur + (goal - cur) * (1 - Math.exp(-speed * Math.max(0, dt)));

// ----- the shortcut as an Electron accelerator ('Control+Alt+Shift+Z'), built from a keydown in Settings -----
const NAMED = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace' };
export function keyFromCode(code) {
  const c = String(code || '');
  let m = /^Key([A-Z])$/.exec(c);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(c);
  if (m) return m[1];
  m = /^F(\d{1,2})$/.exec(c);
  if (m && +m[1] >= 1 && +m[1] <= 24) return 'F' + m[1];
  return NAMED[c] || null;
}
// null while the combination is not usable yet (only modifiers so far, or no Ctrl / Alt / Win, which would take over normal typing)
export function acceleratorFrom(e) {
  const key = keyFromCode(e && e.code);
  if (!key) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  return mods.some((m) => m !== 'Shift') ? [...mods, key].join('+') : null;
}
export const keyLabel = (acc) => String(acc || '').split('+').map((p) => (p === 'Control' ? 'Ctrl' : p === 'Super' ? 'Win' : p)).join(' + ');

export const desktopZoom = () => (typeof window !== 'undefined' && window.adunaDesktop && window.adunaDesktop.zoom) || null;

// ----- the canvas that shows the zoomed picture -----
// Draws `src` (the screen-capture track) every frame, cropped and eased toward the zoom level and the cursor. `track` is what to send instead of `src`.
export function createZoomer(src, { fps = 30, onIdle } = {}) {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true;
  video.srcObject = new MediaStream([src]);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const st = { level: 1, goal: 1, cx: 0.5, cy: 0.5, tx: 0.5, ty: 0.5, last: 0, armed: false };
  let timer = 0, out = null;

  const fit = () => {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return false;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return true;
  };
  const draw = () => {
    const now = performance.now(), dt = Math.min(0.25, (now - st.last) / 1000);
    st.last = now;
    if (!fit()) return;
    st.level = ease(st.level, st.goal, dt, 9);
    if (Math.abs(st.level - st.goal) < 0.005) st.level = st.goal;
    st.cx = ease(st.cx, st.tx, dt, 14);
    st.cy = ease(st.cy, st.ty, dt, 14);
    const r = cropRect(canvas.width, canvas.height, st.cx, st.cy, st.level);
    ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, canvas.width, canvas.height);
    if (st.armed && st.goal === 1 && st.level === 1 && onIdle) onIdle(); // back to the full picture: the caller can put the normal track back
  };

  return {
    get track() { return out; },
    async start() {
      await video.play();
      for (let i = 0; i < 100 && !fit(); i++) await new Promise((r) => setTimeout(r, 20)); // wait for the first frame (up to 2 s)
      if (!fit()) throw new Error('no picture to zoom');
      st.last = performance.now();
      draw(); // something on the canvas before it is captured
      out = canvas.captureStream(fps).getVideoTracks()[0];
      try { out.contentHint = src.contentHint; } catch { /* the default is fine */ }
      timer = setInterval(draw, Math.round(1000 / fps)); // a timer, not requestAnimationFrame: this keeps running while Aduna is behind the shared window
      return out;
    },
    zoomTo(level) { st.goal = Math.max(1, level); if (st.goal > 1) st.armed = true; },
    look(x, y) { st.tx = clamp(+x || 0, 0, 1); st.ty = clamp(+y || 0, 0, 1); },
    stop() {
      clearInterval(timer); timer = 0;
      try { if (out) out.stop(); } catch { /* ended */ }
      out = null;
      try { video.pause(); } catch { /* not playing */ }
      video.srcObject = null;
    },
  };
}

// ----- the controller a call or voice channel creates when a screen share starts -----
// track:  the screen-capture track being shared.   fps: its frame rate.
// swap(t): put track t on the outgoing video sender(s) (the caller knows where they are); may return a promise.
// notice(text): show a short message.
// Returns null when this is not the desktop app. Otherwise { out(), stop() }: out() is the track that is being sent right now (so a caller that
// has to put the screen back on a sender after other changes puts the right one), stop() must be called when the share ends.
export function shareZoom({ track, fps = 30, swap, notice }) {
  const dz = desktopZoom();
  if (!dz) return null;
  let zm = null, zoomed = false, busy = false, dead = false, off = null, level = ZOOM.start;
  const active = (on) => dz.active(on).catch(() => {});

  function leave() { // the picture has eased back to normal: send the plain capture again and drop the canvas
    if (!zm || zoomed) return;
    const z = zm; zm = null;
    Promise.resolve(swap(track)).catch(() => {}).then(() => z.stop());
  }
  async function zoomIn() {
    if (zoomed || busy || dead) return;
    busy = true;
    try {
      if (!zm) {
        const z = createZoomer(track, { fps, onIdle: leave });
        await z.start();
        if (dead) { z.stop(); return; }
        zm = z;
        await swap(z.track);
      }
      zoomed = true;
      zm.zoomTo(level);
      active(true);
    } catch (e) {
      console.warn('screen zoom failed', e);
      if (zm) { try { await swap(track); } catch { /* ignore */ } zm.stop(); zm = null; }
      notice && notice('Could not zoom the shared screen');
    } finally { busy = false; }
  }
  function zoomOut() {
    if (!zoomed) return;
    zoomed = false;
    if (zm) zm.zoomTo(1);
    active(false);
  }
  const onEvent = (type, d) => {
    if (dead) return;
    if (type === 'toggle') { if (zoomed) zoomOut(); else zoomIn(); }
    else if (type === 'wheel') { if (zoomed && zm && d) { level = stepLevel(level, d.dir); zm.zoomTo(level); } }
    else if (type === 'cursor') { if (zm && d) zm.look(d.x, d.y); }
  };

  dz.begin().then((r) => {
    if (dead) { dz.end().catch(() => {}); return; }
    if (r && r.ok) off = dz.on(onEvent);
    else if (r && r.reason === 'taken') notice && notice('The zoom shortcut is used by another program. Change it in Settings > Voice & Video.');
    // a shared window (reason 'window') cannot be followed: no zoom, and no message on every share
  }).catch(() => {});

  return {
    out: () => (zm && zm.track) || track,
    stop() {
      dead = true;
      if (off) { off(); off = null; }
      active(false);
      dz.end().catch(() => {});
      if (zm) { zm.stop(); zm = null; } // the share is ending: the caller takes the video sender off the canvas itself
      zoomed = false;
    },
  };
}
