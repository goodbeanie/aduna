import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api.js';
import { imageUrl } from './image.js';
import { buildPalette } from './themes.js';
import { Icon, ServerIcon } from './ui.jsx';

// App provides { servers, onJoined, onOpen } so a card in any message can join or open the server.
export const InviteContext = createContext({ servers: [], onJoined: () => {}, onOpen: () => {} });

export const INVITE_CODE_RE = /^[a-z0-9_-]{3,32}$/i;

// Colour variables for the card, generated from the server's theme (same palette builder the app uses),
// so the box is drawn in the server's colours whatever theme the reader has.
function themeVars(theme) {
  if (!theme) return undefined;
  const p = buildPalette(theme);
  const out = {};
  for (const [k, v] of Object.entries(p)) if (k.startsWith('--')) out[k] = v;
  return out;
}

const cache = new Map(); // code -> invite info, or null when the code no longer exists

// A box with the server's banner and icon in the server's theme, and a Join button.
export function InviteCard({ code }) {
  const { servers, onJoined, onOpen } = useContext(InviteContext);
  const key = String(code).toLowerCase();
  const [info, setInfo] = useState(() => cache.get(key));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api('/invites/' + encodeURIComponent(key))
      .then((r) => { cache.set(key, r.invite); if (live) setInfo(r.invite); })
      .catch((e) => { if (e.status === 404) { cache.set(key, null); if (live) setInfo(null); } });
    return () => { live = false; };
  }, [key]);

  if (info === null) {
    return <div className="invite-card dead"><div className="ic-body"><div className="ic-label">Server invite</div><div className="ic-name">Invite no longer valid</div><div className="muted small">The code was changed or the server is gone.</div></div></div>;
  }
  if (!info) return <div className="invite-card loading" aria-busy="true"><div className="ic-banner" /><div className="ic-body"><div className="ic-label">Server invite</div></div></div>;

  const member = servers.find((s) => s.id === info.serverId);
  async function join() {
    setBusy(true); setErr('');
    try {
      const { server } = await api('/servers/join', { method: 'POST', body: { code: info.code } });
      onJoined(server);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="invite-card" style={themeVars(info.theme)}>
      <div className="ic-banner" style={info.bannerImage ? { backgroundImage: `url("${imageUrl(info.bannerImage)}")` } : undefined} />
      <div className="ic-icon"><ServerIcon server={{ name: info.name, iconImage: info.iconImage }} fill /></div>
      <div className="ic-body">
        <div className="ic-label">You have been invited to join a server</div>
        <div className="ic-row">
          <div className="ic-text">
            <div className="ic-name">{info.name}</div>
            <div className="ic-meta"><Icon name="users" size={14} /> {info.memberCount} member{info.memberCount === 1 ? '' : 's'}</div>
          </div>
          {member
            ? <button className="btn ic-join" onClick={() => onOpen(member)}>Open</button>
            : <button className="btn primary ic-join" onClick={join} disabled={busy}>{busy ? 'Joining…' : 'Join'}</button>}
        </div>
        {err && <div className="error">{err}</div>}
      </div>
    </div>
  );
}
