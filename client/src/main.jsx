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
import { initTheme } from './themes.js';
import { startPhrases } from './phrases.js';
import { initKeyboard } from './keyboard.js';

try { document.documentElement.dataset.density = localStorage.getItem('aduna-density') === 'compact' ? 'compact' : 'cozy'; } catch { /* storage blocked: stay cozy */ }

initTheme();
initKeyboard();

startPhrases();
createRoot(document.getElementById('root')).render(<App />);
