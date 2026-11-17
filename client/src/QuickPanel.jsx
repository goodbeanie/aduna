import React from 'react';
import { Icon } from './ui.jsx';

// The "Shortcuts" section (Settings > Appearance > Layout). Off until someone places it in a slot; the same actions already exist elsewhere
// in the app, this just keeps them one tap away. It lays itself out as a column on the left or right and as a row on the top or bottom (panels.css).
export default function QuickPanel({ slot, onFriends, onExplore, onShop, onSettings }) {
  const items = [
    ['search', 'Jump to…', () => window.dispatchEvent(new Event('aduna:palette'))],
    ['users', 'Friends', onFriends],
    ['globe', 'Explorer', onExplore],
    ['bag', 'Shop', onShop],
    ['gear', 'Settings', onSettings],
  ];
  return (
    <nav className="quick" data-ui="shortcuts" data-panel="quick" data-slot={slot} aria-label="Shortcuts">
      {items.map(([icon, label, run]) => (
        <button type="button" key={label} className="quick-btn" onClick={run}><Icon name={icon} size={18} /><span>{label}</span></button>
      ))}
    </nav>
  );
}
