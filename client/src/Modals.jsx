import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar, BadgeIcons, Banner, Icon, Modal, PlusBadge, STATUS_LABEL, useCardTheme } from './ui.jsx';
import { useProfileThemes, loadProfileThemes, themeGradient, lightness, CUSTOM_THEME_ID } from './profilethemes.js';
import { nameProps, NAME_FONTS, MAX_NAME_STOPS, DEFAULT_NAME_GRADIENT, nameGradientCss } from './namestyle.js';
import { uploadImage, checkImageFile, ACCEPT_ATTR, AVATAR_SIZE, BANNER_SIZE } from './image.js';
import Cropper from './Cropper.jsx';
import { safetyNumber } from './crypto.js';
import { inviteLink, codeFromInput } from './Invite.jsx';
import { BotTag } from './Bots.jsx';
import { useLang } from './i18n.js';
import { PlayingLine } from './Activity.jsx';

export function ServerModal({ onClose, onDone }) {
  const [tab, setTab] = useState('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const fieldRef = useRef(null);

  async function go(e) {
    e.preventDefault();
    setErr('');
    try {
      const { server } = tab === 'create'
        ? await api('/servers', { method: 'POST', body: { name } })
        : await api('/servers/join', { method: 'POST', body: { code: codeFromInput(code) } });
      onDone(server);
    } catch (e2) { setErr(e2.message); setTimeout(() => fieldRef.current?.focus(), 0); }
  }
  const switchTab = (t) => { setTab(t); setErr(''); };

  return (
    <Modal title={tab === 'create' ? 'Create a server' : 'Join a server'} onClose={onClose}>
      <div className="tabs">
        <button type="button" className={tab === 'create' ? 'on' : ''} onClick={() => switchTab('create')}>Create</button>
        <button type="button" className={tab === 'join' ? 'on' : ''} onClick={() => switchTab('join')}>Join with invite</button>
      </div>
      <form onSubmit={go}>
        {tab === 'create' ? (<><label htmlFor="srv-name">SERVER NAME</label><input id="srv-name" ref={fieldRef} autoFocus value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} maxLength={40} required placeholder="My awesome server" aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'srv-err' : undefined} /></>)
          : (<><label htmlFor="srv-code">INVITE LINK OR CODE</label><input id="srv-code" ref={fieldRef} autoFocus value={code} onChange={(e) => { setCode(e.target.value); setErr(''); }} required placeholder="aduna.onrender.com/invite/aduna" aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'srv-err' : undefined} /></>)}
        {err && <p className="error-text field-error" id="srv-err" role="alert">{err}</p>}
        <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{tab === 'create' ? 'Create' : 'Join'}</button></div>
      </form>
    </Modal>
  );
}

export function CategoryModal({ server, onClose, onDone }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const fieldRef = useRef(null);
  async function go(e) {
    e.preventDefault();
    setErr('');
    try { const { server: s } = await api(`/servers/${server.id}/categories`, { method: 'POST', body: { name } }); onDone(s); }
    catch (e2) { setErr(e2.message); setTimeout(() => fieldRef.current?.focus(), 0); }
  }
  return (
    <Modal title="Add category" onClose={onClose}>
      <form onSubmit={go}>
        <label htmlFor="cat-name">CATEGORY NAME</label>
        <input id="cat-name" ref={fieldRef} autoFocus value={name} onChange={(e) => { setName(e.target.value); setErr(''); }} placeholder="New category" maxLength={30} required aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'cat-err' : undefined} />
        {err && <p className="error-text field-error" id="cat-err" role="alert">{err}</p>}
        <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Add category</button></div>
      </form>
    </Modal>
  );
}

const PRESETS = [
  { type: 'text', icon: 'hash', title: 'Text', desc: 'Chat with messages, files and GIFs', name: '' },
  { type: 'voice', icon: 'speaker', title: 'Voice', desc: 'Hang out and talk, up to 8 people', name: 'voice' },
  { type: 'rules', icon: 'rules', title: 'Rules', desc: 'A list of server rules you build with +', name: 'rules' },
  { type: 'announcements', icon: 'megaphone', title: 'Announcements', desc: 'Notifies everyone; only the owner can post', name: 'announcements' },
];
export function ChannelModal({ server, category, onClose, onDone }) {
  const [type, setType] = useState('text');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false); // once you type a name, picking a preset stops overwriting it
  const [err, setErr] = useState('');
  const fieldRef = useRef(null);
  const pick = (p) => { setType(p.type); if (!touched) setName(p.name); };
  async function go(e) {
    e.preventDefault();
    setErr('');
    try { const { server: s } = await api(`/servers/${server.id}/channels`, { method: 'POST', body: { name, type, categoryId: category?.id } }); onDone(s); }
    catch (e2) { setErr(e2.message); setTimeout(() => fieldRef.current?.focus(), 0); }
  }
  return (
    <Modal title={category ? `Create channel in ${category.name}` : 'Create channel'} onClose={onClose}>
      <form onSubmit={go}>
        <label>CHANNEL TYPE</label>
        <div className="presets" role="radiogroup" aria-label="Channel type">
          {PRESETS.map((p) => (
            <button type="button" key={p.type} role="radio" aria-checked={type === p.type} className={'preset' + (type === p.type ? ' on' : '')} onClick={() => pick(p)}>
              <span className="preset-icon"><Icon name={p.icon} size={22} /></span>
              <span className="preset-text"><b>{p.title}</b><span className="muted small">{p.desc}</span></span>
            </button>
          ))}
        </div>
        <label htmlFor="chan-name">CHANNEL NAME</label>
        <input id="chan-name" ref={fieldRef} autoFocus value={name} onChange={(e) => { setName(e.target.value); setTouched(true); setErr(''); }} placeholder="new-channel" maxLength={30} required aria-invalid={err ? 'true' : undefined} aria-describedby={err ? 'chan-err' : undefined} />
        {err && <p className="error-text field-error" id="chan-err" role="alert">{err}</p>}
        <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Create</button></div>
      </form>
    </Modal>
  );
}

