import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
import Cropper from './Cropper.jsx';
import { toast, askConfirm } from './Dialogs.jsx';
import { ACCEPT_ATTR, AVATAR_SIZE, BANNER_SIZE, checkImageFile, imageUrl, uploadImage } from './image.js';

// A creator's own Clips identity: a username, display name, icon and banner used on Clips INSTEAD of their Aduna profile.
// Nothing carries over from the Aduna profile (the server never falls back to it once this is set), so the two accounts cannot be linked.
// The same form is used twice: in the pop-up offered once after becoming a creator, and on the dashboard's Profile page.
const BASE = '/api/clips/creator/profile';
const WEEK = 7 * 24 * 3600 * 1000;
const NAME_OK = /^[a-zA-Z0-9_]{3,20}$/;

// when the username can next change, or 0 if it can change now
function lockedUntil(profile) {
  if (!profile || !profile.custom || !profile.usernameChangedAt) return 0;
  const t = profile.usernameChangedAt + WEEK;
  return t > Date.now() ? t : 0;
}

function ProfileForm({ profile, submitLabel, onSaved, children }) {
  const custom = !!(profile && profile.custom);
  const [username, setUsername] = useState(profile ? profile.username : '');          // starts as what Clips shows for you now
  const [displayName, setDisplayName] = useState(profile ? profile.displayName : '');
  const [avatar, setAvatar] = useState(null);   // { blob, url } picked but not saved yet
  const [banner, setBanner] = useState(null);
  const [dropAvatar, setDropAvatar] = useState(false); // remove the saved picture on save
  const [dropBanner, setDropBanner] = useState(false);
  const [picking, setPicking] = useState(null);  // { kind, file } while the crop window is open
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  const kindRef = useRef('avatar');

  // object URLs for the staged pictures are freed when they are replaced or the form closes
  useEffect(() => () => { if (avatar) URL.revokeObjectURL(avatar.url); }, [avatar]);
  useEffect(() => () => { if (banner) URL.revokeObjectURL(banner.url); }, [banner]);

  const lock = lockedUntil(profile);
  const savedAvatar = profile && !dropAvatar ? imageUrl(profile.avatarImage) : null; // until saved, this is the Aduna picture Clips shows now
  const savedBanner = profile && !dropBanner ? imageUrl(profile.bannerImage) : null;
  const avatarSrc = avatar ? avatar.url : savedAvatar;
  const bannerSrc = banner ? banner.url : savedBanner;
  const shownName = displayName.trim() || username.trim() || 'Your name';
  const letter = Array.from(shownName)[0].toUpperCase();

  const choose = (kind) => { kindRef.current = kind; fileRef.current.value = ''; fileRef.current.click(); };
  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try { checkImageFile(file); setErr(''); setPicking({ kind: kindRef.current, file }); }
    catch (ex) { setErr(ex.message); }
  };
  const applyCrop = (blob) => {
    const next = { blob, url: URL.createObjectURL(blob) };
    if (picking.kind === 'avatar') { setAvatar(next); setDropAvatar(false); } else { setBanner(next); setDropBanner(false); }
    setPicking(null);
  };
  const removeImage = (kind) => {
    if (kind === 'avatar') { setAvatar(null); setDropAvatar(!!(profile && profile.avatarImage)); } else { setBanner(null); setDropBanner(!!(profile && profile.bannerImage)); }
  };

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    const name = username.trim().replace(/^@/, '');
    if (!NAME_OK.test(name)) { setErr('Username must be 3-20 letters, numbers or underscores'); return; }
    setBusy(true); setErr('');
    try {
      // the name first: the server only accepts pictures once the Clips profile exists
      let p = (await api('/clips/creator/profile', { method: 'PATCH', body: { username: name, displayName: displayName.trim() } })).profile;
      // the first save creates the Clips identity, which never falls back to the Aduna profile, so the pictures Clips shows now are copied across
      const carry = async (kind, id) => {
        const r = await fetch(imageUrl(id));
        if (!r.ok) throw new Error('Could not read the picture');
        return (await uploadImage(kind, await r.blob(), BASE)).profile;
      };
      if (avatar) p = (await uploadImage('avatar', avatar.blob, BASE)).profile;
      else if (dropAvatar) { if (custom) p = (await api('/clips/creator/profile/avatar', { method: 'DELETE' })).profile; }
      else if (!custom && profile && profile.avatarImage) { try { p = await carry('avatar', profile.avatarImage); } catch { /* it just starts without one */ } }
      if (banner) p = (await uploadImage('banner', banner.blob, BASE)).profile;
      else if (dropBanner) { if (custom) p = (await api('/clips/creator/profile/banner', { method: 'DELETE' })).profile; }
      else if (!custom && profile && profile.bannerImage) { try { p = await carry('banner', profile.bannerImage); } catch { /* it just starts without one */ } }
      setAvatar(null); setBanner(null); setDropAvatar(false); setDropBanner(false);
      onSaved(p);
    } catch (ex) {
      setErr(ex.message); // the name may already be saved if a picture failed; pressing Save again is safe
    } finally { setBusy(false); }
  };

  return (
    <form className="cp-form" onSubmit={save} noValidate>
      <div className="cp-preview">
        <div className={'cp-banner' + (bannerSrc ? '' : ' empty')} style={bannerSrc ? { backgroundImage: `url("${bannerSrc}")` } : undefined}>
          <div className="cp-banner-actions">
            <button type="button" className="cp-pick" onClick={() => choose('banner')} disabled={busy}><Icon name="camera" size={15} /> {bannerSrc ? 'Change banner' : 'Add a banner'}</button>
            {bannerSrc && <button type="button" className="cp-pick cp-pick-x" onClick={() => removeImage('banner')} disabled={busy} aria-label="Remove banner"><Icon name="trash" size={15} /></button>}
          </div>
        </div>
        <div className="cp-who">
          <div className="cp-avatar-wrap">
            <button type="button" className="cp-avatar" onClick={() => choose('avatar')} disabled={busy} aria-label={avatarSrc ? 'Change icon' : 'Add an icon'}>
              {avatarSrc ? <img src={avatarSrc} alt="" draggable={false} /> : <span>{letter}</span>}
              <i aria-hidden="true"><Icon name="camera" size={20} /></i>
            </button>
            {avatarSrc && <button type="button" className="cp-avatar-x" onClick={() => removeImage('avatar')} disabled={busy} aria-label="Remove icon"><Icon name="close" size={12} /></button>}
          </div>
          <div className="cp-names">
            <b>{shownName}</b>
            <span className="muted">@{username.trim().replace(/^@/, '') || 'username'}</span>
          </div>
        </div>
      </div>
      <input ref={fileRef} type="file" accept={ACCEPT_ATTR} hidden onChange={onFile} />

      <div className="cp-field">
        <span className="cp-label" id="cp-dn-l">Display name</span>
        <input className="cp-input" aria-labelledby="cp-dn-l" name="clips-display-name" value={displayName} maxLength={32} autoComplete="off" disabled={busy} placeholder="How your name looks on Clips" onChange={(e) => setDisplayName(e.target.value)} />
        <small className="cp-help">Up to 32 characters. Leave it empty to use your username. You can change it any time.</small>
      </div>
      <div className="cp-field">
        <span className="cp-label" id="cp-un-l">Username</span>
        <div className="cp-at">
          <i aria-hidden="true">@</i>
          <input className="cp-input" aria-labelledby="cp-un-l" name="clips-handle" value={username} maxLength={21} autoComplete="off" autoCapitalize="off" spellCheck="false" disabled={busy || !!lock} placeholder="3 to 20 letters, numbers or _" onChange={(e) => setUsername(e.target.value)} />
        </div>
        <small className="cp-help">
          {lock ? `You can change your Clips username again on ${new Date(lock).toLocaleDateString(undefined, { dateStyle: 'medium' })}.` : 'Shown as @username on Clips. After saving you can change it once every 7 days.'}
        </small>
      </div>

      <p className="muted cp-note">{custom ? 'Only what is here shows on Clips.' : 'This starts as your Aduna profile. Change anything to make your Clips identity different; once saved, Clips shows only what is here.'}</p>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="cp-actions">
        {children}
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </div>

      {picking && (
        <Cropper
          file={picking.file}
          size={picking.kind === 'avatar' ? AVATAR_SIZE : BANNER_SIZE}
          shape={picking.kind === 'avatar' ? 'square' : 'wide'}
          title={picking.kind === 'avatar' ? 'Crop your icon' : 'Crop your banner'}
          onApply={applyCrop}
          onCancel={() => setPicking(null)}
        />
      )}
    </form>
  );
}

