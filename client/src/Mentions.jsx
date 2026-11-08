import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Icon } from './ui.jsx';

// A mention is stored in message text as <@userId> (so it survives username and display-name changes) and typed as
// @username. The composer converts between the two, the same way it does for :custom_emoji:.
// A channel tag works the same way: stored as <#channelId> (so it survives a rename), typed as #channel-name, and drawn as a
// button that takes you to that channel. Only channels of the server you are in can be tagged and opened.
export const MENTION_TOKEN = /<@([0-9a-f]{16})>/g;
export const CHANNEL_TOKEN = /<#([0-9a-f]{16})>/g;
export const EVERYONE_RE = /(?<![\w<@])@everyone(?![\w])/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// channel id -> name for every server the person is in, so one-line previews (reply bar, pins, desktop notifications), which have no
// server at hand, can still show "#rules" instead of the raw token. App keeps it up to date.
let channelDir = new Map();
export function setChannelDirectory(servers) {
  const next = new Map();
  for (const s of servers || []) for (const c of s.channels || []) next.set(c.id, c.name);
  channelDir = next;
}

// "hi @sam" -> "hi <@a1b2c3d4e5f60718>" for every @username that belongs to someone in `people`
export function toMentionTokens(text, people) {
  if (!text.includes('@') || !people?.length) return text;
  const byName = new Map(people.map((p) => [p.username.toLowerCase(), p.id]));
  const alt = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp('(?<![\\w@<.])@(' + alt + ')(?![\\w])', 'gi');
  return text.replace(re, (_m, n) => `<@${byName.get(n.toLowerCase())}>`);
}

// the reverse, for editing: tokens of people we do not know are kept so saving does not lose them
export function fromMentionTokens(text, users) {
  return text.replace(MENTION_TOKEN, (m, id) => (users[id] ? '@' + users[id].username : m));
}

// "see #rules" -> "see <#a1b2c3d4e5f60718>" for every #name that is a channel in `channels`. Channel names are lowercase letters, digits,
// - and _, so "#rules-extra" is never read as "#rules", and a "#" glued to a word or a link ("page#top", "site.com/#top") is left alone.
export function toChannelTokens(text, channels) {
  if (!text.includes('#') || !channels?.length) return text;
  const byName = new Map(channels.map((c) => [c.name.toLowerCase(), c.id]));
  const alt = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp('(?<![\\w#<&/])#(' + alt + ')(?![\\w-])', 'gi');
  return text.replace(re, (_m, n) => `<#${byName.get(n.toLowerCase())}>`);
}

// the reverse, for editing: tokens of channels we do not know are kept so saving does not lose them
export function fromChannelTokens(text, channels) {
  if (!text.includes('<#') || !channels?.length) return text;
  const byId = new Map(channels.map((c) => [c.id, c.name]));
  return text.replace(CHANNEL_TOKEN, (m, id) => (byId.has(id) ? '#' + byId.get(id) : m));
}

// for one-line previews (reply bar, delete dialog, desktop notification)
export function mentionPreview(text, users) {
  return String(text ?? '')
    .replace(MENTION_TOKEN, (_m, id) => '@' + (users[id]?.displayName || 'unknown-user'))
    .replace(CHANNEL_TOKEN, (_m, id) => '#' + (channelDir.get(id) || 'unknown-channel'));
}

// ctx: { users, meId, onUser }
export function Mention({ id, ctx }) {
  const u = ctx?.users?.[id];
  return (
    <button type="button" className={'mention' + (ctx?.meId === id ? ' me' : '')} title={u ? '@' + u.username : 'Unknown user'}
      onClick={() => u && ctx?.onUser?.(id)}>@{u?.displayName || 'unknown-user'}</button>
  );
}

// A tagged channel. ctx.channels is { channelId: channel } for the server being read, so a tag that points somewhere else (another
// server, a deleted channel) is drawn as plain "#unknown-channel" and cannot be clicked. ctx.onChannel(id) opens the channel.
export function ChannelMention({ id, ctx }) {
  const c = ctx?.channels?.[id];
  if (!c) return <span className="mention channel gone" title="This channel is not available">#unknown-channel</span>;
  if (!ctx?.onChannel) return <span className="mention channel">#{c.name}</span>;
  return (
    <button type="button" className="mention channel" title={'Go to #' + c.name} onClick={() => ctx.onChannel(id)}>#{c.name}</button>
  );
}

export const EveryoneMention = () => <span className="mention me" title="Everyone in this server was notified">@everyone</span>;

