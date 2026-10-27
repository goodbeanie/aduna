import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Avatar, BadgeIcons, Icon, Modal, timeLabel } from './ui.jsx';
import EmojiPicker from './EmojiPicker.jsx';
import { Attachments, EmojiPop, GifPop, Lightbox } from './Attachments.jsx';
import { Rich, useEmoji } from './Emoji.jsx';
import { InviteCard, inviteCodesIn } from './Invite.jsx';
import { ClipEmbed, clipIdsIn, isOnlyClipLink } from './ClipEmbed.jsx';
import { MentionMenu, fromMentionTokens, mentionPreview, toMentionTokens, useMentionComplete } from './Mentions.jsx';
import { useTypingProof } from './typing.js';
import { BotTag } from './Bots.jsx';
import { PollCard, PollModal } from './Polls.jsx';
import { callSummary } from './callhistory.js';
import { FILE_DAYS, LARGE_FILE_DAYS, MAX_ATTACH, MAX_FILE, discardUpload, previewText, sizeLabel, uploadFile } from './files.js';
import { canCompress, compressVideo } from './compress.js';
import { getDraft, setDraft } from './drafts.js';
import { getSeen, markSeen } from './seen.js';
import VoiceRecorder, { voiceSupported } from './VoiceRecorder.jsx';
import ReactorsModal from './Reactors.jsx';
import { useContextMenu, wantsNative } from './ContextMenu.jsx';
import { api } from './api.js';
import { EmptyState, ListSkeleton, kbd } from './ShellBits.jsx';

const QUICK_REACTION = '\u2764\uFE0F'; // what a double-tap / double-click on a message reacts with

// "Today", "Yesterday", or the date: the line between messages from different days.
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, now.getTime() - 86400000)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

