import React from 'react';
import { imageUrl } from './image.js';
import { t } from './i18n.js';

// STATUS_LABEL[status] gives the word in the current language (a screen redraws on a language change, so it is always read fresh)
export const STATUS_LABEL = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? t('st_' + k) : undefined) });

// Shows the uploaded picture if there is one, otherwise the Aduna logo (avatarLogo) or the emoji / first letter on the avatar colour.
// `avatarPreview` is a temporary object URL used by the profile editor before saving.
export function Avatar({ user, size = 40, presence }) {
  const src = user?.avatarPreview || imageUrl(user?.avatarImage);
  const [failed, setFailed] = React.useState(null); // the src that failed to load, if any
  if (!user) return <div className="avatar" style={{ width: size, height: size, background: '#cfc5ac' }} />;
  const showImg = src && failed !== src;
  const label = user.avatarEmoji || (user.displayName || user.username || '?').slice(0, 1).toUpperCase();
  return (
    <div className="avatar-wrap" style={{ width: size, height: size }}>
      <div className="avatar" style={{ width: size, height: size, background: user.avatarColor, fontSize: size * (user.avatarEmoji ? 0.52 : 0.46) }}>
        {showImg ? <img src={src} alt="" draggable={false} onError={() => setFailed(src)} /> : user.avatarLogo ? <span className="logo-mark" aria-hidden="true" /> : label}
      </div>
      {presence && <span className={'dot ' + presence} style={{ width: Math.max(10, size * 0.3), height: Math.max(10, size * 0.3) }} />}
    </div>
  );
}

// A server's picture: its uploaded icon, or its initials. `preview` is a temporary object URL used by server settings before saving.
export function serverInitials(name) { return String(name || '?').split(/\s+/).filter(Boolean).map((w) => Array.from(w)[0]).join('').slice(0, 3).toUpperCase(); }
export function ServerIcon({ server, size = 48, fill = false, preview }) {
  const src = preview !== undefined ? preview : imageUrl(server?.iconImage);
  const [failed, setFailed] = React.useState(null);
  const showImg = src && failed !== src;
  return (
    <span className={'server-icon' + (fill ? ' fill' : '')} style={fill ? undefined : { width: size, height: size, fontSize: Math.max(10, size * 0.34) }}>
      {showImg ? <img src={src} alt="" draggable={false} onError={() => setFailed(src)} /> : serverInitials(server?.name)}
    </span>
  );
}

export function Banner({ user }) {
  const src = user.bannerPreview || imageUrl(user.bannerImage);
  return <div className="banner" style={{ backgroundColor: user.bannerColor, backgroundImage: src ? `url("${src}")` : undefined }} />;
}

