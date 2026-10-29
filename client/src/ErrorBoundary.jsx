import React from 'react';
import { t, onLang } from './i18n.js';
import './errorboundary.css';

// The safety net around the whole app. If any component throws while drawing, React would otherwise unmount everything and
// leave a blank page. This shows a plain screen with "Reload" and "Try again" instead.
// It only catches errors made while drawing; mistakes in click handlers and requests are dealt with where they happen.
export default class ErrorBoundary extends React.Component {
  state = { error: null };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    console.error('Aduna could not draw this screen:', error, info?.componentStack);
  }

  componentDidMount() { this.offLang = onLang(() => this.forceUpdate()); } // the words follow the language, with no hook in a class
  componentWillUnmount() { this.offLang?.(); }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const details = String(error?.stack || error?.message || error).slice(0, 1500);
    return (
      <div className="crash" role="alert">
        <div className="crash-card">
          <h1>{t('errTitle')}</h1>
          <p>{t('errBody')}</p>
          <div className="crash-actions">
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>{t('errReload')}</button>
            <button type="button" className="btn" onClick={() => this.setState({ error: null })}>{t('errRetry')}</button>
          </div>
          <details>
            <summary>{t('errDetails')}</summary>
            <pre>{details}</pre>
          </details>
        </div>
      </div>
    );
  }
}
