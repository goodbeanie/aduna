import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import '@fontsource-variable/inter';
import './styles.css';
import './redesign.css';
import './redesign5.css';
import './settings.css';
import './shell.css';
import './members.css';
import './chat.css';
import './voice.css';
import './forms.css';
import './density.css';
import './dialogs.css';
import './polish.css';
import './screenshare.css';
import './refine.css';
import './zen.css';
import './plain.css';
import './studio.css';
import './clips.css';
import Dashboard from './Dashboard.jsx';
import AdminPage from './AdminPage.jsx';
import ClipPage from './ClipPage.jsx';
import ClipsSite from './ClipsSite.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { initTheme } from './themes.js';
import { startPhrases } from './phrases.js';
import { initKeyboard } from './keyboard.js';

try { document.documentElement.dataset.density = localStorage.getItem('aduna-density') === 'compact' ? 'compact' : 'cozy'; } catch { /* storage blocked: stay cozy */ }

initTheme();
initKeyboard();

startPhrases();
// /dashboard is the Clips creator page (upload clips), /admin is the admin page (admins only), /clips is the Clips website (the feed), /clips/user/<id> is one person's Clips page,
// /clips/<clip id> is one clip on its own page; everything else is the app
const path = location.pathname;
const onDashboard = /^\/dashboard\/?$/.test(path);
const onAdmin = /^\/admin\/?$/.test(path);
const onClipsFeed = /^\/clips\/?$/.test(path);
const clipsUser = /^\/clips\/user\/([A-Za-z0-9_-]+)\/?$/.exec(path)?.[1] || null;
const clipId = /^\/clips\/([A-Za-z0-9_-]+)\/?$/.exec(path)?.[1] || null;
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    {onDashboard ? <Dashboard />
      : onAdmin ? <AdminPage />
        : onClipsFeed ? <ClipsSite />
          : clipsUser ? <ClipsSite userId={clipsUser} />
            : clipId ? <ClipPage id={clipId} />
              : <App />}
  </ErrorBoundary>
);
