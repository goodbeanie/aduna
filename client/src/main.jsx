import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { initTheme } from './themes.js';
import { startPhrases } from './phrases.js';
import { initKeyboard } from './keyboard.js';

initTheme();
initKeyboard();

startPhrases();
createRoot(document.getElementById('root')).render(<App />);