// The pop-up shown once, right after someone becomes a creator. Closing it or choosing Skip keeps the Aduna profile showing on Clips.
export function SetupPopup({ profile, onSaved, onSkip }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape' && !document.querySelector('.overlay')) onSkip(); }; // the crop window answers Escape first
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onSkip]);
  const skip = async () => {
    if (busy) return;
    setBusy(true);
    await onSkip();
    setBusy(false);
  };
  return (
    <div className="dash-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) skip(); }}>
      <div className="dash-menu cp-menu" role="dialog" aria-modal="true" aria-labelledby="cp-title">
        <header className="dash-menu-head">
          <h2 id="cp-title">Set up your creator profile</h2>
          <button className="dash-menu-x" aria-label="Close" disabled={busy} onClick={skip}>✕</button>
        </header>
        <div className="dash-menu-body cp-body">
          <p className="dash-terms-lead">Pick how you show up on Clips. This can be completely different from your Aduna account: its own username, name, icon and banner.</p>
          <ProfileForm profile={profile} submitLabel="Save and continue" onSaved={(p) => { toast('Your creator profile is saved'); onSaved(p); }}>
            <button type="button" className="btn" disabled={busy} onClick={skip}>Skip for now</button>
          </ProfileForm>
        </div>
      </div>
    </div>
  );
}

