import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar, Icon, Modal, ServerIcon } from './ui.jsx';
import { layoutOf, moveChannel, moveCategory, saveLayout } from './layout.js';
import { processImage, uploadImage, imageUrl, ACCEPT_ATTR, SERVER_ICON_SIZE, SERVER_BANNER_SIZE } from './image.js';
import { THEMES, DEFAULT_CUSTOM, setServerTheme } from './themes.js';
import { ThemeGallery, PublishTheme } from './ThemeGallery.jsx';
import { Swatch } from './Appearance.jsx';
import { can } from './perms.js';
import { RolesTab, MembersTab } from './Roles.jsx';
import { OnboardingTab } from './Onboarding.jsx';
import { BotsTab } from './Bots.jsx';

// [id, label, icon, who may open it]
const TABS = [
  ['overview', 'Overview', 'users', (sv, uid) => can(sv, uid, 'manageServer')],
  ['channels', 'Channels', 'hash', (sv, uid) => can(sv, uid, 'manageChannels')],
  ['roles', 'Roles', 'shield', (sv, uid) => can(sv, uid, 'manageRoles')],
  ['onboarding', 'Onboarding', 'hand', (sv, uid) => can(sv, uid, 'manageServer')],
  ['members', 'Members', 'users', (sv, uid) => can(sv, uid, 'manageRoles') || can(sv, uid, 'kickMembers')],
  ['bots', 'Bots', 'bot', (sv, uid) => can(sv, uid, 'manageServer')],
  ['publish', 'Publish', 'globe', (sv, uid) => sv.ownerId === uid],
  ['ownership', 'Ownership', 'crown', (sv, uid) => sv.ownerId === uid],
  ['theme', 'Server theme', 'palette', (sv, uid) => can(sv, uid, 'manageServer')],
];
const CH_ICON = { voice: 'speaker', rules: 'rules', announcements: 'megaphone' };
const seedOf = (t) => ({ dark: t.dark, bg: t.bg, accent: t.accent });
const sameSeed = (a, b) => a.dark === b.dark && a.bg.toLowerCase() === b.bg.toLowerCase() && a.accent.toLowerCase() === b.accent.toLowerCase();