// Grey placeholder rows while a conversation's history is on its way, so it never flashes "No messages yet".
const SKELETON_ROWS = [[120, 2], [90, 1], [160, 3], [70, 1], [140, 2], [100, 1]];
function MessageSkeleton() {
  return (
    <div className="skel-list" role="status" aria-busy="true" aria-label="Loading messages">
      {SKELETON_ROWS.map(([w, lines], i) => (
        <div className="skel-msg" key={i} aria-hidden="true">
          <span className="skel skel-avatar" />
          <div className="skel-body">
            <span className="skel skel-line" style={{ width: w }} />
            {Array.from({ length: lines }, (_, j) => <span key={j} className="skel skel-line" style={{ width: j === lines - 1 ? '45%' : '85%' }} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

// A conversation with nothing in it yet.
function EmptyChat({ title, subtitle }) {
  const dm = subtitle === '@';
  return (
    <EmptyState icon="message" title={dm ? `This is the start of your conversation with ${title}` : `This is the start of ${subtitle === '#' ? '#' : ''}${title}`}>
      {dm ? 'Say hello. Only the two of you can read what is said here.' : 'Nothing has been said here yet. Say hello.'}
    </EmptyState>
  );
}

function Picker({ onPick, onClose, at }) {
  const ref = useRef(null);
  const [place, setPlace] = useState(null); // null until measured; 'sheet' on phones
  useLayoutEffect(() => {
    const W = 340, H = 380, vw = window.innerWidth, vh = window.innerHeight;
    if (at && vw > 720) { // opened from the right-click menu: sit where the pointer was (the toolbar is hidden then, so it can't be the anchor)
      const left = Math.min(Math.max(8, at.x), vw - W - 8);
      const top = at.y + 6 + H > vh - 8 ? Math.max(8, vh - H - 8) : at.y + 6;
      return setPlace({ left, top });
    }
    const anchor = ref.current?.parentElement?.getBoundingClientRect();
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
      <div className={'picker' + (sheet ? ' sheet' : '')} ref={ref} onContextMenu={(e) => e.stopPropagation()} style={place && !sheet ? { left: place.left, top: place.top } : place ? undefined : { visibility: 'hidden' }}>
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

// A finished call, shown in the DM at the time it ended ("Voice call · 4 min 12 s", "Missed video call"). Not a message: nothing to reply to, react to or edit.
function CallEntry({ m, users, me }) {
  const other = users[m.call.a === me.id ? m.call.b : m.call.a];
  const s = callSummary(m.call, me.id, other?.displayName || 'them');
  return (
    <div className={'call-entry' + (s.bad ? ' missed' : '')} id={'m-' + m.id}>
      <span className="call-ico"><Icon name={s.icon} size={16} /></span>
      <span className="call-title">{s.title}</span>
      <span className="call-detail muted">{s.detail}</span>
      <span className="call-time muted" title={new Date(m.call.startedAt).toLocaleString()}>{timeLabel(m.createdAt)}</span>
    </div>
  );
}

function Message({ m, users, roleColors, me, byId, presence, onVote, onClosePoll, onReact, onReply, onUser, onUserMenu, onEdit, onDelete, editing, setEditing, grouped, canDelete, canPin, onPin, dm, onOpen, tapped, onTap, encode, decode, people, canEveryone }) {
  const [picker, setPicker] = useState(false);
  const [ctxPicker, setCtxPicker] = useState(null); // { x, y }: the emoji picker opened from the right-click menu, placed where you clicked
  const [who, setWho] = useState(null); // the reaction chip that was clicked: opens the "who reacted" list on that emoji
  const lastTap = useRef(0);
  const { lib, openMenu } = useEmoji();
  const ctx = useContextMenu();
  const mine = m.authorId === me.id;
  const author = users[m.authorId];
  const ref = m.replyTo ? byId[m.replyTo] : null;
  const refAuthor = ref ? users[ref.authorId] : null;
  // channel messages carry the server's verdict; DMs are encrypted, so the client reads its own token
  const pinged = !!m.everyone || !!m.mentions?.includes(me.id) || (!!dm && !!m.content?.includes('<@' + me.id + '>'));
  const mention = { users, meId: me.id, onUser, everyone: !!m.everyone };

  // A tap or click on the message itself: one shows its actions on a touch screen, two in a row add a quick reaction
  // (only ever adds: if you already reacted with it, the second tap does nothing rather than take it back).
  function tapMessage(e) {
    if (editing || e.target.closest('button, a, img, video, audio, textarea, input, .toolbar, .reactions, .overlay, .invite-card, .link-card')) return;
    const now = Date.now();
    if (now - lastTap.current < 350) {
      lastTap.current = 0;
      window.getSelection?.()?.removeAllRanges();
      if (!m.reactions?.[QUICK_REACTION]?.includes(me.id)) onReact(m.id, QUICK_REACTION);
      return;
    }
    lastTap.current = now;
    onTap?.();
  }

  // Right-click (or long-press on a phone) on the message. Links, pictures, video, text boxes and selected text keep the browser's own menu.
  function messageMenu(e, at) { // `at` is given when the "more" button opens it: a point under the button instead of the pointer
    if (editing || (!at && wantsNative(e))) return;
    const text = m.content ? decode(m.content) : '';
    const { clientX: x, clientY: y } = at || e;
    ctx.open(at ? { preventDefault() {}, stopPropagation() {}, clientX: x, clientY: y } : e, {
      items: [
        { label: 'Add reaction', icon: 'smile', onClick: () => setCtxPicker({ x, y }) },
        { label: 'Reply', icon: 'reply', onClick: () => onReply(m) },
        canPin && { label: m.pinnedAt ? 'Unpin message' : 'Pin message', icon: 'pushpin', onClick: () => onPin(m, !m.pinnedAt) },
        mine && { label: 'Edit message', icon: 'edit', onClick: () => setEditing(m.id) },
        'sep',
        text && text !== '\u2026' && { label: 'Copy text', icon: 'copy', onClick: () => ctx.copy(text) },
        { label: 'View profile', icon: 'user', onClick: () => onUser(m.authorId) },
        canDelete && 'sep',
        canDelete && { label: 'Delete message', icon: 'trash', danger: true, onClick: () => onDelete(m) },
      ],
    });
  }
  // Right-click on the author's name or picture opens the person's menu instead (App supplies it); without one the message menu shows.
  const authorMenu = (e) => { if (onUserMenu) onUserMenu(e, m.authorId); };

  return (
    <div className={'msg' + (grouped ? ' grouped' : '') + (mine ? ' mine' : '') + (editing ? ' editing' : '') + (tapped ? ' tapped' : '') + (pinged ? ' pinged' : '')} id={'m-' + m.id}
      onClick={tapMessage} onContextMenu={messageMenu}>
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
          : <button className="avatar-btn" onClick={() => onUser(m.authorId)} onContextMenu={authorMenu}><Avatar user={author} size={40} presence={presence[m.authorId] && presence[m.authorId] !== 'offline' ? presence[m.authorId] : undefined} /></button>}
        <div className="msg-body">
          {m.pinnedAt && <div className="pin-flag"><Icon name="pushpin" size={12} /> Pinned</div>}
          {!grouped && (
            <div className="msg-head">
              <button className="name" data-nc style={{ '--nc': roleColors?.[m.authorId] || author?.accentColor }} onClick={() => onUser(m.authorId)} onContextMenu={authorMenu}>{author?.displayName || 'Unknown'}</button><BadgeIcons user={author} size={16} />
              {(author?.bot || m.bot) && <BotTag />}
              <span className="time">{timeLabel(m.createdAt)}</span>
            </div>
          )}
          {editing
            ? <EditBox initial={decode(m.content)} people={people} everyone={canEveryone} allowEmpty={!!m.attachments?.length || !!m.invite || !!m.poll} onSave={(t) => { const x = encode(t); if (x.length > 2000) throw new Error('That message is too long once emoji and mentions are expanded'); return onEdit(m.id, x); }} onCancel={() => setEditing(null)} />
            : (m.content || m.editedAt) && !(isOnlyClipLink(m.content) && !m.editedAt) && <div className="content"><Rich text={m.content} mention={mention} />{m.editedAt && <span className="edited" title={'Edited ' + timeLabel(m.editedAt)}>(edited)</span>}</div>}
          {m.poll && <PollCard m={m} users={users} me={me} onVote={onVote} onClose={onClosePoll} canClose={canDelete} />}
          {m.invite && <InviteCard code={m.invite} />}
          {!editing && inviteCodesIn(m.content).filter((c) => c !== m.invite).map((c) => <InviteCard key={c} code={c} />)}
          {!editing && clipIdsIn(m.content).map((id) => <ClipEmbed key={id} id={id} />)}
          <Attachments atts={m.attachments} dm={dm} onOpen={(v) => onOpen({ ...v, dm })} />
          {Object.keys(m.reactions || {}).length > 0 && (
            <div className="reactions">
              {Object.entries(m.reactions).map(([emoji, ids]) => (
                <button key={emoji} className={'chip' + (ids.includes(me.id) ? ' on' : '')} onClick={() => setWho(emoji)} aria-haspopup="dialog"
                  onContextMenu={emoji.startsWith('c:') ? (e) => { e.preventDefault(); e.stopPropagation(); openMenu(emoji.slice(2), lib.find((x) => x.id === emoji.slice(2))?.name || 'emoji', e.clientX, e.clientY); } : undefined}
                  title={(emoji.startsWith('c:') ? ':' + (lib.find((x) => x.id === emoji.slice(2))?.name || 'custom emoji') + ': (right-click to save or report)\n' : '') + ids.map((i) => users[i]?.displayName || '?').join(', ')}>
                  {emoji.startsWith('c:') ? <img className="cemoji" src={`/api/emoji/${emoji.slice(2)}/image`} alt="" /> : emoji} <span>{ids.length}</span>
                </button>
              ))}
              <button className="chip add" title="Add reaction" aria-label="Add reaction" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCtxPicker({ x: r.left, y: r.bottom }); }}><Icon name="plus" size={14} /></button>
            </div>
          )}
        </div>
        <div className="toolbar">
          <button title="Add reaction" onClick={() => setPicker(true)}><Icon name="smile" size={17} /></button>
          <button title="Reply" onClick={() => onReply(m)}><Icon name="reply" size={17} /></button>
          {mine && <button title="Edit" onClick={() => setEditing(m.id)}><Icon name="edit" size={17} /></button>}
          {canDelete && <button title="Delete" className="del" onClick={() => onDelete(m)}><Icon name="trash" size={17} /></button>}
          <button title="More" aria-label="More actions" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); messageMenu(e, { clientX: r.right, clientY: r.bottom + 4 }); }}><Icon name="more" size={17} /></button>
          {picker && !editing && <Picker onPick={(e) => onReact(m.id, e)} onClose={() => setPicker(false)} />}
        </div>
      </div>
      {who && <ReactorsModal reactions={m.reactions} start={who} users={users} me={me} onToggle={(e) => onReact(m.id, e)} onUser={onUser} onClose={() => setWho(null)} />}
      {ctxPicker && !editing && <Picker at={ctxPicker} onPick={(e) => onReact(m.id, e)} onClose={() => setCtxPicker(null)} />}
    </div>
  );
}

export default function Chat({ title, subtitle, headerExtra, stage, onBack, messages, loading, users, me, presence, onSend, onPoll, onVote, onClosePoll, onReact, onEdit, onDelete, canModerate, canPin, onPin, pinsFor, bell, roleColors, onTyping, typingNames, placeholder, notice, onUser, onUserMenu, files, gifEnabled, readOnly, mentionables, canEveryone, draftKey, unreadCount, unreadExact }) {
  const convoKey = draftKey || title; // which conversation this composer belongs to (titles can repeat, so App passes a real key)
  const [text, setText] = useState(() => getDraft(convoKey));
  const [replyTo, setReplyTo] = useState(null);
  const [searching, setSearching] = useState(false); // the search bar under the header: finds text in the messages loaded here
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const [pinsOpen, setPinsOpen] = useState(false); // the pinned messages panel under the header (server channels only)
  const [pinned, setPinned] = useState(null); // pins as the server last sent them (null until the panel was opened once)
  const [pinsErr, setPinsErr] = useState(false);
  const pinsRef = useRef(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [pending, setPending] = useState([]); // uploads: { key, name, size, type, progress, att, err, preview, compressing }
  const [bigVideos, setBigVideos] = useState([]); // videos over the size limit waiting for "compress it?" (the first one is being asked about)
  const aborts = useRef({}); // pending key -> AbortController, for a video that is being compressed
  const [pop, setPop] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [tapped, setTapped] = useState(null); // touch screens: tap a message to show its actions
  const [pollOpen, setPollOpen] = useState(false);
  const attachWrap = useRef(null), camInput = useRef(null);
  useEffect(() => { // the attach menu closes when you tap anywhere else
    if (pop !== 'attach') return undefined;
    const away = (e) => { if (attachWrap.current && !attachWrap.current.contains(e.target)) setPop(null); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [pop]);
  const fileInput = useRef(null);
  const { lib, toTokens, fromTokens } = useEmoji();
  const people = mentionables || [];
  const encode = (t) => toMentionTokens(toTokens(t), people); // :emoji: and @username -> tokens, as stored
  const decode = (t) => fromMentionTokens(fromTokens(t), users); // and back, for editing
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => () => { Object.values(aborts.current).forEach((c) => c.abort()); }, []); // leaving the chat stops any compressing
  const scroller = useRef(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false); // scrolled well above the newest message: shows the jump-to-latest button
  const [fresh, setFresh] = useState(0); // messages from others that arrived below while you were scrolled up
  const lastMsgId = useRef(null); // newest message at the previous render, to tell what is new
  const [divider, setDivider] = useState(null); // id of the first message you had not read when you opened this chat: the "New messages" line goes above it
  const openInfo = useRef(null); // what was unread when the chat was opened { since, count, exact }; cleared once the line is placed
  const newest = useRef(null); // { key, ts } of the newest message in the list, remembered when you leave
  const lastTyping = useRef(0);
  const inputRef = useRef(null);
  const mc = useMentionComplete({ text, setText, inputRef, people, everyone: canEveryone });
  const typed = useTypingProof(inputRef, !!readOnly); // how this message was written, sent along so the server can decide if it earns credits

  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  const q = searching ? query.trim().toLowerCase() : '';
  const shownMessages = q ? messages.filter((m) => !m.system && decode(m.content || '').toLowerCase().includes(q)) : messages;

  // ---- search (Ctrl/Cmd+F while no dialog is open) ----
  const openSearch = () => { setSearching(true); setPinsOpen(false); setTimeout(() => { searchRef.current?.focus(); searchRef.current?.select(); }, 0); };
  const closeSearch = () => { setSearching(false); setQuery(''); };
  useEffect(() => {
    const k = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f' || document.querySelector('.overlay')) return;
      e.preventDefault();
      openSearch();
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- pinned messages: fetched when the panel opens and again (a moment after) whenever the messages change while it is open ----
  useEffect(() => {
    if (!pinsOpen || !pinsFor) return undefined;
    let live = true;
    const t = setTimeout(() => {
      api(`/channels/${pinsFor}/pins`).then((r) => { if (live) { setPinned(r.messages); setPinsErr(false); } }).catch(() => { if (live) setPinsErr(true); });
    }, pinned === null ? 0 : 800);
    return () => { live = false; clearTimeout(t); };
  }, [pinsOpen, pinsFor, messages]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // Escape or a click outside closes the panel (the button that opens it toggles it)
    if (!pinsOpen) return undefined;
    const away = (e) => { if (pinsRef.current && !pinsRef.current.contains(e.target) && !e.target.closest?.('.pins-btn')) setPinsOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setPinsOpen(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  }, [pinsOpen]);
  // what the server sent, corrected by the messages we hold live (a pin or unpin arrives as an edit, a deletion as a removal)
  const pinList = (() => {
    const livePins = new Map(messages.filter((m) => m.pinnedAt).map((m) => [m.id, m]));
    const notPinned = new Set(messages.filter((m) => !m.pinnedAt).map((m) => m.id));
    return [...(pinned || []).filter((m) => !livePins.has(m.id) && !notPinned.has(m.id)), ...livePins.values()].sort((a, b) => b.pinnedAt - a.pinnedAt);
  })();
  function jumpTo(id) {
    const go = () => {
      const el = document.getElementById('m-' + id);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1800);
    };
    setPinsOpen(false);
    if (searching) { closeSearch(); setTimeout(go, 60); } else go();
  }

  useLayoutEffect(() => {
    const el = scroller.current;
    const prev = lastMsgId.current;
    lastMsgId.current = messages[messages.length - 1]?.id ?? null;
    if (el && stick.current) { el.scrollTop = el.scrollHeight; setFresh(0); return; }
    // scrolled up: count what came in below the old newest message (yours and call entries don't count)
    const i = prev ? messages.findIndex((m) => m.id === prev) : -1;
    if (i >= 0) {
      const n = messages.slice(i + 1).filter((m) => !m.system && m.authorId !== me.id).length;
      if (n) setFresh((c) => c + n);
    }
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  function jumpToLatest() {
    const el = scroller.current;
    if (!el) return;
    stick.current = true; setFresh(0); setAway(false);
    el.scrollTop = el.scrollHeight;
  }

  useEffect(() => { setReplyTo(null); setEditing(null); setConfirmDel(null); setPop(null); setSearching(false); setQuery(''); setPinsOpen(false); setPinned(null); setPinsErr(false); clearPending(true); setText(getDraft(convoKey)); typed.reset(); stick.current = true; setTapped(null); setFresh(0); setAway(false); lastMsgId.current = messages[messages.length - 1]?.id ?? null; setDivider(null); openInfo.current = unreadCount > 0 ? { since: getSeen(convoKey), count: unreadCount, exact: !!unreadExact } : null; if (window.matchMedia?.('(hover: hover)').matches) inputRef.current?.focus(); }, [convoKey]); // switching chats brings back what you had typed there

  // every change to the composer is saved as that conversation's draft (sending clears the text, which clears the draft)
  useEffect(() => { if (!readOnly) setDraft(convoKey, text); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // "New messages" line: placed once, as soon as the chat has messages, and then left where it is while you read.
  // Where you stopped last time wins; otherwise the unread count is used, but only when it counts every message (not for @mentions-only or muted channels).
  useEffect(() => {
    const o = openInfo.current;
    if (!o || !messages.length) return;
    const incoming = messages.filter((m) => !m.system && m.authorId !== me.id);
    let id = null;
    if (o.since) id = incoming.find((m) => m.createdAt > o.since)?.id ?? null;
    else if (o.exact) id = incoming[Math.max(0, incoming.length - o.count)]?.id ?? null;
    openInfo.current = null;
    setDivider(id);
  }, [messages, convoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember where you stopped: the newest message on screen, counted only if you were at the bottom and the tab was visible.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last && !document.hidden) newest.current = { key: convoKey, ts: last.createdAt };
  }, [messages, convoKey]);
  useEffect(() => () => { const s = newest.current; if (s && stick.current) markSeen(s.key, s.ts); }, [convoKey]); // runs when you switch chats or leave

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
    for (const p of pendingRef.current) { if (p.preview) URL.revokeObjectURL(p.preview); if (discard && p.att) discardUpload(p.att.id); if (discard) aborts.current[p.key]?.abort(); }
    if (discard) setBigVideos([]);
    setPending([]);
  }
  const patch = (key, fields) => setPending((l) => l.map((p) => (p.key === key ? { ...p, ...fields } : p)));
  function removePending(p) {
    if (p.preview) URL.revokeObjectURL(p.preview);
    if (p.att) discardUpload(p.att.id);
    aborts.current[p.key]?.abort(); // stops compressing a video that is still being squeezed
    setPending((l) => l.filter((x) => x.key !== p.key));
  }
  // Uploads one file. compress: shrink the video first (it was over the limit and the person said yes).
  function startUpload(f, compress) {
    const key = Math.random().toString(36).slice(2);
    const entry = { key, name: f.name || 'pasted-file', size: f.size, type: f.type, progress: 0, compressing: !!compress, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
    setPending((l) => [...l, entry]);
    (async () => {
      let file = f;
      if (compress) {
        const ctl = new AbortController();
        aborts.current[key] = ctl;
        try { file = await compressVideo(f, { signal: ctl.signal, onProgress: (progress) => patch(key, { progress }) }); } finally { delete aborts.current[key]; }
        patch(key, { compressing: false, progress: 0, name: file.name, size: file.size, type: file.type });
      }
      const att = await uploadFile(file, files.scope, (progress) => patch(key, { progress }));
      patch(key, { att, progress: 1 });
    })().catch((e) => { if (!e.cancelled) patch(key, { err: e.message, compressing: false }); });
  }
  function addFiles(list) {
    const picked = [...list];
    if (!picked.length) return;
    if (!files?.scope) return setErr('You can only send files to friends');
    const room = MAX_ATTACH - pendingRef.current.length;
    if (picked.length > room) setErr(`You can attach up to ${MAX_ATTACH} files per message`);
    else setErr('');
    for (const f of picked.slice(0, Math.max(room, 0))) {
      if (f.size > MAX_FILE && f.type.startsWith('video/') && canCompress()) setBigVideos((l) => [...l, f]); // ask before squeezing it
      else startUpload(f, false);
    }
  }
  function answerBigVideo(yes) {
    const f = bigVideos[0];
    setBigVideos((l) => l.slice(1));
    if (!f) return;
    if (!yes) return setErr(`${f.name || 'The video'} was not added: it is over 20 MB`);
    if (pendingRef.current.length >= MAX_ATTACH) return setErr(`You can attach up to ${MAX_ATTACH} files per message`);
    setErr('');
    startUpload(f, true);
  }
  const uploading = pending.some((p) => !p.att && !p.err);

  // voice messages: record, upload (encrypted for a DM), then send as an attachment
  const [recording, setRecording] = useState(false);
  const voiceUp = useRef(null); // { file, att }: an uploaded voice message whose send failed, so Retry does not upload it twice
  const canRecordVoice = !!files?.scope && voiceSupported();
  async function sendVoice(file, onProgress) {
    if (!voiceUp.current || voiceUp.current.file !== file) voiceUp.current = { file, att: await uploadFile(file, files.scope, onProgress) };
    await onSend('', replyTo?.id || null, [voiceUp.current.att]);
    voiceUp.current = null; setReplyTo(null); stick.current = true; setRecording(false);
  }
  function stopVoice() { // closes the recorder; an upload that was never sent is discarded
    if (voiceUp.current) { discardUpload(voiceUp.current.att.id); voiceUp.current = null; }
    setRecording(false);
  }
  useEffect(() => { stopVoice(); }, [convoKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
      await onSend(t, replyTo?.id || null, atts, typed.proof());
      typed.reset();
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
      const last = [...messages].reverse().find((m) => !m.system && !m.poll && m.authorId === me.id);
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
        <button className={'icon-btn' + (searching ? ' on' : '')} title="Search messages" data-kbd={kbd('F')} aria-label="Search messages" aria-pressed={searching} onClick={() => (searching ? closeSearch() : openSearch())}><Icon name="search" size={18} /></button>
        {pinsFor && <button className={'icon-btn pins-btn' + (pinsOpen ? ' on' : '')} title="Pinned messages" aria-label="Pinned messages" aria-haspopup="dialog" aria-expanded={pinsOpen} onClick={() => { setPinsOpen((o) => !o); closeSearch(); }}><Icon name="pushpin" size={18} /></button>}
        {bell && <button className={'icon-btn hide-sm' + (bell.muted ? ' bell-muted' : '')} title={bell.muted ? 'Notification settings (muted)' : 'Notification settings'} aria-label="Notification settings" onClick={bell.onClick}><Icon name={bell.muted ? 'belloff' : 'bell'} size={18} /></button>}
        {headerExtra}
        {pinsOpen && pinsFor && (
          <div className="pins-pop" role="dialog" aria-label="Pinned messages" ref={pinsRef}>
            <div className="pins-head"><b>Pinned messages</b><button className="icon-btn" title="Close" aria-label="Close" onClick={() => setPinsOpen(false)}><Icon name="close" size={16} /></button></div>
            <div className="pins-list">
              {pinned === null && !pinsErr && <ListSkeleton rows={3} avatar={28} lines={2} label="Loading pinned messages" />}
              {pinsErr && pinned === null && <EmptyState icon="alert" compact title="Could not load pins">Close this and try again.</EmptyState>}
              {(pinned !== null || pinList.length > 0) && pinList.length === 0 && (
                <EmptyState icon="pushpin" compact title="Nothing pinned yet">{canPin ? 'Pin a message from its “⋯” menu to keep it here.' : 'Messages pinned by moderators show up here.'}</EmptyState>
              )}
              {pinList.map((m) => (
                <div className="pin-item" key={m.id}>
                  <Avatar user={users[m.authorId]} size={28} />
                  <div className="pin-main">
                    <div className="pin-meta"><b data-nc style={{ '--nc': roleColors?.[m.authorId] || users[m.authorId]?.accentColor }}>{users[m.authorId]?.displayName || 'Unknown'}</b><span className="muted small">{timeLabel(m.createdAt)}</span></div>
                    <div className="pin-text">{mentionPreview(previewText(m), users) || 'Sent an attachment'}</div>
                  </div>
                  <div className="pin-actions">
                    {byId[m.id] ? <button className="btn small-btn" onClick={() => jumpTo(m.id)}>Jump</button> : <span className="muted small">Older</span>}
                    {canPin && <button className="icon-btn" title="Unpin" aria-label="Unpin message" onClick={() => onPin(m, false)}><Icon name="close" size={15} /></button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </header>
      {searching && (
        <div className="chat-search" role="search">
          <Icon name="search" size={16} />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); } }} placeholder={`Search ${subtitle === '@' ? 'this conversation' : '#' + title}`} aria-label="Search messages" maxLength={80} />
          <span className="muted small">{q ? `${shownMessages.length} result${shownMessages.length === 1 ? '' : 's'}` : 'Messages loaded here'}</span>
          <button className="icon-btn" title="Close search" aria-label="Close search" onClick={closeSearch}><Icon name="close" size={16} /></button>
        </div>
      )}
      {stage}
      <div className="scroll" ref={scroller} role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages" onScroll={(e) => { const el = e.currentTarget; const gap = el.scrollHeight - el.scrollTop - el.clientHeight; stick.current = gap < 80; setAway(gap > 200); if (gap < 80) setFresh(0); }}>
        {notice && <div className="notice">{notice}</div>}
        {!messages.some((m) => !m.system) && (loading ? <MessageSkeleton /> : <EmptyChat title={title} subtitle={subtitle} />)}
        {q && shownMessages.length === 0 && <EmptyState icon="search" title={`No messages match “${query.trim()}”`}>Only the messages loaded in this conversation are searched.</EmptyState>}
        {shownMessages.map((m, i) => {
          const before = shownMessages[i - 1];
          const day = !before || !sameDay(before.createdAt, m.createdAt) ? <div key={'day-' + m.id} className="day-divider" role="separator"><span>{dayLabel(m.createdAt)}</span></div> : null;
          if (m.system === 'call') return <React.Fragment key={m.id}>{day}<CallEntry m={m} users={users} me={me} /></React.Fragment>;
          const prev = shownMessages[i - 1];
          const grouped = prev && !prev.system && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 5 * 60000 && !m.replyTo;
          return <React.Fragment key={m.id}>{day}{m.id === divider && <div className="new-divider" role="separator"><span>New messages</span></div>}<Message m={m} grouped={grouped && m.id !== divider && !day} users={users} roleColors={roleColors} me={me} byId={byId} presence={presence} onVote={onVote} onClosePoll={onClosePoll}
            onReact={onReact} onReply={(x) => { setReplyTo(x); setEditing(null); inputRef.current?.focus(); }} onUser={onUser} onUserMenu={onUserMenu}
            onEdit={onEdit} onDelete={setConfirmDel} editing={editing === m.id} setEditing={setEditing} encode={encode} decode={decode} people={people} canEveryone={canEveryone}
            canDelete={m.authorId === me.id || !!canModerate} canPin={!!canPin && !m.system} onPin={onPin} dm={files?.dm} onOpen={setLightbox}
            tapped={tapped === m.id} onTap={() => setTapped((t) => (t === m.id ? null : m.id))} /></React.Fragment>;
        })}
        {(away || fresh > 0) && (
          <div className="jump-wrap">
            <button className={'jump-btn' + (fresh > 0 ? ' fresh' : '')} onClick={jumpToLatest}
              aria-label={fresh > 0 ? `${fresh} new message${fresh > 1 ? 's' : ''}. Jump to the latest` : 'Jump to the latest messages'}>
              <Icon name="chevron" size={16} />
              {fresh > 0 && <span>{fresh > 99 ? '99+' : fresh} new message{fresh > 1 ? 's' : ''}</span>}
            </button>
          </div>
        )}
      </div>
      {readOnly ? <div className="composer-wrap readonly"><div className="readonly-note"><Icon name="lock" size={15} className="inline-icon" /> {readOnly}</div></div> : <div className="composer-wrap">
        {replyTo && (
          <div className="replying">
            Replying to <b>{users[replyTo.authorId]?.displayName || 'Unknown'}</b>
            <span className="reply-text">{mentionPreview(previewText(replyTo), users)}</span>
            <button className="icon-btn" title="Cancel reply" data-kbd="Esc" onClick={() => setReplyTo(null)}><Icon name="close" size={15} /></button>
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
                <div className="muted small">{p.err || (p.att ? sizeLabel(p.size) : (p.compressing ? 'Compressing ' : '') + Math.round(p.progress * 100) + '%')}</div>
                {!p.att && !p.err && <div className="pend-bar"><i style={{ width: p.progress * 100 + '%' }} /></div>}
                <button className="pend-x" title={p.compressing ? 'Cancel' : 'Remove'} onClick={() => removePending(p)}><Icon name="close" size={13} /></button>
              </div>
            ))}
            {pending.some((p) => p.compressing) && <div className="muted small" style={{ flexBasis: '100%' }}>Compressing takes about as long as the video lasts. Keep this window open.</div>}
            <div className="muted small" style={{ flexBasis: '100%' }}>Files are removed {FILE_DAYS} days after sending ({LARGE_FILE_DAYS} days if over 10 MB).</div>
          </div>
        )}
        {recording && <VoiceRecorder onSend={sendVoice} onCancel={stopVoice} />}
        {err && <div className="composer-err" role="alert"><span>{err}</span><button className="icon-btn" aria-label="Dismiss" onClick={() => setErr('')}><Icon name="close" size={14} /></button></div>}
        <div className="composer-row" style={recording ? { display: 'none' } : undefined}>
          <div className="attach-wrap" ref={attachWrap}>
            <button className="icon-btn" title="Attach" aria-label="Attach" aria-haspopup="menu" aria-expanded={pop === 'attach'} disabled={!files?.scope && !onPoll} onClick={() => setPop(pop === 'attach' ? null : 'attach')}><Icon name="plus" size={20} /></button>
            {pop === 'attach' && (
              <div className="pop attach-pop" role="menu">
                <button role="menuitem" disabled={!files?.scope} onClick={() => { setPop(null); camInput.current?.click(); }}><Icon name="camera" size={18} />Camera</button>
                <button role="menuitem" disabled={!files?.scope} title={`Max 20 MB each (bigger videos can be compressed); removed after ${FILE_DAYS} days (${LARGE_FILE_DAYS} if over 10 MB)`} onClick={() => { setPop(null); fileInput.current?.click(); }}><Icon name="file" size={18} />Files</button>
                {onPoll && <button role="menuitem" onClick={() => { setPop(null); setPollOpen(true); }}><Icon name="poll" size={18} />Poll</button>}
              </div>
            )}
          </div>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <input ref={camInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <textarea ref={inputRef} className="composer" rows={1} value={text} onChange={onChange} onKeyDown={onKey} placeholder={placeholder} maxLength={2000} {...mc.bind}
            onFocus={() => { if (!window.matchMedia('(max-width: 720px)').matches) return; stick.current = true; [120, 320, 600].forEach((ms) => setTimeout(() => { const el = scroller.current; if (el && document.activeElement === inputRef.current) el.scrollTop = el.scrollHeight; }, ms)); }}
            onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }} />
          <div className="comp-tools">
            {canRecordVoice && <button className="icon-btn" title="Voice message" aria-label="Record a voice message" onClick={() => { setErr(''); setPop(null); setRecording(true); }}><Icon name="mic" size={20} /></button>}
            <button className="icon-btn" title="Emoji" onClick={() => setPop(pop === 'emoji' ? null : 'emoji')}><Icon name="smile" size={20} /></button>
            <button className="icon-btn gif-btn" title="GIF" onClick={() => setPop(pop === 'gif' ? null : 'gif')}>GIF</button>
          </div>
          <button className="icon-btn send-btn" title="Send" data-kbd="Enter" aria-label="Send" onMouseDown={(e) => e.preventDefault()} onClick={submit} disabled={uploading || (!text.trim() && !pending.some((p) => p.att))}><Icon name="send" size={19} /></button>
          {pop === 'emoji' && <EmojiPop onClose={() => setPop(null)} onPick={(e) => { setText((t) => t + e); setPop(null); inputRef.current?.focus(); }} />}
          {pop === 'gif' && <GifPop enabled={gifEnabled} onClose={() => setPop(null)} onPick={sendGif} />}
        </div>
        <div className="typing" aria-live="polite">{typingNames.length ? `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…` : ' '}</div>
      </div>}
      {dragging && <div className="drop-hint"><Icon name="clip" size={28} />Drop files to send</div>}
      {lightbox && <Lightbox view={lightbox} onClose={() => setLightbox(null)} />}
      {pollOpen && onPoll && <PollModal onSubmit={onPoll} onClose={() => setPollOpen(false)} />}
      {bigVideos[0] && (
        <Modal title="Compress this video?" onClose={() => answerBigVideo(false)}>
          <p className="muted"><b>{bigVideos[0].name || 'This video'}</b> is {sizeLabel(bigVideos[0].size)}, over the 20 MB limit. Would you like to compress it so it can be sent?</p>
          <p className="muted small">It is compressed on your device and takes about as long as the video lasts. The picture will be a bit smaller and softer. Your original file is not changed.</p>
          <div className="modal-foot">
            <button className="btn" onClick={() => answerBigVideo(false)}>Don't send</button>
            <button className="btn primary" autoFocus onClick={() => answerBigVideo(true)}>Compress</button>
          </div>
        </Modal>
      )}
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
