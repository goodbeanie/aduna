import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { initTheme } from './themes.js';

initTheme();

createRoot(document.getElementById('root')).render(<App />);
