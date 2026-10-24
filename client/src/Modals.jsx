import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar, BadgeIcons, Banner, Icon, Modal, STATUS_LABEL, useCardTheme } from './ui.jsx';
import { useProfileThemes, setProfileThemes, themeGradient } from './profilethemes.js';
import { processImage, uploadImage, ACCEPT_ATTR, AVATAR_SIZE, BANNER_SIZE } from './image.js';
import { safetyNumber } from './crypto.js';
import { inviteLink, codeFromInput } from './Invite.jsx';
import { BotTag } from './Bots.jsx';
import { useLang } from './i18n.js';

export function ServerModal({ onClose, onDone }) {
  const [tab, setTab] = useState('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');

  async function go(e) {
    e.preventDefault();
    setErr('');
    try {
      const { server } = tab === 'create'
        ? await api('/servers', { method: 'POST', body: { name } })
        : await api('/servers/join', { method: 'POST', body: { code: codeFromInput(code) } });
      onDone(server);
    } catch (e2) { setErr(e2.message); }
  }

  return (
    <Modal title={tab === 'create' ? 'Create a server' : 'Join a server'} onClose={onClose}>
      <div className="tabs">
        <button className={tab === 'create' ? 'on' : ''} onClick={() => setTab('create')}>Create</button>
        <button className={tab === 'join' ? 'on' : ''} onClick={() => setTab('join')}>Join with invite</button>
      </div>
      <form onSubmit={go}>
        {tab === 'create' ? (<><label>SERVER NAME</label><input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required placeholder="My awesome server" /></>)
          : (<><label>INVITE LINK OR CODE</label><input autoFocus value={code} onChange={(e) => setCode(e.target.value)} required placeholder="aduna.onrender.com/invite/aduna" /></>)}
        {err && <div className="error">{err}</div>}
        <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{tab === 'create' ? 'Create' : 'Join'}</button></div>
      </form>
    </Modal>
  );
}

