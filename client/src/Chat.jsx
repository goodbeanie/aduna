import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar, Icon, Modal, timeLabel } from './ui.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import { Attachments, EmojiPop, GifPop, Lightbox } from './Attachments.jsx';
import { Rich, useEmoji } from './Emoji.jsx';
import { InviteCard, inviteCodesIn } from './Invite.jsx';
import { MentionMenu, fromMentionTokens, mentionPreview, toMentionTokens, useMentionComplete } from './Mentions.jsx';
import { FILE_DAYS, LARGE_FILE_DAYS, MAX_ATTACH, discardUpload, previewText, sizeLabel, uploadFile } from './files.js';

function Picker({ onPick, onClose }) {
  const ref = useRef(null);
  const [place, setPlace] = useState(null); // null until measured; 'sheet' on phones
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement?.getBoundingClientRect();
    const W = 340, H = 380, vw = window.innerWidth, vh = window.innerHeight;
    if (!anchor || vw <= 720) return setPlace('sheet');
    const left = Math.min(Math.max(8, anchor.right - W), vw - W - 8);
    let top = anchor.bottom + 6;
    if (top + H > vh - 8) top = Math.max(8, anchor.top - H - 6);
    setPlace({ left, top });
  }, []);
  useEffect(() => {
    const h = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    const k = (e) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => document.addEventListener('mousedown', h), 0);
    document.addEventListener('keydown', k);
    window.addEventListener('resize', onClose);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); window.removeEventListener('resize', onClose); };
  }, [onClose]);
  const sheet = place === 'sheet';
  return (
    <>
      {sheet && <div className="sheet-backdrop" onClick={onClose} />}
      <div className={'picker' + (sheet ? ' sheet' : '')} ref={ref} style={place && !sheet ? { left: place.left, top: place.top } : place ? undefined : { visibility: 'hidden' }}>
        <EmojiPicker onPick={(e) => { onPick(e); onClose(); }} onCustom={(e) => { onPick('c:' + e.id); onClose(); }} />
      </div>
    </>
  );
}

