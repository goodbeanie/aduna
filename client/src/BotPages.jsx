import React, { useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar, Modal } from './ui.jsx';
import { ACCEPT_ATTR, AVATAR_SIZE, checkImageFile, imageUrl, processImage, uploadImage } from './image.js';

// A bot's own page: its picture, banner and long description. Two parts:
//   BotPictures  Settings > Developer: choose or remove the picture and the banner (needs a saved bot)
//   BotDetails   the Bots tab in the Explorer: the page people see when they open a bot
// The numbers are LIMITS in server/bots.js, which checks them again (the banner may be up to 1600 x 600 there).

export const BOT_BANNER = { w: 1200, h: 400 }; // 3:1, the same shape as the banner at the top of a bot's page

const asUser = (b) => ({ id: b.id, username: b.name, displayName: b.name, avatarImage: b.avatarImage, avatarColor: '#8c6b4f' });
const bannerStyle = (b) => (b.bannerImage ? { backgroundImage: `url(${imageUrl(b.bannerImage)})` } : undefined);

export function BotPictures({ bot, held, onSaved }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const avatarIn = useRef(null);
  const bannerIn = useRef(null);

  async function pick(kind, file) {
    if (!file) return;
    setErr(''); setBusy(kind);
    try {
      checkImageFile(file);
      const blob = await processImage(file, kind === 'avatar' ? AVATAR_SIZE : BOT_BANNER);
      const r = await uploadImage(kind, blob, `/api/bots/${bot.id}`);
      onSaved(r.bot);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function remove(kind) {
    setErr(''); setBusy(kind);
    try { const r = await api(`/bots/${bot.id}/${kind}`, { method: 'DELETE' }); onSaved(r.bot); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }

  const off = held || !!busy;
  return (
    <div className="bot-pics">
      <label>PICTURE AND BANNER</label>
      <div className={'bot-banner-pic' + (bot.bannerImage ? '' : ' empty')} style={bannerStyle(bot)}>
        {!bot.bannerImage && <span className="muted small">No banner yet</span>}
      </div>
      <div className="bot-pics-row">
        <Avatar user={asUser(bot)} size={56} />
        <div className="bot-pics-btns">
          <button type="button" className="btn small-btn" disabled={off} onClick={() => avatarIn.current?.click()}>{busy === 'avatar' ? 'Saving…' : bot.avatarImage ? 'Change picture' : 'Add picture'}</button>
          {bot.avatarImage && <button type="button" className="btn small-btn" disabled={off} onClick={() => remove('avatar')}>Remove picture</button>}
          <button type="button" className="btn small-btn" disabled={off} onClick={() => bannerIn.current?.click()}>{busy === 'banner' ? 'Saving…' : bot.bannerImage ? 'Change banner' : 'Add banner'}</button>
          {bot.bannerImage && <button type="button" className="btn small-btn" disabled={off} onClick={() => remove('banner')}>Remove banner</button>}
        </div>
      </div>
      <input ref={avatarIn} type="file" hidden accept={ACCEPT_ATTR} onChange={(e) => { pick('avatar', e.target.files[0]); e.target.value = ''; }} />
      <input ref={bannerIn} type="file" hidden accept={ACCEPT_ATTR} onChange={(e) => { pick('banner', e.target.files[0]); e.target.value = ''; }} />
      <p className="muted small hint">The picture is square and the banner is wide (3 to 1, best at 1200 x 400): both are cropped to fit. The banner shows on the bot&rsquo;s page and on its profile. Pictures save as soon as you choose them.</p>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

// `bot` comes from /explore/bots (a public bot). onAdd opens the "Add to server" picker.
export function BotDetails({ bot, onAdd, onClose }) {
  const by = bot.developer ? (bot.developer.displayName || bot.developer.username) : 'a developer';
  return (
    <Modal title={bot.name} onClose={onClose} wide>
      <div className="bot-page">
        <div className={'bot-page-banner' + (bot.bannerImage ? '' : ' empty')} style={bannerStyle(bot)} />
        <div className="bot-page-head">
          <Avatar user={asUser(bot)} size={64} />
          <div>
            <div className="bot-head"><b className="bot-name">{bot.name}</b><span className="bot-tag">BOT</span></div>
            <div className="muted small">by {by} · {bot.installs} server{bot.installs === 1 ? '' : 's'}</div>
          </div>
        </div>
        {bot.tags.length > 0 && <div className="tag-row">{bot.tags.map((t) => <span key={t} className="tag">#{t}</span>)}</div>}
        {bot.description && <p className="bot-page-short">{bot.description}</p>}
        {bot.about && <div className="bot-page-about">{bot.about}</div>}
        {!bot.about && !bot.description && <p className="muted small">This bot has no description yet.</p>}
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={onAdd}>Add to server</button>
        </div>
      </div>
    </Modal>
  );
}