export function CategoryModal({ server, onClose, onDone }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault();
    try { const { server: s } = await api(`/servers/${server.id}/categories`, { method: 'POST', body: { name } }); onDone(s); }
    catch (e2) { setErr(e2.message); }
  }
  return (
    <Modal title="Add category" onClose={onClose}>
      <form onSubmit={go}>
        <label>CATEGORY NAME</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="New category" maxLength={30} required />
        {err && <div className="error">{err}</div>}
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
  const pick = (p) => { setType(p.type); if (!touched) setName(p.name); };
  async function go(e) {
    e.preventDefault();
    try { const { server: s } = await api(`/servers/${server.id}/channels`, { method: 'POST', body: { name, type, categoryId: category?.id } }); onDone(s); }
    catch (e2) { setErr(e2.message); }
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
        <label>CHANNEL NAME</label>
        <input autoFocus value={name} onChange={(e) => { setName(e.target.value); setTouched(true); }} placeholder="new-channel" maxLength={30} required />
        {err && <div className="error">{err}</div>}
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
  const tint = useCardTheme(user);
  if (!user) return null;
  return (
    <Modal title="Profile" onClose={onClose}>
      <div className="card" style={{ '--accent': user.accentColor, ...tint }}>
        <Banner user={user} />
        <div className="card-avatar"><Avatar user={user} size={80} presence={presence} /></div>
        <div className="card-body">
          <h3 data-nc style={{ '--nc': user.accentColor }}>{user.displayName}{user.bot && <> <BotTag /></>} <BadgeIcons user={user} size={20} /></h3>
          <div className="muted">{user.bot ? 'A bot. It only reads and answers in the channels it was added to.' : `@${user.username} · ${STATUS_LABEL[presence || 'offline']}`}</div>
          {user.bio && (<><h4>ABOUT ME</h4><p className="bio">{user.bio}</p></>)}
          <ProfileLinks links={user.links} />
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

function ColorRow({ label, value, onChange, colors = COLORS }) {
  return (
    <div className="color-row">
      <label>{label}</label>
      <div className="swatches">
        {colors.map((c) => <button type="button" key={c} className={'swatch' + (c === value ? ' on' : '')} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />)}
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label + ' custom'} />
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

  // Gradient profile themes: a few are free, the rest are bought with credits. The choice is saved with "Save changes".
  const ptList = useProfileThemes();
  const [theme, setTheme] = useState(me.profileTheme || null);
  const [credits, setCredits] = useState(null);
  const [ptBusy, setPtBusy] = useState('');
  useEffect(() => { api('/profile-themes').then((r) => { setProfileThemes(r.themes); setCredits(r.balance); }).catch(() => {}); }, []);
  async function buyTheme(th) {
    if (!window.confirm(`Buy the ${th.name} profile theme for ${th.price} credits?`)) return;
    setPtBusy(th.id); setErr('');
    try { const r = await api(`/profile-themes/${th.id}/buy`, { method: 'POST' }); setProfileThemes(r.themes); setCredits(r.balance); setTheme(th.id); }
    catch (ex) { setErr(ex.message); }
    setPtBusy('');
  }

  // Badges: everything the person owns, each worn or taken off. Saved with the rest of the profile; the preview card follows the toggles.
  const ownedBadges = Array.isArray(me.ownedBadges) ? me.ownedBadges : [];
  const [hidden, setHidden] = useState(() => new Set(ownedBadges.filter((b) => b.worn === false).map((b) => b.id)));
  const toggleBadge = (id) => setHidden((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

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
  async function pick(kind, e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    setErr('');
    try {
      const blob = await processImage(file, kind === 'avatar' ? AVATAR_SIZE : BANNER_SIZE);
      stage(kind, { blob, url: URL.createObjectURL(blob) });
      if (kind === 'avatar') setMode('image');
    } catch (ex) { setErr(ex.message); }
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

  const preview = {
    ...me, ...f,
    badges: ownedBadges.length ? ownedBadges.filter((b) => !hidden.has(b.id)) : me.badges, // the card shows only the badges that are on
    username: me.username,
    profileTheme: theme,
    avatarLogo: mode === 'logo',
    avatarEmoji: mode === 'letter' ? f.avatarEmoji : '',
    avatarImage: mode === 'image' && staged.avatar !== null ? me.avatarImage : null,
    avatarPreview: mode === 'image' ? staged.avatar?.url : undefined,
    bannerImage: staged.banner === null ? null : me.bannerImage, bannerPreview: staged.banner?.url,
  };

  async function save() {
    setSaving(true);
    setErr('');
    try {
      const body = { ...f, avatarLogo: mode === 'logo', profileTheme: theme, links: f.links.filter((l) => l.url.trim()) };
      if (renaming) body.username = f.username.trim().replace(/^@/, ''); else delete body.username;
      if (ownedBadges.length) body.hiddenBadges = [...hidden];
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
          <label>{t('displayName')}</label>
          <input value={f.displayName} maxLength={32} onChange={(e) => set('displayName')(e.target.value)} />

          <label>{t('email')}</label>
          <input type="email" value={f.email} maxLength={254} autoComplete="email" placeholder="you@example.com" onChange={(e) => set('email')(e.target.value)} />
          <p className="muted small hint">{t('emailPrivate')}</p>

          <label>{t('username')}</label>
          <div className="at-input">
            <span>@</span>
            <input value={f.username} maxLength={20} disabled={locked} autoCapitalize="none" autoCorrect="off" spellCheck={false}
              onChange={(e) => set('username')(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} />
          </div>
          <p className="muted small hint">
            {locked
              ? t('usernameLocked', { date: fmtDate(unlockAt) })
              : renaming
                ? t('usernameHeadsUp')
                : t('usernameRule')}
          </p>

          <label>{t('aboutMe')}</label>
          <textarea rows={3} maxLength={190} value={f.bio} onChange={(e) => set('bio')(e.target.value)} />

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

          <label>{t('profilePicture')}</label>
          <div className="mode-pick" role="radiogroup" aria-label={t('picStyle')}>
            {[['letter', t('picLetter')], ['logo', t('picLogo')], ['image', t('picImage')]].map(([k, label]) => (
              <button type="button" role="radio" aria-checked={mode === k} key={k} className={mode === k ? 'on' : ''} onClick={() => chooseMode(k)}>{label}</button>
            ))}
          </div>
          <input ref={avatarInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick('avatar', e)} />
          {mode !== 'image' && <ColorRow label={t('avatarColor')} value={f.avatarColor} onChange={set('avatarColor')} />}
          <p className="muted small hint">{t('picTip')}</p>

          <label>{t('banner')}</label>
          <ColorRow label={t('bannerColor')} value={f.bannerColor} onChange={set('bannerColor')} colors={BANNER_COLORS} />
          {hasBanner && <div className="upload-row"><button type="button" className="btn" onClick={removeBanner}>{t('removeBanner')}</button></div>}
          <input ref={bannerInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick('banner', e)} />

          <label>Profile theme</label>
          <div className="pt-grid" role="radiogroup" aria-label="Profile theme">
            <button type="button" role="radio" aria-checked={!theme} className={'pt-tile' + (!theme ? ' on' : '')} onClick={() => setTheme(null)}>
              <span className="pt-swatch" style={{ background: f.bannerColor }} /><span className="pt-name">None</span><span className="pt-price">Your banner colour</span>
            </button>
            {(ptList || []).map((th) => (
              <button type="button" role="radio" aria-checked={theme === th.id} key={th.id} className={'pt-tile' + (theme === th.id ? ' on' : '')} disabled={ptBusy === th.id}
                onClick={() => (th.owned ? setTheme(th.id) : buyTheme(th))}>
                <span className={'pt-swatch' + (th.animated ? ' pt-anim' : '')} style={{ backgroundImage: themeGradient(th), backgroundSize: th.animated ? '300% 300%' : undefined }} />
                <span className="pt-name">{th.name}</span>
                <span className="pt-price">{th.owned ? (th.price ? 'Owned' : 'Free') : <><Icon name="coin" size={12} />{th.price}</>}</span>
                {th.animated && <span className="pt-tag">Animated</span>}
              </button>
            ))}
          </div>
          <p className="muted small hint">Gradient themes colour your banner and tint your profile card. An uploaded banner picture shows instead of the gradient.{credits !== null ? ` You have ${credits.toLocaleString()} credits; earn more on the Quests tab.` : ''}</p>

          <ColorRow label={t('nameColor')} value={f.accentColor} onChange={set('accentColor')} />
          <label>{t('statusLbl')}</label>
          <select value={f.status} onChange={(e) => set('status')(e.target.value)}>
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
                      <button type="button" className={'btn small-btn' + (on ? '' : ' primary')} aria-pressed={on} onClick={() => toggleBadge(b.id)}>{on ? 'Take off' : 'Put on'}</button>
                    </div>
                  );
                })}
              </div>
              <p className="muted small hint">Badges you take off are hidden from your profile and from next to your name. You still own them, so you can put them back on any time. Press Save changes to apply.</p>
            </>
          )}
          {err && <div className="error">{err}</div>}
        </div>

        <div className="editor-preview">
          <div className="card">
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
              <h3 data-nc style={{ '--nc': preview.accentColor }}>{preview.displayName || me.username} <BadgeIcons user={preview} size={20} /></h3>
              <div className="muted">@{renaming ? f.username.trim() || me.username : me.username}</div>
              {preview.bio && (<><h4>{t('aboutMe')}</h4><p className="bio">{preview.bio}</p></>)}
              <ProfileLinks links={f.links.filter((l) => l.url.trim()).map((l) => ({ label: l.label.trim() || l.url.trim().replace(/^https?:\/\/(www\.)?/i, '').split('/')[0], url: /^[a-z][a-z0-9+.-]*:/i.test(l.url.trim()) ? l.url.trim() : 'https://' + l.url.trim() }))} />
            </div>
          </div>
        </div>
      </div>
      <div className="settings-foot">
        <button className="btn" onClick={onClose}>{t('cancel')}</button> <button className="btn primary" onClick={save} disabled={saving}>{t('saveChanges')}</button>
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
