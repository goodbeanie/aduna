import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Avatar, Icon, Modal } from './ui.jsx';
import { can } from './perms.js';

// Bots on the client: Settings > Developer (write, test and publish bots), Server settings > Bots (add, scope and remove them),
// and the "Add to server" picker the explorer uses. The sandbox and every rule live on the server; this file only asks.

export const BotTag = () => <span className="bot-tag" title="This is a bot">BOT</span>;

const STARTER = `// Your code is the body of a function that receives \`bot\`.
// Reply when someone types !ping:
bot.on('message', (m) => {
  if (m.text === '!ping') bot.reply(m, 'pong <@' + m.author.id + '>');
});

// Greet people who join (the bot may write in these channels):
bot.on('memberJoin', (e) => {
  if (e.channels.length) bot.send(e.channels[0].id, 'Welcome <@' + e.user.id + '>!');
});
`;

const when = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const tagsOf = (s) => s.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);

function StatusChips({ bot }) {
  return (
    <>
      <span className={'bchip ' + (bot.visibility === 'public' ? 'bchip-pub' : '')}>{bot.visibility === 'public' ? 'Public' : 'Private'}</span>
      {bot.review === 'removed' && <span className="bchip bchip-bad">Removed by moderators</span>}
      {bot.review && bot.review !== 'removed' && <span className="bchip bchip-warn">Listing under review</span>}
      {bot.pausedUntil && <span className="bchip bchip-warn">Paused after timeouts</span>}
    </>
  );
}