const PATHS = {
  pin: <><path d="M12 21s-6-5.6-6-10a6 6 0 0112 0c0 4.4-6 10-6 10z" /><circle cx="12" cy="11" r="2.2" /></>,
  coin: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="5" /><path d="M12 9.6v4.8M10.3 11h2.7a1 1 0 010 2h-2.7" /></>,
  camera: <><path d="M4 8.5h3.2L9 6h6l1.8 2.5H20v10H4z" /><circle cx="12" cy="13.2" r="3.2" /></>,
  link: <><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  bag: <><path d="M5.5 8h13l-1 11.5h-11z" /><path d="M9 10.5V7a3 3 0 016 0v3.5" /></>,
  star: <path d="M12 4l2.4 5 5.4.7-4 3.8 1 5.4L12 16.3 7.2 18.9l1-5.4-4-3.8 5.4-.7z" />,
  leaf: <><path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14z" /><path d="M5 19l8-8" /></>,
  cup: <><path d="M5 8h11v6a4 4 0 01-4 4H9a4 4 0 01-4-4z" /><path d="M16 9.5h1.5a2.5 2.5 0 010 5H16" /><path d="M8 4.5V6M12 4.5V6" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17" /><path d="M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z" /></>,
  ball: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5c-3.2 3.2-3.2 13.8 0 17M12 3.5c3.2 3.2 3.2 13.8 0 17M3.5 12h17" /></>,
  bulb: <><path d="M9 17.5h6M10 20.5h4" /><path d="M12 3.5a5.5 5.5 0 00-3.2 10c.5.4.7.9.7 1.5h5c0-.6.2-1.1.7-1.5A5.5 5.5 0 0012 3.5z" /></>,
  speaker: <><path d="M4.5 9.5h3L12 5.5v13l-4.5-4h-3z" /><path d="M15.5 9a4.2 4.2 0 010 6M18 6.8a7.5 7.5 0 010 10.4" /></>,
  rules: <><path d="M5.5 4.5h11a2 2 0 012 2v13h-11a2 2 0 01-2-2v-11a2 2 0 012-2z" /><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4" /></>,
  bell: <><path d="M6 16.5V11a6 6 0 1112 0v5.5l1.5 1.5h-15z" /><path d="M10 20.5a2 2 0 004 0" /></>,
  megaphone: <><path d="M4 10v4h3l8 4.5v-13L7 10z" /><path d="M18.5 9.5a3.5 3.5 0 010 5M7 14l1.2 5h2.3L9.5 15" /></>,
  hash: <path d="M9 4.5L7.5 19.5M16.5 4.5L15 19.5M4.5 9h15M4 15h15" />,
  close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" /><path d="M8 10.5V8a4 4 0 018 0v2.5" /></>,
  users: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3 19c.5-3.2 3-5 6-5s5.5 1.8 6 5" /><path d="M16 5.6a3.2 3.2 0 010 5.8M18 14.4c1.8.6 2.8 2.2 3 4.6" /></>,
  message: <path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z" />,
  palette: <><path d="M12 3.5a8.5 8.5 0 000 17c1.4 0 2-.9 2-1.8 0-1.2-1-1.5-1-2.6 0-.9.7-1.6 1.6-1.6H17a3.5 3.5 0 003.5-3.5C20.5 6.7 16.7 3.5 12 3.5z" /><circle cx="7.8" cy="11.2" r=".9" /><circle cx="10.2" cy="7.6" r=".9" /><circle cx="14.6" cy="7.6" r=".9" /></>,
  smile: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14c.9 1.3 2 2 3.5 2s2.6-.7 3.5-2" /><path d="M9.2 9.6v.2M14.8 9.6v.2" /></>,
  reply: <><path d="M9.5 6L4 11.5 9.5 17" /><path d="M4 11.5h9a7 7 0 017 7" /></>,
  edit: <><path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17z" /><path d="M14.5 7.5l3 3" /></>,
  trash: <><path d="M4.5 7h15" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l.8 12.5h9.4L17.5 7" /><path d="M10 11v5M14 11v5" /></>,
  alert: <><path d="M12 4.2l9 15.6H3z" /><path d="M12 10v4.2" /><path d="M12 17.2v.1" /></>,
  shield: <path d="M12 3.5l7 2.5v5.5c0 4.3-3 7.4-7 9-4-1.6-7-4.7-7-9V6z" />,
  crown: <path d="M4 17.5L3.5 8l5 4L12 6l3.5 6 5-4-.5 9.5z" />,
  flag: <><path d="M6 20.5V4" /><path d="M6 5h11l-2 3.5 2 3.5H6" /></>,
  clip: <path d="M20 11.5l-7.8 7.8a5 5 0 01-7-7l8-8a3.4 3.4 0 014.8 4.8l-8 8a1.8 1.8 0 01-2.5-2.5l7.3-7.3" />,
  file: <><path d="M6 3.5h8l4.5 4.5v12.5H6z" /><path d="M14 3.5V8h4.5" /></>,
  download: <><path d="M12 4v11" /><path d="M7.5 10.5L12 15l4.5-4.5" /><path d="M5 19.5h14" /></>,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  pause: <><rect x="7" y="5.5" width="3.4" height="13" rx="1" /><rect x="13.6" y="5.5" width="3.4" height="13" rx="1" /></>,
  poll: <><path d="M5 20V11M12 20V4.5M19 20v-6.5" /><path d="M3.5 20.5h17" /></>,
  phone: <path d="M6.5 4h3l1.5 4-2 1.3a11 11 0 005.7 5.7L16 13l4 1.5v3a2 2 0 01-2.2 2A15.5 15.5 0 014.5 6.2 2 2 0 016.5 4z" />,
  video: <><rect x="3.5" y="6.5" width="12" height="11" rx="2.5" /><path d="M15.5 10.5l5-3v9l-5-3" /></>,
  videooff: <><rect x="3.5" y="6.5" width="12" height="11" rx="2.5" /><path d="M15.5 10.5l5-3v9l-5-3" /><path d="M4 4l16 16" /></>,
  mic: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3" /></>,
  micoff: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3" /><path d="M4 4l16 16" /></>,
  screen: <><rect x="3.5" y="5" width="17" height="11.5" rx="2" /><path d="M9 20h6M12 16.5V20" /></>,
  headphones: <><path d="M4.5 15v-3a7.5 7.5 0 0115 0v3" /><rect x="3.5" y="14" width="4" height="6.5" rx="1.8" /><rect x="16.5" y="14" width="4" height="6.5" rx="1.8" /></>,
  headphonesoff: <><path d="M4.5 15v-3a7.5 7.5 0 0115 0v3" /><rect x="3.5" y="14" width="4" height="6.5" rx="1.8" /><rect x="16.5" y="14" width="4" height="6.5" rx="1.8" /><path d="M4 4l16 16" /></>,
  signal: <path d="M5 19v-3M10 19v-6.5M15 19V9M20 19V5" />,
  back: <path d="M15 5l-7 7 7 7" />,
  send: <path d="M20.5 3.5L10 14M20.5 3.5l-6.5 17-3.5-6.5L3.5 10.5z" />,
  expand: <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />,
  shrink: <path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7" />,
  code: <><path d="M9 7l-5 5 5 5" /><path d="M15 7l5 5-5 5" /><path d="M13.5 5l-3 14" /></>,
  bot: <><rect x="5" y="8.5" width="14" height="10" rx="3" /><path d="M12 8.5V5M10 4.5h4" /><circle cx="9.3" cy="13.3" r=".9" /><circle cx="14.7" cy="13.3" r=".9" /><path d="M9.5 16h5" /></>,
  hand: <><path d="M8 12V6.5a1.5 1.5 0 013 0V11M11 10.5V5a1.5 1.5 0 013 0v5.5M14 10.5V6.5a1.5 1.5 0 013 0V13" /><path d="M8 12l-1.7-1.8a1.4 1.4 0 00-2 2L8 17c1.3 2.5 3 3.5 5 3.5 3.3 0 5-2.4 5-6" /></>,
};
export function Icon({ name, size = 18, className = '', ...rest }) {
  return (
    <svg className={'icon ' + className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {PATHS[name]}
    </svg>
  );
}

export const EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🔥', '👀', '🙏', '✅', '❌', '💯'];

export function Modal({ title, onClose, children, wide }) {
  React.useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const timeLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return 'Today at ' + t;
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return 'Yesterday at ' + t;
  return d.toLocaleDateString() + ' ' + t;
};

// Small badges next to a name: the Creator badge, and any a creator gave the person. A badge is a picture or an emoji on a colour.
export function BadgeIcons({ user, size = 16 }) {
  const list = Array.isArray(user?.badges) ? user.badges : [];
  if (!list.length) return null;
  return (
    <span className="ubadges">
      {list.map((b) => {
        const src = b.builtin ? '/badges/creator.png' : imageUrl(b.image);
        return (
          <span key={b.id} className="ubadge" title={b.name} style={{ width: size, height: size, fontSize: size * 0.7, background: src ? 'transparent' : b.color }}>
            {src ? <img src={src} alt={b.name} draggable={false} /> : b.emoji || Array.from(b.name)[0]}
          </span>
        );
      })}
    </span>
  );
}
