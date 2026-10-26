import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

// Command palette (Ctrl+K / Cmd+K, or the search button in the user panel): type to jump to a server, channel, DM or settings section.
// It only navigates: App.jsx passes the same functions the sidebar already uses.

const SETTINGS = [
  ['profile', 'My profile', 'smile', 'name about email username avatar'],
  ['appearance', 'Appearance', 'palette', 'theme dark light colour density'],
  ['language', 'Language', 'globe', 'translate'],
  ['notifications', 'Notifications', 'bell', 'sound mute alerts'],
  ['voice', 'Voice & Video', 'mic', 'microphone camera input output'],
  ['security', 'Security', 'lock', 'password two factor sessions'],
  ['whatsnew', "What's new", 'bulb', 'updates changelog'],
  ['developer', 'Developer', 'code', 'bots api ai'],
  ['artist', 'Artist', 'palette', 'badges frames shop'],
];
const CH_ICON = { voice: 'speaker', rules: 'rules', announcements: 'megaphone' };

// 3 = starts with the query, 2 = a word starts with it, 1.5 = contains it, 1 = letters appear in order (3+ letters, names only), 0 = no match
function score(q, text, fuzzy) {
  if (!q) return 1;
  const s = text.toLowerCase();
  const i = s.indexOf(q);
  if (i === 0) return 3;
  if (i > 0) return /[\s\-_#@·]/.test(s[i - 1]) ? 2 : 1.5;
  if (!fuzzy || q.length < 3) return 0;
  let at = 0;
  for (const ch of q) { at = s.indexOf(ch, at); if (at < 0) return 0; at++; }
  return 1;
}

export function CommandPalette({ servers, users, convos, meId, onChannel, onDm, onSettings }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  const back = useRef(null); // what had focus before, so Esc puts it back

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        if (!open && document.querySelector('.overlay')) return; // another dialog is up: leave it alone
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onEvt = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('aduna:palette', onEvt);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('aduna:palette', onEvt); };
  }, [open]);

  useEffect(() => {
    if (open) { back.current = document.activeElement; setQ(''); setSel(0); setTimeout(() => input.current?.focus(), 0); }
  }, [open]);

  const close = () => { setOpen(false); const el = back.current; if (el && el.focus) setTimeout(() => el.focus(), 0); };

  const all = useMemo(() => {
    if (!open) return [];
    const out = [];
    for (const s of servers || []) {
      for (const c of s.channels || []) out.push({ key: 'c' + c.id, label: c.name, hint: s.name, icon: CH_ICON[c.type] || 'hash', kind: 'Channel', run: () => onChannel(s, c) });
    }
    // people: everyone you have a DM with first, then members of your servers (one row each, even if they share several servers)
    const seen = new Set();
    const people = [];
    for (const id of convos || []) { const u = users?.[id]; if (u && !seen.has(id)) { seen.add(id); people.push(u); } }
    for (const s of servers || []) for (const m of s.members || []) { if (m.id !== meId && !m.bot && !seen.has(m.id)) { seen.add(m.id); people.push(users?.[m.id] || m); } }
    for (const u of people) {
      if (u.id === meId) continue;
      out.push({ key: 'd' + u.id, label: u.displayName || u.username, hint: u.username ? '@' + u.username : '', icon: 'message', kind: 'Message', run: () => onDm(u) });
    }
    for (const [id, label, icon, words] of SETTINGS) out.push({ key: 's' + id, label, hint: 'Settings', icon, kind: 'Settings', words, run: () => onSettings(id) });
    return out;
  }, [open, servers, users, convos, meId, onChannel, onDm, onSettings]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    return all
      .map((it) => ({ it, s: Math.max(score(query, it.label, true), score(query, it.hint) * 0.6, it.words ? score(query, it.words) * 0.5 : 0) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((r) => r.it);
  }, [all, q]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel, results]);

  if (!open) return null;

  const go = (it) => { if (!it) return; setOpen(false); it.run(); };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => Math.min(n + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => Math.max(n - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[sel]); }
  };

  return (
    <div className="overlay cp-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal cp" role="dialog" aria-label="Jump to" onKeyDown={onKeyDown}>
        <div className="cp-field">
          <Icon name="search" size={18} />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a channel, person or setting" aria-label="Jump to" role="combobox" aria-expanded="true" aria-controls="cp-list" aria-activedescendant={results[sel] ? 'cp-' + results[sel].key : undefined} autoComplete="off" spellCheck="false" />
        </div>
        <div className="cp-list" id="cp-list" role="listbox" ref={list}>
          {results.length === 0 && <div className="cp-empty">Nothing matches “{q}”. Try a channel, a person or a setting.</div>}
          {results.map((it, i) => (
            <button key={it.key} id={'cp-' + it.key} role="option" aria-selected={i === sel} className={'cp-row' + (i === sel ? ' on' : '')} onMouseMove={() => i !== sel && setSel(i)} onClick={() => go(it)}>
              <Icon name={it.icon} size={18} />
              <span className="cp-label">{it.label}</span>
              {it.hint && <span className="cp-hint">{it.hint}</span>}
              <span className="cp-kind">{it.kind}</span>
            </button>
          ))}
        </div>
        <div className="cp-foot">↑ ↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