// ---------- Settings > Developer ----------
export function DeveloperSettings({ me, onSaved }) {
  const [state, setState] = useState('loading'); // loading | ready | error
  const [dev, setDev] = useState(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null); // null = list, 'new' or a bot
  const editKey = useRef(0); // bumps when another bot is opened, so saving a new bot does not reset the editor
  const open = (x) => { editKey.current += 1; setEditing(x); };
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api('/developer').then((r) => { setDev(r); setState('ready'); }).catch((e) => { setErr(e.message); setState('error'); }), []);
  useEffect(() => { load(); }, [load]);
  // the server tells the developer live when a listing is held, removed or restored, or a bot gets paused
  useEffect(() => {
    const h = (e) => setDev((d) => (d ? { ...d, bots: d.bots.map((b) => (b.id === e.detail.id ? { ...b, ...e.detail } : b)) } : d));
    window.addEventListener('aduna:bot', h);
    return () => window.removeEventListener('aduna:bot', h);
  }, []);

  async function join() {
    setErr(''); setBusy(true);
    try { const r = await api('/developer/join', { method: 'POST', body: { accept: true } }); onSaved?.(r.user); await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const upsert = (bot) => setDev((d) => ({ ...d, bots: d.bots.some((b) => b.id === bot.id) ? d.bots.map((b) => (b.id === bot.id ? bot : b)) : [...d.bots, bot] }));
  const drop = (id) => setDev((d) => ({ ...d, bots: d.bots.filter((b) => b.id !== id) }));

  if (state === 'loading') return <p className="muted">Loading…</p>;
  if (state === 'error') return <div className="error">{err}</div>;
  if (!dev.developer) {
    return (
      <div className="dev-join">
        <p>Developer accounts let you write bots: small JavaScript programs that read messages in the servers they are added to and answer them. Keep them private for your own servers, or list them on the Bots tab in the Explorer for anyone to add.</p>
        <ul className="dev-rules">
          <li>Bots run in a sandbox on Aduna&rsquo;s servers with no files and no direct internet, and a short time limit for every event. Through Aduna they can keep a little data for each server, set timers, and read a few allowed public web addresses.</li>
          <li>A bot can only read and write text channels of servers where someone with Manage server added it.</li>
          <li>A bot cannot ping anyone except the person it is answering, and never @everyone.</li>
          <li>Public bots have to follow the same rules as public servers, and people can report them. You are responsible for what your bot says.</li>
        </ul>
        <label className="check-row"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> <span>I understand and agree to these rules</span></label>
        {err && <div className="error">{err}</div>}
        <button className="btn primary" disabled={!accept || busy} onClick={join}>{busy ? 'Turning on…' : 'Turn on my developer account'}</button>
      </div>
    );
  }
  if (editing) {
    return <BotEditor key={editKey.current} bot={editing === 'new' ? null : editing} limits={dev.limits} fetchHosts={dev.fetchHosts} onSaved={(b) => { upsert(b); setEditing(b); }} onDeleted={(id) => { drop(id); open(null); }} onBack={() => open(null)} />;
  }
  const full = dev.bots.length >= dev.limits.perDeveloper;
  return (
    <div className="dev-list">
      <p className="muted small hint">Signed in as <b>@{me.username}</b>. You can have up to {dev.limits.perDeveloper} bots.</p>
      {dev.bots.length === 0 && <div className="empty">You have no bots yet.</div>}
      {dev.bots.map((b) => (
        <button key={b.id} className="bot-row" onClick={() => open(b)}>
          <div className="bot-head"><b className="bot-name">{b.name}</b><BotTag /><StatusChips bot={b} /></div>
          <div className="muted small">{b.installs} server{b.installs === 1 ? '' : 's'}{b.description ? ' · ' + b.description : ''}</div>
        </button>
      ))}
      <button className="btn primary" disabled={full} onClick={() => open('new')}><Icon name="plus" size={16} className="inline-icon" /> New bot</button>
      {full && <p className="muted small hint">You have reached the limit. Delete a bot to make a new one.</p>}
      <SeasonTest me={me} onSaved={onSaved} />
    </div>
  );
}

// Developer test mode: look at Halloween or Christmas whatever the date is. The themes, decorations, ringtone, quests and the Advent
// calendar all follow it, on every device signed in to this account. Claims in it are dry runs (the server pays nothing, see server/events.js).
const TEST_EVENTS = [[null, 'Off'], ['halloween', '\u{1F383} Halloween'], ['christmas', '\u{1F384} Christmas']];
function SeasonTest({ me, onSaved }) {
  const mode = me.seasonTest || null;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  async function run(path, body, done) {
    setErr(''); setNote(''); setBusy(true);
    try { const r = await api(path, { method: 'POST', body }); onSaved?.({ ...me, seasonTest: r.seasonTest }); setNote(done); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="season-test">
      <h4 className="credit-h">Event test mode</h4>
      <p className="muted small">Try Halloween or Christmas whatever the date is: the limited-time themes and decorations, the ringtone, the event quests and the Advent calendar (every door is open). Only you see it, on every device you are signed in on.</p>
      <div className="mode-pick" role="radiogroup" aria-label="Event test mode">
        {TEST_EVENTS.map(([id, label]) => (
          <button type="button" role="radio" key={String(id)} aria-checked={mode === id} className={mode === id ? 'on' : ''} disabled={busy}
            onClick={() => mode !== id && run('/credits/season/test', { mode: id }, id ? `Test mode is on: ${label.replace(/^\S+\s/, '')}.` : 'Test mode is off.')}>{label}</button>
        ))}
      </div>
      {mode && <button type="button" className="btn small-btn" disabled={busy} onClick={() => run('/credits/season/test/reset', {}, 'Test progress reset. Quests and doors are closed again.')}>Reset test progress</button>}
      <p className="muted small">Claims in test mode are a dry run: they show the reward, but no credits are paid and no badge is given. Test progress is kept apart from your real progress.</p>
      {err && <div className="error">{err}</div>}
      {note && <p className="ok-text small">{note}</p>}
    </div>
  );
}

function BotEditor({ bot, limits, fetchHosts, onSaved, onDeleted, onBack }) {
  const [name, setName] = useState(bot?.name || '');
  const [description, setDescription] = useState(bot?.description || '');
  const [tags, setTags] = useState((bot?.tags || []).join(', '));
  const [visibility, setVisibility] = useState(bot?.visibility || 'private');
  const [code, setCode] = useState(bot?.code ?? STARTER);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const held = !!bot?.review; // a listing under review or removed cannot be edited by its developer
  const removed = bot?.review === 'removed';
  const dirty = !bot || name !== bot.name || description !== bot.description || tags !== (bot.tags || []).join(', ') || visibility !== bot.visibility || code !== bot.code;

  async function save() {
    setErr(''); setNote(''); setBusy(true);
    try {
      const body = { name, description, tags: tagsOf(tags), visibility, code };
      const r = bot ? await api(`/bots/${bot.id}`, { method: 'PATCH', body }) : await api('/bots', { method: 'POST', body });
      onSaved(r.bot);
      setNote('Saved.');
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function del() {
    setBusy(true);
    try { await api(`/bots/${bot.id}`, { method: 'DELETE' }); onDeleted(bot.id); }
    catch (e) { setErr(e.message); setConfirmDel(false); setBusy(false); }
  }
  const onTab = (e) => { // Tab inserts two spaces in the code box instead of leaving it (Escape then Tab leaves)
    if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const t = e.target, a = t.selectionStart, z = t.selectionEnd;
    const next = code.slice(0, a) + '  ' + code.slice(z);
    setCode(next);
    requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = a + 2; });
  };

  return (
    <div className="bot-editor">
      <button className="link-btn" onClick={onBack}><Icon name="back" size={14} className="inline-icon" /> All bots</button>
      <h2 className="bot-editor-title">{bot ? bot.name : 'New bot'}</h2>
      {bot && <div className="bot-head"><StatusChips bot={bot} /></div>}
      {removed && <div className="error">Moderators removed this bot from the public listing after reports. It left every server and cannot be added again.</div>}
      {bot?.review && !removed && <div className="error">This bot&rsquo;s public listing is under review after reports. You can edit it again once moderators have decided.</div>}
      {bot?.pausedUntil && <div className="error">This bot is paused because its code kept running out of time. Save new code to resume it.</div>}

      <label>NAME</label>
      <input value={name} maxLength={limits.name} onChange={(e) => setName(e.target.value)} aria-label="Bot name" disabled={held} />
      <label>DESCRIPTION</label>
      <textarea rows={2} value={description} maxLength={limits.description} onChange={(e) => setDescription(e.target.value)} aria-label="Bot description" placeholder="What does your bot do? Public bots need this." disabled={held} />
      <label>TAGS</label>
      <input value={tags} maxLength={120} onChange={(e) => setTags(e.target.value)} aria-label="Bot tags" placeholder="fun, moderation, music (up to 5)" disabled={held} />
      <label>WHO CAN ADD IT</label>
      <select value={visibility} onChange={(e) => setVisibility(e.target.value)} aria-label="Visibility" disabled={held}>
        <option value="private">Only me (private)</option>
        <option value="public">Anyone, listed on the Bots tab (public)</option>
      </select>
      {visibility === 'public' && <p className="muted small hint">Public bots are checked like public servers (no links or blocked words in the name, description or tags) and can be reported. Making a public bot private again removes it from servers you do not manage.</p>}

      <label>CODE</label>
      <textarea className="code-box" rows={16} value={code} spellCheck={false} autoCapitalize="off" autoCorrect="off" onKeyDown={onTab} onChange={(e) => setCode(e.target.value)} aria-label="Bot code" disabled={held} />
      <p className="muted small hint">{new Blob([code]).size.toLocaleString()} of {(limits.code / 1024)} KB. Press Escape, then Tab, to leave the code box with the keyboard.</p>
      {err && <div className="error">{err}</div>}
      {note && !err && <div className="ok-note">{note}</div>}
      <div className="bot-actions">
        <button className="btn primary" disabled={busy || held || !dirty} onClick={save}>{bot ? 'Save changes' : 'Create bot'}</button>
        {bot && <button className="btn danger" disabled={busy} onClick={() => setConfirmDel(true)}>Delete bot</button>}
      </div>

      <TestRun code={code} fetchHosts={fetchHosts} />
      {bot && <RunLog botId={bot.id} limits={limits} />}
      <ApiHelp limits={limits} fetchHosts={fetchHosts} />
      {confirmDel && (
        <Modal title="Delete bot" onClose={() => setConfirmDel(false)}>
          <p className="muted">Delete <b>{bot.name}</b>? It leaves {bot.installs} server{bot.installs === 1 ? '' : 's'} at once. Messages it already sent stay.</p>
          <div className="modal-foot"><button className="btn" onClick={() => setConfirmDel(false)}>Cancel</button>
            <button className="btn primary danger-fill" autoFocus disabled={busy} onClick={del}>Delete</button></div>
        </Modal>
      )}
    </div>
  );
}

// Runs the code in the same sandbox against a made-up event. Nothing is posted anywhere.
const EVENTS = [
  ['message', 'Someone posts a message'], ['messageEdit', 'Someone edits a message'], ['memberJoin', 'Someone joins'],
  ['memberLeave', 'Someone leaves'], ['install', 'The bot is added to a server'], ['timer', 'A timer goes off'], ['fetch', 'A web request is answered'],
];
const EVENT_LABEL = Object.fromEntries(EVENTS.map(([k, v]) => [k, v]));
const SHORT_EVENT = { message: 'message', messageEdit: 'message edited', memberJoin: 'member joined', memberLeave: 'member left', install: 'added', timer: 'timer', fetch: 'web answer' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function TestRun({ code, fetchHosts }) {
  const [event, setEvent] = useState('message');
  const [text, setText] = useState('!ping');
  const [name, setName] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function run() {
    setErr(''); setBusy(true); setRes(null);
    try { setRes((await api('/developer/test', { method: 'POST', body: { code, event, text, name } })).result); }
    catch (e) { setErr(e.code === 'sandbox_missing' ? 'The bot sandbox is not installed on this server.' : e.message); }
    finally { setBusy(false); }
  }
  return (
    <section className="bot-panel">
      <h3>Try it</h3>
      <p className="muted small hint">Runs your code above, saved or not, against a made-up event in an empty test server. Nothing is posted, stored or requested for real; you see what a real server would do.{event === 'fetch' ? ' The pretend answer is what your handler receives as text (and as json if it is JSON).' : ''}</p>
      <div className="bot-test-row">
        <select value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event to test">
          {EVENTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        {(event === 'message' || event === 'messageEdit') && <input value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} aria-label="Test message" placeholder="Message text" onKeyDown={(e) => e.key === 'Enter' && !busy && run()} />}
        {(event === 'timer' || event === 'fetch') && <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} aria-label={event === 'timer' ? 'Timer name' : 'Request name'} placeholder={event === 'timer' ? 'Timer name' : 'Request name'} />}
        {event === 'fetch' && <input value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} aria-label="Pretend answer" placeholder='Pretend answer, e.g. {"stars": 3}' />}
        <button className="btn" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run'}</button>
      </div>
      {err && <div className="error">{err}</div>}
      {res && (
        <div className="bot-result" aria-live="polite">
          <div className="muted small">{res.ok ? 'Finished' : res.timedOut ? 'Stopped: it ran out of time' : 'Failed'} in {res.ms} ms</div>
          {res.error && <pre className="bot-err">{res.error}</pre>}
          {res.actions.length === 0 && res.ok && !res.reactions?.length && !res.fetches?.length && !res.stored?.length && !res.timersSet?.length && <div className="muted small">The bot did not do anything.</div>}
          {res.actions.map((a, i) => <div key={i} className="bot-out"><Icon name="message" size={14} /> <span>{a.replyTo ? '(reply) ' : ''}{a.text}</span></div>)}
          {res.reactions?.length > 0 && <div className="bot-out"><Icon name="smile" size={14} /> <span>Would react: {res.reactions.map((r) => r.emoji).join(' ')}</span></div>}
          {res.fetches?.length > 0 && <div className="bot-out"><Icon name="link" size={14} /> <span>Would ask for: {res.fetches.map((f) => `${f.url} (as "${f.name}")`).join(', ')}. The answer comes back later as a "fetch" event.{fetchHosts?.length ? ` Allowed sites: ${fetchHosts.join(', ')}.` : ''}</span></div>}
          {res.stored?.length > 0 && <pre className="bot-logs">{'Saved data afterwards:\n' + res.stored.map((s) => `${s.key} = ${s.value}`).join('\n')}</pre>}
          {res.timersSet?.length > 0 && <pre className="bot-logs">{'Timers afterwards:\n' + res.timersSet.map((x) => `${x.name}: ${x.kind === 'after' ? 'once' : x.kind === 'every' ? `every ${x.everySec} s` : `daily at ${x.time}${x.tz ? ' ' + x.tz : ''}`}`).join('\n')}</pre>}
          {res.dropped?.length > 0 && <div className="bot-dropped">A real server would refuse: {res.dropped.join('; ')}</div>}
          {res.logs?.length > 0 && <pre className="bot-logs">{res.logs.join('\n')}</pre>}
        </div>
      )}
    </section>
  );
}

// The last runs in real servers: what the bot sent, what was refused, errors, and bot.log() output. Kept in memory on the server.
function RunLog({ botId, limits }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true); setErr('');
    try { setData(await api(`/bots/${botId}/logs`)); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }, [botId]);
  useEffect(() => { load(); }, [load]);
  return (
    <section className="bot-panel">
      <div className="bot-panel-head"><h3>Recent runs</h3><button className="btn small-btn" disabled={busy} onClick={load}>Refresh</button></div>
      <p className="muted small hint">Up to {limits.logKeep} recent runs in servers, newest first. A restart of the server clears them. Limits per bot in each server: {limits.eventsPerMin} events, {limits.messagesPerMin} messages, {limits.reactionsPerMin} reactions and {limits.fetchesPerMin} web requests a minute.</p>
      {err && <div className="error">{err}</div>}
      {data && data.logs.length === 0 && <div className="muted small">Nothing has run yet. Add the bot to a server and send a message.</div>}
      {data && data.logs.map((l, i) => (
        <div key={i} className={'bot-run' + (l.ok === false ? ' bad' : '')}>
          <div><b>{when(l.at)}</b> · {l.server} · {SHORT_EVENT[l.event] || l.event || 'message'}{l.skipped ? ` · skipped (${l.skipped})` : ` · ${l.ok ? 'ok' : 'failed'} · ${l.ms} ms · sent ${l.sent || 0}${l.reacted ? ` · ${plural(l.reacted, 'reaction', 'reactions')}` : ''}${l.stored ? ` · ${plural(l.stored, 'data change', 'data changes')}` : ''}${l.timers ? ` · ${plural(l.timers, 'timer request', 'timer requests')}` : ''}${l.fetches ? ` · ${plural(l.fetches, 'web request', 'web requests')}` : ''}`}</div>
          {l.error && <div className="bot-err">{l.error}</div>}
          {l.dropped?.length > 0 && <div className="bot-dropped">Refused: {l.dropped.join('; ')}</div>}
          {l.logs?.length > 0 && <pre className="bot-logs">{l.logs.join('\n')}</pre>}
        </div>
      ))}
    </section>
  );
}