// The code, then a direct invite section: pick friends and each gets a DM with an invite card.
export function InviteModal({ server, friends, isOwner, onSend, onClose }) {
  const [copied, setCopied] = useState(false);
  const [q, setQ] = useState('');
  const [state, setState] = useState({}); // friendId -> 'sending' | 'sent' | error text
  const list = friends.filter((u) => (u.username + ' ' + u.displayName).toLowerCase().includes(q.trim().toLowerCase()));
  async function send(u) {
    setState((p) => ({ ...p, [u.id]: 'sending' }));
    try { await onSend(u, inviteLink(server.inviteCode)); setState((p) => ({ ...p, [u.id]: 'sent' })); }
    catch (e) { setState((p) => ({ ...p, [u.id]: e.message || 'Failed' })); }
  }
  return (
    <Modal title={`Invite people to ${server.name}`} onClose={onClose}>
      <label>INVITE LINK</label>
      <div className="invite">
        <code className="invite-url">{inviteLink(server.inviteCode)}</code>
        <button className="btn primary" onClick={() => { navigator.clipboard?.writeText(inviteLink(server.inviteCode)); setCopied(true); }}>{copied ? 'Copied!' : 'Copy'}</button>
      </div>
      <p className="muted small hint">Paste the link in any chat and it turns into a join box. Anyone who opens it can join.{isOwner ? ' You can set your own link ending in Server settings.' : ''}</p>

      <label>DIRECT INVITE</label>
      {friends.length === 0 ? <p className="muted">Add friends to send them an invite directly.</p> : (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your friends…" />
          <div className="results">
            {list.map((u) => {
              const st = state[u.id];
              const already = server.members.some((m) => m.id === u.id);
              return (
                <div key={u.id} className="result invite-friend">
                  <Avatar user={u} size={32} />
                  <div className="grow"><b>{u.displayName}</b><span className="muted"> @{u.username}</span>{st && st !== 'sending' && st !== 'sent' && <div className="error-text small">{st}</div>}</div>
                  {already
                    ? <span className="muted small">Member</span>
                    : <button className={'btn small-btn' + (st === 'sent' ? '' : ' primary')} disabled={st === 'sending' || st === 'sent'} onClick={() => send(u)}>{st === 'sent' ? 'Sent' : st === 'sending' ? 'Sending…' : 'Invite'}</button>}
                </div>
              );
            })}
            {list.length === 0 && <p className="muted">No friends match.</p>}
          </div>
        </>
      )}
    </Modal>
  );
}

export function NewDmModal({ friends, onClose, onPick }) {
  const [q, setQ] = useState('');
  const list = friends.filter((u) => (u.username + ' ' + u.displayName).toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal title="Start a conversation" onClose={onClose}>
      {friends.length === 0 ? <p className="muted">You can message friends. Add one from the Friends page first.</p> : (
        <>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your friends…" />
          <div className="results">
            {list.map((u) => (
              <button key={u.id} className="result" onClick={() => onPick(u)}>
                <Avatar user={u} size={32} /><div><b>{u.displayName}</b><span className="muted"> @{u.username}</span></div>
              </button>
            ))}
            {list.length === 0 && <p className="muted">No friends match.</p>}
          </div>
        </>
      )}
    </Modal>
  );
}

// Asks before removing a member (opened from the right-click menu). The server checks the rank rules again, so a refusal is shown here.
export function KickModal({ server, user, onClose, onDone }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function kick() {
    setBusy(true); setErr('');
    try { const r = await api(`/servers/${server.id}/members/${user.id}/kick`, { method: 'POST' }); onDone(r.server); }
    catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Kick member" onClose={onClose}>
      <p className="muted">Remove <b>{user.displayName}</b> from {server.name}? They can join again with the invite link{server.visibility === 'private' ? ', unless the server is private and you do not add them back to its list' : ''}.</p>
      {err && <div className="error">{err}</div>}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary danger-fill" autoFocus disabled={busy} onClick={kick}>Kick</button>
      </div>
    </Modal>
  );
}

