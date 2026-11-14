import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from './ui.jsx';

// The command popup in the chat box. Each bot lists a prefix (default "/") and commands { name, description } in its settings; the server
// sends them with the bots installed in a server (server.bots). Typing a prefix at the start of the message lists those commands with the
// bot's name beside each, filtered as you type. Picking one only INSERTS the text ("/roll "): the bot does its own parsing, the same as
// if the person had typed it.

// Every command a person could use in this channel: from the bots installed in the server that may read it.
export function commandsFor(server, channel) {
  const out = [];
  for (const i of server?.bots || []) {
    if (!i.commands?.length) continue;
    if (Array.isArray(i.channels) && !i.channels.includes(channel.id)) continue; // the bot cannot see this channel
    const user = (server.members || []).find((m) => m.id === i.userId);
    if (!user) continue;
    for (const c of i.commands) out.push({ key: i.botId + ':' + c.name, user, botName: user.displayName || user.username, prefix: i.prefix || '/', name: c.name, description: c.description || '' });
  }
  return out;
}

const NAME_CHARS = /^[a-zA-Z0-9_-]*$/;

// commands: from commandsFor(). Returns what the composer needs to draw and drive the menu, shaped like useMentionComplete.
export function useCommandComplete({ text, setText, inputRef, commands }) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(null); // the text the person dismissed the menu for with Escape
  const after = useRef(null);

  const at = Math.min(caret, text.length);
  const before = text.slice(0, at);
  const lead = before.length - before.trimStart().length;
  const body = before.slice(lead); // only the very start of a message counts: "and/or" in the middle of a sentence is just text

  const prefixes = useMemo(() => [...new Set((commands || []).map((c) => c.prefix))].sort((a, b) => b.length - a.length), [commands]);
  let prefix = null, query = null;
  for (const p of prefixes) { // the longest prefix first, so "!!" is not read as "!" followed by "!"
    if (body.startsWith(p) && NAME_CHARS.test(body.slice(p.length))) { prefix = p; query = body.slice(p.length).toLowerCase(); break; }
  }

  const items = useMemo(() => {
    if (prefix === null) return [];
    const scored = [];
    for (const c of commands) {
      if (c.prefix !== prefix) continue;
      const n = c.name.toLowerCase();
      const score = !query ? 0 : n.startsWith(query) ? 0 : n.includes(query) ? 1 : -1;
      if (score >= 0) scored.push({ score, c });
    }
    scored.sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name) || a.c.botName.localeCompare(b.c.botName));
    return scored.map((s) => s.c);
  }, [commands, prefix, query]);

  const open = items.length > 0 && closed !== body;
  const sel = Math.min(index, Math.max(items.length - 1, 0));

  useLayoutEffect(() => { // after a pick, put the caret just behind the inserted command
    if (after.current === null) return;
    const el = inputRef.current, pos = after.current;
    after.current = null;
    if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    setCaret(pos);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(item) {
    if (!item || prefix === null) return;
    const ins = item.prefix + item.name + ' ';
    after.current = lead + ins.length;
    setText(text.slice(0, lead) + ins + text.slice(at));
    setIndex(0);
  }

  const track = (e) => setCaret(e.target.selectionStart ?? 0);

  // returns true when the key belonged to the menu
  function onKeyDown(e) {
    if (!open) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); pick(items[sel]); return true; }
    if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia?.('(pointer: coarse)').matches) {
      // a command that is already typed out in full is sent, not inserted again
      if (body.toLowerCase() === items[sel].prefix + items[sel].name.toLowerCase()) return false;
      e.preventDefault(); pick(items[sel]);
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setClosed(body); return true; }
    return false;
  }

  return { open, items, index: sel, setIndex, pick, track, onKeyDown, bind: { onSelect: track, onKeyUp: track } };
}

function Row({ it, on, onEnter, onPick }) {
  const ref = useRef(null);
  useEffect(() => { if (on) ref.current?.scrollIntoView?.({ block: 'nearest' }); }, [on]);
  return (
    <button ref={ref} role="option" aria-selected={on} className={on ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onMouseEnter={onEnter} onClick={onPick}>
      <b>{it.prefix}{it.name}</b>
      <span className="muted small cm-desc">{it.description}</span>
      <span className="cm-bot"><Avatar user={it.user} size={18} /><span className="muted small">{it.botName}</span></span>
      {on && <span className="muted small mm-key">Tab</span>}
    </button>
  );
}

export function CommandMenu({ cc }) {
  if (!cc.open) return null;
  return (
    <div className="suggest mention-menu cmd-menu" role="listbox" aria-label="Bot commands">
      {cc.items.map((it, i) => <Row key={it.key} it={it} on={i === cc.index} onEnter={() => cc.setIndex(i)} onPick={() => cc.pick(it)} />)}
    </div>
  );
}
