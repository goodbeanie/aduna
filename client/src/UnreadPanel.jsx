import React from 'react';
import { Icon } from './ui.jsx';

// The "Unread" section (Settings > Appearance > Layout): everything with something new, in one list. Off until it is placed in a slot.
// `items` is [{ key, label, sub, unread, mentions, onOpen }]; App.jsx builds it from the unread and mention counts it already keeps.
// It reuses the shortcuts panel's look (.quick) so it lays out as a column on the left or right and as a scrolling row on the top or bottom.
export default function UnreadPanel({ slot, items }) {
  return (
    <aside className="quick unread-panel" data-ui="unread" data-panel="unread" data-slot={slot} aria-label="Unread">
      {items.length === 0 && <div className="quick-empty muted small"><Icon name="check" size={16} /> Nothing new</div>}
      {items.map((it) => (
        <button type="button" key={it.key} data-item={{ c: 'channels', g: 'groups', d: 'dms' }[it.key[0]]} className="quick-btn" onClick={it.onOpen} title={it.sub ? `${it.label} · ${it.sub}` : it.label}>
          <span className="quick-label">{it.label}{it.sub && <span className="muted small"> {it.sub}</span>}</span>
          {it.mentions > 0 && <span className="badge inline at">@{it.mentions}</span>}
          {it.unread > 0 && it.mentions === 0 && <span className="badge inline">{it.unread}</span>}
        </button>
      ))}
    </aside>
  );
}