export function ProfileLinks({ links }) {
  const safe = (links || []).filter((l) => /^https?:\/\//i.test(l.url));
  if (!safe.length) return null;
  return (
    <>
      <h4>LINKS</h4>
      <div className="plinks">
        {safe.map((l, i) => (
          <a key={i} className="plink" href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc" title={l.url}>
            <Icon name="link" size={14} /><span>{l.label}</span>
          </a>
        ))}
      </div>
    </>
  );
}

export function UserCard({ user, presence, relation, onClose, onMessage, onEdit, onAddFriend, onAccept }) {
  const th = useCardTheme(user);
  if (!user) return null;
  return (
    <Modal title="Profile" bare onClose={onClose}>
      <div className={'card' + th.className} style={{ '--accent': user.accentColor, ...th.style }}>
        <Banner user={user} />
        <div className="card-avatar"><Avatar user={user} size={80} presence={presence} /></div>
        {user.plus && <PlusBadge />}
        <div className="card-body">
          <h3><span {...nameProps(user)}>{user.displayName}</span>{user.bot && <> <BotTag /></>} <BadgeIcons user={user} size={20} /></h3>
          <div className="muted">{user.bot ? 'A bot. It only reads and answers in the channels it was added to.' : `@${user.username} · ${STATUS_LABEL[presence || 'offline']}`}</div>
          {user.bio && (<><h4>ABOUT ME</h4><p className="bio">{user.bio}</p></>)}
          {/* the game they are playing right now; the server only sends it when they are online and have it switched on */}
          {!user.bot && <PlayingLine activity={user.activity} />}
          <ProfileLinks links={user.links} />
          {/* a Clips creator who switched their page link on (Clips dashboard) shows it here */}
          {!user.bot && typeof user.clipsPage === 'string' && user.clipsPage.startsWith('/clips/user/') && (
            <>
              <h4>CLIPS</h4>
              <div className="plinks">
                <a className="plink" href={user.clipsPage} target="_blank" rel="noopener noreferrer"><Icon name="link" size={14} /><span>Clips page</span></a>
              </div>
            </>
          )}
          <h4>MEMBER SINCE</h4>
          <p>{new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          {relation === 'self' && <button className="btn primary full" onClick={onEdit}>Edit profile</button>}
          {!user.bot && relation === 'friend' && <button className="btn primary full" onClick={onMessage}><Icon name="lock" size={16} className="inline-icon" /> Send encrypted message</button>}
          {!user.bot && relation === 'none' && <button className="btn primary full" onClick={onAddFriend}>Add friend</button>}
          {!user.bot && relation === 'outgoing' && <button className="btn full" disabled>Friend request sent</button>}
          {!user.bot && relation === 'incoming' && <button className="btn primary full" onClick={onAccept}>Accept friend request</button>}
        </div>
      </div>
    </Modal>
  );
}

const COLORS = ['#2a251e', '#8c6b4f', '#b4553d', '#5f7a55', '#a67c1f', '#4b6a88', '#7a5a7d', '#c4707a'];
const BANNER_COLORS = ['#e3dccb', '#d9cdb4', '#cfc0a0', '#c9d5c0', '#c7d3df', '#e0c8c2', '#d8cde0', '#2a251e'];
const SOCIALS = ['X / Twitter', 'Instagram', 'YouTube', 'GitHub', 'Twitch', 'TikTok'];
const USERNAME_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // keep in sync with the server
const MAX_LINKS = 5;
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

// One group of fields in the profile editor: a heading, one line saying what it is for, then the fields.
function EdHead({ id, title, note }) {
  return (
    <div className="ed-head">
      <h2 id={id}>{title}</h2>
      {note && <p>{note}</p>}
    </div>
  );
}

// "Shown" / "Hidden" switch for a badge: the state is written out, not only coloured.
function Switch({ on, label, onChange }) {
  return (
    <span className="sw-wrap">
      <span className="sw-text" aria-hidden="true">{on ? 'Shown' : 'Hidden'}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className={'sw' + (on ? ' on' : '')} onClick={onChange}><i /></button>
    </span>
  );
}

function ColorRow({ label, value, onChange, colors = COLORS }) {
  const custom = !colors.includes(value); // the colour is not one of the presets: the picker at the end is the selected one
  return (
    <div className="color-row">
      <label>{label}</label>
      <div className="swatches" role="radiogroup" aria-label={label}>
        {colors.map((c) => <button type="button" role="radio" aria-checked={c === value} key={c} className={'swatch' + (c === value ? ' on' : '')} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />)}
        <span className={'swatch-custom' + (custom ? ' on' : '')} style={custom ? { '--cc': value } : undefined} title="Pick any colour">
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label + ': custom colour'} />
        </span>
      </div>
    </div>
  );
}

export function ProfileEditor({ me, onClose, onSaved, onLogout }) {
  const { t } = useLang();
  const [f, setF] = useState({
    displayName: me.displayName, username: me.username, email: me.email || '', bio: me.bio, avatarEmoji: me.avatarEmoji, avatarColor: me.avatarColor,
    bannerColor: me.bannerColor, accentColor: me.accentColor, status: me.status,
    links: (me.links || []).map((l) => ({ ...l })),
  });
  // What the profile picture shows: the first letter, the Aduna logo, or an uploaded image.
  const [mode, setMode] = useState(me.avatarImage ? 'image' : me.avatarLogo ? 'logo' : 'letter');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));

  // Name style: a font and an optional gradient for the display name. Both are free and saved with "Save changes".
  const [nameFont, setNameFont] = useState(me.nameFont || 'aduna');
  const [gradOn, setGradOn] = useState(!!me.nameGradient);
  const [nameG, setNameG] = useState(() => (me.nameGradient ? { colors: [...me.nameGradient.colors], angle: me.nameGradient.angle } : { ...DEFAULT_NAME_GRADIENT, colors: [...DEFAULT_NAME_GRADIENT.colors] }));
  const setNameStop = (i, c) => setNameG((g) => ({ ...g, colors: g.colors.map((x, j) => (j === i ? c : x)) }));
  const addNameStop = () => setNameG((g) => (g.colors.length >= MAX_NAME_STOPS ? g : { ...g, colors: [...g.colors, g.colors[g.colors.length - 1]] }));
  const removeNameStop = (i) => setNameG((g) => (g.colors.length <= 2 ? g : { ...g, colors: g.colors.filter((_, j) => j !== i) }));

  // Gradient profile themes: all free. The choice is saved with "Save changes". Pick a preset, or design your own with Custom.
  // (Animated presets are added on the server later; they will show up in this same list, tagged "Animated".)
  const ptList = useProfileThemes();
  const [theme, setTheme] = useState(me.profileTheme || null);
  const [customG, setCustomG] = useState(() => (me.profileGradient && Array.isArray(me.profileGradient.colors) ? me.profileGradient : { colors: ['#ff9a8b', '#6a88ff'], angle: 135 })); // the person's own gradient
  const setStop = (i, c) => setCustomG((g) => ({ ...g, colors: g.colors.map((x, j) => (j === i ? c : x)) }));
  const addStop = () => setCustomG((g) => (g.colors.length >= 4 ? g : { ...g, colors: [...g.colors, g.colors[g.colors.length - 1]] }));
  const removeStop = (i) => setCustomG((g) => (g.colors.length <= 2 ? g : { ...g, colors: g.colors.filter((_, j) => j !== i) }));
  useEffect(() => { loadProfileThemes(true); }, []);

  // Badges: everything the person owns, each worn or taken off. Saved with the rest of the profile; the preview card follows the toggles.
  const ownedBadges = Array.isArray(me.ownedBadges) ? me.ownedBadges : [];
  const [hidden, setHidden] = useState(() => new Set(ownedBadges.filter((b) => b.worn === false).map((b) => b.id)));
  const toggleBadge = (id) => setHidden((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Frames: the rings around the profile picture that the person owns; one is worn at a time ('' = none).
  const ownedFrames = Array.isArray(me.ownedFrames) ? me.ownedFrames : [];
  const [frameId, setFrameId] = useState(() => (ownedFrames.find((x) => x.worn) || {}).id || '');

  // Username can be changed once every 7 days (the server enforces this; this just explains it).
  const unlockAt = me.usernameChangedAt ? me.usernameChangedAt + USERNAME_COOLDOWN_MS : 0;
  const locked = unlockAt > Date.now();
  const renaming = !locked && f.username.trim().replace(/^@/, '') !== me.username;

  // Picture changes are staged until "Save changes": undefined = unchanged, null = remove,
  // { blob, url } = new (already resized) image with a temporary preview URL.
  const [staged, setStaged] = useState({ avatar: undefined, banner: undefined });
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const avatarInput = useRef(null);
  const bannerInput = useRef(null);
  useEffect(() => () => { for (const s of Object.values(stagedRef.current)) if (s) URL.revokeObjectURL(s.url); }, []);

  function stage(kind, value) {
    setStaged((s) => { if (s[kind]) URL.revokeObjectURL(s[kind].url); return { ...s, [kind]: value }; });
  }
  const [cropping, setCropping] = useState(null); // { kind, file }: a picture just chosen, waiting for the person to crop and position it
  async function pick(kind, e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    setErr('');
    try { checkImageFile(file); setCropping({ kind, file }); }
    catch (ex) { setErr(ex.message); }
  }
  function applyCrop(blob) {
    const { kind } = cropping;
    stage(kind, { blob, url: URL.createObjectURL(blob) });
    if (kind === 'avatar') setMode('image');
    setCropping(null);
  }
  const hasAvatarImage = staged.avatar === undefined ? !!me.avatarImage : staged.avatar !== null;
  const hasBanner = staged.banner === undefined ? !!me.bannerImage : staged.banner !== null;
  const removeBanner = () => stage('banner', me.bannerImage ? null : undefined); // drop a staged upload, or remove the saved one

  function chooseMode(m) {
    setErr('');
    if (m === 'image') {
      if (hasAvatarImage) setMode('image'); else avatarInput.current.click(); // nothing to show yet: pick a file
      return;
    }
    setMode(m);
    if (m === 'letter') set('avatarEmoji')('');
  }

  const setLink = (i, k, v) => setF((s) => ({ ...s, links: s.links.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const addLink = (label = '') => setF((s) => (s.links.length >= MAX_LINKS ? s : { ...s, links: [...s.links, { label, url: '' }] }));
  const removeLink = (i) => setF((s) => ({ ...s, links: s.links.filter((_, j) => j !== i) }));

  // Unsaved changes: compare everything the form holds with how it looked when it opened. Save stays off until something changed.
  const snapshot = JSON.stringify([f, mode, nameFont, gradOn, gradOn ? nameG : null, theme, theme === CUSTOM_THEME_ID ? customG : null, [...hidden].sort(), frameId,
    staged.avatar === undefined ? 0 : staged.avatar === null ? 'x' : staged.avatar.url, staged.banner === undefined ? 0 : staged.banner === null ? 'x' : staged.banner.url]);
  const openSnapshot = useRef(null);
  if (openSnapshot.current === null) openSnapshot.current = snapshot;
  const dirty = snapshot !== openSnapshot.current;

  // The font tiles and the small name bar show your name on a surface that contrasts with its own colour, so a dark name on the dark app (or a pale one on a light app) can still be read.
  const sampleStops = (gradOn ? nameG.colors : [f.accentColor]).filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const sampleLight = sampleStops.length ? sampleStops.reduce((s, c) => s + lightness(c), 0) / sampleStops.length > 0.45 : false;
  const nameSurface = sampleLight ? '#2b2620' : '#f6f2e9';

  const preview = {
    ...me, ...f,
    badges: ownedBadges.length ? ownedBadges.filter((b) => !hidden.has(b.id)) : me.badges, // the card shows only the badges that are on
    username: me.username,
    frame: null, framePreview: frameId ? imageUrl((ownedFrames.find((x) => x.id === frameId) || {}).image) : null, // the card shows the frame that is chosen
    profileTheme: theme,
    nameFont: nameFont === 'aduna' ? null : nameFont,
    nameGradient: gradOn ? nameG : null,
    profileGradient: theme === CUSTOM_THEME_ID ? customG : null,
    avatarLogo: mode === 'logo',
    avatarEmoji: mode === 'letter' ? f.avatarEmoji : '',
    avatarImage: mode === 'image' && staged.avatar !== null ? me.avatarImage : null,
    avatarPreview: mode === 'image' ? staged.avatar?.url : undefined,
    bannerImage: staged.banner === null ? null : me.bannerImage, bannerPreview: staged.banner?.url,
  };
  const cardTheme = useCardTheme(preview);

  async function save() {
    setSaving(true);
    setErr('');
    try {
      const body = { ...f, avatarLogo: mode === 'logo', profileTheme: theme, links: f.links.filter((l) => l.url.trim()), nameFont: nameFont === 'aduna' ? null : nameFont, nameGradient: gradOn ? nameG : null };
      if (theme === CUSTOM_THEME_ID) body.profileGradient = customG;
      if (renaming) body.username = f.username.trim().replace(/^@/, ''); else delete body.username;
      if (ownedBadges.length) body.hiddenBadges = [...hidden];
      if (ownedFrames.length) body.frame = frameId || null;
      let { user } = await api('/me', { method: 'PATCH', body });
      // Choosing the letter or the logo drops any saved picture; choosing "image" applies the staged upload.
      const avatarChange = mode === 'image' ? staged.avatar : (me.avatarImage ? null : undefined);
      const changes = { avatar: avatarChange, banner: staged.banner };
      for (const kind of ['avatar', 'banner']) {
        const s = changes[kind];
        if (s === undefined) continue;
        ({ user } = s === null ? await api('/me/' + kind, { method: 'DELETE' }) : await uploadImage(kind, s.blob));
      }
      onSaved(user);
      onClose();
    } catch (ex) { setErr(ex.message); setSaving(false); }
  }

  return (
    <div className="settings-pane">
      <div className="editor">
        <div className="editor-form">
          {/* narrow screens: the card preview sits below the fields, so a small bar stays on top and shows the name as you style it */}
          <div className="ed-mini" aria-hidden="true">
            <Avatar user={preview} size={32} presence={f.status === 'invisible' ? 'offline' : f.status} />
            <span className="ed-mini-name" style={{ background: nameSurface }}><span {...nameProps(preview)}>{preview.displayName || me.username}</span></span>
            <BadgeIcons user={preview} size={16} />
          </div>

          <section className="ed-sec" aria-labelledby="pe-account">
          <EdHead id="pe-account" title="Account" note="Your display name and username are public. Your email is private." />
          <label htmlFor="pe-name">{t('displayName')}</label>
          <input id="pe-name" value={f.displayName} maxLength={32} onChange={(e) => set('displayName')(e.target.value)} />

          <label htmlFor="pe-email">{t('email')}</label>
          <input id="pe-email" type="email" value={f.email} maxLength={254} autoComplete="email" placeholder="you@example.com" onChange={(e) => set('email')(e.target.value)} />
          <p className="muted small hint">{t('emailPrivate')}</p>

          <label htmlFor="pe-user">{t('username')}</label>
          <div className="at-input">
            <span>@</span>
            <input id="pe-user" value={f.username} maxLength={20} disabled={locked} autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onChange={(e) => set('username')(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
          </div>
          <p className="muted small hint">
            {locked
              ? t('usernameLocked', { date: fmtDate(unlockAt) })
              : renaming
                ? t('usernameHeadsUp')
                : t('usernameRule')}
          </p>

          </section>

          <section className="ed-sec" aria-labelledby="pe-about">
          <EdHead id="pe-about" title="About you" note="Shown on your profile card." />
          <label htmlFor="pe-bio">{t('aboutMe')}</label>
          <textarea id="pe-bio" rows={3} maxLength={190} value={f.bio} onChange={(e) => set('bio')(e.target.value)} />
          <p className="hint ed-count" aria-live="off">{f.bio.length} / 190</p>

          <label>{t('links')}</label>
          <div className="links-edit">
            {f.links.map((l, i) => (
              <div className="link-row" key={i}>
                <input className="link-label" value={l.label} maxLength={24} placeholder={t('linkLabel')} aria-label={t('linkLabelAria')} onChange={(e) => setLink(i, 'label', e.target.value)} />
                <input className="link-url" value={l.url} maxLength={200} placeholder="instagram.com/you" aria-label={t('linkAddr')} inputMode="url" autoCapitalize="none" onChange={(e) => setLink(i, 'url', e.target.value)} />
                <button type="button" className="icon-btn" title={t('removeLink')} aria-label={t('removeLink')} onClick={() => removeLink(i)}><Icon name="close" size={16} /></button>
              </div>
            ))}
            {f.links.length < MAX_LINKS && (
              <div className="social-chips">
                <button type="button" className="btn" onClick={() => addLink()}><Icon name="plus" size={14} className="inline-icon" /> {t('addLink')}</button>
                {SOCIALS.map((n) => <button type="button" key={n} className="soc-chip" onClick={() => addLink(n)}>{n}</button>)}
              </div>
            )}
            <p className="muted small hint">{t('linksHint', { n: MAX_LINKS })}</p>
          </div>

          </section>

          <section className="ed-sec" aria-labelledby="pe-look">
          <EdHead id="pe-look" title="Picture and banner" note="You can also click either one in the preview to upload an image." />
          <label id="pe-pic-label">{t('profilePicture')}</label>
          <div className="mode-pick" role="radiogroup" aria-label={t('picStyle')}>
            {[['letter', t('picLetter')], ['logo', t('picLogo')], ['image', t('picImage')]].map(([k, label]) => (
              <button type="button" role="radio" aria-checked={mode === k} key={k} className={mode === k ? 'on' : ''} onClick={() => chooseMode(k)}>{label}</button>
            ))}
          </div>
          <input ref={avatarInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick('avatar', e)} />
          {mode === 'image' && <div className="upload-row"><button type="button" className="btn" onClick={() => avatarInput.current.click()}><Icon name="camera" size={14} className="inline-icon" /> Replace picture</button></div>}
          {mode !== 'image' && <ColorRow label={t('avatarColor')} value={f.avatarColor} onChange={set('avatarColor')} />}

          <label id="pe-banner-label">{t('banner')}</label>
          <ColorRow label={t('bannerColor')} value={f.bannerColor} onChange={set('bannerColor')} colors={BANNER_COLORS} />
          <div className="upload-row">
            <button type="button" className="btn" onClick={() => bannerInput.current.click()}><Icon name="camera" size={14} className="inline-icon" /> {hasBanner ? 'Replace banner image' : 'Upload banner image'}</button>
            {hasBanner && <button type="button" className="btn ghost" onClick={removeBanner}>{t('removeBanner')}</button>}
          </div>
          <input ref={bannerInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick('banner', e)} />
          {cropping && <Cropper file={cropping.file} size={cropping.kind === 'avatar' ? AVATAR_SIZE : BANNER_SIZE} shape={cropping.kind === 'avatar' ? 'square' : 'wide'} title={cropping.kind === 'avatar' ? t('cropTitleAvatar') : t('cropTitleBanner')} onApply={applyCrop} onCancel={() => setCropping(null)} />}

          </section>

          <section className="ed-sec" aria-labelledby="pe-theme">
          <EdHead id="pe-theme" title="Card theme" note="A gradient fills your card under the banner. Your banner stays as you set it." />
          <div className="pt-grid" role="radiogroup" aria-label="Card theme">
            <button type="button" role="radio" aria-checked={!theme} className={'pt-tile' + (!theme ? ' on' : '')} onClick={() => setTheme(null)}>
              <span className="pt-swatch pt-none" /><span className="pt-name">None</span>
            </button>
            {(ptList || []).map((th) => (
              <button type="button" role="radio" aria-checked={theme === th.id} key={th.id} className={'pt-tile' + (theme === th.id ? ' on' : '')} onClick={() => setTheme(th.id)}>
                <span className={'pt-swatch' + (th.animated ? ' pt-anim' : '')} style={{ backgroundImage: themeGradient(th), backgroundSize: th.animated ? '300% 300%' : undefined }} />
                <span className="pt-name">{th.name}</span>
                {th.animated && <span className="pt-tag">Animated</span>}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={theme === CUSTOM_THEME_ID} className={'pt-tile' + (theme === CUSTOM_THEME_ID ? ' on' : '')} onClick={() => setTheme(CUSTOM_THEME_ID)}>
              <span className="pt-swatch" style={{ backgroundImage: themeGradient(customG) }} />
              <span className="pt-name">Custom</span>
            </button>
          </div>
          {theme === CUSTOM_THEME_ID && (
            <div className="custom-grad">
              <div className="cg-stops">
                {customG.colors.map((c, i) => (
                  <span className="cg-stop" key={i}>
                    <input type="color" value={c} onChange={(e) => setStop(i, e.target.value)} aria-label={`Gradient colour ${i + 1}`} />
                    {customG.colors.length > 2 && <button type="button" className="icon-btn" title="Remove this colour" aria-label={`Remove gradient colour ${i + 1}`} onClick={() => removeStop(i)}><Icon name="close" size={14} /></button>}
                  </span>
                ))}
                {customG.colors.length < 4 && <button type="button" className="btn small-btn" onClick={addStop}><Icon name="plus" size={14} className="inline-icon" /> Colour</button>}
              </div>
              <label className="cg-angle">
                <span>Angle {customG.angle}°</span>
                <input type="range" min="0" max="360" step="5" value={customG.angle} onChange={(e) => setCustomG((g) => ({ ...g, angle: Number(e.target.value) }))} aria-label="Gradient angle" />
              </label>
              <div className="name-grad-row"><span className="sw-bar" style={{ backgroundImage: themeGradient(customG) }} /></div>
            </div>
          )}
          <p className="muted small hint">More themes, including animated ones, are coming.</p>
          </section>

          <section className="ed-sec" aria-labelledby="pe-name-style">
          <EdHead id="pe-name-style" title="Name style" note="How your display name looks everywhere it appears." />
          <ColorRow label={t('nameColor')} value={f.accentColor} onChange={set('accentColor')} />

          <label>Name font</label>
          <div className="nf-grid" role="radiogroup" aria-label="Name font">
            {NAME_FONTS.map((x) => (
              <button type="button" role="radio" aria-checked={nameFont === x.id} key={x.id} className={'nf-tile' + (nameFont === x.id ? ' on' : '')} onClick={() => setNameFont(x.id)}>
                <span className="nf-surface" style={{ background: nameSurface }}>
                  <span className="nf-sample" {...nameProps({ accentColor: f.accentColor, nameFont: x.id, nameGradient: gradOn ? nameG : null })}>{(f.displayName || me.username).slice(0, 14)}</span>
                </span>
                <span className="nf-label">{x.label}</span>
              </button>
            ))}
          </div>

          <label>Name gradient</label>
          <div className="mode-pick" role="radiogroup" aria-label="Name gradient">
            <button type="button" role="radio" aria-checked={!gradOn} className={!gradOn ? 'on' : ''} onClick={() => setGradOn(false)}>Solid colour</button>
            <button type="button" role="radio" aria-checked={gradOn} className={gradOn ? 'on' : ''} onClick={() => setGradOn(true)}>Gradient</button>
          </div>
          {gradOn && (
            <div className="custom-grad">
              <div className="cg-stops">
                {nameG.colors.map((c, i) => (
                  <span className="cg-stop" key={i}>
                    <input type="color" value={c} onChange={(e) => setNameStop(i, e.target.value)} aria-label={`Name gradient colour ${i + 1}`} />
                    {nameG.colors.length > 2 && <button type="button" className="icon-btn" title="Remove this colour" aria-label={`Remove name gradient colour ${i + 1}`} onClick={() => removeNameStop(i)}><Icon name="close" size={14} /></button>}
                  </span>
                ))}
                {nameG.colors.length < MAX_NAME_STOPS && <button type="button" className="btn small-btn" onClick={addNameStop}><Icon name="plus" size={14} className="inline-icon" /> Colour</button>}
              </div>
              <label className="cg-angle">
                <span>Angle {nameG.angle}°</span>
                <input type="range" min="0" max="360" step="5" value={nameG.angle} onChange={(e) => setNameG((g) => ({ ...g, angle: Number(e.target.value) }))} aria-label="Name gradient angle" />
              </label>
              <div className="name-grad-row"><span className="sw-bar" style={{ backgroundImage: nameGradientCss(nameG) }} /></div>
            </div>
          )}
          <p className="muted small hint">Where a gradient can't be drawn, your name colour is used instead.</p>
          </section>

          <section className="ed-sec" aria-labelledby="pe-status">
          <EdHead id="pe-status" title="Status and badges" note="Who can see you online, and which badges you wear." />
          <label htmlFor="pe-status-sel">{t('statusLbl')}</label>
          <select id="pe-status-sel" value={f.status} onChange={(e) => set('status')(e.target.value)}>
            {['online', 'idle', 'dnd', 'invisible'].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
          {ownedBadges.length > 0 && (
            <>
              <label>Badges</label>
              <div className="badge-wear">
                {ownedBadges.map((b) => {
                  const on = !hidden.has(b.id);
                  return (
                    <div key={b.id} className={'badge-wear-row' + (on ? ' on' : '')}>
                      <BadgeIcons user={{ badges: [b] }} size={28} />
                      <span className="grow">{b.name}</span>
                      <Switch on={on} label={`Show the ${b.name} badge`} onChange={() => toggleBadge(b.id)} />
                    </div>
                  );
                })}
              </div>
              <p className="muted small hint">A hidden badge disappears from your profile and from next to your name. You still own it and can show it again any time.</p>
            </>
          )}
          {ownedFrames.length > 0 && (
            <>
              <label>Profile frame</label>
              <div className="badge-wear">
                <div className={'badge-wear-row' + (!frameId ? ' on' : '')}>
                  <span className="grow">No frame</span>
                  <button type="button" className={'btn small-btn' + (!frameId ? '' : ' primary')} aria-pressed={!frameId} onClick={() => setFrameId('')}>{!frameId ? 'Selected' : 'Choose'}</button>
                </div>
                {ownedFrames.map((fr) => {
                  const on = frameId === fr.id;
                  return (
                    <div key={fr.id} className={'badge-wear-row' + (on ? ' on' : '')}>
                      <BadgeArt item={{ kind: 'frame', name: fr.name, image: fr.image }} size={40} />
                      <span className="grow">{fr.name}</span>
                      <button type="button" className={'btn small-btn' + (on ? '' : ' primary')} aria-pressed={on} onClick={() => setFrameId(on ? '' : fr.id)}>{on ? 'Selected' : 'Choose'}</button>
                    </div>
                  );
                })}
              </div>
              <p className="muted small hint">A frame is a ring around your profile picture. You wear one at a time.</p>
            </>
          )}
          </section>
        </div>

        <div className="editor-preview">
          <div className="ed-preview-label">Preview</div>
          <div className={'card' + cardTheme.className} style={cardTheme.style}>
            <div className="banner-edit">
              <Banner user={preview} />
              <button type="button" className="img-overlay banner-ov" onClick={() => bannerInput.current.click()} aria-label={t('changeBannerAria')}>
                <Icon name="camera" size={20} /><span>{t('changeBanner')}</span>
              </button>
            </div>
            <div className="card-avatar avatar-edit">
              <Avatar user={preview} size={80} presence={f.status === 'invisible' ? 'offline' : f.status} />
              <button type="button" className="img-overlay avatar-ov" onClick={() => avatarInput.current.click()} aria-label={t('changePicAria')}>
                <Icon name="camera" size={22} />
              </button>
            </div>
            <div className="card-body">
              <h3><span {...nameProps(preview)}>{preview.displayName || me.username}</span> <BadgeIcons user={preview} size={20} /></h3>
              <div className="muted">@{renaming ? f.username.trim() || me.username : me.username}</div>
              {preview.bio && (<><h4>{t('aboutMe')}</h4><p className="bio">{preview.bio}</p></>)}
              <ProfileLinks links={f.links.filter((l) => l.url.trim()).map((l) => ({ label: l.label.trim() || l.url.trim().replace(/^https?:\/\/(www\.)?/i, '').split('/')[0], url: /^[a-z][a-z0-9+.-]*:/i.test(l.url.trim()) ? l.url.trim() : 'https://' + l.url.trim() }))} />
            </div>
          </div>
        </div>
      </div>
      <div className="settings-foot">
        <span className={'ed-dirty' + (err ? ' err' : '')} role="status">{err || (dirty ? 'Unsaved changes' : '')}</span>
        <button className="btn" onClick={onClose}>{dirty ? 'Discard' : t('cancel')}</button>
        <button className="btn primary" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : t('saveChanges')}</button>
      </div>
    </div>
  );
}

export function SafetyModal({ me, other, onClose }) {
  const [num, setNum] = useState('…');
  useEffect(() => { safetyNumber(me.publicKey, other.publicKey).then(setNum); }, [me, other]);
  return (
    <Modal title="Verify encryption" onClose={onClose}>
      <p>Messages with <b>{other.displayName}</b> are end-to-end encrypted: the server only stores scrambled data.</p>
      <p className="muted">To be sure nobody swapped keys, compare this number with {other.displayName} over a call or in person. If it matches on both screens, you're secure.</p>
      <div className="safety">{num}</div>
    </Modal>
  );
}
