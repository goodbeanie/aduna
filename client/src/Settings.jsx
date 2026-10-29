import React, { useEffect, useState } from 'react';
import { Icon } from './ui.jsx';
import { ProfileEditor } from './Modals.jsx';
import { AppearancePicker } from './Appearance.jsx';
import { NotificationSettings } from './Notifications.jsx';
import { VoiceSettings } from './VoiceSettings.jsx';
import { SecuritySettings } from './Security.jsx';
import { DeveloperSettings } from './Bots.jsx';
import { BadgeSettings } from './Badges.jsx';
import { ArtistSettings } from './Artist.jsx';
import { WhatsNewSettings } from './WhatsNew.jsx';
import { LanguageSettings } from './Setup.jsx';
import { useLang } from './i18n.js';
import { askConfirm } from './Dialogs.jsx';

const TABS = [['profile', 'tabProfile', 'smile'], ['appearance', 'tabAppearance', 'palette'], ['language', 'tabLanguage', 'globe'], ['notifications', 'tabNotifications', 'bell'], ['voice', 'tabVoice', 'mic'], ['security', 'tabSecurity', 'lock'], ['whatsnew', 'tabWhatsNew', 'bulb'], ['developer', 'tabDeveloper', 'code'], ['artist', 'tabArtist', 'palette']];

// Extra words the settings search also matches, so "password" finds Security and "theme" finds Appearance.
const KEYWORDS = {
  profile: 'avatar picture name bio banner frame status',
  appearance: 'theme colour color dark light font accent',
  language: 'translate locale',
  notifications: 'sound alerts mute desktop',
  voice: 'microphone mic camera audio input output',
  security: 'password two factor 2fa sessions login email',
  whatsnew: 'updates changelog release',
  developer: 'bots api token ai coder',
  artist: 'shop sell art',
  badges: 'creator shop',
};

// Full-screen settings: a section list on the left (a tab bar on phones) and the chosen section on the right.
// aiFocus: opened by the desktop app's AI Coder button/menu/notification: show Developer with the AI panel.
export function SettingsScreen({ me, initialTab = 'profile', aiFocus, onClose, onSaved, onPrefs, onLogout, getSocketId }) {
  const { t } = useLang();
  const [tab, setTab] = useState(initialTab);
  const [q, setQ] = useState('');
  const all = [...TABS, ...(me.creator ? [['badges', 'tabBadges', 'star']] : [])];
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter(([id, label]) => (t(label) + ' ' + id + ' ' + (KEYWORDS[id] || '')).toLowerCase().includes(needle)) : all;
  useEffect(() => {
    // Esc closes settings, unless something on top of it (a dialog, a confirm) wants the key first
    const h = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.overlay, .dlg-layer')) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const confirmLogout = async () => {
    if (await askConfirm({ title: 'Log out?', body: 'You will be signed out of Aduna on this device.', confirmLabel: t('logOut') })) onLogout();
  };

  return (
    <div className="settings-screen" role="dialog" aria-label="Settings">
      <nav className="settings-nav">
        <button className="icon-btn settings-navclose" onClick={onClose} aria-label={t('closeSettings')}><Icon name="close" size={20} /></button>
        <h2>{t('settings')}</h2>
        <input
          type="search"
          className="settings-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown.length) { setTab(shown[0][0]); }
            if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); }
          }}
          placeholder={t('search') === 'search' ? 'Search settings' : t('search')}
          aria-label="Search settings"
        />
        {shown.map(([id, label, icon]) => (
          <button key={id} className={'settings-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
            <Icon name={icon} size={18} /><span>{t(label)}</span>
          </button>
        ))}
        {!shown.length && <p className="muted small settings-nomatch">No settings match “{q}”.</p>}
        <div className="spacer" />
        <button className="settings-tab danger-text" onClick={confirmLogout}><span>{t('logOut')}</span></button>
      </nav>
      <main className="settings-main">
        <button className="icon-btn settings-close" onClick={onClose} aria-label={t('closeSettings')} title={t('closeEsc')}><Icon name="close" size={20} /></button>
        <div className="settings-content">
          {/* The profile editor stays mounted (just hidden) while another tab is open, so edits you have not saved yet are not lost by looking at Appearance or Security. */}
          <div style={tab === 'profile' ? undefined : { display: 'none' }}><h1>{t('tabProfile')}</h1><ProfileEditor me={me} onClose={onClose} onSaved={onSaved} onLogout={onLogout} /></div>
          {tab === 'notifications' && <><h1>{t('tabNotifications')}</h1><NotificationSettings me={me} onPrefs={onPrefs} /></>}
          {tab === 'voice' && <><h1>{t('tabVoice')}</h1><VoiceSettings /></>}
          {tab === 'security' && <><h1>{t('tabSecurity')}</h1><SecuritySettings me={me} onSaved={onSaved} getSocketId={getSocketId} /></>}
          {tab === 'whatsnew' && <><h1>{t('tabWhatsNew')}</h1><WhatsNewSettings /></>}
          {tab === 'developer' && <><h1>{t('tabDeveloper')}</h1><DeveloperSettings me={me} onSaved={onSaved} aiFocus={aiFocus} /></>}
          {tab === 'badges' && me.creator && <><h1>{t('tabBadges')}</h1><BadgeSettings /></>}
          {tab === 'artist' && <><h1>{t('tabArtist')}</h1><ArtistSettings me={me} /></>}
          {tab === 'appearance' && <><h1>{t('tabAppearance')}</h1><AppearancePicker /></>}
          {tab === 'language' && <><h1>{t('tabLanguage')}</h1><LanguageSettings me={me} onSaved={onSaved} /></>}
        </div>
      </main>
    </div>
  );
}