function ApiHelp({ limits, fetchHosts }) {
  const st = limits.state || {}, fe = limits.fetch || {};
  return (
    <details className="bot-panel bot-help">
      <summary>What your code can use</summary>
      <pre>{`bot.on('message', (m) => { ... })   // a person posted in a text channel the bot may read
  m.id  m.channelId  m.serverId  m.text  m.mentions  m.mentionsBot
  m.attachments (a count)  m.replyTo  m.createdAt
  m.author = { id, username, displayName, bot }

bot.on('messageEdit', (m) => { ... })  // same as message, plus m.editedAt
bot.on('memberJoin', (e) => { ... })   // someone joined
  e.user = { id, username, displayName, bot }
  e.channels = [{ id, name }]          // text channels the bot may write in
bot.on('memberLeave', (e) => { ... }) // like memberJoin, plus e.reason: 'left' or 'kicked'
bot.on('install', (e) => { ... })      // the bot was just added: e.serverName, e.by, e.channels
bot.on('timer', (e) => { ... })        // e.name, e.kind, e.data, e.firedAt, e.channels
bot.on('fetch', (e) => { ... })        // the answer to bot.fetch: e.name, e.url, e.ok, e.status,
                                       //   e.text, e.json (or null), e.truncated, e.error, e.channels

bot.reply(m, 'text')              // answer a message in its channel
bot.send(channelId, 'text')       // post in a text channel
bot.react(m, '👍')                // add a reaction to a message
bot.log('anything', value)        // shows up in Recent runs

bot.store.set('key', value)       // saved data, only for this bot in this server (any JSON value)
bot.store.get('key')              // undefined when nothing is saved
bot.store.incr('count', 1)        // add to a number, returns the new total
bot.store.delete('key')   bot.store.keys()

bot.timer.after('name', 60, data)         // once, in 60 seconds (data is optional JSON)
bot.timer.every('name', 3600, data)       // repeating
bot.timer.daily('name', '09:30', 'America/Vancouver', data)   // every day at that time in that time zone
bot.timer.cancel('name')   bot.timer.list()

bot.fetch('https://api.github.com/repos/owner/name', 'stars')   // GET; the answer arrives later as a 'fetch' event

Mention the person you answer with '<@' + m.author.id + '>'.`}</pre>
      <ul className="muted small">
        <li>Handlers may be async. Variables are not kept between events: use bot.store for anything you need later.</li>
        <li>No files, console or direct internet. Each event gets about 100 ms.</li>
        <li>Per event: up to 5 messages of 2,000 characters, 20 log lines{st.opsPerRun ? `, ${st.opsPerRun} saved-data changes` : ''}, 5 reactions and {fe.perRun || 3} web requests.</li>
        {st.keys && <li>Saved data per server: {st.keys} keys, up to {(st.valueBytes / 1024)} KB a value and {(st.totalBytes / 1024)} KB in total. It is stored on Aduna&rsquo;s server, so do not keep secrets in it.</li>}
        {st.timersPerInstall && <li>Timers: up to {st.timersPerInstall} per server, at least {st.minAfterSec} seconds for after and {st.minEverySec} for every, at most 30 days. Daily needs a time zone name such as Europe/London (blank means UTC).</li>}
        <li>Web requests: GET only, https only, answers must be JSON or text (about {fe.maxBytes ? Math.round(fe.maxBytes / 1024) : 200} KB read, {fe.textChars ? (fe.textChars / 1000) + ',000' : '16,000'} characters of text). Private addresses are always refused.{fetchHosts?.length ? <> Allowed sites on this server: <b>{fetchHosts.join(', ')}</b>.</> : null}</li>
        <li>Bots never receive messages from other bots.</li>
      </ul>
    </details>
  );
}

