import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Select } from './Controls.jsx';
import { PanelSkeleton } from './ShellBits.jsx';
import './automod.css';

// Server settings > Automod. The rules live in server/automod.js. The whole settings object is sent with Save and checked there as one piece.
const NON_TEXT = ['voice', 'rules', 'todo', 'goals'];
const RULE_ROWS = [
  ['words', 'Banned words', 'Messages, and the names of files and GIFs on them, with a word from the list below.'],
  ['links', 'Links', 'Messages with a link, except to the sites you allow.'],
  ['invites', 'Other servers\u2019 invites', 'Invite links to any server but this one.'],
  ['caps', 'Capital letters', 'Long messages that are mostly capitals.'],
  ['mentions', 'Mention floods', 'Messages that mention too many people, or @everyone.'],
  ['repeat', 'Repeated messages', 'The same message sent again and again.'],
];
const lines = (text) => String(text).split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const ACTION_LABEL = { blocked: 'Blocked', warned: 'Warned', timeout: 'Timed out', kick: 'Kicked' };

export function AutomodTab({ server }) {
  const base = `/servers/${server.id}/automod`;
  const [data, setData] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [wordsText, setWordsText] = useState('');
  const [allowText, setAllowText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = (d) => {
    setData(d);
    setCfg(d.config);
    setWordsText((d.config.words || []).join('\n'));
    setAllowText((d.config.rules.links.allow || []).join('\n'));
  };
  useEffect(() => {
    let live = true;
    api(base).then((d) => live && load(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [base]);

  if (!cfg) return <><h1>Automod</h1>{err ? <div className="error" role="alert">{err}</div> : <PanelSkeleton />}</>;

  const rule = (name, patch) => { setSaved(false); setCfg((c) => ({ ...c, rules: { ...c.rules, [name]: { ...c.rules[name], ...patch } } })); };
  const top = (patch) => { setSaved(false); setCfg((c) => ({ ...c, ...patch })); };
  const strikes = (patch) => { setSaved(false); setCfg((c) => ({ ...c, strikes: { ...c.strikes, ...patch } })); };
  const step = (i, patch) => strikes({ ladder: cfg.strikes.ladder.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const toggle = (key, id) => top({ [key]: cfg[key].includes(id) ? cfg[key].filter((x) => x !== id) : [...cfg[key], id] });
  const num = (v) => (v === '' ? '' : Number(v));

  async function save() {
    setErr(''); setBusy(true);
    const body = { ...cfg, words: lines(wordsText), rules: { ...cfg.rules, links: { ...cfg.rules.links, allow: lines(allowText) } } };
    try { load(await api(base, { method: 'PUT', body })); setSaved(true); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function forgive(userId) {
    setErr('');
    try { setData(await api(`${base}/strikes/${userId}`, { method: 'DELETE' })); }
    catch (e) { setErr(e.message); }
  }

  const textChannels = (server.channels || []).filter((c) => !NON_TEXT.includes(c.type));
  const nameOf = (id) => server.members.find((m) => m.id === id)?.displayName || 'Former member';
  const R = cfg.rules;

  return (
    <>
      <h1>Automod</h1>
      <p className="muted">Messages that break a rule are not sent, and the person is told why. A rule can also add a warning, and warnings lead to a timeout or a kick. The owner and anyone with Manage messages are never checked.</p>

      <label className="sb-check"><input type="checkbox" checked={cfg.enabled} onChange={(e) => top({ enabled: e.target.checked })} /> Automod is on</label>

      <label>RULES</label>
      {RULE_ROWS.map(([name, title, hint]) => (
        <div key={name} className="automod-rule">
          <label className="sb-check"><input type="checkbox" checked={R[name].on} onChange={(e) => rule(name, { on: e.target.checked })} /> <b>{title}</b></label>
          <p className="muted small">{hint}</p>
          {R[name].on && (
            <div className="automod-opts">
              <label className="sb-check"><input type="checkbox" checked={R[name].warn} onChange={(e) => rule(name, { warn: e.target.checked })} /> Also give a warning</label>
              {name === 'caps' && <span className="small">from <input type="number" min="40" max="100" value={R.caps.percent} onChange={(e) => rule('caps', { percent: num(e.target.value) })} aria-label="Capitals percent" /> % capitals, in messages with at least <input type="number" min="5" max="200" value={R.caps.minLetters} onChange={(e) => rule('caps', { minLetters: num(e.target.value) })} aria-label="Minimum letters" /> letters</span>}
              {name === 'mentions' && <span className="small">more than <input type="number" min="1" max="50" value={R.mentions.max} onChange={(e) => rule('mentions', { max: num(e.target.value) })} aria-label="Mentions allowed" /> mentions</span>}
              {name === 'repeat' && <span className="small">the <input type="number" min="2" max="10" value={R.repeat.times} onChange={(e) => rule('repeat', { times: num(e.target.value) })} aria-label="Times" /> time within <input type="number" min="5" max="300" value={R.repeat.seconds} onChange={(e) => rule('repeat', { seconds: num(e.target.value) })} aria-label="Seconds" /> seconds</span>}
            </div>
          )}
        </div>
      ))}

      <label htmlFor="am-words">BANNED WORDS ({lines(wordsText).length})</label>
      <textarea id="am-words" rows={6} value={wordsText} onChange={(e) => { setWordsText(e.target.value); setSaved(false); }} placeholder={'One per line, or separated by commas.\nspam*   matches spammer, spamming\n*tard   matches words that end in tard\nkill yourself'} />
      <p className="muted small hint">Capitals, accents, number swaps (b4d), spaced letters (b a d) and stretched letters (baaad) are all caught. A short word only matches as a whole word, so &ldquo;ass&rdquo; does not catch &ldquo;class&rdquo;. Only people who manage the server can see this list.</p>

      {R.links.on && (
        <>
          <label htmlFor="am-allow">ALLOWED SITES</label>
          <textarea id="am-allow" rows={3} value={allowText} onChange={(e) => { setAllowText(e.target.value); setSaved(false); }} placeholder={'example.com'} />
          <p className="muted small hint">Links to these sites, and their subdomains, are fine. Invites to this server are always fine.</p>
        </>
      )}

      <label>WARNINGS</label>
      <p className="small">A warning counts for <input type="number" min="1" max="365" value={cfg.strikes.expireDays} onChange={(e) => strikes({ expireDays: num(e.target.value) })} aria-label="Days a warning counts" /> days. When someone reaches:</p>
      {cfg.strikes.ladder.map((s, i) => (
        <div key={i} className="automod-step small">
          <input type="number" min="1" max="50" value={s.at} onChange={(e) => step(i, { at: num(e.target.value) })} aria-label="Warnings" /> warnings:
          <Select value={s.action} onChange={(e) => step(i, e.target.value === 'kick' ? { action: 'kick', minutes: undefined } : { action: 'timeout', minutes: s.minutes || 10 })} aria-label="What happens">
            <option value="timeout">timeout for</option>
            <option value="kick">kick from the server</option>
          </Select>
          {s.action === 'timeout' && <><input type="number" min="1" max="40320" value={s.minutes} onChange={(e) => step(i, { minutes: num(e.target.value) })} aria-label="Minutes" /> minutes</>}
          <button type="button" className="btn" onClick={() => strikes({ ladder: cfg.strikes.ladder.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      {cfg.strikes.ladder.length < 6 && <button type="button" className="btn" onClick={() => strikes({ ladder: [...cfg.strikes.ladder, { at: (cfg.strikes.ladder.at(-1)?.at || 0) + 1, action: 'timeout', minutes: 10 }] })}>Add a step</button>}
      {!cfg.strikes.ladder.length && <p className="muted small hint">With no steps, warnings are only counted and nothing happens to the person.</p>}

      <label>NOT CHECKED</label>
      <p className="muted small">Members with these roles, and messages in these channels, skip automod.</p>
      <div className="sb-roles">
        {(server.roles || []).length === 0 && <p className="muted small">This server has no roles yet.</p>}
        {(server.roles || []).map((r) => (
          <label key={r.id} className="sb-check"><input type="checkbox" checked={cfg.exemptRoles.includes(r.id)} onChange={() => toggle('exemptRoles', r.id)} /> <span style={r.color ? { color: r.color } : undefined}>{r.name}</span></label>
        ))}
        {textChannels.map((c) => (
          <label key={c.id} className="sb-check"><input type="checkbox" checked={cfg.exemptChannels.includes(c.id)} onChange={() => toggle('exemptChannels', c.id)} /> # {c.name}</label>
        ))}
      </div>

      <label>LOG CHANNEL</label>
      <Select value={cfg.logChannel || ''} onChange={(e) => top({ logChannel: e.target.value || null })} aria-label="Log channel">
        <option value="">No log channel</option>
        {textChannels.map((c) => <option key={c.id} value={c.id}># {c.name}</option>)}
      </Select>
      <p className="muted small hint">Automod posts a line here each time it blocks, warns, times out or kicks someone. Pick a channel only managers can read, because the line names the word that was caught.</p>

      {err && <div className="error" role="alert">{err}</div>}
      <div className="settings-foot">
        {saved && <span className="muted small">Saved</span>}
        <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving\u2026' : 'Save automod'}</button>
      </div>

      {data.strikes.length > 0 && (
        <>
          <label>WARNINGS AND TIMEOUTS RIGHT NOW</label>
          {data.strikes.map((x) => (
            <div key={x.userId} className="automod-step small">
              <b>{nameOf(x.userId)}</b> {x.count} {x.count === 1 ? 'warning' : 'warnings'}{x.until ? `, timed out until ${when(x.until)}` : ''}
              <button type="button" className="btn" onClick={() => forgive(x.userId)}>Forgive</button>
            </div>
          ))}
        </>
      )}

      <label>RECENT ACTIONS</label>
      {data.log.length === 0 && <p className="muted small">Nothing yet. Refused messages show up here with what was caught.</p>}
      {data.log.map((l) => (
        <div key={l.id} className="automod-log small">
          <span className="muted">{when(l.at)}</span> <b>{l.user}</b> &middot; {ACTION_LABEL[l.action] || l.action} &middot; {l.rule}: {l.what}
          {l.preview && <div className="muted">{l.preview}</div>}
        </div>
      ))}
    </>
  );
}
