import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Modal } from './ui.jsx';

// "Boost server": any member spends credits to boost the server for 14 days (rules and prices: server/boosts.js, the numbers come from the server).
const LEVEL_NAME = { 1: 'Level 1', 2: 'Level 2', 3: 'Level 3' };
const daysLeft = (endsAt) => Math.max(1, Math.ceil((endsAt - Date.now()) / 86400000));

export function BoostModal({ server, users = {}, onClose, onBalance }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(0); // the level being bought

  useEffect(() => {
    let dead = false;
    api(`/servers/${server.id}/boost`).then((r) => { if (!dead) setInfo(r); }).catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [server.id]);

  async function buy(level) {
    setErr('');
    setBusy(level);
    try {
      const r = await api(`/servers/${server.id}/boost`, { method: 'POST', body: { level } });
      setInfo(r);
      if (onBalance) onBalance(r.balance);
    } catch (e) {
      setErr(e.code === 'not_enough_credits' ? 'You do not have enough credits for this boost.' : e.message);
    }
    setBusy(0);
  }

  async function useFree() {
    setErr('');
    setBusy(-1);
    try {
      const r = await api(`/servers/${server.id}/boost/free`, { method: 'POST' });
      setInfo(r);
    } catch (e) {
      setErr(e.message);
    }
    setBusy(0);
  }

  const top = info ? info.level : 0;
  const mine = info ? info.mine : null;
  const others = info ? info.boosters.filter((b) => !mine || b.userId !== mine.userId) : [];
  const nameOf = (id) => (users[id] && users[id].displayName) || 'A member';

  return (
    <Modal title="Boost server" onClose={onClose}>
      <div className="boost-body">
        {!info && !err && <p className="boost-note">Loading…</p>}
        {info && (
          <>
            <p className="boost-note">
              {top ? `${server.name} is at level ${top}.` : `${server.name} has no boost yet.`} A boost lasts {info.days} days and is paid with credits.
              Your balance: <b>{info.balance}</b>.
            </p>
            {info.free && (
              <div className="boost-free">
                <b>Free with Aduna Plus</b>
                {!info.free.plus && <p className="boost-note">Aduna Plus members get a free level 3 boost every month, on any server they are in.</p>}
                {info.free.plus && !info.free.used && <p className="boost-note">Your free level 3 boost for this month is ready. It lasts {info.days} days.</p>}
                {info.free.plus && info.free.used && <p className="boost-note">You used this month’s free boost. The next one is ready on {new Date(info.free.resetsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.</p>}
                {info.free.plus && !info.free.used && (
                  <button className="btn primary" disabled={(mine && mine.level >= 3) || busy !== 0} onClick={useFree}>
                    {busy === -1 ? 'Boosting…' : mine && mine.level >= 3 ? 'Level 3 already running' : mine ? 'Upgrade to level 3 for free' : 'Use my free level 3 boost'}
                  </button>
                )}
              </div>
            )}
            <div className="boost-tiers">
              {info.tiers.map((t) => {
                const ownRunning = mine && mine.level >= t.level;
                const blocked = t.level < top;
                const label = ownRunning ? `Running, ${daysLeft(mine.endsAt)} days left` : blocked ? 'Server is already higher' : mine ? `Upgrade for ${t.credits}` : `Boost for ${t.credits}`;
                return (
                  <div key={t.level} className={'boost-tier' + (top >= t.level ? ' on' : '')}>
                    <b>{LEVEL_NAME[t.level]}</b>
                    <span className="boost-price">{t.credits} credits</span>
                    <ul>{t.perks.map((p) => <li key={p}>{p}</li>)}</ul>
                    <button className="btn primary" disabled={ownRunning || blocked || busy !== 0} onClick={() => buy(t.level)}>
                      {busy === t.level ? 'Boosting…' : label}
                    </button>
                  </div>
                );
              })}
            </div>
            {others.length > 0 && (
              <p className="boost-note">Boosted by {others.map((b) => `${nameOf(b.userId)} (level ${b.level})`).join(', ')}.</p>
            )}
            <p className="boost-note small">Upgrading replaces your own lower boost at the full price. If the server is deleted, every running boost gives back its unused time.</p>
          </>
        )}
        {err && <p className="boost-err" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}
