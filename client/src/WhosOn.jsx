import React, { useEffect, useState } from 'react';
import { Avatar, BadgeIcons, Icon } from './ui.jsx';
import { nameProps } from './namestyle.js';
import { useLang } from './i18n.js';
import { EmptyState } from './ShellBits.jsx';
import { playingFor } from './Activity.jsx';
import { buildWhosOn, countOn } from './whoson.js';

// Who's On: the first thing on the Friends page. Friends who are online, in a voice channel, or playing something, with one tap to join them.
export default function WhosOn({ friends, users, statusOf, voiceMembers, servers, me, onMessage, onUser, onJoinVoice, onSettings }) {
  const { t } = useLang();
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []); // "for 25m" stays fresh
  const w = buildWhosOn({ friends, users, statusOf, voiceMembers, servers });
  const hiddenSelf = me && me.showActivity === false;

  const row = (r, sub, action) => (
    <div className="frow" key={r.user.id}>
      <button className="frow-main" onClick={() => onUser(r.user.id)}>
        <Avatar user={r.user} size={40} presence={r.status} />
        <div className="frow-text">
          <div className="frow-name"><b {...nameProps(r.user)}>{r.user.displayName}</b><BadgeIcons user={r.user} size={16} /></div>
          <div className="frow-sub muted small">{sub}</div>
        </div>
      </button>
      <div className="frow-actions">{action}</div>
    </div>
  );
  const game = (a) => { const d = playingFor(a.since); return <>{t('whoPlaying', { game: a.name })}{d && ` · ${t('playingFor', { time: d })}`}</>; };
  const section = (label, rows) => rows.length > 0 && <section key={label}><div className="side-label">{label} — {rows.length}</div>{rows}</section>;

  return (
    <div className="whoson">
      {hiddenSelf && (
        <p className="muted small hint whoson-off">{t('whoOffHint')} <button className="link-btn" onClick={onSettings}>{t('whoOffLink')}</button></p>
      )}
      {section(t('whoCall'), w.call.map((r) => row(r,
        <><Icon name="speaker" size={14} className="inline-icon" /> {r.at.channelName} · {r.at.serverName}{r.activity && <> · {game(r.activity)}</>}</>,
        <>
          <button className="btn primary small-btn" onClick={() => onJoinVoice(r.at.serverId, r.at.channelId)}>{t('whoJoin')}</button>
          <button className="icon-btn" title={t('message')} aria-label={t('message')} onClick={() => onMessage(r.user)}><Icon name="message" size={17} /></button>
        </>)))}
      {section(t('whoPlayingH'), w.playing.map((r) => row(r, game(r.activity),
        <button className="icon-btn" title={t('message')} aria-label={t('message')} onClick={() => onMessage(r.user)}><Icon name="message" size={17} /></button>)))}
      {section(t('whoOnline'), w.online.map((r) => row(r, r.status === 'idle' ? t('whoIdle') : r.status === 'dnd' ? t('whoDnd') : t('whoHere'),
        <button className="icon-btn" title={t('message')} aria-label={t('message')} onClick={() => onMessage(r.user)}><Icon name="message" size={17} /></button>)))}
      {countOn(w) === 0 && <EmptyState icon="users" title={friends.length === 0 ? t('noFriends') : t('whoNobody')}>{friends.length === 0 ? null : t('whoNobodySub')}</EmptyState>}
    </div>
  );
}
