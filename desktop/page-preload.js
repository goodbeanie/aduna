// Runs inside the Aduna web page (sandboxed, https only). It does three things:
//  0. Exposes window.adunaDesktop so the page can show native notifications.
//  1. Streams the page's theme colours to the title bar so the bar always matches the UI (including server themes).
//  2. Shows the update status on the right side of the server bar (.rail): checking / no update / available + Install.
const { ipcRenderer, contextBridge } = require('electron');

if (location.protocol === 'https:') {
  // ---------- 0. notifications: lets the page (client/src/notify.js) show native Windows notifications ----------
  let onClick = null;
  ipcRenderer.on('notif-click', (_e, target) => { if (onClick) onClick(String(target || '')); });
  contextBridge.exposeInMainWorld('adunaDesktop', {
    notify: (n) => ipcRenderer.send('notify', { title: String(n && n.title || ''), body: String(n && n.body || ''), tag: String(n && n.tag || ''), target: String(n && n.target || ''), sticky: !!(n && n.sticky) }),
    dismiss: (tag) => ipcRenderer.send('notify-dismiss', String(tag || '')),
    onClick: (cb) => { onClick = typeof cb === 'function' ? cb : null; return () => { onClick = null; }; },
  });

  // ---------- 1. theme sync ----------
  const KEYS = ['--bg3', '--line', '--head', '--muted', '--hover', '--danger', '--ink', '--on-ink'];
  let last = '';
  const sample = () => {
    const cs = getComputedStyle(document.documentElement);
    const vars = {};
    for (const k of KEYS) { const v = cs.getPropertyValue(k).trim(); if (v) vars[k] = v; }
    // --hover in the bar needs to read on top of --bg3 (the page's --hover is tuned for --bg), so nudge it with a mix
    if (vars['--head'] && vars['--bg3']) vars['--hover'] = 'color-mix(in srgb, ' + vars['--head'] + ' 10%, ' + vars['--bg3'] + ')';
    const s = JSON.stringify(vars);
    if (s !== last) { last = s; ipcRenderer.send('theme-vars', vars); }
  };
  // The page fades theme variables over .6s, so keep sampling for a moment after any change to follow the fade.
  let sampling = 0;
  const follow = () => {
    const until = performance.now() + 900;
    if (sampling) { sampling = until; return; }
    sampling = until;
    const tick = () => { sample(); if (performance.now() < sampling) requestAnimationFrame(tick); else sampling = 0; };
    requestAnimationFrame(tick);
  };

  // ---------- 2. update chip in the server bar ----------
  const CSS = `
  #adn-upd{margin-left:auto;flex:none;display:flex;align-items:center;gap:9px;height:36px;padding:0 6px 0 14px;border-radius:999px;background:var(--bg);border:1px solid var(--line);color:var(--muted);font:13px/1 var(--font);white-space:nowrap;opacity:0;transition:opacity .5s ease;user-select:none}
  #adn-upd.show{opacity:1}
  #adn-upd[hidden]{display:none}
  #adn-upd.noinstall{padding-right:14px}
  #adn-upd svg{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
  #adn-upd .spin{animation:adn-spin .9s linear infinite}
  #adn-upd .ok{color:var(--green,currentColor)}
  #adn-upd .warn{color:var(--gold,currentColor)}
  #adn-upd .bad{color:var(--danger,currentColor)}
  #adn-upd b{font-weight:400;color:var(--head)}
  #adn-upd button{font:inherit;height:26px;padding:0 13px;border-radius:999px;background:var(--ink);color:var(--on-ink);cursor:pointer;border:0}
  #adn-upd button:hover{background:var(--ink-h,var(--ink));filter:brightness(1.08)}
  #adn-upd .pbar{width:70px;height:4px;border-radius:2px;background:var(--line);overflow:hidden}
  #adn-upd .pbar i{display:block;height:100%;background:var(--ink);border-radius:2px;transition:width .2s}
  @keyframes adn-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){#adn-upd{transition:none}#adn-upd .spin{animation-duration:2.5s}}
  `;
  const ICONS = {
    spin: '<svg class="spin" viewBox="0 0 16 16"><path d="M13.2 8A5.2 5.2 0 1 1 11.7 4.3"/></svg>',
    ok: '<svg class="ok" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.2l2 2 3.6-4"/></svg>',
    warn: '<svg class="warn" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6v4.2"/><circle cx="8" cy="11.1" r=".5" fill="currentColor"/></svg>',
    down: '<svg class="warn" viewBox="0 0 16 16"><path d="M8 2.5v8M4.8 7.6L8 10.8l3.2-3.2M3 13.2h10"/></svg>',
    bad: '<svg class="bad" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>',
  };

  let st = { phase: 'idle' };
  let chip = null, hideTimer = 0;

  const ensureChip = () => {
    if (chip) return chip;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    chip = document.createElement('div');
    chip.id = 'adn-upd';
    chip.hidden = true;
    chip.setAttribute('role', 'status');
    chip.setAttribute('aria-live', 'polite');
    return chip;
  };
  const mount = () => {
    const rail = document.querySelector('.rail');
    if (!rail || st.phase === 'idle' && (!chip || chip.hidden)) return;
    ensureChip();
    if (chip.parentNode !== rail) rail.appendChild(chip);
  };

  const fill = (icon, html, button) => {
    chip.innerHTML = icon;
    const t = document.createElement('span');
    t.innerHTML = html;
    chip.appendChild(t);
    chip.classList.toggle('noinstall', !button);
    if (button) {
      const b = document.createElement('button');
      b.textContent = button;
      b.onclick = () => { b.disabled = true; ipcRenderer.send('upd-install'); };
      chip.appendChild(b);
    }
  };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const render = () => {
    clearTimeout(hideTimer);
    if (st.phase === 'idle') {
      if (!chip || chip.hidden) return;
      chip.classList.remove('show');                         // fade out...
      hideTimer = setTimeout(() => { if (st.phase === 'idle' && chip) chip.hidden = true; }, 600); // ...then take it out of the layout
      return;
    }
    ensureChip();
    switch (st.phase) {
      case 'checking': fill(ICONS.spin, 'Checking for update…'); break;
      case 'none': fill(ICONS.ok, 'No update available'); break;
      case 'available': fill(ICONS.down, 'Update available' + (st.version ? ' <b>' + esc(st.version) + '</b>' : ''), 'Install'); break;
      case 'downloading': {
        fill(ICONS.down, 'Downloading <b>' + Math.round(st.pct || 0) + '%</b>');
        const bar = document.createElement('div'); bar.className = 'pbar';
        const fillBar = document.createElement('i'); fillBar.style.width = Math.max(2, Math.min(100, st.pct || 0)) + '%';
        bar.appendChild(fillBar); chip.appendChild(bar); chip.classList.remove('noinstall'); chip.style.paddingRight = '14px';
        break;
      }
      case 'installing': fill(ICONS.spin, 'Installing…'); break;
      case 'error': fill(ICONS.bad, esc(st.message || 'Couldn\u2019t check for updates')); break;
      default: return;
    }
    if (st.phase !== 'downloading') chip.style.paddingRight = '';
    mount();
    if (chip.hidden) { chip.hidden = false; void chip.offsetWidth; }
    requestAnimationFrame(() => chip.classList.add('show'));
  };

  ipcRenderer.on('upd-state', (_e, s) => { st = s || { phase: 'idle' }; render(); });

  // keep the chip attached when React swaps the rail in and out (login, logout)
  let queued = false;
  const onMutate = () => {
    if (queued) return; queued = true;
    requestAnimationFrame(() => { queued = false; if (chip && !chip.hidden && chip.parentNode !== document.querySelector('.rail')) mount(); });
  };

  window.addEventListener('DOMContentLoaded', () => {
    sample();
    new MutationObserver(follow).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    new MutationObserver(onMutate).observe(document.body, { childList: true, subtree: true });
    window.addEventListener('storage', follow);
    ipcRenderer.send('upd-get');
  });
}