// The dashboard's Profile page.
export function ProfilePage({ profile, onChange }) {
  const [busy, setBusy] = useState(false);
  if (!profile) return <div className="dash-card"><p className="muted clip-note">Loading…</p></div>;

  const useAduna = async () => {
    const ok = await askConfirm({ title: 'Use your Aduna profile on Clips?', body: 'Your Clips username, display name, icon and banner are deleted, and Clips shows your Aduna profile again. Your clips and followers stay.', confirmLabel: 'Use my Aduna profile', danger: true });
    if (!ok) return;
    setBusy(true);
    try { onChange((await api('/clips/creator/profile', { method: 'DELETE' })).profile); toast('Clips now shows your Aduna profile'); }
    catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="dash-card">
        <h2>{profile.custom ? 'Your creator profile' : 'Make a separate creator profile'}</h2>
        <p className="muted">
          {profile.custom
            ? 'This is how you appear on Clips: on your clips, your Clips page and in search.'
            : `Right now Clips shows your Aduna profile (@${profile.accountUsername}). Pick a different username, name, icon and banner to keep your Clips identity separate.`}
        </p>
        <ProfileForm key={profile.custom ? 'c' + (profile.usernameChangedAt || 0) : 'n'} profile={profile} submitLabel={profile.custom ? 'Save changes' : 'Create creator profile'} onSaved={(p) => { onChange(p); toast('Saved'); }} />
      </div>
      {profile.custom && (
        <div className="dash-card">
          <h2>Go back to your Aduna profile</h2>
          <p className="muted">Stop using a separate Clips identity. Your Aduna username, name, icon and banner show on Clips again.</p>
          <div><button className="btn" disabled={busy} onClick={useAduna}>Use my Aduna profile</button></div>
        </div>
      )}
    </>
  );
}

// a small identity row for the front page
export function IdentityRow({ profile, onEdit }) {
  if (!profile) return null;
  const src = imageUrl(profile.avatarImage);
  const name = profile.displayName || profile.username || '?';
  return (
    <div className="cp-row">
      <span className="cp-avatar sm">{src ? <img src={src} alt="" draggable={false} /> : <span>{Array.from(name)[0].toUpperCase()}</span>}</span>
      <div className="cp-names"><b>{name}</b><span className="muted">@{profile.username}</span></div>
      <button className="btn" onClick={onEdit}>Edit profile</button>
    </div>
  );
}
