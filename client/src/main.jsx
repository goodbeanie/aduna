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
import './soundboard.css';
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
import './wordle.css';
import './contexto.css';
import './events.css';
import AdminPage from './AdminPage.jsx';
import Payments from './Payments.jsx';
import { CLIPS_ENABLED } from './features.js';
// The Clips pages (feed, one clip, creator dashboard) are only loaded when Clips are switched on (features.js). While they are off nothing of them is fetched.
const Dashboard = CLIPS_ENABLED ? React.lazy(() => import('./Dashboard.jsx')) : null;
const ClipPage = CLIPS_ENABLED ? React.lazy(() => import('./ClipPage.jsx')) : null;
const ClipsSite = CLIPS_ENABLED ? React.lazy(() => import('./ClipsSite.jsx')) : null;
import './even.css'; // last on purpose: small evenness fixes that must win over every older layer
import './sidebar.css'; // after even.css: the one sidebar pass (spacing, labels, icon weight, states)
import './friends.css'; // after sidebar.css: the Friends page rows (one column, hover, quiet actions)
import './header.css'; // after friends.css: the top bar (grouped controls, one size, quiet lock chip)
import './messages.css'; // after header.css: the message area (divider contrast, speaker spacing, whole type sizes)
import './signup.css'; // the three-step sign-up (SignupFlow.jsx)
import './profile-editor.css'; // after signup.css: the Settings > My profile editor (sections, sticky preview, switches)
import './legibility.css'; // last: raises the few remaining sub-12px labels to the 12px floor (remove this line to undo)
import './checkbox.css'; // the custom checkbox look for every checkbox in the app (remove this line to get the browser's boxes back)
import './controls.css'; // after checkbox.css: the custom dropdown, date and colour pickers (Controls.jsx), sliders, scrollbars and the details arrow
import './buttons.css'; // last: text on accent-coloured buttons (Leave, etc.) follows --on-ink so it stays readable on light accents (remove this line to undo)
import './voice-channel.css'; // last: the voice channel page (tiles, soundboard card, control bar); remove this line to undo
import ErrorBoundary from './ErrorBoundary.jsx';
import { initTheme } from './themes.js';
import { startPhrases } from './phrases.js';
import { initKeyboard } from './keyboard.js';

try { document.documentElement.dataset.density = localStorage.getItem('aduna-density') === 'compact' ? 'compact' : 'cozy'; } catch { /* storage blocked: stay cozy */ }

initTheme();
initKeyboard();

startPhrases();
// /dashboard is the Clips creator page (upload clips), /admin is the admin page (admins only), /payments is the plan and purchase history, /clips is the Clips website (the feed), /clips/user/<id> is one person's Clips page,
// /clips/<clip id> is one clip on its own page; everything else is the app
const path = location.pathname;
const onDashboard = CLIPS_ENABLED && /^\/dashboard\/?$/.test(path);
const onAdmin = /^\/admin\/?$/.test(path);
const onPayments = /^\/payments\/?$/.test(path);
const onClipsFeed = CLIPS_ENABLED && /^\/clips\/?$/.test(path);
const clipsUser = CLIPS_ENABLED ? /^\/clips\/user\/([A-Za-z0-9_-]+)\/?$/.exec(path)?.[1] || null : null;
const clipId = CLIPS_ENABLED ? /^\/clips\/([A-Za-z0-9_-]+)\/?$/.exec(path)?.[1] || null : null;
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <React.Suspense fallback={null}>
      {onDashboard ? <Dashboard />
        : onAdmin ? <AdminPage />
          : onPayments ? <Payments />
            : onClipsFeed ? <ClipsSite />
              : clipsUser ? <ClipsSite userId={clipsUser} />
                : clipId ? <ClipPage id={clipId} />
                  : <App />}
    </React.Suspense>
  </ErrorBoundary>
);