const KIND_LABEL = { text: 'Text channel', voice: 'Voice channel', rules: 'Rules', announcements: 'Announcements', todo: 'To-do', goals: 'Goals' };

// ---------- autocomplete while typing "@sam" or "#gen" ----------
// people: [{ id, username, displayName, ... }]; everyone: offer @everyone too (server owners only);
// channels: [{ id, name, type }] of the server being written in (none in DMs and group chats, so "#" does nothing there).
// Works from the caret, not just the end of the text. Returns what the composer needs to draw and drive the menu.
export function useMentionComplete({ text, setText, inputRef, people, everyone, channels }) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [closed, setClosed] = useState(null); // start position of an "@..." or "#..." the person dismissed with Escape
  const after = useRef(null);

  const at = Math.min(caret, text.length);
  const before = text.slice(0, at);
  // "@" and "#" can never both match at the caret: neither character is allowed inside the other's name
  const mu = /(?:^|[\s(])@([a-zA-Z0-9_]{0,20})$/.exec(before);
  const mch = channels?.length ? /(?:^|[\s(])#([a-zA-Z0-9_-]{0,30})$/.exec(before) : null;
  const m = mch || mu;
  const kind = mch ? 'channel' : mu ? 'user' : null;
  const query = m ? m[1].toLowerCase() : null;
  const start = m ? at - m[1].length - 1 : -1;

  const items = useMemo(() => {
    if (query === null) return [];
    if (kind === 'channel') {
      const scored = [];
      for (const c of channels || []) {
        const n = c.name.toLowerCase();
        const score = !query ? 0 : n.startsWith(query) ? 0 : n.includes(query) ? 1 : -1;
        if (score >= 0) scored.push({ score, name: n, item: { channel: true, id: c.id, name: c.name, type: c.type || 'text' } });
      }
      scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
      return scored.slice(0, 8).map((s) => s.item);
    }
    const scored = [];
    for (const p of people || []) {
      const u = p.username.toLowerCase(), d = (p.displayName || '').toLowerCase();
      const score = !query ? 1 : u.startsWith(query) ? 0 : d.startsWith(query) ? 1 : u.includes(query) || d.includes(query) ? 2 : -1;
      if (score >= 0) scored.push({ score, name: d, item: { id: p.id, username: p.username, displayName: p.displayName || p.username, user: p } });
    }
    scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
    const list = scored.slice(0, 8).map((s) => s.item);
    if (everyone && 'everyone'.startsWith(query)) list.unshift({ everyone: true, username: 'everyone' });
    return list.slice(0, 8);
  }, [query, kind, people, channels, everyone]);

  const open = items.length > 0 && closed !== start;
  const sel = Math.min(index, Math.max(items.length - 1, 0));

  // after a pick, put the caret just behind the inserted name
  useLayoutEffect(() => {
    if (after.current === null) return;
    const el = inputRef.current, pos = after.current;
    after.current = null;
    if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    setCaret(pos);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(item) {
    if (!item || start < 0) return;
    const ins = (item.channel ? '#' + item.name : '@' + item.username) + ' ';
    after.current = start + ins.length;
    setText(text.slice(0, start) + ins + text.slice(at));
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
    if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey && !(e.key === 'Enter' && window.matchMedia?.('(pointer: coarse)').matches)) {
      e.preventDefault(); pick(items[sel]);
      return true;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setClosed(start); return true; }
    return false;
  }

  return { open, items, index: sel, setIndex, pick, track, onKeyDown, bind: { onSelect: track, onKeyUp: track } };
}

export function MentionMenu({ mc }) {
  if (!mc.open) return null;
  return (
    <div className="suggest mention-menu" role="listbox" aria-label="Mention someone or a channel">
      {mc.items.map((it, i) => (
        <button key={it.everyone ? 'everyone' : it.id} role="option" aria-selected={i === mc.index} className={i === mc.index ? 'on' : ''}
          onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => mc.setIndex(i)} onClick={() => mc.pick(it)}>
          {it.channel
            ? <><span className="mm-ico mm-hash">#</span><b>{it.name}</b><span className="muted small">{KIND_LABEL[it.type] || 'Channel'}</span></>
            : it.everyone
              ? <><span className="mm-ico"><Icon name="users" size={16} /></span><b>@everyone</b><span className="muted small">Notify everyone in this server</span></>
              : <><Avatar user={it.user} size={22} /><b>{it.displayName}</b><span className="muted small">@{it.username}</span></>}
          {i === mc.index && <span className="muted small mm-key">Tab</span>}
        </button>
      ))}
    </div>
  );
}