function EditBox({ initial, allowEmpty, onSave, onCancel, people, everyone }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const mc = useMentionComplete({ text: v, setText: setV, inputRef: ref, people, everyone });
  useEffect(() => { const el = ref.current; el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, []);
  async function save() {
    const t = v.trim();
    if ((!t && !allowEmpty) || busy) return;
    if (t === initial.trim()) return onCancel();
    setBusy(true); setErr('');
    try { await onSave(t); onCancel(); } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <div className="edit-box">
      <MentionMenu mc={mc} />
      <textarea ref={ref} className="composer" rows={Math.min(8, v.split('\n').length + 1)} value={v} maxLength={2000} {...mc.bind}
        onChange={(e) => { setV(e.target.value); mc.track(e); }}
        onKeyDown={(e) => {
          if (mc.onKeyDown(e)) return;
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
          if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
        }} />
      <div className="edit-hint">
        {err ? <span className="error-text">{err}</span> : <>escape to <button onClick={onCancel}>cancel</button> · enter to <button onClick={save}>save</button></>}
      </div>
    </div>
  );
}

function Message({ m, users, me, byId, presence, onReact, onReply, onUser, onEdit, onDelete, editing, setEditing, grouped, canDelete, dm, onOpen, tapped, onTap, encode, decode, people, canEveryone }) {
  const [picker, setPicker] = useState(false);
  const { lib, openMenu } = useEmoji();
  const mine = m.authorId === me.id;
  const author = users[m.authorId];
  const ref = m.replyTo ? byId[m.replyTo] : null;
  const refAuthor = ref ? users[ref.authorId] : null;
  // channel messages carry the server's verdict; DMs are encrypted, so the client reads its own token
  const pinged = !!m.everyone || !!m.mentions?.includes(me.id) || (!!dm && !!m.content?.includes('<@' + me.id + '>'));
  const mention = { users, meId: me.id, onUser, everyone: !!m.everyone };

  return (
    <div className={'msg' + (grouped ? ' grouped' : '') + (mine ? ' mine' : '') + (editing ? ' editing' : '') + (tapped ? ' tapped' : '') + (pinged ? ' pinged' : '')} id={'m-' + m.id}
      onClick={(e) => { if (!editing && !e.target.closest('button, a, img, video, audio, textarea, input, .toolbar')) onTap?.(); }}>
      {m.replyTo && (
        <div className="reply-ref" onClick={() => document.getElementById('m-' + m.replyTo)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
          <span className="reply-line" />
          {ref ? (
            <>
              <Avatar user={refAuthor} size={16} />
              <b data-nc style={{ '--nc': refAuthor?.accentColor }}>{refAuthor?.displayName || 'Unknown'}</b>
              <span className="reply-text">{mentionPreview(previewText(ref), users)}</span>
            </>
          ) : <i className="muted">Original message was deleted or isn't loaded</i>}
        </div>
      )}
      <div className="msg-row">
        {grouped ? <div className="gutter"><span className="hover-time">{new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
          : <button className="avatar-btn" onClick={() => onUser(m.authorId)}><Avatar user={author} size={40} presence={presence[m.authorId] && presence[m.authorId] !== 'offline' ? presence[m.authorId] : undefined} /></button>}
        <div className="msg-body">
          {!grouped && (
            <div className="msg-head">
              <button className="name" data-nc style={{ '--nc': author?.accentColor }} onClick={() => onUser(m.authorId)}>{author?.displayName || 'Unknown'}</button>
              <span className="time">{timeLabel(m.createdAt)}</span>
            </div>
          )}
          {editing
            ? <EditBox initial={decode(m.content)} people={people} everyone={canEveryone} allowEmpty={!!m.attachments?.length || !!m.invite} onSave={(t) => { const x = encode(t); if (x.length > 2000) throw new Error('That message is too long once emoji and mentions are expanded'); return onEdit(m.id, x); }} onCancel={() => setEditing(null)} />
            : (m.content || m.editedAt) && <div className="content"><Rich text={m.content} mention={mention} />{m.editedAt && <span className="edited" title={'Edited ' + timeLabel(m.editedAt)}>(edited)</span>}</div>}
          {m.invite && <InviteCard code={m.invite} />}
          {!editing && inviteCodesIn(m.content).filter((c) => c !== m.invite).map((c) => <InviteCard key={c} code={c} />)}
          <Attachments atts={m.attachments} dm={dm} onOpen={(v) => onOpen({ ...v, dm })} />
          {Object.keys(m.reactions || {}).length > 0 && (
            <div className="reactions">
              {Object.entries(m.reactions).map(([emoji, ids]) => (
                <button key={emoji} className={'chip' + (ids.includes(me.id) ? ' on' : '')} onClick={() => onReact(m.id, emoji)}
                  onContextMenu={emoji.startsWith('c:') ? (e) => { e.preventDefault(); openMenu(emoji.slice(2), lib.find((x) => x.id === emoji.slice(2))?.name || 'emoji', e.clientX, e.clientY); } : undefined}
                  title={(emoji.startsWith('c:') ? ':' + (lib.find((x) => x.id === emoji.slice(2))?.name || 'custom emoji') + ': (right-click to save or report)\n' : '') + ids.map((i) => users[i]?.displayName || '?').join(', ')}>
                  {emoji.startsWith('c:') ? <img className="cemoji" src={`/api/emoji/${emoji.slice(2)}/image`} alt="" /> : emoji} <span>{ids.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="toolbar">
          <button title="Add reaction" onClick={() => setPicker(true)}><Icon name="smile" size={17} /></button>
          <button title="Reply" onClick={() => onReply(m)}><Icon name="reply" size={17} /></button>
          {mine && <button title="Edit" onClick={() => setEditing(m.id)}><Icon name="edit" size={17} /></button>}
          {canDelete && <button title="Delete" className="del" onClick={() => onDelete(m)}><Icon name="trash" size={17} /></button>}
          {picker && !editing && <Picker onPick={(e) => onReact(m.id, e)} onClose={() => setPicker(false)} />}
        </div>
      </div>
    </div>
  );
}

export default function Chat({ title, subtitle, headerExtra, onBack, messages, users, me, presence, onSend, onReact, onEdit, onDelete, canModerate, onTyping, typingNames, placeholder, notice, onUser, files, gifEnabled, readOnly, mentionables, canEveryone }) {
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [pending, setPending] = useState([]); // uploads: { key, name, size, type, progress, att, err, preview }
  const [pop, setPop] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [tapped, setTapped] = useState(null); // touch screens: tap a message to show its actions
  const fileInput = useRef(null);
  const { lib, toTokens, fromTokens } = useEmoji();
  const people = mentionables || [];
  const encode = (t) => toMentionTokens(toTokens(t), people); // :emoji: and @username -> tokens, as stored
  const decode = (t) => fromMentionTokens(fromTokens(t), users); // and back, for editing
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const scroller = useRef(null);
  const stick = useRef(true);
  const lastTyping = useRef(0);
  const inputRef = useRef(null);
  const mc = useMentionComplete({ text, setText, inputRef, people, everyone: canEveryone });

  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => { setReplyTo(null); setEditing(null); setConfirmDel(null); setPop(null); clearPending(true); setText(''); stick.current = true; setTapped(null); if (window.matchMedia?.('(hover: hover)').matches) inputRef.current?.focus(); }, [title]);

  // drop a pending reply / edit if its message disappears
  useEffect(() => {
    if (replyTo && !byId[replyTo.id]) setReplyTo(null);
    if (editing && !byId[editing]) setEditing(null);
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // the composer grows with what you type (up to a limit)
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px'; }
  }, [text]);

  async function doDelete() {
    const m = confirmDel;
    try { await onDelete(m.id); setConfirmDel(null); } catch (e) { setConfirmDel(null); setErr(e.message); }
  }

  function clearPending(discard) {
    for (const p of pendingRef.current) { if (p.preview) URL.revokeObjectURL(p.preview); if (discard && p.att) discardUpload(p.att.id); }
    setPending([]);
  }
  const patch = (key, fields) => setPending((l) => l.map((p) => (p.key === key ? { ...p, ...fields } : p)));
  function removePending(p) {
    if (p.preview) URL.revokeObjectURL(p.preview);
    if (p.att) discardUpload(p.att.id);
    setPending((l) => l.filter((x) => x.key !== p.key));
  }
  function addFiles(list) {
    const picked = [...list];
    if (!picked.length) return;
    if (!files?.scope) return setErr('You can only send files to friends');
    const room = MAX_ATTACH - pendingRef.current.length;
    if (picked.length > room) setErr(`You can attach up to ${MAX_ATTACH} files per message`);
    else setErr('');
    for (const f of picked.slice(0, Math.max(room, 0))) {
      const key = Math.random().toString(36).slice(2);
      const entry = { key, name: f.name || 'pasted-file', size: f.size, type: f.type, progress: 0, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      setPending((l) => [...l, entry]);
      uploadFile(f, files.scope, (progress) => patch(key, { progress }))
        .then((att) => patch(key, { att, progress: 1 }))
        .catch((e) => patch(key, { err: e.message }));
    }
  }
  const uploading = pending.some((p) => !p.att && !p.err);

  async function sendGif(g) {
    setPop(null); setErr('');
    try {
      await onSend('', replyTo?.id || null, [{ gif: true, url: g.url, w: g.w, h: g.h, title: g.title }]);
      setReplyTo(null); stick.current = true;
    } catch (e) { setErr(e.message); }
  }

  async function submit() {
    const t = encode(text.trim());
    const atts = pending.filter((p) => p.att).map((p) => p.att);
    if ((!t && !atts.length) || uploading) return;
    if (t.length > 2000) return setErr('That message is too long once emoji and mentions are expanded');
    setErr('');
    try {
      await onSend(t, replyTo?.id || null, atts);
      setText('');
      clearPending(false);
      setReplyTo(null);
      stick.current = true;
    } catch (e) { setErr(e.message); }
  }

  function onKey(e) {
    if (mc.onKeyDown(e)) return;
    if (e.key === 'Tab' && suggestions.length && !e.shiftKey) { e.preventDefault(); pickSuggestion(suggestions[0]); return; }
    // on a touch screen Enter adds a new line and the send button sends
    if (e.key === 'Enter' && !e.shiftKey && !window.matchMedia?.('(pointer: coarse)').matches) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') setReplyTo(null);
    if (e.key === 'ArrowUp' && !text) {
      const last = [...messages].reverse().find((m) => m.authorId === me.id);
      if (last) { e.preventDefault(); setEditing(last.id); }
    }
  }

  // typing ":par" offers matching custom emoji
  const partial = /(?:^|\s):([a-z0-9_]{1,32})$/i.exec(text);
  const suggestions = partial ? lib.filter((e) => e.name.startsWith(partial[1].toLowerCase())).slice(0, 8) : [];
  function pickSuggestion(e) {
    setText((t) => t.replace(/:([a-z0-9_]{1,32})$/i, `:${e.name}: `));
    inputRef.current?.focus();
  }

  function onChange(e) {
    setText(e.target.value);
    mc.track(e);
    const t = Date.now();
    if (t - lastTyping.current > 2500) { lastTyping.current = t; onTyping?.(); }
  }

  return (
    <section className="chat"
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget) || setDragging(false)}
      onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); } }}>
      <header className="chat-head">
        {onBack && <button className="icon-btn back-btn" title="Back" aria-label="Back to list" onClick={onBack}><Icon name="back" size={22} /></button>}
        <span className="hash">{subtitle}</span>
        <h3>{title}</h3>
        <div className="spacer" />
        {headerExtra}
      </header>
      <div className="scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {notice && <div className="notice">{notice}</div>}
        {messages.length === 0 && <div className="empty">No messages yet. Say hello.</div>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 5 * 60000 && !m.replyTo;
          return <Message key={m.id} m={m} grouped={grouped} users={users} me={me} byId={byId} presence={presence}
            onReact={onReact} onReply={(x) => { setReplyTo(x); setEditing(null); inputRef.current?.focus(); }} onUser={onUser}
            onEdit={onEdit} onDelete={setConfirmDel} editing={editing === m.id} setEditing={setEditing} encode={encode} decode={decode} people={people} canEveryone={canEveryone}
            canDelete={m.authorId === me.id || !!canModerate} dm={files?.dm} onOpen={setLightbox}
            tapped={tapped === m.id} onTap={() => setTapped((t) => (t === m.id ? null : m.id))} />;
        })}
      </div>
      {readOnly ? <div className="composer-wrap readonly"><div className="readonly-note"><Icon name="lock" size={15} className="inline-icon" /> {readOnly}</div></div> : <div className="composer-wrap">
        {replyTo && (
          <div className="replying">
            Replying to <b>{users[replyTo.authorId]?.displayName || 'Unknown'}</b>
            <span className="reply-text">{mentionPreview(previewText(replyTo), users)}</span>
            <button className="icon-btn" title="Cancel reply" onClick={() => setReplyTo(null)}><Icon name="close" size={15} /></button>
          </div>
        )}
        <MentionMenu mc={mc} />
        {suggestions.length > 0 && (
          <div className="suggest">
            {suggestions.map((e, i) => (
              <button key={e.id} onClick={() => pickSuggestion(e)}><img className="cemoji" src={`/api/emoji/${e.id}/image`} alt="" />:{e.name}:{i === 0 && <span className="muted small"> Tab</span>}</button>
            ))}
          </div>
        )}
        {pending.length > 0 && (
          <div className="pending">
            {pending.map((p) => (
              <div key={p.key} className={'pend' + (p.err ? ' bad' : '')} title={p.err || p.name}>
                {p.preview ? <img src={p.preview} alt="" /> : <Icon name="file" size={26} />}
                <div className="pend-name">{p.name}</div>
                <div className="muted small">{p.err || (p.att ? sizeLabel(p.size) : Math.round(p.progress * 100) + '%')}</div>
                {!p.att && !p.err && <div className="pend-bar"><i style={{ width: p.progress * 100 + '%' }} /></div>}
                <button className="pend-x" title="Remove" onClick={() => removePending(p)}><Icon name="close" size={13} /></button>
              </div>
            ))}
            <div className="muted small" style={{ flexBasis: '100%' }}>Files are removed {FILE_DAYS} days after sending ({LARGE_FILE_DAYS} days if over 10 MB).</div>
          </div>
        )}
        <div className="composer-row">
          <button className="icon-btn" title="Attach files (max 20 MB each; removed after 14 days, or 5 days if over 10 MB)" disabled={!files?.scope} onClick={() => fileInput.current?.click()}><Icon name="clip" size={20} /></button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <textarea ref={inputRef} className="composer" rows={1} value={text} onChange={onChange} onKeyDown={onKey} placeholder={placeholder} maxLength={2000} {...mc.bind}
            onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }} />
          <div className="comp-tools">
            <button className="icon-btn" title="Emoji" onClick={() => setPop(pop === 'emoji' ? null : 'emoji')}><Icon name="smile" size={20} /></button>
            <button className="icon-btn gif-btn" title="GIF" onClick={() => setPop(pop === 'gif' ? null : 'gif')}>GIF</button>
          </div>
          <button className="icon-btn send-btn" title="Send" aria-label="Send" onMouseDown={(e) => e.preventDefault()} onClick={submit} disabled={uploading || (!text.trim() && !pending.some((p) => p.att))}><Icon name="send" size={19} /></button>
          {pop === 'emoji' && <EmojiPop onClose={() => setPop(null)} onPick={(e) => { setText((t) => t + e); setPop(null); inputRef.current?.focus(); }} />}
          {pop === 'gif' && <GifPop enabled={gifEnabled} onClose={() => setPop(null)} onPick={sendGif} />}
        </div>
        <div className="typing">{err ? <span className="error-text">{err}</span> : typingNames.length ? `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…` : ' '}</div>
      </div>}
      {dragging && <div className="drop-hint"><Icon name="clip" size={28} />Drop files to send</div>}
      {lightbox && <Lightbox view={lightbox} onClose={() => setLightbox(null)} />}
      {confirmDel && (
        <Modal title="Delete message" onClose={() => setConfirmDel(null)}>
          <p className="muted">This permanently removes the message for everyone in this conversation.</p>
          <div className="del-preview"><b data-nc style={{ '--nc': users[confirmDel.authorId]?.accentColor }}>{users[confirmDel.authorId]?.displayName}</b><div className="reply-text">{mentionPreview(previewText(confirmDel), users)}</div></div>
          <div className="modal-foot">
            <button className="btn" onClick={() => setConfirmDel(null)}>Cancel</button>
            <button className="btn primary danger-fill" autoFocus onClick={doDelete}>Delete</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