// ---------- Server settings > Bots ----------
export function BotsTab({ server, me, onChange }) {
  const [mine, setMine] = useState([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [scoping, setScoping] = useState(null); // botId whose channel list is open
  const installed = server.bots || [];
  const has = (id) => installed.some((i) => i.botId === id);
  const textChannels = server.channels.filter((c) => (c.type || 'text') === 'text');
  const seq = useRef(0);

  useEffect(() => { if (me.developer) api('/developer').then((r) => setMine(r.bots || [])).catch(() => {}); }, [me.developer]);
  useEffect(() => {
    const my = ++seq.current;
    const t = setTimeout(() => {
      api(`/explore/bots?q=${encodeURIComponent(q.trim())}&sort=popular`).then((r) => { if (my === seq.current) setFound(r.bots); }).catch(() => {});
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q]);

  async function run(key, fn) {
    setErr(''); setBusy(key);
    try { const r = await fn(); if (r?.server) onChange(r.server); return true; }
    catch (e) { setErr(e.message); return false; } finally { setBusy(''); }
  }
  const add = (b) => run('add' + b.id, () => api(`/servers/${server.id}/bots`, { method: 'POST', body: { botId: b.id } }));
  const remove = (i) => run('rm' + i.botId, () => api(`/servers/${server.id}/bots/${i.botId}`, { method: 'DELETE' }));
  const scope = (i, channels) => run('sc' + i.botId, () => api(`/servers/${server.id}/bots/${i.botId}`, { method: 'PATCH', body: { channels } }));

  const mineIds = new Set(mine.filter((b) => !b.review || b.review !== 'removed').map((b) => b.id));
  const candidates = [...mine.filter((b) => mineIds.has(b.id)), ...found.filter((b) => !mineIds.has(b.id))].filter((b) => !has(b.id));
  const shown = q.trim() ? candidates.filter((b) => found.some((f) => f.id === b.id) || `${b.name} ${b.description}`.toLowerCase().includes(q.trim().toLowerCase())) : candidates;

  return (
    <div className="bots-tab">
      <p className="muted small hint">Bots read messages in the text channels you let them see and can answer there. They never get direct messages, voice or anything private, and they cannot ping anyone except the person they answer.</p>
      {err && <div className="error">{err}</div>}
      <label>IN THIS SERVER ({installed.length})</label>
      {installed.length === 0 && <div className="empty">No bots yet.</div>}
      {installed.map((i) => {
        const u = server.members.find((m) => m.id === i.userId);
        if (!u) return null;
        const sel = i.channels;
        return (
          <div key={i.botId} className="bot-inst">
            <div className="bot-inst-row">
              <Avatar user={u} size={34} />
              <div className="bot-inst-who"><b>{u.displayName}</b> <BotTag /><div className="muted small">{sel ? `${sel.length} channel${sel.length === 1 ? '' : 's'}` : 'All text channels'}</div></div>
              <button className="btn small-btn" onClick={() => setScoping(scoping === i.botId ? null : i.botId)} aria-expanded={scoping === i.botId}>Channels</button>
              <button className="btn small-btn danger" disabled={busy === 'rm' + i.botId} onClick={() => remove(i)}>Remove</button>
            </div>
            {scoping === i.botId && (
              <div className="bot-scope">
                <label className="check-row"><input type="checkbox" checked={!sel} onChange={(e) => scope(i, e.target.checked ? null : textChannels.map((c) => c.id))} /> <span>All text channels, including new ones</span></label>
                {sel && textChannels.map((c) => (
                  <label key={c.id} className="check-row"><input type="checkbox" checked={sel.includes(c.id)} disabled={busy === 'sc' + i.botId}
                    onChange={(e) => scope(i, e.target.checked ? [...sel, c.id] : sel.filter((x) => x !== c.id))} /> <span># {c.name}</span></label>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <label>ADD A BOT</label>
      <div className="explore-search">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search public bots and your own" aria-label="Search bots to add" maxLength={60} />
      </div>
      {shown.length === 0 && <div className="muted small bots-none">{q.trim() ? `No bots match “${q.trim()}”.` : 'No bots to add. Public bots appear here, and so do your own.'}</div>}
      {shown.slice(0, 12).map((b) => (
        <div key={b.id} className="bot-inst-row bot-cand">
          <div className="bot-inst-who">
            <div className="bot-head"><b className="bot-name">{b.name}</b><BotTag />{b.mine && <span className="bchip">{b.visibility === 'public' ? 'Yours' : 'Yours, private'}</span>}</div>
            <div className="muted small">{b.description || 'No description'}{b.developer && !b.mine ? ` · by ${b.developer.displayName || b.developer.username}` : ''}</div>
          </div>
          <button className="btn small-btn primary" disabled={busy === 'add' + b.id || installed.length >= 10} onClick={() => add(b)}>Add</button>
        </div>
      ))}
      {installed.length >= 10 && <p className="muted small hint">A server can have up to 10 bots.</p>}
    </div>
  );
}

// ---------- Explorer: "Add to server" ----------
export function AddToServerModal({ bot, servers, me, onAdded, onClose }) {
  const mine = servers.filter((s) => can(s, me.id, 'manageServer'));
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  async function add(s) {
    setErr(''); setBusy(s.id);
    try { const r = await api(`/servers/${s.id}/bots`, { method: 'POST', body: { botId: bot.id } }); onAdded?.(r.server); setDone(s.name); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  return (
    <Modal title={`Add ${bot.name}`} onClose={onClose}>
      {done ? <p>Added to <b>{done}</b>. You can pick which channels it sees in Server settings &rsaquo; Bots.</p> : (
        <>
          <p className="muted small">Pick a server. It can read and answer in all text channels at first; you can narrow that afterwards.</p>
          {mine.length === 0 && <div className="empty">You do not manage any server. You need the Manage server permission to add a bot.</div>}
          <div className="bot-servers">
            {mine.map((s) => {
              const has = (s.bots || []).some((i) => i.botId === bot.id);
              return (
                <div key={s.id} className="bot-inst-row">
                  <div className="bot-inst-who"><b>{s.name}</b></div>
                  {has ? <span className="muted small">Already added</span> : <button className="btn small-btn primary" disabled={!!busy} onClick={() => add(s)}>{busy === s.id ? 'Adding…' : 'Add'}</button>}
                </div>
              );
            })}
          </div>
          {err && <div className="error">{err}</div>}
        </>
      )}
      <div className="modal-foot"><button className="btn" onClick={onClose}>{done ? 'Done' : 'Cancel'}</button></div>
    </Modal>
  );
}