// Full-screen settings for a server (each tab needs its own permission; the owner has all): name, icon, banner and a theme the app fades to while you are on the server.
// Picture changes are staged until Save (undefined = unchanged, null = remove, { blob, url } = new image).
// While this screen is open the draft theme is previewed live on the whole app.
export function ServerSettings({ server, me, onClose, onSaved, startTab }) {
  const tabs = TABS.filter((t) => t[3](server, me.id));
  const [pickedTab, setTab] = useState(startTab || 'overview');
  const tab = tabs.some((t) => t[0] === pickedTab) ? pickedTab : tabs[0]?.[0]; // a tab you lose access to (role changed live) falls back to the first you still have
  const [name, setName] = useState(server.name);
  const [code, setCode] = useState(server.inviteCode);
  const [codeState, setCodeState] = useState({ status: 'current', reason: '' }); // current | checking | free | taken | invalid
  const [tags, setTags] = useState(server.tags || []);
  const [themeOn, setThemeOn] = useState(!!server.theme);
  const [publishing, setPublishing] = useState(false);
  const [theme, setTheme] = useState(server.theme || seedOf(DEFAULT_CUSTOM));
  const [staged, setStaged] = useState({ icon: undefined, banner: undefined });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const iconInput = useRef(null);
  const bannerInput = useRef(null);

  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  // Ask the server whether the typed invite code is free (debounced while typing)
  useEffect(() => {
    const c = code.trim().toLowerCase();
    if (c === server.inviteCode) { setCodeState({ status: 'current', reason: '' }); return undefined; }
    if (!/^[a-z0-9_-]{3,32}$/.test(c)) { setCodeState({ status: 'invalid', reason: 'Use 3 to 32 letters, numbers, - or _' }); return undefined; }
    setCodeState({ status: 'checking', reason: '' });
    let live = true;
    const t = setTimeout(() => {
      api(`/servers/${server.id}/invite-check?code=${encodeURIComponent(c)}`)
        .then((r) => live && setCodeState(r.available ? { status: 'free', reason: '' } : { status: 'taken', reason: r.reason || 'That code is already taken' }))
        .catch((e) => live && setCodeState({ status: 'invalid', reason: e.message }));
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [code, server.id, server.inviteCode]);
  useEffect(() => () => { for (const s of Object.values(stagedRef.current)) if (s) URL.revokeObjectURL(s.url); }, []);

  // live preview: the whole app fades to the draft theme (App puts the saved one back when this screen closes)
  useEffect(() => { setServerTheme(themeOn ? theme : null, { force: true }); }, [themeOn, theme]);

  function stage(kind, value) {
    setStaged((s) => { if (s[kind]) URL.revokeObjectURL(s[kind].url); return { ...s, [kind]: value }; });
  }
  async function pick(kind, e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setErr('');
    try {
      const blob = await processImage(file, kind === 'icon' ? SERVER_ICON_SIZE : SERVER_BANNER_SIZE);
      stage(kind, { blob, url: URL.createObjectURL(blob) });
    } catch (ex) { setErr(ex.message); }
  }
  const has = (kind) => (staged[kind] === undefined ? !!server[kind === 'icon' ? 'iconImage' : 'bannerImage'] : staged[kind] !== null);
  const remove = (kind) => stage(kind, server[kind === 'icon' ? 'iconImage' : 'bannerImage'] ? null : undefined);

  const iconSrc = staged.icon === undefined ? imageUrl(server.iconImage) : staged.icon?.url || null;
  const bannerSrc = staged.banner === undefined ? imageUrl(server.bannerImage) : staged.banner?.url || null;
  const shownName = name.trim() || server.name;

  const pickTheme = (seed) => { setTheme(seed); setThemeOn(true); };
  const setSeed = (patch) => pickTheme({ ...theme, ...patch });

  async function save() {
    if (!name.trim()) { setTab('overview'); return setErr('Give the server a name'); }
    if (codeState.status === 'taken' || codeState.status === 'invalid') { setTab('overview'); return setErr(codeState.reason || 'Fix the invite code first'); }
    if (codeState.status === 'checking') return setErr('Still checking the invite code, try again in a moment');
    setSaving(true);
    setErr('');
    try {
      let { server: sv } = await api(`/servers/${server.id}`, { method: 'PATCH', body: { name, tags, theme: themeOn ? theme : null, inviteCode: code.trim().toLowerCase() } });
      for (const kind of ['icon', 'banner']) {
        const s = staged[kind];
        if (s === undefined) continue;
        ({ server: sv } = s === null ? await api(`/servers/${server.id}/${kind}`, { method: 'DELETE' }) : await uploadImage(kind, s.blob, `/api/servers/${server.id}`));
      }
      onSaved(sv);
      onClose();
    } catch (ex) { setErr(ex.message); setSaving(false); }
  }

  return (
    <div className="settings-screen" role="dialog" aria-label="Server settings">
      <nav className="settings-nav">
        <button className="icon-btn settings-navclose" onClick={onClose} aria-label="Close server settings"><Icon name="close" size={20} /></button>
        <h2>{server.name}</h2>
        {tabs.map(([id, label, icon]) => (
          <button key={id} className={'settings-tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
            <Icon name={icon} size={18} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <main className="settings-main">
        <button className="icon-btn settings-close" onClick={onClose} aria-label="Close server settings" title="Close (Esc)"><Icon name="close" size={20} /></button>
        <div className="settings-content">
          <input ref={iconInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick('icon', e)} />
          <input ref={bannerInput} type="file" accept={ACCEPT_ATTR} hidden onChange={(e) => pick('banner', e)} />

          {tab === 'overview' && (
            <>
              <h1>Overview</h1>
              <div className="server-prev">
                <div className="sp-banner" style={bannerSrc ? { backgroundImage: `url("${bannerSrc}")` } : undefined}>
                  <button type="button" className="img-overlay banner-ov" onClick={() => bannerInput.current.click()} aria-label="Change server banner">
                    <Icon name="camera" size={20} /><span>Change banner</span>
                  </button>
                </div>
                <div className="sp-icon">
                  <ServerIcon server={{ name: shownName }} fill preview={iconSrc} />
                  <button type="button" className="img-overlay" onClick={() => iconInput.current.click()} aria-label="Change server icon"><Icon name="camera" size={22} /></button>
                </div>
                <div className="sp-body"><div className="sp-name">{shownName}</div><div className="muted small">{server.channels.length} channel{server.channels.length === 1 ? '' : 's'} · {server.members.length} member{server.members.length === 1 ? '' : 's'}</div></div>
              </div>
              <p className="muted small hint">Tip: hover the banner or icon in the preview and click it to upload an image. Icons are cropped square, banners are cropped to 3:1.</p>

              <label>SERVER NAME</label>
              <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />

              <label>CUSTOM INVITE LINK ENDING</label>
              <input className={'code-input ' + codeState.status} value={code} maxLength={32} spellCheck={false} autoCapitalize="none" autoCorrect="off" onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} aria-describedby="code-hint" />
              <p id="code-hint" className={'code-hint ' + codeState.status} role="status">
                {codeState.status === 'current' && 'This is your current invite code.'}
                {codeState.status === 'checking' && 'Checking…'}
                {codeState.status === 'free' && 'Available. It becomes your invite code when you save.'}
                {(codeState.status === 'taken' || codeState.status === 'invalid') && codeState.reason}
              </p>
              <p className="muted small hint">Changing the code stops the old one from working, including invite links already shared.</p>

              <label>TAGS</label>
              <TagInput tags={tags} onChange={setTags} />
              <p className="muted small hint">Tags help people find your server when it is public: searching for a tag ranks your server above ones that only mention the word. Up to 5. Press Enter or comma to add one.</p>

              <label>ICON AND BANNER</label>
              <div className="upload-row">
                <button type="button" className="btn" onClick={() => iconInput.current.click()}>{has('icon') ? 'Change icon' : 'Upload icon'}</button>
                {has('icon') && <button type="button" className="btn" onClick={() => remove('icon')}>Remove icon</button>}
                <button type="button" className="btn" onClick={() => bannerInput.current.click()}>{has('banner') ? 'Change banner' : 'Upload banner'}</button>
                {has('banner') && <button type="button" className="btn" onClick={() => remove('banner')}>Remove banner</button>}
              </div>
            </>
          )}

          {tab === 'theme' && (
            <>
              <h1>Server theme</h1>
              <p className="muted">When someone opens your server, the app fades from their own theme to this one, and fades back when they leave.</p>
              <div className="appearance">
                <label>THEME</label>
                <div className="mode-pick" role="radiogroup" aria-label="Server theme">
                  <button type="button" role="radio" aria-checked={!themeOn} className={!themeOn ? 'on' : ''} onClick={() => setThemeOn(false)}>No server theme</button>
                  <button type="button" role="radio" aria-checked={themeOn} className={themeOn ? 'on' : ''} onClick={() => setThemeOn(true)}>Use a server theme</button>
                </div>

                <label>START FROM A PRESET</label>
                <div className="theme-grid">
                  {THEMES.map((t) => <Swatch key={t.id} theme={t} on={themeOn && sameSeed(theme, seedOf(t))} onPick={() => pickTheme(seedOf(t))} />)}
                </div>

                <label>COMMUNITY THEMES</label>
                <ThemeGallery current={themeOn ? theme : null} onPick={(seed) => pickTheme({ dark: seed.dark, bg: seed.bg, accent: seed.accent })} />

                <label>OR CHOOSE YOUR OWN</label>
                <div className={'custom-theme' + (themeOn ? ' on' : '')}>
                  <div className="mode-pick" role="radiogroup" aria-label="Theme base">
                    {[[false, 'Light base'], [true, 'Dark base']].map(([d, label]) => (
                      <button type="button" role="radio" key={label} aria-checked={theme.dark === d} className={themeOn && theme.dark === d ? 'on' : ''} onClick={() => setSeed({ dark: d })}>{label}</button>
                    ))}
                  </div>
                  <div className="custom-row">
                    <span>Background</span>
                    <input type="color" value={theme.bg} onChange={(e) => setSeed({ bg: e.target.value })} aria-label="Server background colour" />
                    <code>{theme.bg}</code>
                  </div>
                  <div className="custom-row">
                    <span>Accent (buttons, highlights)</span>
                    <input type="color" value={theme.accent} onChange={(e) => setSeed({ accent: e.target.value })} aria-label="Server accent colour" />
                    <code>{theme.accent}</code>
                  </div>
                  <div className="mode-pick"><button type="button" onClick={() => setPublishing(true)}>Publish this theme to the gallery…</button></div>
                  <p className="muted small hint">Sidebars, borders, hover and text colours are generated from these two colours, so text stays readable.</p>
                </div>
                {publishing && <PublishTheme seed={theme} onClose={() => setPublishing(false)} />}
                <p className="muted small hint">You are previewing this live. It only changes for everyone after you save. People can turn server themes off in their own Appearance settings.</p>
              </div>
            </>
          )}

          {tab === 'channels' && <ChannelsTab server={server} onChange={onSaved} />}
          {tab === 'roles' && <RolesTab server={server} me={me} onChange={onSaved} />}
          {tab === 'onboarding' && <OnboardingTab key={server.id} server={server} onChange={onSaved} />}
          {tab === 'bots' && <BotsTab key={server.id} server={server} me={me} onChange={onSaved} />}
          {tab === 'members' && <MembersTab server={server} me={me} onChange={onSaved} />}
          {tab === 'ownership' && <OwnershipTab server={server} me={me} onChange={onSaved} onClose={onClose} />}
          {tab === 'publish' && <PublishTab server={server} onChange={onSaved} goChannels={() => setTab('channels')} />}

          {(tab === 'overview' || tab === 'theme') && err && <div className="error">{err}</div>}
          {(tab === 'overview' || tab === 'theme') && <div className="settings-foot">
            <button className="btn" onClick={onClose}>Cancel</button> <button className="btn primary" onClick={save} disabled={saving}>Save changes</button>
          </div>}
        </div>
      </main>
    </div>
  );
}

// Edit, delete and reorder channels and categories. Unlike the other tabs these apply immediately (no Save button).
function ChannelsTab({ server, onChange }) {
  const [editing, setEditing] = useState(null); // { kind: 'chan' | 'cat', id, text }
  const [confirm, setConfirm] = useState(null); // { kind, item }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const lay = layoutOf(server);
  const cats = server.categories || [];
  const chanById = new Map(server.channels.map((c) => [c.id, c]));
  const run = async (fn) => {
    setErr(''); setBusy(true);
    try { const { server: sv } = await fn(); onChange(sv); return true; }
    catch (e) { setErr(e.message); return false; }
    finally { setBusy(false); }
  };
  const base = `/servers/${server.id}`;
  const saveName = async (e) => {
    e.preventDefault();
    if (!editing.text.trim()) return;
    const url = editing.kind === 'chan' ? `${base}/channels/${editing.id}` : `${base}/categories/${editing.id}`;
    if (await run(() => api(url, { method: 'PATCH', body: { name: editing.text } }))) setEditing(null);
  };
  const doDelete = async () => {
    const { kind, item } = confirm;
    if (await run(() => api(kind === 'chan' ? `${base}/channels/${item.id}` : `${base}/categories/${item.id}`, { method: 'DELETE' }))) setConfirm(null);
  };
  const nameCell = (kind, item, icon) => (editing?.kind === kind && editing.id === item.id ? (
    <form className="ch-edit" onSubmit={saveName}>
      <input autoFocus value={editing.text} maxLength={30} onChange={(e) => setEditing({ ...editing, text: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
      <button className="btn primary" disabled={busy}>Save</button>
      <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
    </form>
  ) : (
    <>
      <span className="ch-name">{icon}{item.name}</span>
      <button className="icon-btn" title="Rename" aria-label={`Rename ${item.name}`} onClick={() => setEditing({ kind, id: item.id, text: item.name })}><Icon name="edit" size={16} /></button>
    </>
  ));
  const arrows = (up, down, label) => (
    <>
      <button className="icon-btn ch-up" title="Move up" aria-label={`Move ${label} up`} disabled={!up || busy} onClick={up}><Icon name="chevron" size={16} /></button>
      <button className="icon-btn" title="Move down" aria-label={`Move ${label} down`} disabled={!down || busy} onClick={down}><Icon name="chevron" size={16} /></button>
    </>
  );
  const move = (next) => run(() => saveLayout(api, server.id, next));

  const chanRow = (c, group) => {
    const i = group.findIndex((x) => x.id === c.id), prev = group[i - 1], next = group[i + 1];
    const catId = lay.chans.find((x) => x.id === c.id).categoryId;
    return (
      <div className="ch-row" key={c.id}>
        {nameCell('chan', c, <span className="hash">{CH_ICON[c.type] ? <Icon name={CH_ICON[c.type]} size={16} /> : '#'}</span>)}
        <div className="grow" />
        {cats.length > 0 && (
          <select className="ch-cat" value={catId || ''} aria-label={`Category of ${c.name}`} disabled={busy} onChange={(e) => move(moveChannel(lay, c.id, e.target.value || null, null))}>
            <option value="">No category</option>
            {cats.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        )}
        {arrows(prev && (() => move(moveChannel(lay, c.id, catId, prev.id))), next && (() => move(moveChannel(lay, c.id, catId, group[i + 2]?.id || null))), c.name)}
        <button className="icon-btn" title="Delete channel" aria-label={`Delete ${c.name}`} disabled={server.channels.length <= 1} onClick={() => setConfirm({ kind: 'chan', item: c })}><Icon name="trash" size={16} /></button>
      </div>
    );
  };
  const groupOf = (catId) => lay.chans.filter((x) => (x.categoryId || null) === catId).map((x) => chanById.get(x.id));
  const loose = groupOf(null);

  return (
    <>
      <h1>Channels</h1>
      <p className="muted">Changes here apply right away. You can also drag channels and categories in the channel list to reorder them.</p>
      {err && <div className="error">{err}</div>}
      {loose.length > 0 && <div className="ch-group"><div className="ch-head"><span>NO CATEGORY</span></div>{loose.map((c) => chanRow(c, loose))}</div>}
      {cats.map((cat, ci) => {
        const items = groupOf(cat.id);
        return (
          <div className="ch-group" key={cat.id}>
            <div className="ch-head">
              {nameCell('cat', cat, null)}
              <div className="grow" />
              {arrows(ci > 0 && (() => move(moveCategory(lay, cat.id, lay.cats[ci - 1]))), ci < cats.length - 1 && (() => move(moveCategory(lay, cat.id, lay.cats[ci + 2] || null))), cat.name)}
              <button className="icon-btn" title="Delete category" aria-label={`Delete category ${cat.name}`} onClick={() => setConfirm({ kind: 'cat', item: cat })}><Icon name="trash" size={16} /></button>
            </div>
            {items.length === 0 && <p className="muted small ch-empty">No channels in this category.</p>}
            {items.map((c) => chanRow(c, items))}
          </div>
        );
      })}
      {server.channels.length <= 1 && <p className="muted small hint">A server needs at least one channel, so the last one cannot be deleted.</p>}
      {confirm && (
        <Modal title={confirm.kind === 'chan' ? 'Delete channel' : 'Delete category'} onClose={() => setConfirm(null)}>
          <p className="muted">
            {confirm.kind === 'chan'
              ? <>This permanently deletes <b>#{confirm.item.name}</b> with all its messages and files for everyone. This cannot be undone.</>
              : <>This deletes the category <b>{confirm.item.name}</b>. Its channels are kept and move to the top of the list.</>}
          </p>
          {err && <div className="error">{err}</div>}
          <div className="modal-foot">
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn primary danger-fill" autoFocus disabled={busy} onClick={doDelete}>Delete</button>
          </div>
        </Modal>
      )}
    </>
  );
}

const VIS = [
  { id: 'private', icon: 'lock', title: 'Private', desc: 'Only the people you list can join, even with the invite code.' },
  { id: 'unlisted', icon: 'link', title: 'Unlisted', desc: 'Anyone with your invite code can join. It is not listed anywhere.' },
  { id: 'public', icon: 'globe', title: 'Public', desc: 'Anyone with the code can join, and it can be found in the server explorer.' },
];
// Publishing: the server must first have enough channels, then the owner picks who can find and join it.
// Applies immediately (no Save button). Private servers also get a list of who is allowed in.
function PublishTab({ server, onChange, goChannels }) {
  const [info, setInfo] = useState(null);
  const [pick, setPick] = useState(null);
  const [desc, setDesc] = useState(server.description || '');
  const [who, setWho] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  // refetch whenever channels change (the requirements are counted on the server)
  const chanKey = server.channels.map((c) => c.id + (c.type || 'text')).join();
  useEffect(() => {
    let live = true;
    api(`/servers/${server.id}/publish`).then((r) => { if (live) { setInfo(r.publish); setPick((p) => p || r.publish.visibility); } }).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [server.id, chanKey]);
  if (!info) return <><h1>Publish</h1>{err ? <div className="error">{err}</div> : <p className="muted">Loading…</p>}</>;

  const review = info.review === 'removed'
    ? 'This server was removed from the public listing after reports. You can still use it as private or unlisted.'
    : info.review === 'hidden' ? 'Your public listing is hidden while a moderator reviews reports about it. It cannot be changed until then.' : '';
  const rows = [['text', 'text channels', false], ['voice', 'voice channels', false], ['rules', 'rules channel', true], ['announcements', 'announcements channel', true]];
  const current = info.visibility;
  const dirty = pick && (pick !== current || (pick === 'public' && desc.trim() !== (info.description || '')));
  const run = async (fn, after) => {
    setErr(''); setSaved(''); setBusy(true);
    try { const r = await fn(); if (r.publish) setInfo(r.publish); if (r.server) onChange(r.server); after?.(r); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const publish = () => run(() => api(`/servers/${server.id}/publish`, { method: 'PUT', body: { visibility: pick, description: desc } }), () => setSaved(current ? 'Updated.' : 'Published.'));
  const unpublish = () => run(() => api(`/servers/${server.id}/publish`, { method: 'PUT', body: { visibility: null } }), () => { setPick(null); setSaved('Unpublished. Your invite code still works for anyone who has it.'); });
  const addWho = (e) => { e.preventDefault(); if (who.trim()) run(() => api(`/servers/${server.id}/publish/allowed`, { method: 'POST', body: { username: who } }), () => setWho('')); };
  const removeWho = (id) => run(() => api(`/servers/${server.id}/publish/allowed/${id}`, { method: 'DELETE' }));

  return (
    <>
      <h1>Publish</h1>
      <p className="muted">Choose who can find and join your server. A server needs enough channels first, so it is not empty when people arrive.</p>
      {review && <div className="error">{review}</div>}

      <label>REQUIREMENTS</label>
      <div className="req-list">
        {rows.map(([k, label, publicOnly]) => {
          const have = info.counts[k], need = publicOnly ? info.publicRequirements[k] : info.requirements[k], ok = have >= need;
          return (
            <div key={k} className={'req' + (ok ? ' ok' : '')}>
              <span className="req-mark"><Icon name={ok ? 'check' : 'close'} size={14} /></span>
              <span>At least <b>{need}</b> {label}{publicOnly && <span className="live-tag only">Public only</span>}</span>
              <span className="grow" />
              <span className="muted small">{Math.min(have, need)} / {need}{have > need ? ` (${have} total)` : ''}</span>
            </div>
          );
        })}
      </div>
      {!info.metPublic && <p className="muted small hint">{info.met ? 'Public servers also need a rules channel and an announcements channel. ' : ''}Add the missing channels in the <button className="link-btn" onClick={goChannels}>Channels</button> list (the + in the channel list, or any category), then come back here.</p>}

      <label>VISIBILITY{current ? '' : ' (NOT PUBLISHED YET)'}</label>
      <div className={'vis-grid' + (info.met ? '' : ' locked')} role="radiogroup" aria-label="Visibility">
        {VIS.map((v) => (
          <button type="button" key={v.id} role="radio" aria-checked={pick === v.id} disabled={!info.met || (v.id === 'public' && (!info.metPublic || !!info.review)) || busy} className={'vis' + (pick === v.id ? ' on' : '')} onClick={() => setPick(v.id)}>
            <span className="preset-icon"><Icon name={v.icon} size={22} /></span>
            <span className="preset-text"><b>{v.title}{current === v.id && <span className="live-tag">Live</span>}{v.id === 'public' && info.met && !info.metPublic && <span className="live-tag only">Needs rules + announcements</span>}</b><span className="muted small">{v.desc}</span></span>
          </button>
        ))}
      </div>
      {!current && <p className="muted small hint">Until you publish, your server works like Unlisted: anyone with the invite code can join.</p>}

      {info.met && pick === 'private' && (
        <>
          <label>PEOPLE WHO CAN JOIN</label>
          <form className="allow-add" onSubmit={addWho}>
            <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Add by username" maxLength={20} />
            <button className="btn" disabled={busy || !who.trim()}>Add</button>
          </form>
          <div className="allow-list">
            {info.allowed.length === 0 && <p className="muted small">Nobody yet. Add the usernames of people allowed to join. People already in the server stay in.</p>}
            {info.allowed.map((u) => (
              <div className="allow-row" key={u.id}>
                <Avatar user={u} size={28} /><span className="grow"><b>{u.displayName}</b> <span className="muted small">@{u.username}</span></span>
                <button className="icon-btn" title="Remove" aria-label={`Remove ${u.displayName}`} onClick={() => removeWho(u.id)}><Icon name="close" size={16} /></button>
              </div>
            ))}
          </div>
          <p className="muted small hint">They still need your invite code or a direct invite to get in. Anyone not on this list is turned away.</p>
        </>
      )}

      {info.met && pick === 'public' && (
        <>
          <label>DESCRIPTION</label>
          <textarea className="pub-desc" rows={3} maxLength={200} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is your server about?" />
          <p className="muted small hint">{desc.length}/200. The server explorer is coming soon. Your server will be listed there when it launches.</p>
        </>
      )}

      {err && <div className="error">{err}</div>}
      {saved && <div className="notice pub-saved" role="status">{saved}</div>}
      <div className="settings-foot">
        {current && <button className="btn" disabled={busy} onClick={unpublish}>Unpublish</button>}{' '}
        <button className="btn primary" disabled={busy || !info.met || !dirty} onClick={publish}>{current ? 'Update' : 'Publish'}</button>
      </div>
    </>
  );
}

// Chips plus a text box. Enter, comma or leaving the box adds the tag; Backspace on an empty box removes the last one.
function TagInput({ tags, onChange }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const clean = (t) => t.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  function add(raw) {
    const t = clean(raw);
    if (!t) return;
    if (!/^[a-z0-9][a-z0-9-]{0,18}[a-z0-9]$/.test(t)) return setMsg('Tags are 2 to 20 letters, numbers or dashes');
    if (tags.includes(t)) { setText(''); return setMsg(''); }
    if (tags.length >= 5) return setMsg('You can use up to 5 tags');
    onChange([...tags, t]); setText(''); setMsg('');
  }
  return (
    <>
      <div className="tag-input" onClick={(e) => e.currentTarget.querySelector('input')?.focus()}>
        {tags.map((t) => <span className="tag on" key={t}>#{t}<button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}><Icon name="close" size={12} /></button></span>)}
        {tags.length < 5 && (
          <input value={text} maxLength={21} placeholder={tags.length ? '' : 'gaming, art, study…'} aria-label="Add a tag"
            onChange={(e) => { setMsg(''); const v = e.target.value; if (v.endsWith(',')) add(v.slice(0, -1)); else setText(v); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(text); } else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1)); }}
            onBlur={() => text && add(text)} />
        )}
      </div>
      {msg && <p className="code-hint invalid" role="status">{msg}</p>}
    </>
  );
}


// Hand the server to another member, or delete it. Both ask for your password (and your 2FA code when it is on).
function OwnershipTab({ server, me, onChange, onClose }) {
  const [mode, setMode] = useState(null); // 'transfer' | 'delete'
  const [target, setTarget] = useState('');
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const others = server.members.filter((u) => u.id !== me.id);
  const picked = others.find((u) => u.id === target);
  const close = () => { setMode(null); setTarget(''); setTyped(''); setPassword(''); setCode(''); setErr(''); };
  const ready = password && (!me.twoFactor || code) && (mode === 'transfer' ? !!picked : typed.trim() === server.name);
  const run = async () => {
    setErr(''); setBusy(true);
    try {
      if (mode === 'transfer') {
        const r = await api(`/servers/${server.id}/transfer`, { method: 'POST', body: { userId: target, password, code: me.twoFactor ? code : undefined } });
        onChange(r.server); close(); onClose(); // you are no longer the owner: the owner-only screens are gone
      } else {
        await api(`/servers/${server.id}`, { method: 'DELETE', body: { name: typed.trim(), password, code: me.twoFactor ? code : undefined } });
        // the server:removed event takes the server out of the app and closes this screen
      }
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  return (
    <>
      <h1>Ownership</h1>
      <div className="own-card">
        <h3>Transfer ownership</h3>
        <p className="muted">Make another member the owner. They get every permission and the owner-only settings; you stay in the server as an ordinary member with no roles.</p>
        <button className="btn" disabled={!others.length} onClick={() => setMode('transfer')}>Transfer ownership…</button>
        {!others.length && <p className="muted small hint">You are the only member. Invite someone first, or delete the server.</p>}
      </div>
      <div className="own-card danger">
        <h3>Delete server</h3>
        <p className="muted">Permanently deletes {server.name} for everyone: all channels, messages, uploaded files, roles and the invite link. This cannot be undone.</p>
        <button className="btn danger" onClick={() => setMode('delete')}>Delete server…</button>
      </div>
      {mode && (
        <Modal title={mode === 'transfer' ? 'Transfer ownership' : 'Delete server'} onClose={busy ? () => {} : close}>
          {mode === 'transfer' ? (
            <>
              <label className="field">New owner
                <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
                  <option value="">Choose a member…</option>
                  {others.map((u) => <option key={u.id} value={u.id}>{u.displayName} (@{u.username})</option>)}
                </select>
              </label>
              {picked && <p className="muted small">After this, <b>{picked.displayName}</b> can change or delete everything here and you cannot take it back unless they give it to you.</p>}
            </>
          ) : (
            <label className="field">Type <b>{server.name}</b> to confirm
              <input value={typed} disabled={busy} autoFocus autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
            </label>
          )}
          <label className="field">Your password
            <input type="password" value={password} autoComplete="current-password" disabled={busy} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {me.twoFactor && (
            <label className="field">Authenticator code
              <input value={code} autoComplete="one-time-code" maxLength={20} disabled={busy} placeholder="123456" onChange={(e) => setCode(e.target.value)} />
            </label>
          )}
          {err && <div className="error">{err}</div>}
          <div className="modal-foot">
            <button className="btn" disabled={busy} onClick={close}>Cancel</button>
            <button className="btn primary danger-fill" disabled={busy || !ready} onClick={run}>{busy ? 'Working…' : mode === 'transfer' ? 'Transfer ownership' : 'Delete server'}</button>
          </div>
        </Modal>
      )}
    </>
  );
}
