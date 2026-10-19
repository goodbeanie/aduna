import React, { useEffect, useState } from 'react';
import { Icon } from './ui.jsx';
import { ProfileEditor } from './Modals.jsx';
import { AppearancePicker } from './Appearance.jsx';
import { NotificationSettings } from './Notifications.jsx';
import { SecuritySettings } from './Security.jsx';

const TABS = [['profile', 'My profile', 'smile'], ['appearance', 'Appearance', 'palette'], ['notifications', 'Notifications', 'bell'], ['security', 'Security', 'lock']];

// Full-screen settings: a section list on the left (a tab bar on phones) and the chosen section on the right.
export function SettingsScreen({ me, initialTab = 'profile', onClose, onSaved, onPrefs, onLogout, getSocketId }) {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="settings-screen" role="dialog" aria-label="Settings">
      <nav className="settings-nav">
        <button className="icon-btn settings-navclose" onClick={onClose} aria-label="Close settings"><Icon name="close" size={20} /></button>
        <h2>Settings</h2>
        {TABS.map(([id, label, icon]) => (
          <button key={id} className={'settings-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
            <Icon name={icon} size={18} /><span>{label}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="settings-tab danger-text" onClick={onLogout}><span>Log out</span></button>
      </nav>
      <main className="settings-main">
        <button className="icon-btn settings-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)"><Icon name="close" size={20} /></button>
        <div className="settings-content">
          {tab === 'profile' && <><h1>My profile</h1><ProfileEditor me={me} onClose={onClose} onSaved={onSaved} onLogout={onLogout} /></>}
          {tab === 'notifications' && <><h1>Notifications</h1><NotificationSettings me={me} onPrefs={onPrefs} /></>}
          {tab === 'security' && <><h1>Security</h1><SecuritySettings getSocketId={getSocketId} /></>}
          {tab === 'appearance' && <><h1>Appearance</h1><AppearancePicker /></>}
        </div>
      </main>
    </div>
  );
}
