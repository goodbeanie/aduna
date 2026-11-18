import React from 'react';
import { Icon } from './ui.jsx';
import { CLIPS_ENABLED } from './features.js';

// The "Shortcuts" section (Settings > Appearance > Layout). Off until someone places it in a slot; the same actions already exist elsewhere
// in the app, this just keeps them one tap away. It lays itself out as a column on the left or right and as a row on the top or bottom (panels.css).
// Every button is drawn and the ones turned off are hidden with CSS (ITEMS.quick in panels.js says which are on to begin with).
export default function QuickPanel({ slot, onFriends, onExplore, onShop, onSettings, onQuests, onDms, onEmoji, onProfile, onAddServer }) {
  const items = [
    ['search', 'search', 'Jump to…', () => window.dispatchEvent(new Event('aduna:palette'))],
    ['dms', 'message', 'Direct messages', onDms],
    ['friends', 'users', 'Friends', onFriends],
    ['explorer', 'globe', 'Explorer', onExplore],
    ['shop', 'bag', 'Shop', onShop],
    ['quests', 'flag', 'Quests', onQuests],
    CLIPS_ENABLED && ['clips', 'video', 'Clips', () => window.location.assign('/clips')],
    ['emoji', 'smile', 'Custom emoji', onEmoji],
    ['profile', 'user', 'Your profile', onProfile],
    ['addserver', 'plus', 'Create or join a server', onAddServer],
    ['settings', 'gear', 'Settings', onSettings],
  ].filter(Boolean);
  return (
    <nav className="quick" data-ui="shortcuts" data-panel="quick" data-slot={slot} aria-label="Shortcuts">
      {items.map(([id, icon, label, run]) => (
        <button type="button" key={id} data-item={id} className="quick-btn" onClick={run}><Icon name={icon} size={18} /><span>{label}</span></button>
      ))}
    </nav>
  );
}
