import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import '@fontsource-variable/inter';
import '@fontsource/noto-color-emoji';
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
import './wordle.css';
import './puzzle.css';
import './contexto.css';
import './events.css';
import './boost.css';
import './sponsored.css';
import './recap.css';
import AdminPage from './AdminPage.jsx';
import Payments from './Payments.jsx';
import Affiliate from './Affiliate.jsx';
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
import './panels.css'; // after everything: where the server bar and the side and member lists sit (Settings > Appearance > Layout)
import './sectionopts.css'; // the Customize dialog of one part of the app (SectionOptions.jsx)
import './rail-folders.css'; // server bar folders and drag to reorder (ServerRail.jsx)
import ErrorBoundary from './ErrorBoundary.jsx';
import { initTheme, applyTheme, loadTheme, DEFAULT_CUSTOM } from './themes.js';
import { initPanels } from './panels.js';
import { initDevTheme } from './devtheme.js';
import { startPhrases } from './phrases.js';
import { initKeyboard } from './keyboard.js';

try { document.documentElement.dataset.density = localStorage.getItem('aduna-density') === 'compact' ? 'compact' : 'cozy'; } catch { /* storage blocked: stay cozy */ }

initTheme();
initPanels();
{ // the developer theme the person chose goes on top of their colours; an admin's preview link (?devthemepreview=...) shows the theme's own colours for this page only
  const previewSeed = initDevTheme();
  if (previewSeed) applyTheme({ ...loadTheme(), id: 'custom', custom: { ...DEFAULT_CUSTOM, ...previewSeed, stops: null } });
}
initKeyboard();

startPhrases();
// /admin is the admin page (admins only), /payments is the plan and purchase history, /affiliate is the affiliate program; everything else is the app
const path = location.pathname;
const onAdmin = /^\/admin\/?$/.test(path);
const onPayments = /^\/payments\/?$/.test(path);
const onAffiliate = /^\/affiliate\/?$/.test(path);
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <React.Suspense fallback={null}>
      {onAdmin ? <AdminPage />
        : onPayments ? <Payments />
          : onAffiliate ? <Affiliate />
            : <App />}
    </React.Suspense>
  </ErrorBoundary>
);
