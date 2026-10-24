import React, { useEffect, useState } from 'react';
import { Avatar, Modal } from './ui.jsx';
import { useEmoji } from './Emoji.jsx';

// The emoji of a reaction: a Unicode emoji as text, or a custom emoji ("c:<id>") as its picture.
function Glyph({ emoji }) {
  return emoji.startsWith('c:') ? <img className="cemoji" src={`/api/emoji/${emoji.slice(2)}/image`} alt="" /> : <>{emoji}</>;
}

// "Who reacted": opened by clicking a reaction chip. One tab per emoji on the message, the people who used the selected one below,
// and a button to add or take back your own. `reactions` is the message's live { emoji: [userId] } so the list follows changes.
export default function ReactorsModal({ reactions, start, users, me, onToggle, onUser, onClose }) {
  const { lib } = useEmoji();
  const emojis = Object.keys(reactions || {});
  const [sel, setSel] = useState(start);
  const key = emojis.join('|');
  useEffect(() => {
    if (!emojis.length) onClose(); // the last reaction was taken back
    else if (!reactions[sel]) setSel(emojis[0]); // the selected one is gone: show the next
  }, [key, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const ids = reactions?.[sel] || [];
  const mineOn = ids.includes(me.id);
  const customName = sel?.startsWith('c:') ? lib.find((x) => x.id === sel.slice(2))?.name : null;

  return (
    <Modal title="Reactions" onClose={onClose}>
      <div className="who-tabs" role="tablist">
        {emojis.map((e) => (
          <button key={e} type="button" role="tab" aria-selected={e === sel} className={'chip' + (e === sel ? ' on' : '')} onClick={() => setSel(e)}>
            <Glyph emoji={e} /> <span>{reactions[e].length}</span>
          </button>
        ))}
      </div>
      {customName && <div className="muted small who-sub">:{customName}:</div>}
      <ul className="who-list">
        {ids.map((id) => {
          const u = users[id];
          return (
            <li key={id}>
              <button type="button" className="who-row" onClick={() => { onClose(); onUser(id); }}>
                <Avatar user={u} size={32} />
                <span className="who-name">{u?.displayName || 'Unknown'}{id === me.id && <span className="muted"> (you)</span>}</span>
                {u?.username && <span className="muted small">@{u.username}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn primary" onClick={() => onToggle(sel)}>{mineOn ? 'Take back my reaction' : 'React too'}</button>
      </div>
    </Modal>
  );
}
