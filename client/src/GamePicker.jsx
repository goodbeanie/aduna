import React, { useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';

// Game pictures and the "Favorite games" picker in the profile editor.
//
// A game is { name, app }. app is the Steam app id: with one, the picture is Steam's cover for that game (the tall library image, then the wide header if the
// tall one does not exist); without one (Minecraft, a name someone typed) it is a lettered tile. The built-in list and the Steam search live on the server
// (server/gamecatalog.js, GET /api/games/catalog and /api/games/search); the images load straight from Steam's image servers (allowed in server/security.js).
// Older profiles hold plain names, so every helper here takes a string or an object.

const STEAM = 'https://cdn.cloudflare.steamstatic.com/steam/apps/';
export const gameName = (g) => (typeof g === 'string' ? g : g && typeof g.name === 'string' ? g.name : '');
const gameApp = (g) => (g && typeof g === 'object' && Number.isInteger(g.app) && g.app > 0 ? g.app : 0);
const hueOf = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };

// The picture for one game. Draws a lettered tile whenever there is no picture or it fails to load, so the row never shows a broken image.
export function GameIcon({ game, size = 28 }) {
  const name = gameName(game), app = gameApp(game);
  const [step, setStep] = useState(0);
  useEffect(() => { setStep(0); }, [app]);
  const src = app ? [`${STEAM}${app}/library_600x900.jpg`, `${STEAM}${app}/header.jpg`][step] : undefined;
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.42)), '--gh': hueOf(name) };
  return (
    <span className={'gicon' + (src ? '' : ' no-img')} style={style} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" draggable={false} onError={() => setStep((s) => s + 1)} /> : (Array.from(name.trim())[0] || '?').toUpperCase()}
    </span>
  );
}

let catalog = null; // the built-in list, fetched once per page load
const NAME_MAX = 40; // LIMITS.gameName in server/profile.js

export default function GamePicker({ games, max, onChange }) {
  const [list, setList] = useState(catalog || []);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState([]); // Steam's answers for what is typed
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open || catalog) return;
    api('/games/catalog').then((r) => { catalog = r.games || []; setList(catalog); }).catch(() => setNote('The game list could not load. You can still type a name.'));
  }, [open]);

  // Steam search, a moment after the typing stops. The built-in list answers instantly in the meantime.
  useEffect(() => {
    const term = q.trim();
    setFound([]);
    if (!open || term.length < 2) { setBusy(false); return undefined; }
    let live = true;
    setBusy(true);
    const timer = setTimeout(async () => {
      try { const r = await api('/games/search?q=' + encodeURIComponent(term)); if (live) setFound(r.games || []); }
      catch { /* the built-in list still works */ }
      if (live) setBusy(false);
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [q, open]);

  const have = new Set(games.map((g) => gameName(g).toLowerCase()));
  const full = games.length >= max;
  const term = q.trim().toLowerCase();

  const rows = useMemo(() => {
    if (!term) return list;
    const hits = list.filter((g) => g.name.toLowerCase().includes(term));
    hits.sort((a, b) => Number(b.name.toLowerCase().startsWith(term)) - Number(a.name.toLowerCase().startsWith(term))); // names that start with what is typed come first
    const names = new Set(hits.map((g) => g.name.toLowerCase()));
    return [...hits.slice(0, 40), ...found.filter((g) => !names.has(g.name.toLowerCase()))];
  }, [list, term, found]);

  const typed = q.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
  const canAddTyped = typed.length >= 2 && !rows.some((g) => g.name.toLowerCase() === typed.toLowerCase()) && !have.has(typed.toLowerCase());

  function add(game) {
    if (full || have.has(game.name.toLowerCase())) return;
    const next = [...games, { name: game.name, app: game.app || 0 }];
    onChange(next);
    setQ('');
    if (next.length >= max) setOpen(false);
  }
  const remove = (i) => onChange(games.filter((_, j) => j !== i));
  const close = () => { setOpen(false); setQ(''); };

  function keys(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter') { // Enter adds the first match, or the name as typed
      e.preventDefault();
      const first = rows.find((g) => !have.has(g.name.toLowerCase()));
      if (term && first) add(first); else if (canAddTyped) add({ name: typed, app: 0 });
    }
  }

  return (
    <div className="gp">
      {games.length > 0 && (
        <ul className="gp-chosen">
          {games.map((g, i) => (
            <li key={gameName(g) + i} className="gp-chip">
              <GameIcon game={g} size={24} />
              <span>{gameName(g)}</span>
              <button type="button" className="icon-btn" title="Remove this game" aria-label={`Remove ${gameName(g)}`} onClick={() => remove(i)}><Icon name="close" size={14} /></button>
            </li>
          ))}
        </ul>
      )}

      {!open && !full && <div className="social-chips"><button type="button" className="btn" onClick={() => setOpen(true)}><Icon name="plus" size={14} className="inline-icon" /> Add games</button></div>}

      {open && (
        <div className="gp-box">
          <div className="gp-search">
            <Icon name="search" size={16} />
            <input value={q} maxLength={NAME_MAX} placeholder={`Search ${list.length || 'hundreds of'} games`} aria-label="Search games" autoFocus
              autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setQ(e.target.value)} onKeyDown={keys} />
          </div>
          <ul className="gp-list" aria-label="Games">
            {canAddTyped && (
              <li><button type="button" className="gp-row" disabled={full} onClick={() => add({ name: typed, app: 0 })}>
                <GameIcon game={typed} size={32} /><span className="gp-name">Add &ldquo;{typed}&rdquo;</span><Icon name="plus" size={16} />
              </button></li>
            )}
            {rows.map((g) => {
              const on = have.has(g.name.toLowerCase());
              return (
                <li key={g.name + g.app}>
                  <button type="button" className="gp-row" disabled={on || full} aria-label={on ? `${g.name} (added)` : `Add ${g.name}`} onClick={() => add(g)}>
                    <GameIcon game={g} size={32} /><span className="gp-name">{g.name}</span><Icon name={on ? 'check' : 'plus'} size={16} />
                  </button>
                </li>
              );
            })}
          </ul>
          {term && !rows.length && !canAddTyped && !busy && <p className="gp-note muted">Nothing matches. Keep typing, or add it as you wrote it.</p>}
          {busy && <p className="gp-note muted" role="status">Searching Steam...</p>}
          {note && <p className="gp-note muted" role="status">{note}</p>}
          <div className="gp-foot"><span className="muted small">{games.length} of {max} added</span><button type="button" className="btn" onClick={close}>Done</button></div>
        </div>
      )}
      <p className="muted small hint">Up to {max} games, shown in this order on your card. Pick from the list, search any Steam game, or type your own.</p>
    </div>
  );
}
