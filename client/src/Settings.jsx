import React, { useEffect, useState } from 'react';
import { Icon } from './ui.jsx';
import { ProfileEditor } from './Modals.jsx';
import { AppearancePicker } from './Appearance.jsx';
import { NotificationSettings } from './Notifications.jsx';
import { VoiceSettings } from './VoiceSettings.jsx';
import { SecuritySettings } from './Security.jsx';
import { DeveloperSettings } from './Bots.jsx';
import { BadgeSettings } from './Badges.jsx';
import { WhatsNewSettings } from './WhatsNew.jsx';
import { LanguageSettings } from './Setup.jsx';
import { useLang } from './i18n.js';

const TABS = [['profile', 'tabProfile', 'smile'], ['appearance', 'tabAppearance', 'palette'], ['language', 'tabLanguage', 'globe'], ['notifications', 'tabNotifications', 'bell'], ['voice', 'tabVoice', 'mic'], ['security', 'tabSecurity', 'lock'], ['whatsnew', 'tabWhatsNew', 'bulb'], ['developer', 'tabDeveloper', 'code']];

// Full-screen settings: a section list on the left (a tab bar on phones) and the chosen section on the right.
// aiFocus: opened by the desktop app's AI Coder button/menu/notification: show Developer with the AI panel.
export function SettingsScreen({ me, initialTab = 'profile', aiFocus, onClose, onSaved, onPrefs, onLogout, getSocketId }) {
  const { t } = useLang();
  const [tab, setTab] = useState(initialTab);
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className="settings-screen" role="dialog" aria-label="Settings">
      <nav className="settings-nav">
        <button className="icon-btn settings-navclose" onClick={onClose} aria-label={t('closeSettings')}><Icon name="close" size={20} /></button>
        <h2>{t('settings')}</h2>
        {[...TABS, ...(me.creator ? [['badges', 'tabBadges', 'star']] : [])].map(([id, label, icon]) => (
          <button key={id} className={'settings-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
            <Icon name={icon} size={18} /><span>{t(label)}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="settings-tab danger-text" onClick={onLogout}><span>{t('logOut')}</span></button>
      </nav>
      <main className="settings-main">
        <button className="icon-btn settings-close" onClick={onClose} aria-label={t('closeSettings')} title={t('closeEsc')}><Icon name="close" size={20} /></button>
        <div className="settings-content">
          {tab === 'profile' && <><h1>{t('tabProfile')}</h1><ProfileEditor me={me} onClose={onClose} onSaved={onSaved} onLogout={onLogout} /></>}
          {tab === 'notifications' && <><h1>{t('tabNotifications')}</h1><NotificationSettings me={me} onPrefs={onPrefs} /></>}
          {tab === 'voice' && <><h1>{t('tabVoice')}</h1><VoiceSettings /></>}
          {tab === 'security' && <><h1>{t('tabSecurity')}</h1><SecuritySettings me={me} onSaved={onSaved} getSocketId={getSocketId} /></>}
          {tab === 'whatsnew' && <><h1>{t('tabWhatsNew')}</h1><WhatsNewSettings /></>}
          {tab === 'developer' && <><h1>{t('tabDeveloper')}</h1><DeveloperSettings me={me} onSaved={onSaved} aiFocus={aiFocus} /></>}
          {tab === 'badges' && me.creator && <><h1>{t('tabBadges')}</h1><BadgeSettings /></>}
          {tab === 'appearance' && <><h1>{t('tabAppearance')}</h1><AppearancePicker /></>}
          {tab === 'language' && <><h1>{t('tabLanguage')}</h1><LanguageSettings me={me} onSaved={onSaved} /></>}
        </div>
      </main>
    </div>
  );
}
