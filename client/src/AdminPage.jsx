import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { imageUrl } from './image.js';
import { RecapSettings } from './Recap.jsx';
import './admin.css';

// /admin: for admins, and for moderators (who only get Overview and Reports). The server already redirects anyone else to the home page before
// this loads, and every /api/admin route answers people without the role with a 404; if /api/admin/me fails here anyway, the page sends the
// visitor to the home page itself.
// The page has its own small dialogs and messages (no dependence on the app's theme), and shows everything people wrote as plain text.

const TABS = [['overview', 'Overview'], ['applications', 'Applications'], ['artists', 'Artist review'], ['shop', 'Shop'], ['people', 'People'], ['bots', 'Bots'], ['themes', 'Themes'], ['reports', 'Reports'], ['status', 'Status'], ['releases', 'Releases'], ['switches', 'Switches'], ['recap', 'Recap'], ['sales', 'Sales'], ['links', 'Links'], ['ipbans', 'IP bans'], ['admins', 'Admins'], ['log', 'Log']];
const REPORT_TABS = [['users', 'People and messages'], ['servers', 'Servers'], ['bots', 'Bots'], ['clips', 'Clips']];
const ROLE = { creator: 'Founder', config: 'Admin (server settings)', admin: 'Admin', moderator: 'Moderator' };
const MOD_TABS = ['overview', 'reports', 'people']; // a moderator reads and reviews reports, looks people up, and warns or mutes
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
// "for how long" choices (hours; the server's limits are in server/moderation.js)
const MUTE_FOR = [[1, '1 hour'], [6, '6 hours'], [24, '1 day'], [72, '3 days'], [168, '7 days'], [720, '30 days']];
const SUSPEND_FOR = [['', 'Until I lift it'], [24, '1 day'], [72, '3 days'], [168, '7 days'], [720, '30 days']];
const BAN_FOR = [[24, '1 day'], [168, '7 days'], [720, '30 days'], [8760, '1 year'], ['forever', 'Until I lift it']];
const label = (s) => String(s || '').replace(/[_-]/g, ' ').replace(/^./, (c) => c.toUpperCase());
const tabFromHash = () => { const h = location.hash.replace('#', ''); return TABS.some((t) => t[0] === h) ? h : 'overview'; };

const Ctx = React.createContext(null);
const useAdm = () => React.useContext(Ctx);

function Face({ u, size = 36 }) {
  const src = imageUrl(u.avatarImage);
  const [bad, setBad] = useState(false);
  const letter = u.avatarEmoji || (u.displayName || u.username || '?').slice(0, 1).toUpperCase();
  return (
    <span className="adm-face" style={{ width: size, height: size, background: u.avatarColor || '#8c6b4f', fontSize: size * 0.45 }}>
      {src && !bad ? <img src={src} alt="" onError={() => setBad(true)} /> : letter}
    </span>
  );
}

// A question in the page's own style. d: { title, body, lines, match (type this to confirm), textarea (label), required (the text may not be empty),
// duration: { label, options: [[value, name]], value } (a "for how long" choice, handed back as `hours`), checkbox: { label, on }, confirmLabel, danger }
function Dialog({ d, onDone }) {
  const [text, setText] = useState('');
  const [checked, setChecked] = useState(!!(d.checkbox && d.checkbox.on));
  const [hours, setHours] = useState(d.duration ? String(d.duration.value) : '');
  const ready = (d.match ? text.trim().toLowerCase() === String(d.match).toLowerCase() : true) && (!d.required || !!text.trim());
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onDone(null); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onDone]);
  return (
    <div className="adm-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onDone(null); }}>
      <div className="adm-dlg" role="dialog" aria-modal="true" aria-label={d.title}>
        <h2>{d.title}</h2>
        {d.body && <p className="adm-muted">{d.body}</p>}
        {d.lines && d.lines.length > 0 && <ul className="adm-lines">{d.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        {d.match && (
          <label className="adm-field"><span>Type <b>{d.match}</b> to confirm</span>
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        )}
        {d.textarea && (
          <label className="adm-field"><span>{d.textarea}</span>
            <textarea rows={3} maxLength={300} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}
        {d.duration && (
          <label className="adm-field"><span>{d.duration.label}</span>
            <select className="adm-input" value={hours} onChange={(e) => setHours(e.target.value)}>
              {d.duration.options.map(([v, name]) => <option key={v} value={String(v)}>{name}</option>)}
            </select>
          </label>
        )}
        {d.checkbox && <label className="adm-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /><span>{d.checkbox.label}</span></label>}
        <div className="adm-actions">
          <button className="adm-btn" onClick={() => onDone(null)}>Cancel</button>
          <button className={'adm-btn ' + (d.danger ? 'danger' : 'primary')} disabled={!ready} onClick={() => onDone({ text: text.trim(), checked, hours })}>{d.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- reports ----------
function ReportItems({ list, onChanged }) {
  const { me, ask, run } = useAdm();
  const dropMessage = async (id) => {
    const r = await ask({ title: 'Delete this message?', body: 'It is removed for everyone in the channel. The report stays until you dismiss it.', confirmLabel: 'Delete message', danger: true });
    if (r && await run(() => api(`/admin/messages/${id}/delete`, { method: 'POST' }), 'Message deleted')) onChanged();
  };
  return (
    <ul className="adm-reports">
      {list.map((r, i) => (
        <li key={i}>
          <div><b>{label(r.reason)}</b>{r.about === 'message' ? ' · message' : r.about === 'account' ? ' · account' : ''} <span className="adm-muted">by {r.by || 'someone'} · {when(r.at)}</span></div>
          {r.details && <p className="adm-details">{r.details}</p>}
          {r.message && (
            <blockquote>
              <small className="adm-muted">#{r.message.channel} in {r.message.server} · {when(r.message.sentAt)}</small>
              <p>{r.message.content || '(no text)'}{r.message.attachments > 0 && <span className="adm-muted"> · {r.message.attachments} attachment{r.message.attachments === 1 ? '' : 's'}</span>}</p>
              {me.role !== 'moderator' && <button className="adm-btn small danger" onClick={() => dropMessage(r.message.id)}>Delete message</button>}
            </blockquote>
          )}
        </li>
      ))}
    </ul>
  );
}

function Empty({ text }) { return <div className="adm-card"><p className="adm-muted">{text}</p></div>; }

function UserReports({ openUser }) {
  const { me, say, run, ask, refresh } = useAdm();
  const [rows, setRows] = useState(null);
  const load = useCallback(() => api('/admin/user-reports').then((r) => setRows(r.users)).catch((e) => { setRows([]); say(e.message, 'error'); }), [say]);
  useEffect(() => { load(); }, [load]);
  const changed = () => { load(); refresh(); };
  const dismiss = async (u) => {
    const r = await ask({ title: `Dismiss the reports about ${u.username}?`, body: 'They are cleared and nothing else happens to the account.', confirmLabel: 'Dismiss' });
    if (r && await run(() => api(`/admin/users/${u.userId}/reports`, { method: 'POST', body: { action: 'dismiss' } }), 'Reports dismissed')) changed();
  };
  if (!rows) return <p className="adm-muted">Loading…</p>;
  if (!rows.length) return <Empty text="No open reports about people or messages." />;
  return rows.map((u) => (
    <div className="adm-card" key={u.userId}>
      <div className="adm-row">
        <div><h3>{u.displayName || u.username} <span className="adm-muted">@{u.username}</span></h3><span className="adm-muted">{u.reports.length} report{u.reports.length === 1 ? '' : 's'}</span></div>
        <div className="adm-actions">
          <button className="adm-btn small" onClick={() => openUser(u.userId)}>Open person</button>
          <button className="adm-btn small" onClick={() => dismiss(u)}>Dismiss</button>
        </div>
      </div>
      <ReportItems list={u.reports} onChanged={changed} />
    </div>
  ));
}

function ServerSearch({ onChanged }) {
  const { say, run, ask } = useAdm();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!q.trim()) { setRows(null); return undefined; }
    const id = setTimeout(() => api('/admin/servers?q=' + encodeURIComponent(q.trim())).then((r) => setRows(r.servers)).catch((e) => say(e.message, 'error')), 250);
    return () => clearTimeout(id);
  }, [q, say]);
  const remove = async (s) => {
    const r = await ask({ title: `Delete the server “${s.name}”?`, body: `All its messages, files and ${s.members} member${s.members === 1 ? '' : 's'}’ place in it are removed for good.`, match: s.name, confirmLabel: 'Delete server', danger: true });
    if (r && await run(() => api(`/admin/servers/${s.id}/delete`, { method: 'POST' }), 'Server deleted')) { setRows((x) => (x || []).filter((y) => y.id !== s.id)); onChanged(); }
  };
  return (
    <div className="adm-card">
      <h3>Find a server</h3>
      <input className="adm-input" type="search" placeholder="Name, invite code or id" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows && !rows.length && <p className="adm-muted">No server matches.</p>}
      {rows && rows.map((s) => (
        <div className="adm-row adm-line" key={s.id}>
          <div><b>{s.name}</b> <span className="adm-muted">owner {s.owner || '—'} · {s.members} member{s.members === 1 ? '' : 's'} · {s.visibility || 'not listed'}{s.reports ? ` · ${s.reports} report${s.reports === 1 ? '' : 's'}` : ''}</span></div>
          <button className="adm-btn small danger" onClick={() => remove(s)}>Delete</button>
        </div>
      ))}
    </div>
  );
}

function ServerReports() {
  const { me, say, run, ask, refresh } = useAdm();
  const isMod = me.role === 'moderator';
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/admin/listing-reports').then(setData).catch((e) => { setData({ servers: [], toHide: 0 }); say(e.message, 'error'); }), [say]);
  useEffect(() => { load(); }, [load]);
  const changed = () => { load(); refresh(); };
  const listing = async (s, action, ok) => { if (await run(() => api(`/admin/servers/${s.serverId}/listing`, { method: 'POST', body: { action } }), ok)) changed(); };
  const remove = async (s) => {
    const r = await ask({ title: `Delete the server “${s.name}”?`, body: 'All its messages and files are removed for good, and every member is told it was deleted.', match: s.name, confirmLabel: 'Delete server', danger: true });
    if (r && await run(() => api(`/admin/servers/${s.serverId}/delete`, { method: 'POST' }), 'Server deleted')) changed();
  };
  return (
    <>
      {!data ? <p className="adm-muted">Loading…</p> : !data.servers.length ? <Empty text="No servers have reports or holds." /> : data.servers.map((s) => (
        <div className="adm-card" key={s.serverId}>
          <div className="adm-row">
            <div>
              <h3>{s.name}</h3>
              <span className="adm-muted">owner {s.owner || '—'} · {s.members} member{s.members === 1 ? '' : 's'} · {s.visibility || 'not listed'} · {s.counted}/{data.toHide} counted reports{s.hold ? ` · ${s.hold.state}` : ''}</span>
              {s.description && <p className="adm-details">{s.description}</p>}
            </div>
            <div className="adm-actions">
              {s.hold && <button className="adm-btn small" onClick={() => listing(s, 'restore', 'Listing restored')}>Restore listing</button>}
              <button className="adm-btn small" onClick={() => listing(s, 'dismiss', 'Reports dismissed')}>Dismiss</button>
              {!isMod && s.visibility === 'public' && <button className="adm-btn small" onClick={() => listing(s, 'remove', 'Taken off the explorer')}>Unlist</button>}
              {!isMod && <button className="adm-btn small danger" onClick={() => remove(s)}>Delete server</button>}
            </div>
          </div>
          {s.reports.length > 0 && <ReportItems list={s.reports} onChanged={changed} />}
        </div>
      ))}
      {!isMod && <ServerSearch onChanged={changed} />}
    </>
  );
}

function BotReports() {
  const { me, say, run, refresh } = useAdm();
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/admin/bot-reports').then(setData).catch((e) => { setData({ bots: [], toHide: 0 }); say(e.message, 'error'); }), [say]);
  useEffect(() => { load(); }, [load]);
  const changed = () => { load(); refresh(); };
  const act = async (b, action, ok) => { if (await run(() => api(`/admin/bots/${b.botId}/listing`, { method: 'POST', body: { action } }), ok)) changed(); };
  if (!data) return <p className="adm-muted">Loading…</p>;
  if (!data.bots.length) return <Empty text="No bots have reports or holds." />;
  return data.bots.map((b) => (
    <div className="adm-card" key={b.botId}>
      <div className="adm-row">
        <div>
          <h3>{b.name}</h3>
          <span className="adm-muted">developer {b.developer || '—'} · {b.visibility} · {b.installs} install{b.installs === 1 ? '' : 's'} · {b.counted}/{data.toHide} counted reports{b.hold ? ` · ${b.hold.state}` : ''}</span>
          {b.description && <p className="adm-details">{b.description}</p>}
        </div>
        <div className="adm-actions">
          {b.hold && <button className="adm-btn small" onClick={() => act(b, 'restore', 'Bot restored')}>Restore</button>}
          <button className="adm-btn small" onClick={() => act(b, 'dismiss', 'Reports dismissed')}>Dismiss</button>
          {me.role !== 'moderator' && <button className="adm-btn small danger" onClick={() => act(b, 'remove', 'Bot removed from every server')}>Remove bot</button>}
        </div>
      </div>
      {b.reports.length > 0 && <ReportItems list={b.reports} onChanged={changed} />}
    </div>
  ));
}

// ---------- bot verification ----------
// Public bots are listed whether or not they are verified (the explorer warns about the ones that are not). An admin opens a bot, reads its code, and verifies it.
// Verification is tied to the name and code that were read: the server refuses it if the developer changed the bot after it was opened, and it lapses by itself
// if the name or code change later (the "lapsed" mark below). Everything the developer wrote is shown as plain text.
function BotVerify() {
  const { say, run, ask } = useAdm();
  const [filter, setFilter] = useState('unverified');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null); // { id, code, about, prefix, commands, hash } for the bot being reviewed
  const load = useCallback(() => api('/admin/bots?filter=' + filter + (q.trim() ? '&q=' + encodeURIComponent(q.trim()) : '')).then(setData).catch((e) => { setData({ total: 0, bots: [] }); say(e.message, 'error'); }), [filter, q, say]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  const review = async (b) => {
    if (open && open.id === b.id) { setOpen(null); return; }
    try { setOpen({ id: b.id, ...(await api(`/admin/bots/${b.id}/code`)) }); } catch (e) { say(e.message, 'error'); }
  };
  const verify = async (b) => {
    if (!open || open.id !== b.id) return;
    if (await run(() => api(`/admin/bots/${b.id}/verify`, { method: 'POST', body: { hash: open.hash } }), 'Bot verified')) { setOpen(null); load(); }
  };
  const unverify = async (b) => {
    const r = await ask({ title: `Remove the verified mark from ${b.name}?`, body: 'It is listed with the warning for unverified bots again, and its developer is told.', confirmLabel: 'Remove mark', danger: true });
    if (r && await run(() => api(`/admin/bots/${b.id}/verify`, { method: 'POST', body: { verified: false } }), 'Verified mark removed')) { setOpen(null); load(); }
  };
  return (
    <>
      <div className="adm-subtabs" role="group" aria-label="Filter bots">
        {[['unverified', 'Waiting'], ['verified', 'Verified'], ['all', 'All public bots']].map(([id, name]) => (
          <button key={id} className={'adm-chip' + (filter === id ? ' on' : '')} aria-pressed={filter === id} onClick={() => { setFilter(id); setOpen(null); }}>{name}</button>
        ))}
        <input className="adm-input" placeholder="Search by bot or developer" value={q} maxLength={60} onChange={(e) => setQ(e.target.value)} aria-label="Search bots" />
      </div>
      {!data ? <p className="adm-muted">Loading…</p> : !data.bots.length ? <Empty text={filter === 'unverified' ? 'No public bots are waiting for review.' : 'No bots match.'} /> : (
        <>
          {data.total > data.bots.length && <p className="adm-muted">Showing {data.bots.length} of {data.total}. Search to narrow it down.</p>}
          {data.bots.map((b) => (
            <div className="adm-card" key={b.id}>
              <div className="adm-row">
                <div>
                  <h3>{b.name} {b.verified && <span className="adm-muted">✓ verified</span>}{b.lapsed && <span className="adm-muted"> · verification lapsed: the code or name changed</span>}</h3>
                  <span className="adm-muted">developer {b.developer || '—'} · {b.installs} install{b.installs === 1 ? '' : 's'} · updated {when(b.updatedAt)}{b.hold ? ` · listing ${b.hold}` : ''}{b.verified && b.verifiedBy ? ` · verified by ${b.verifiedBy} on ${when(b.verifiedAt)}` : ''}</span>
                  {b.description && <p className="adm-details">{b.description}</p>}
                  {b.tags.length > 0 && <span className="adm-muted">Tags: {b.tags.join(', ')}</span>}
                </div>
                <div className="adm-actions">
                  <button className="adm-btn small" onClick={() => review(b)}>{open && open.id === b.id ? 'Close' : 'Read the code'}</button>
                  {b.verified && <button className="adm-btn small danger" onClick={() => unverify(b)}>Remove mark</button>}
                  {!b.verified && <button className="adm-btn small primary" disabled={!open || open.id !== b.id || !!b.hold} title={b.hold ? 'Settle the reports first' : 'Read the code first'} onClick={() => verify(b)}>Verify</button>}
                </div>
              </div>
              {open && open.id === b.id && (
                <div>
                  <p className="adm-muted">Command prefix: <b>{open.prefix}</b>{open.commands.length > 0 && ` · ${open.commands.length} command${open.commands.length === 1 ? '' : 's'}: ${open.commands.map((c) => (typeof c === 'string' ? c : c && c.name) || '?').join(', ')}`}</p>
                  {open.about && <p className="adm-details">{open.about}</p>}
                  <pre style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: 12, borderRadius: 8, background: 'rgba(127,127,127,.12)', fontSize: 12 }}>{open.code || '(no code)'}</pre>
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

// ---------- developer themes ----------
// A developer theme is CSS plus pictures. An admin reads the CSS, looks at every picture, tries it in the app, then approves or rejects exactly that:
// the server refuses the decision if the developer changed anything after it was opened (hash), and an approval lapses if the theme changes later.
const THEME_STATE = { draft: 'Draft', pending: 'Waiting', approved: 'Verified', rejected: 'Turned down' };
const previewLink = (t) => `/app?devthemepreview=${encodeURIComponent(t.id)}.${t.key}.${t.seed.dark ? 'dark' : 'light'}.${t.seed.bg.slice(1)}.${t.seed.accent.slice(1)}`;

function ThemeReview() {
  const { say, run, ask } = useAdm();
  const [filter, setFilter] = useState('pending');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => api('/admin/devthemes?filter=' + filter + (q.trim() ? '&q=' + encodeURIComponent(q.trim()) : '')).then(setData).catch((e) => { setData({ total: 0, themes: [] }); say(e.message, 'error'); }), [filter, q, say]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  const read = async (t) => {
    if (open && open.id === t.id) { setOpen(null); return; }
    try { setOpen(await api(`/admin/devthemes/${t.id}`)); } catch (e) { say(e.message, 'error'); }
  };
  const decide = async (t, action) => {
    let note = '';
    if (action === 'reject') {
      const r = await ask({ title: `Turn down ${t.name}?`, body: 'The developer sees your note. They have to change something before they can send it again.', textarea: 'Note for the developer (optional)', confirmLabel: 'Turn down', danger: true });
      if (!r) return;
      note = r.text;
    }
    if (action === 'revoke') {
      const r = await ask({ title: `Remove the verified mark from ${t.name}?`, body: 'It leaves the gallery and nobody can load it any more.', confirmLabel: 'Remove mark', danger: true });
      if (!r) return;
    }
    const done = { approve: 'Theme verified', reject: 'Theme turned down', revoke: 'Verified mark removed' }[action];
    if (await run(() => api(`/admin/devthemes/${t.id}/review`, { method: 'POST', body: { action, hash: open && open.id === t.id ? open.hash : undefined, note } }), done)) { setOpen(null); load(); }
  };
  return (
    <>
      <div className="adm-subtabs" role="group" aria-label="Filter themes">
        {[['pending', 'Waiting'], ['approved', 'Verified'], ['rejected', 'Turned down'], ['all', 'All']].map(([id, name]) => (
          <button key={id} className={'adm-chip' + (filter === id ? ' on' : '')} aria-pressed={filter === id} onClick={() => { setFilter(id); setOpen(null); }}>{name}</button>
        ))}
        <input className="adm-input" placeholder="Search by theme or developer" value={q} maxLength={60} onChange={(e) => setQ(e.target.value)} aria-label="Search themes" />
      </div>
      {!data ? <p className="adm-muted">Loading…</p> : !data.themes.length ? <Empty text={filter === 'pending' ? 'No themes are waiting for review.' : 'No themes match.'} /> : (
        <>
          {data.total > data.themes.length && <p className="adm-muted">Showing {data.themes.length} of {data.total}. Search to narrow it down.</p>}
          {data.themes.map((t) => {
            const shown = open && open.id === t.id;
            return (
              <div className="adm-card" key={t.id}>
                <div className="adm-row">
                  <div>
                    <h3>{t.name} <span className="adm-muted">{THEME_STATE[t.status] || t.status}</span>{t.lapsed && <span className="adm-muted"> · verification lapsed: something changed</span>}{t.hidden && <span className="adm-muted"> · hidden by reports</span>}</h3>
                    <span className="adm-muted">developer {t.developer || '—'} · {t.images} picture{t.images === 1 ? '' : 's'} · {t.uses} use{t.uses === 1 ? '' : 's'} · {t.submittedAt ? `sent ${when(t.submittedAt)}` : `updated ${when(t.updatedAt)}`}{t.reviewedBy ? ` · reviewed by ${t.reviewedBy}` : ''}</span>
                    {t.description && <p className="adm-details">{t.description}</p>}
                  </div>
                  <div className="adm-actions">
                    <button className="adm-btn small" onClick={() => read(t)}>{shown ? 'Close' : 'Read it'}</button>
                    {t.status === 'pending' && <button className="adm-btn small primary" disabled={!shown} title={shown ? '' : 'Read it first'} onClick={() => decide(t, 'approve')}>Verify</button>}
                    {t.status === 'pending' && <button className="adm-btn small danger" disabled={!shown} title={shown ? '' : 'Read it first'} onClick={() => decide(t, 'reject')}>Turn down</button>}
                    {(t.status === 'approved' || t.lapsed) && <button className="adm-btn small danger" onClick={() => decide(t, 'revoke')}>Remove mark</button>}
                  </div>
                </div>
                {shown && (
                  <div>
                    <p className="adm-muted">Base colours: {open.seed.dark ? 'dark' : 'light'}, background {open.seed.bg}, accent {open.seed.accent}. <a href={previewLink(open)} target="_blank" rel="noopener noreferrer">Try it in the app</a> (this tab only, nothing is saved).</p>
                    {open.note && <p className="adm-details">Earlier note: {open.note}</p>}
                    {open.images.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '8px 0' }}>
                        {open.images.map((p) => (
                          <figure key={p.name} style={{ margin: 0, maxWidth: 220 }}>
                            <a href={p.url} target="_blank" rel="noopener noreferrer"><img src={p.url} alt={p.name} loading="lazy" style={{ maxWidth: 220, maxHeight: 160, objectFit: 'contain', borderRadius: 6, background: 'rgba(127,127,127,.12)' }} /></a>
                            <figcaption className="adm-muted">{p.name} · {p.width}×{p.height} · {Math.max(1, Math.round(p.bytes / 1024))} KB</figcaption>
                          </figure>
                        ))}
                      </div>
                    )}
                    <pre style={{ maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: 12, borderRadius: 8, background: 'rgba(127,127,127,.12)', fontSize: 12 }}>{open.css || '(no CSS)'}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function ClipReports() {
  const { me, say, run, ask, refresh } = useAdm();
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/admin/clips').then(setData).catch((e) => { setData(e.status === 503 ? { off: true, clips: [] } : { clips: [] }); if (e.status !== 503) say(e.message, 'error'); }), [say]);
  useEffect(() => { load(); }, [load]);
  const changed = () => { load(); refresh(); };
  const act = async (c, action, ok) => { if (await run(() => api(`/admin/clips/${c.id}`, { method: 'POST', body: { action } }), ok)) changed(); };
  const remove = async (c) => {
    const r = await ask({ title: 'Remove this clip?', body: 'The video is deleted for good. Its numbers stay.', confirmLabel: 'Remove clip', danger: true });
    if (r) act(c, 'remove', 'Clip removed');
  };
  if (!data) return <p className="adm-muted">Loading…</p>;
  if (data.off) return <Empty text="Clips are not set up on this server." />;
  if (!data.clips.length) return <Empty text="No clips have reports or holds." />;
  return data.clips.map((c) => (
    <div className="adm-card" key={c.id}>
      <div className="adm-row">
        <div className="adm-clip">
          {c.poster && <img src={c.poster} alt="" loading="lazy" />}
          <div>
            <h3>{c.caption || '(no caption)'}</h3>
            <span className="adm-muted">by {c.owner || '—'} · {c.state}{c.hold ? (c.hold.by === 'screening' ? ' (held by the automatic check)' : ` (${c.hold.state || 'held'})`) : ''} · {c.views} views · {c.likes} likes · {c.counted}/{data.toHide} counted reports</span>
            {c.screen && c.screen.verdict !== 'pass' && <div className="adm-muted">Automatic check: {c.screen.summary}</div>}
            {c.url && <div><a href={c.url} target="_blank" rel="noopener noreferrer">Watch the video</a></div>}
          </div>
        </div>
        <div className="adm-actions">
          {c.state === 'hidden' && <button className="adm-btn small" onClick={() => act(c, 'restore', 'Clip restored')}>Restore</button>}
          <button className="adm-btn small" onClick={() => act(c, 'dismiss', 'Reports dismissed')}>Dismiss</button>
          {me.role !== 'moderator' && <button className="adm-btn small danger" onClick={() => remove(c)}>Remove</button>}
        </div>
      </div>
      {c.reports.length > 0 && <ReportItems list={c.reports} onChanged={changed} />}
    </div>
  ));
}

function Reports({ sub, setSub, openUser }) {
  const { summary } = useAdm();
  const n = (k) => (summary ? summary.reports[k] : 0);
  return (
    <>
      <div className="adm-subtabs" role="tablist">
        {REPORT_TABS.map(([id, name]) => (
          <button key={id} role="tab" aria-selected={sub === id} className={'adm-chip' + (sub === id ? ' on' : '')} onClick={() => setSub(id)}>{name}{n(id) > 0 && <b>{n(id)}</b>}</button>
        ))}
      </div>
      {sub === 'users' && <UserReports openUser={openUser} />}
      {sub === 'servers' && <ServerReports />}
      {sub === 'bots' && <BotReports />}
      {sub === 'clips' && <ClipReports />}
    </>
  );
}

// ---------- people ----------
function UserDetail({ id, onChanged, onClose }) {
  const { ask, run, me } = useAdm();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api('/admin/users/' + id).then((r) => { setD(r); setErr(''); }).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { setD(null); load(); }, [load]);
  if (err) return <div className="adm-card"><p className="adm-muted">{err}</p></div>;
  if (!d) return <div className="adm-card"><p className="adm-muted">Loading…</p></div>;
  const u = d.user;
  const isMod = me.role === 'moderator';
  const after = () => { load(); onChanged(); };

  const suspend = async () => {
    const r = await ask({ title: `Suspend ${u.username}?`, body: 'They are signed out everywhere right away and cannot sign in. Nothing of theirs is removed, and their username and email stay reserved. You can lift this later, or pick a length and it ends by itself.', textarea: 'Reason (they see it when they try to sign in)', duration: { label: 'For how long', options: SUSPEND_FOR, value: '' }, confirmLabel: 'Suspend', danger: true });
    if (r && await run(() => api(`/admin/users/${u.id}/suspend`, { method: 'POST', body: { reason: r.text, hours: r.hours ? Number(r.hours) : undefined } }), 'Account suspended')) after();
  };
  const unsuspend = async () => { if (await run(() => api(`/admin/users/${u.id}/unsuspend`, { method: 'POST' }), 'Suspension lifted')) after(); };
  const m = u.moderation || { warnings: [], activeWarnings: 0, mute: null, suspendedUntil: null };
  const warn = async () => {
    const r = await ask({ title: `Warn ${u.username}?`, body: 'Next time they open Aduna they see this and must press “I understand” before they can send anything. A warning counts for 90 days: the 3rd is a 24 hour mute' + (isMod ? ' automatically. The 5th suspends the account, so an admin has to give that one.' : ' and the 5th a 7 day suspension, automatically.'), textarea: 'What is it for? (they read this)', required: true, confirmLabel: 'Send warning' });
    if (!r) return;
    await run(() => api(`/admin/users/${u.id}/warn`, { method: 'POST', body: { reason: r.text } }).then((x) => { after(); return x; }),
      (x) => (x.escalation ? `Warning sent. That was warning ${x.moderation.activeWarnings}, so they are now ${x.escalation.type === 'mute' ? 'muted for 24 hours' : 'suspended for 7 days'}.` : 'Warning sent'));
  };
  const mute = async () => {
    const r = await ask({ title: `Mute ${u.username}?`, body: 'They cannot send messages in channels, DMs or groups until it ends. They can still read, and see the reason.', textarea: 'Reason (they see it)', required: true, duration: { label: 'For how long', options: isMod ? MUTE_FOR.filter(([h]) => h <= 24) : MUTE_FOR, value: 24 }, confirmLabel: 'Mute' });
    if (r && await run(() => api(`/admin/users/${u.id}/mute`, { method: 'POST', body: { reason: r.text, hours: Number(r.hours) } }), 'Muted')) after();
  };
  const unmute = async () => { if (await run(() => api(`/admin/users/${u.id}/unmute`, { method: 'POST' }), 'Mute lifted')) after(); };
  const retract = async (w) => {
    const r = await ask({ title: 'Take this warning back?', body: w.seenAt ? 'It stops counting towards the 3 and 5 warning limits. A mute or suspension it already caused stays until you lift it.' : 'They have not read it yet, so it disappears from their screen. A mute or suspension it already caused stays until you lift it.', confirmLabel: 'Take it back' });
    if (r && await run(() => api(`/admin/users/${u.id}/warnings/${w.id}`, { method: 'DELETE' }), 'Warning taken back')) after();
  };
  const del = async () => {
    const lines = u.owned.map((s) => `The server “${s.name}” (${s.members} member${s.members === 1 ? '' : 's'}) is deleted`);
    if (u.liveClips) lines.push(`${u.liveClips} live clip${u.liveClips === 1 ? '' : 's'} removed`);
    if (u.bots) lines.push(`${u.bots} bot${u.bots === 1 ? '' : 's'} deleted`);
    const r = await ask({
      title: `Delete ${u.username}?`,
      body: 'They are signed out everywhere and this cannot be undone. Their direct messages stay for the people they wrote to. Their username and email become free to register again (Suspend keeps them reserved).',
      lines, match: u.username, checkbox: { label: 'Also delete all their messages in servers', on: true }, confirmLabel: 'Delete account', danger: true,
    });
    if (!r) return;
    const ok = await run(() => api(`/admin/users/${u.id}/delete`, { method: 'POST', body: { confirm: u.username, purge: r.checked } }),
      (x) => `Deleted. Removed ${x.serversDeleted} server${x.serversDeleted === 1 ? '' : 's'}, ${x.messages} message${x.messages === 1 ? '' : 's'}, ${x.clips} clip${x.clips === 1 ? '' : 's'}, ${x.bots} bot${x.bots === 1 ? '' : 's'}.`);
    if (ok) { onChanged(); onClose(); }
  };
  const makeAdmin = async () => {
    const r = await ask({ title: `Make ${u.username} an admin?`, body: 'They can open this page, read every report, suspend or delete accounts, and delete servers. They cannot act on creators or other admins.', confirmLabel: 'Make admin' });
    if (r && await run(() => api('/admin/admins', { method: 'POST', body: { userId: u.id } }), `${u.username} is now an admin`)) after();
  };
  const dropAdmin = async () => {
    const r = await ask({ title: `Remove ${u.username} as admin?`, confirmLabel: 'Remove admin', danger: true });
    if (r && await run(() => api('/admin/admins/' + u.id, { method: 'DELETE' }), 'Admin removed')) after();
  };
  const removeArtist = async () => {
    const r = await ask({ title: `Remove ${u.username} as an artist?`, body: 'The Artist badge goes and their approved items come off sale. People who already own an item keep it, and anything still waiting for review is sent back. They see your reason and can apply again after the wait.', textarea: 'Reason (they see it)', required: true, confirmLabel: 'Remove artist', danger: true });
    if (r && await run(() => api(`/admin/users/${u.id}/remove-artist`, { method: 'POST', body: { reason: r.text } }), 'Artist removed')) after();
  };
  const resetStorage = async () => {
    const r = await ask({ title: 'Reset the storage plan for this test account?', body: 'This clears the plan record on Aduna, so Subscribe works again for another test payment. It does not touch Stripe: the subscription and saved card there stay, and nothing is refunded. Payment testing only.', confirmLabel: 'Reset plan', danger: true });
    if (r && await run(() => api(`/admin/users/${u.id}/storage-reset`, { method: 'POST' }), (x) => `Storage plan cleared (was ${x.was})`)) after();
  };

  return (
    <div className="adm-card adm-detail">
      <div className="adm-row">
        <div className="adm-who"><Face u={u} size={56} /><div><h2>{u.displayName}</h2><span className="adm-muted">@{u.username}</span></div></div>
        <button className="adm-btn small" onClick={onClose}>Close</button>
      </div>
      <div className="adm-tags">
        {u.role && <span className="adm-tag">{ROLE[u.role]}</span>}
        {u.artist && <span className="adm-tag">Artist</span>}
        {u.suspended && <span className="adm-tag bad">Suspended</span>}
        {m.mute && <span className="adm-tag warn">Muted</span>}
        {m.activeWarnings > 0 && <span className="adm-tag warn">{m.activeWarnings} warning{m.activeWarnings === 1 ? '' : 's'}</span>}
      </div>
      {u.suspended && <p className="adm-details">Suspended {when(u.suspended.at)}{u.suspended.until ? ` until ${when(u.suspended.until)}` : ' until lifted'}{u.suspended.reason ? `: ${u.suspended.reason}` : ''}</p>}
      {m.mute && <p className="adm-details">Muted until {when(m.mute.until)}{m.mute.auto ? ' (automatic, from warnings)' : m.mute.by ? ` by ${m.mute.by}` : ''}: {m.mute.reason}</p>}
      {u.bio && <p className="adm-details">{u.bio}</p>}
      <dl className="adm-facts">
        <div><dt>Joined</dt><dd>{when(u.createdAt)}</dd></div>
        {!u.limited && <div><dt>Servers</dt><dd>{u.servers} ({u.owned.length} owned)</dd></div>}
        {!u.limited && <div><dt>Clips</dt><dd>{u.clips} ({u.liveClips} live)</dd></div>}
        {!u.limited && <div><dt>Bots</dt><dd>{u.bots}</dd></div>}
        <div><dt>Reports</dt><dd>{u.reports}</dd></div>
        <div><dt>User id</dt><dd className="adm-mono">{u.id}</dd></div>
      </dl>
      {u.owned.length > 0 && <p className="adm-muted">Owns: {u.owned.map((s) => `${s.name} (${s.members})`).join(', ')}</p>}

      {u.canModerate ? (
        <div className="adm-actions">
          <button className="adm-btn" onClick={warn}>Warn</button>
          {m.mute ? (!isMod || m.mute.by === me.username) && <button className="adm-btn" onClick={unmute}>Lift mute</button> : <button className="adm-btn" onClick={mute}>Mute</button>}
          {!isMod && (u.suspended ? <button className="adm-btn" onClick={unsuspend}>Lift suspension</button> : <button className="adm-btn" onClick={suspend}>Suspend</button>)}
          {!isMod && u.artist && <button className="adm-btn" onClick={removeArtist}>Remove artist</button>}
          {!isMod && <button className="adm-btn danger" onClick={del}>Delete account</button>}
          {!isMod && me.canManageAdmins && (u.role === 'admin' ? <button className="adm-btn" onClick={dropAdmin}>Remove as admin</button> : !u.role && !u.suspended && <button className="adm-btn" onClick={makeAdmin}>Make admin</button>)}
        </div>
      ) : (
        <p className="adm-muted">{u.id === me.id ? 'This is you.' : u.role === 'creator' ? 'Founder accounts cannot be moderated here.' : u.moderator && isMod ? 'Only an admin can act on a moderator.' : 'Only a founder can act on an admin.'}</p>
      )}
      {u.ownsOfficialServer && <p className="adm-muted">This account owns the official Aduna server, so it cannot be deleted until that is transferred.</p>}
      {u.canResetStorage && (
        <div className="adm-actions">
          <button className="adm-btn" onClick={resetStorage}>Reset storage plan (payment testing)</button>
          <span className="adm-muted">Plan now: {u.storagePlanStatus || 'none'}{u.storagePaidThrough ? ` · paid through ${when(u.storagePaidThrough)}` : ''}</span>
        </div>
      )}

      <h3>Warnings</h3>
      {m.warnings.length ? (
        <ul className="adm-reports">
          {m.warnings.map((w) => (
            <li key={w.id}>
              <div><b>{w.counts ? 'Counts' : 'Over 90 days old'}</b> <span className="adm-muted">{w.by ? `by ${w.by}` : 'automatic'} · {when(w.at)} · {w.seenAt ? `read ${when(w.seenAt)}` : 'not read yet'}</span></div>
              <p className="adm-details">{w.reason}</p>
              {u.canModerate && (!isMod || w.by === me.username) && <button className="adm-btn small" onClick={() => retract(w)}>Take back</button>}
            </li>
          ))}
        </ul>
      ) : <p className="adm-muted">None.</p>}

      <h3>Reports about them</h3>
      {d.reports.length ? <ReportItems list={d.reports} onChanged={after} /> : <p className="adm-muted">None.</p>}
    </div>
  );
}

const PEOPLE_FILTERS = [['', 'Everyone'], ['artist', 'Artists'], ['admin', 'Admins'], ['founder', 'Founders']];

function People({ focusId, clearFocus, refresh }) {
  const { say } = useAdm();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [sel, setSel] = useState(focusId || null);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (focusId) { setSel(focusId); clearFocus(); } }, [focusId, clearFocus]);
  useEffect(() => {
    const id = setTimeout(() => api('/admin/users?q=' + encodeURIComponent(q.trim()) + (role ? '&role=' + role : '')).then((r) => { setRows(r.users); setTotal(r.total); }).catch((e) => say(e.message, 'error')), q ? 250 : 0);
    return () => clearTimeout(id);
  }, [q, role, tick, say]);
  const changed = () => { setTick((t) => t + 1); refresh(); };
  return (
    <div className="adm-split">
      <div className="adm-card adm-list">
        <input className="adm-input" type="search" placeholder="Search by username, name or id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        <div className="adm-subtabs" role="group" aria-label="Filter by role">
          {PEOPLE_FILTERS.map(([id, name]) => <button key={id} className={'adm-chip' + (role === id ? ' on' : '')} aria-pressed={role === id} onClick={() => setRole(id)}>{name}</button>)}
        </div>
        {!rows ? <p className="adm-muted">Loading…</p> : !rows.length ? <p className="adm-muted">No one matches.</p> : (
          <>
            <ul>
              {rows.map((u) => (
                <li key={u.id}>
                  <button className={'adm-person' + (sel === u.id ? ' on' : '')} onClick={() => setSel(u.id)}>
                    <Face u={u} />
                    <span><b>{u.displayName}</b><small className="adm-muted"> @{u.username}</small></span>
                    {u.role && <span className="adm-tag">{u.role === 'creator' ? 'Founder' : 'Admin'}</span>}
                    {u.artist && <span className="adm-tag">Artist</span>}
                    {u.suspended && <span className="adm-tag bad">Suspended</span>}
                    {u.muted && <span className="adm-tag warn">Muted</span>}
                    {u.reports > 0 && <span className="adm-tag warn">{u.reports}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {total > rows.length && <p className="adm-muted">Showing {rows.length} of {total}. Type more to narrow it down.</p>}
          </>
        )}
      </div>
      <div className="adm-pane">
        {sel ? <UserDetail id={sel} onChanged={changed} onClose={() => setSel(null)} /> : <div className="adm-card"><p className="adm-muted">Pick someone to see their details and moderate them.</p></div>}
      </div>
    </div>
  );
}

// ---------- admins ----------
function Admins({ openUser }) {
  const { me, say, run, ask, refresh } = useAdm();
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [mods, setMods] = useState(null);
  const load = useCallback(() => api('/admin/admins').then((r) => setList(r.admins)).catch((e) => say(e.message, 'error')), [say]);
  const loadMods = useCallback(() => api('/admin/moderators').then((r) => setMods(r.moderators)).catch((e) => say(e.message, 'error')), [say]);
  useEffect(() => { load(); loadMods(); }, [load, loadMods]);
  useEffect(() => {
    if (!q.trim()) { setFound(null); return undefined; }
    const id = setTimeout(() => api('/admin/users?q=' + encodeURIComponent(q.trim())).then((r) => setFound(r.users)).catch((e) => say(e.message, 'error')), 250);
    return () => clearTimeout(id);
  }, [q, say]);
  const add = async (u) => {
    const r = await ask({ title: `Make ${u.username} an admin?`, body: 'They can open this page, read every report, suspend or delete accounts, and delete servers. They cannot act on creators or other admins.', confirmLabel: 'Make admin' });
    if (r && await run(() => api('/admin/admins', { method: 'POST', body: { userId: u.id } }), `${u.username} is now an admin`)) { setQ(''); load(); loadMods(); refresh(); }
  };
  const addMod = async (u) => {
    const r = await ask({ title: `Make ${u.username} a moderator?`, body: 'They can open this page, read every report and dismiss or restore what was reported, look people up, and warn them or mute them for up to a day. They cannot suspend, delete or take anything down for good, cannot act on admins or other moderators, and see nothing else here.', confirmLabel: 'Make moderator' });
    if (r && await run(() => api('/admin/moderators', { method: 'POST', body: { userId: u.id } }), `${u.username} is now a moderator`)) { setQ(''); loadMods(); }
  };
  const dropMod = async (u) => {
    const r = await ask({ title: `Remove ${u.username} as moderator?`, body: 'They lose access to this page right away.', confirmLabel: 'Remove moderator', danger: true });
    if (r && await run(() => api('/admin/moderators/' + u.id, { method: 'DELETE' }), 'Moderator removed')) loadMods();
  };
  const drop = async (u) => {
    const r = await ask({ title: `Remove ${u.username} as admin?`, body: 'They lose access to this page right away.', confirmLabel: 'Remove admin', danger: true });
    if (r && await run(() => api('/admin/admins/' + u.id, { method: 'DELETE' }), 'Admin removed')) { load(); refresh(); }
  };
  return (
    <>
      <div className="adm-card">
          <h3>Add an admin or moderator</h3>
          <input className="adm-input" type="search" placeholder="Search for the person by username" value={q} onChange={(e) => setQ(e.target.value)} />
          {found && !found.length && <p className="adm-muted">No one matches.</p>}
          {found && found.map((u) => (
            <div className="adm-row adm-line" key={u.id}>
              <div className="adm-who"><Face u={u} /><div><b>{u.displayName}</b> <span className="adm-muted">@{u.username}</span></div></div>
              {u.role ? <span className="adm-tag">{ROLE[u.role]}</span> : u.suspended ? <span className="adm-tag bad">Suspended</span> : (
                <div className="adm-actions">
                  {u.moderator ? <span className="adm-tag">{ROLE.moderator}</span> : <button className="adm-btn small" onClick={() => addMod(u)}>Make moderator</button>}
                  {me.canManageAdmins && <button className="adm-btn small primary" onClick={() => add(u)}>Make admin</button>}
                </div>
              )}
            </div>
          ))}
          {!me.canManageAdmins && <p className="adm-muted">Only a creator account can make admins. You can make moderators.</p>}
      </div>
      <div className="adm-card">
        <h3>Moderators</h3>
        <p className="adm-muted">They can read every report and dismiss or restore what was reported. Nothing else.</p>
        {!mods ? <p className="adm-muted">Loading…</p> : !mods.length ? <p className="adm-muted">No moderators yet.</p> : mods.map((u) => (
          <div className="adm-row adm-line" key={u.id}>
            <div className="adm-who"><Face u={u} /><div><b>{u.displayName}</b> <span className="adm-muted">@{u.username}</span><div className="adm-muted">{u.since ? `since ${when(u.since)}` : ''}{u.addedBy ? ` · added by ${u.addedBy}` : ''}</div></div></div>
            <div className="adm-actions">
              <button className="adm-btn small" onClick={() => openUser(u.id)}>Open</button>
              <button className="adm-btn small danger" onClick={() => dropMod(u)}>Remove</button>
            </div>
          </div>
        ))}
      </div>
      <div className="adm-card">
        <h3>Everyone with access</h3>
        {!list ? <p className="adm-muted">Loading…</p> : list.map((u) => (
          <div className="adm-row adm-line" key={u.id}>
            <div className="adm-who"><Face u={u} /><div><b>{u.displayName}</b> <span className="adm-muted">@{u.username}</span><div className="adm-muted">{ROLE[u.role]}{u.since ? ` · since ${when(u.since)}` : ''}{u.addedBy ? ` · added by ${u.addedBy}` : ''}</div></div></div>
            <div className="adm-actions">
              {u.id !== me.id && <button className="adm-btn small" onClick={() => openUser(u.id)}>Open</button>}
              {me.canManageAdmins && u.role === 'admin' && <button className="adm-btn small danger" onClick={() => drop(u)}>Remove</button>}
            </div>
          </div>
        ))}
        <p className="adm-muted">Founder accounts and names in the server’s ADMIN_USERNAMES setting always have access and cannot be removed here.</p>
      </div>
    </>
  );
}

// ---------- applications ----------
// People ask to join from the sign-up screen; nothing is created until someone approves here. Everything they wrote is shown as plain text.
function Applications() {
  const { say, run, ask } = useAdm();
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/admin/applications').then(setData).catch((e) => { setData({ pending: [], denied: [], on: true }); say(e.message, 'error'); }), [say]);
  useEffect(() => { load(); }, [load]);
  const approve = async (a) => {
    const r = await ask({ title: `Approve ${a.username}?`, body: 'Their account is made right away and they can log in with the password they chose.', confirmLabel: 'Approve' });
    if (r) { await run(() => api(`/admin/applications/${a.id}/approve`, { method: 'POST' }), `${a.username} approved`); load(); }
  };
  const deny = async (a) => {
    const r = await ask({ title: `Deny ${a.username}?`, body: 'No account is made. They are told it was not approved the next time they try to log in (and by email, if email is set up).', textarea: 'Note to the applicant (optional)', confirmLabel: 'Deny', danger: true });
    if (r) { await run(() => api(`/admin/applications/${a.id}/deny`, { method: 'POST', body: { note: r.text } }), 'Application denied'); load(); }
  };
  if (!data) return <p className="adm-muted">Loading…</p>;
  return (
    <>
      {!data.on && <div className="adm-card"><p className="adm-muted">Applications are switched off on this server (APPLY_TO_JOIN=off), so new people sign up without one. Any still waiting below can be decided.</p></div>}
      {!data.pending.length ? <Empty text="No applications are waiting." /> : data.pending.map((a) => (
        <div className="adm-card" key={a.id}>
          <div className="adm-row">
            <div>
              <h3>{a.displayName} <span className="adm-muted">@{a.username}</span></h3>
              <span className="adm-muted">{a.email} · applied {when(a.createdAt)}{a.source ? ` · heard about us: ${a.source}` : ''}</span>
              <p className="adm-details">{a.reason}</p>
            </div>
            <div className="adm-actions">
              <button className="adm-btn small primary" onClick={() => approve(a)}>Approve</button>
              <button className="adm-btn small danger" onClick={() => deny(a)}>Deny</button>
            </div>
          </div>
        </div>
      ))}
      {data.denied.length > 0 && (
        <div className="adm-card">
          <h3>Recently denied</h3>
          {data.denied.map((a) => (
            <div className="adm-row adm-line" key={a.id}>
              <div><b>@{a.username}</b> <span className="adm-muted">{a.email} · denied {when(a.decidedAt)} by {a.decidedBy || '—'}{a.note ? ` · “${a.note}”` : ''}</span></div>
            </div>
          ))}
          <p className="adm-muted">Denials are forgotten after 30 days.</p>
        </div>
      )}
    </>
  );
}

// ---------- artist review ----------
// Artists apply with four pieces of art and then send shop items (badges, profile frames, sticker packs) for review. Both wait here.
// Creator accounts need no review (the server approves theirs when they are sent). Nobody can decide on their own application or items.
const ITEM_KIND = { badge: 'Badge', frame: 'Profile frame', stickers: 'Sticker pack' };
const thumb = { height: 96, maxWidth: 160, objectFit: 'contain', borderRadius: 8, background: 'rgba(128,128,128,.15)' };
function ArtistReview() {
  const { say, run, ask } = useAdm();
  const [q, setQ] = useState(null);
  const load = useCallback(() => api('/artists/review').then(setQ).catch((e) => { setQ({ applications: [], items: [] }); say(e.message, 'error'); }), [say]);
  useEffect(() => { load(); }, [load]);
  const decide = async (url, action) => {
    let note = '';
    if (action === 'reject') {
      const r = await ask({ title: 'Send this back?', body: 'The artist sees your note, so say what to change.', textarea: 'Note to the artist (needed)', confirmLabel: 'Reject', danger: true });
      if (!r) return;
      if (!r.text) { say('Write a note so the artist knows what to change', 'error'); return; }
      note = r.text;
    }
    if (await run(() => api(url, { method: 'POST', body: { action, note } }), action === 'approve' ? 'Approved' : 'Sent back')) load();
  };
  const buttons = (own, url) => (own
    ? <p className="adm-muted">This one is yours, so someone else has to review it.</p>
    : <div className="adm-actions"><button className="adm-btn small primary" onClick={() => decide(url, 'approve')}>Approve</button><button className="adm-btn small danger" onClick={() => decide(url, 'reject')}>Reject</button></div>);
  if (!q) return <p className="adm-muted">Loading…</p>;
  if (!q.applications.length && !q.items.length) return <Empty text="Nothing is waiting for artist review." />;
  return (
    <>
      {q.applications.map((a) => (
        <div className="adm-card" key={'a' + a.userId}>
          <h3>{a.displayName || a.username} <span className="adm-muted">@{a.username}</span></h3>
          <span className="adm-muted">Wants to sell art in the shop · applied {when(a.appliedAt)}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
            {(a.pieces || []).filter(Boolean).map((id) => <a key={id} href={imageUrl(id)} target="_blank" rel="noopener noreferrer"><img src={imageUrl(id)} alt="A piece of art" style={thumb} /></a>)}
          </div>
          {a.note && <p className="adm-details">{a.note}</p>}
          {buttons(a.own, '/artists/review/applications/' + a.userId)}
        </div>
      ))}
      {q.items.map((it) => (
        <div className="adm-card" key={'i' + it.id}>
          <h3>{it.name} <span className="adm-muted">{ITEM_KIND[it.kind] || 'Badge'} · {it.price} credits · by @{it.artist.username}</span></h3>
          <span className="adm-muted">Sent {when(it.submittedAt)}</span>
          {it.desc && <p className="adm-details">{it.desc}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
            {it.kind === 'stickers'
              ? (it.stickers || []).map((s) => <img key={s.id} src={imageUrl(s.id)} alt={s.name} title={s.name} style={thumb} />)
              : it.image && <a href={imageUrl(it.image)} target="_blank" rel="noopener noreferrer"><img src={imageUrl(it.image)} alt={it.name} style={thumb} /></a>}
          </div>
          {buttons(it.own, '/artists/review/items/' + it.id)}
        </div>
      ))}
    </>
  );
}

// ---------- releases ----------
// Creator accounts only. Every release is added here by itself as a private DRAFT (the server does it on every deploy). Nobody else sees a draft:
// it shows up in What's new for everybody only once a creator account presses Publish. The notes can be edited before and after.
// A release also says which new features it contains (the list of features lives in the code, server/features.js). Those features are for creator accounts
// only while the release is a draft, and for everyone once it is published.
function Releases() {
  const { me, say, run, ask } = useAdm();
  const [rows, setRows] = useState(null);
  const [catalog, setCatalog] = useState([]); // the features the code knows about: [{ id, name, desc, state }]
  const [edit, setEdit] = useState(null); // { id, title, items: [{ title, text }], features: [id] } while a release is being edited
  const [testing, setTesting] = useState(null); // the id of the release THIS creator is testing right now (their own account only), or null
  const load = useCallback(() => api('/admin/releases').then((r) => { setRows(r.releases); setCatalog(r.features || []); setTesting(r.testing || null); }).catch((e) => { setRows([]); say(e.message, 'error'); }), [say]);
  useEffect(() => { if (me.canManageFeatures) load(); }, [load, me.canManageFeatures]);
  if (!me.canManageFeatures) return <Empty text="Only a creator account can publish releases." />;
  if (!rows) return <p className="adm-muted">Loading…</p>;

  const apply = (x) => { setRows(x.releases); if (x.features) setCatalog(x.features); if ('testing' in x) setTesting(x.testing || null); return x; };
  const nameOf = (id) => catalog.find((f) => f.id === id)?.name || id;
  const names = (r) => r.features.map(nameOf);
  const startEdit = (r) => setEdit({ id: r.id, title: r.title, features: [...r.features], items: r.items.length ? r.items.map((i) => ({ ...i })) : [{ title: '', text: '' }] });
  const setItem = (i, k, v) => setEdit((e) => ({ ...e, items: e.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)) }));
  const tickFeature = (id) => setEdit((e) => ({ ...e, features: e.features.includes(id) ? e.features.filter((x) => x !== id) : [...e.features, id] }));
  const save = async () => {
    const was = rows.find((r) => r.id === edit.id);
    // changing the features of a PUBLISHED release changes what everyone can use straight away, so ask first
    if (was?.status === 'public' && [...was.features].sort().join() !== [...edit.features].sort().join()) {
      const ok = await ask({ title: 'Change what everyone can use?', body: 'This release is published, so the features you tick are on for everyone right away, and the ones you untick are back to creator accounts only.', confirmLabel: 'Save', danger: true });
      if (!ok) return;
    }
    const done = await run(() => api('/admin/releases/' + encodeURIComponent(edit.id), { method: 'PATCH', body: { title: edit.title, features: edit.features, items: edit.items.filter((i) => i.title.trim() || i.text.trim()) } }).then(apply), () => 'Release saved');
    if (done) setEdit(null);
  };
  const publish = async (r) => {
    const ok = await ask({ title: `Publish “${r.title}”?`, body: 'Everyone sees it in What’s new, and people who have the popup on are told about it the next time they open Aduna.' + (r.features.length ? ' The features below also become available to everyone, right away, in every open app.' : '') + ' You can pull it back to a draft at any time.', lines: names(r), confirmLabel: 'Publish' });
    if (ok) await run(() => api(`/admin/releases/${encodeURIComponent(r.id)}/publish`, { method: 'POST' }).then(apply), () => 'Release published');
  };
  const unpublish = async (r) => {
    const ok = await ask({ title: `Make “${r.title}” a draft again?`, body: 'It disappears from What’s new for everyone except creator accounts.' + (r.features.length ? ' The features below go back to creator accounts only.' : ''), lines: names(r), confirmLabel: 'Back to draft', danger: true });
    if (ok) await run(() => api(`/admin/releases/${encodeURIComponent(r.id)}/unpublish`, { method: 'POST' }).then(apply), () => 'Release is a draft again');
  };
  // Test: this creator's account gets what everybody will have once the release is published, and none of the other unreleased features.
  const test = async (r, on) => {
    const msg = on ? (r.features.length ? 'Testing this release on your account' : 'Testing this release. It lists no features, so you only have what is already live.') : 'Stopped testing';
    await run(() => api(`/admin/releases/${encodeURIComponent(r.id)}/${on ? 'test' : 'untest'}`, { method: 'POST' }).then(apply), () => msg);
  };

  return (
    <>
      <div className="adm-card">
        <h3>How releases work</h3>
        <ul className="adm-lines">
          <li>Every release is added here by itself, as a <b>draft</b>. A draft is private: only creator accounts can see it.</li>
          <li>Edit the release and tick the <b>features</b> it contains. While it is a draft, those features work for creator accounts only, so you can test them on the real site. Anyone else cannot use them.</li>
          <li>Press <b>Test</b> on any release to try it the way everybody will get it: your account then has the features this release lists, and none of the other unreleased ones. A release with no features ticked works too, you just get what is already live. Press <b>Stop testing</b> to get all of them back. It only changes your own account.</li>
          <li>Check the notes, then <b>Publish</b>. Only then does the release appear in What’s new, and its features switch on for everyone.</li>
          <li>You can pull a published release back to a draft, and its features go back to creator accounts only. Everything is written to the Log.</li>
        </ul>
      </div>
      {!rows.length && <Empty text="No releases yet. The next release will show up here as a draft." />}
      {rows.map((r) => (
        <div className="adm-card" key={r.id}>
          <div className="adm-row">
            <div>
              <h3>{r.title} <span className={'adm-tag' + (r.status === 'draft' ? ' warn' : '')}>{r.status === 'draft' ? 'Draft · private' : 'Public · everyone'}</span>{testing === r.id && <> <span className="adm-tag">Testing on your account</span></>}</h3>
              <span className="adm-muted">{r.date}{r.desktop ? ` · desktop ${r.desktop}` : ''}{r.android ? ` · Android ${r.android}` : ''}{r.publishedAt ? ` · published ${when(r.publishedAt)}` : ''}</span>
            </div>
            <div className="adm-actions">
              {edit?.id !== r.id && <button className="adm-btn small" onClick={() => startEdit(r)}>Edit notes</button>}
              {testing === r.id
                ? <button className="adm-btn small" onClick={() => test(r, false)}>Stop testing</button>
                : <button className="adm-btn small" onClick={() => test(r, true)}>Test</button>}
              {r.status === 'draft' && <button className="adm-btn small primary" onClick={() => publish(r)}>Publish</button>}
              {r.status === 'public' && <button className="adm-btn small danger" onClick={() => unpublish(r)}>Back to draft</button>}
            </div>
          </div>
          {edit?.id === r.id ? (
            <>
              <label className="adm-field"><span><b>Title</b></span><input value={edit.title} maxLength={80} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
              {catalog.length > 0 && (
                <div className="adm-field">
                  <span><b>Features in this release</b> <span className="adm-muted">(creator accounts only until it is published)</span></span>
                  {catalog.map((f) => (
                    <label className="adm-check" key={f.id}>
                      <input type="checkbox" checked={edit.features.includes(f.id)} onChange={() => tickFeature(f.id)} aria-label={`Include ${f.name}`} />
                      <span><b>{f.name}</b> <span className="adm-muted">{f.desc}</span></span>
                    </label>
                  ))}
                </div>
              )}
              {edit.items.map((it, i) => (
                <div className="adm-field" key={i}>
                  <input value={it.title} maxLength={60} placeholder="Short title" aria-label={`Note ${i + 1} title`} onChange={(e) => setItem(i, 'title', e.target.value)} />
                  <textarea rows={2} value={it.text} maxLength={300} placeholder="What changed" aria-label={`Note ${i + 1} text`} onChange={(e) => setItem(i, 'text', e.target.value)} />
                  <div className="adm-actions"><button className="adm-btn small" onClick={() => setEdit((e) => ({ ...e, items: e.items.filter((_, j) => j !== i) }))}>Remove note</button></div>
                </div>
              ))}
              <div className="adm-actions">
                {edit.items.length < 12 && <button className="adm-btn small" onClick={() => setEdit((e) => ({ ...e, items: [...e.items, { title: '', text: '' }] }))}>Add a note</button>}
                <button className="adm-btn small" onClick={() => setEdit(null)}>Cancel</button>
                <button className="adm-btn small primary" onClick={save}>Save</button>
              </div>
            </>
          ) : r.items.length ? (
            <ul className="adm-lines">{r.items.map((it, i) => <li key={i}><b>{it.title}</b>{it.text ? ` — ${it.text}` : ''}</li>)}</ul>
          ) : (
            <p className="adm-muted">No notes yet. Use Edit notes to say what changed before publishing.</p>
          )}
          {edit?.id !== r.id && r.features.length > 0 && (
            <p className="adm-muted">
              Features: {names(r).join(', ')} · {r.status === 'public' ? 'on for everyone' : 'creator accounts only until this is published'}
            </p>
          )}
        </div>
      ))}
    </>
  );
}

// ---------- unsafe links ----------
// Creator accounts only. Links to these domains (and everything under them) are blocked for everybody, with no "Show anyway". The browser also checks
// every link by itself for lookalike addresses, shorteners and program downloads; this list is for sites you know are bad. Changes reach open apps at once.
function Links() {
  const { me, say, run, ask } = useAdm();
  const [data, setData] = useState(null);
  const [domain, setDomain] = useState('');
  const [note, setNote] = useState('');
  const load = useCallback(() => api('/admin/links').then(setData).catch((e) => { setData({ links: [], seed: 0, max: 0, lookup: false }); say(e.message, 'error'); }), [say]);
  useEffect(() => { if (me.canManageFeatures) load(); }, [load, me.canManageFeatures]);
  if (!me.canManageFeatures) return <Empty text="Only a creator account can change the link blocklist." />;
  if (!data) return <p className="adm-muted">Loading…</p>;
  const add = async (e) => {
    e.preventDefault();
    if (!domain.trim()) return;
    if (await run(() => api('/admin/links', { method: 'POST', body: { domain, note } }).then(setData), () => 'Blocked')) { setDomain(''); setNote(''); }
  };
  const drop = async (l) => {
    const ok = await ask({ title: `Unblock ${l.domain}?`, body: 'Links to it work again (the browser’s other checks still apply).', confirmLabel: 'Unblock' });
    if (ok) await run(() => api('/admin/links/' + encodeURIComponent(l.domain), { method: 'DELETE' }).then(setData), () => 'Unblocked');
  };
  return (
    <>
      <div className="adm-card">
        <h3>How link protection works</h3>
        <ul className="adm-lines">
          <li>Every link in a message is checked in the person’s browser, so it also works in encrypted DMs and group chats. Lookalike addresses, shorteners and program downloads are hidden behind a warning with <b>Show anyway</b>.</li>
          <li>A domain on this list is <b>blocked outright</b>, with no way through. It blocks the domain and every address under it.</li>
          <li>Suspicious links in server channels are also looked up with Google Safe Browsing: {data.lookup ? <b>on</b> : <b>off</b>}{data.lookup ? '.' : ' (set SAFE_BROWSING_API_KEY on Render to turn it on).'} In DMs a person can press “Check with Google” on a link, which sends just that address.</li>
          <li>{data.seed} starter domain{data.seed === 1 ? ' is' : 's are'} built in (server/link-blocklist.json) and can only be changed in the code.</li>
        </ul>
      </div>
      <form className="adm-card" onSubmit={add}>
        <h3>Block a domain</h3>
        <input className="adm-input" placeholder="evil.example" value={domain} maxLength={253} onChange={(e) => setDomain(e.target.value)} aria-label="Domain to block" autoComplete="off" spellCheck={false} />
        <input className="adm-input" placeholder="Note (why, optional)" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        <div className="adm-actions"><button className="adm-btn primary" disabled={!domain.trim()}>Block it</button></div>
      </form>
      <div className="adm-card">
        <h3>Blocked by you ({data.links.length}{data.max ? ` of ${data.max}` : ''})</h3>
        {!data.links.length && <p className="adm-muted">Nothing yet.</p>}
        {data.links.map((l) => (
          <div className="adm-row adm-line" key={l.domain}>
            <div><b className="adm-mono">{l.domain}</b> <span className="adm-muted">{l.by ? `added by ${l.by} · ` : ''}{when(l.at)}{l.note ? ` · ${l.note}` : ''}</span></div>
            <button type="button" className="adm-btn small danger" onClick={() => drop(l)}>Unblock</button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- sales ----------
// Creator accounts only (server/sales-report.js). Sales to Canada and the US in Canadian dollars over the last 12 months, against the limits that
// decide when to register for sales tax. US payments are converted at the rate set in SALES_USD_TO_CAD.
function Sales() {
  const { me, say } = useAdm();
  const [d, setD] = useState(null);
  useEffect(() => { if (me.canManageFeatures) api('/admin/sales').then(setD).catch((e) => say(e.message, 'error')); }, [me.canManageFeatures, say]);
  if (!me.canManageFeatures) return <Empty text="Only a creator account can see sales." />;
  if (!d) return <div className="adm-card"><p className="adm-muted">Loading…</p></div>;
  const cad = (c) => (c / 100).toLocaleString(undefined, { style: 'currency', currency: 'CAD' });
  const label = { over: 'Over the limit', near: 'Getting close', ok: 'Under the limit' };
  const day = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const place = (r) => `${r.region}, ${r.country === 'US' ? 'United States' : 'Canada'}`;
  return (
    <>
      <div className="adm-card">
        <h3>Sales and tax limits</h3>
        <p className="adm-muted">{day(d.since)} to {day(d.until)}, in Canadian dollars, without the tax collected. US sales count at 1 USD = {d.rate} CAD. Refunded payments are left out.</p>
      </div>
      <div className="adm-card adm-scroll">
        <table className="adm-table">
          <thead><tr><th>Where</th><th>Payments</th><th>Sales</th><th>Limit</th><th>Status</th></tr></thead>
          <tbody>
            <tr><td><b>All of Canada</b></td><td>{d.canada.count}</td><td>{cad(d.canada.cents)}</td><td>{cad(d.canada.limit)}</td><td>{label[d.canada.status]}</td></tr>
            {d.regions.map((r) => <tr key={r.country + r.region}><td>{place(r)}</td><td>{r.count}</td><td>{cad(r.cents)}</td><td>{cad(r.limit)}</td><td>{label[r.status]}</td></tr>)}
            <tr><td><b>All of the United States</b></td><td>{d.us.count}</td><td>{cad(d.us.cents)}</td><td /><td /></tr>
            {d.unplaced.count > 0 && <tr><td>No location saved</td><td>{d.unplaced.count}</td><td>{cad(d.unplaced.cents)}</td><td /><td /></tr>}
          </tbody>
        </table>
        {!d.regions.length && <p className="adm-muted">No sales with a location yet.</p>}
      </div>
    </>
  );
}

// ---------- status notice ----------
// The bar on the home page and the connect page (server/index.js: /api/public/status-notice). Any admin can post or clear it. Pages that are open
// pick it up within about 30 seconds. If the server itself is down nobody can post, so the status pages also show their own "server not answering" bar.
const STATUS_TEMPLATES = {
  restart: { label: 'Server restart', down: true, time: 'optional', msg: 'Server restart. Aduna will be back shortly.' },
  maintenance: { label: 'Server maintenance', down: true, time: 'ask', msg: 'Server maintenance in progress.' },
  crash: { label: 'Server crash', down: true, time: 'optional', msg: 'The server crashed. We’re working on it.' },
  slow: { label: 'Slow / degraded', down: false, time: false, msg: 'Aduna is running slowly right now. We’re looking into it.' },
  custom: { label: 'Custom', down: false, time: 'optional', msg: '' },
};
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const localInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function statusText(n, backAt) {
  if (!n || !n.message) return '';
  let text = n.message.trim();
  if (backAt) {
    const t = Date.parse(backAt);
    if (!isNaN(t)) {
      if (!/[.!?]$/.test(text)) text += '.';
      text += t > Date.now() ? ' Back up around ' + new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : ' Should be back any moment.';
    }
  }
  return text;
}
// what the toast says after a change: `saved` is whether the copy on the status site (kept for when this server is off) was written
const savedText = (base) => (r) => (r && r.saved === true ? base + ' and saved on the status site' : r && r.saved === false ? base + ', but saving it on the status site failed, so it will not show while the server is off' : base + '. Set STATUS_GITHUB_TOKEN on the server to also keep it on the status site for when the server is off');
function StatusBar({ down, text }) {
  const style = text
    ? { background: down ? '#b3261e' : '#f1d98a', color: down ? '#fff' : '#3b2f00' }
    : { border: '1px dashed var(--line)', color: 'var(--muted)' };
  return <div style={{ padding: '10px 14px', borderRadius: 8, textAlign: 'center', ...style }}>{text || 'Nothing to show'}</div>;
}
function StatusNotice() {
  const { say, ask, run } = useAdm();
  const [now, setNow] = useState(undefined); // undefined while loading
  const [tpl, setTpl] = useState('restart');
  const [msg, setMsg] = useState(STATUS_TEMPLATES.restart.msg);
  const [kind, setKind] = useState('down');
  const [back, setBack] = useState('');
  const load = useCallback(() => fetch('/api/public/status-notice', { cache: 'no-store' }).then((r) => r.json()).then(setNow).catch(() => { setNow(null); say('Could not read the current notice.', 'error'); }), [say]);
  useEffect(() => { load(); }, [load]);
  const t = STATUS_TEMPLATES[tpl];
  const down = tpl === 'custom' ? kind === 'down' : t.down;
  const backIso = t.time && back ? new Date(back).toISOString() : null;
  const pick = (k) => { setTpl(k); setMsg(STATUS_TEMPLATES[k].msg); setKind(STATUS_TEMPLATES[k].down ? 'down' : 'warn'); setBack(''); };
  const post = async () => {
    if (!msg.trim()) return say('Write a message first.', 'error');
    if (t.time === 'ask' && !back) return say('Pick when the server will be back up.', 'error');
    const ok = await ask({ title: 'Post this notice?', body: 'It shows on the home page and the connect page right away.', lines: [statusText({ message: msg }, backIso)], confirmLabel: 'Post notice' });
    if (ok) await run(() => api('/admin/status-notice', { method: 'POST', body: { down, message: msg.trim(), backAt: backIso, template: tpl } }).then((r) => { setNow(r); return r; }), savedText('Notice posted'));
  };
  const clear = async () => {
    const ok = await ask({ title: 'Clear the notice?', body: 'The bar is hidden everywhere.', confirmLabel: 'Clear notice', danger: true });
    if (ok) await run(() => api('/admin/status-notice', { method: 'DELETE' }).then((r) => { setNow(r); return r; }), savedText('Notice cleared'));
  };
  const live = now && now.message ? statusText(now, now.backAt) : '';
  return (
    <>
      <div className="adm-card">
        <h3>On the site now</h3>
        {now === undefined ? <p className="adm-muted">Loading…</p> : <StatusBar down={!!(now && now.down)} text={live} />}
        {now && now.updatedAt && <p className="adm-muted">Posted {when(now.updatedAt)}</p>}
      </div>
      <div className="adm-card">
        <h3>Post a notice</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
          {Object.entries(STATUS_TEMPLATES).map(([k, v]) => (
            <button key={k} type="button" className={'adm-btn small' + (tpl === k ? ' primary' : '')} onClick={() => pick(k)}>{v.label}</button>
          ))}
        </div>
        <label className="adm-field"><span>Message</span><textarea className="adm-input" maxLength={300} rows={3} value={msg} onChange={(e) => setMsg(e.target.value)} /></label>
        {tpl === 'custom' && (
          <label className="adm-field" style={{ marginTop: 10 }}><span>Bar colour</span>
            <select className="adm-input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="down">Red (server is down)</option><option value="warn">Yellow (warning)</option></select>
          </label>
        )}
        {t.time && (
          <div style={{ marginTop: 10 }}>
            <label className="adm-field"><span>Server back up {t.time === 'ask' ? '(needed)' : '(optional)'}</span><input type="datetime-local" className="adm-input" value={back} onChange={(e) => setBack(e.target.value)} /></label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {[[15, '+15 min'], [60, '+1 hour'], [180, '+3 hours'], [0, 'No time']].map(([m, name]) => (
                <button key={m} type="button" className="adm-btn small" onClick={() => setBack(m ? localInput(new Date(Date.now() + m * 60000)) : '')}>{name}</button>
              ))}
            </div>
            <p className="adm-muted">In your time zone. Visitors see it in theirs.</p>
          </div>
        )}
        <h3 style={{ marginTop: 16 }}>Preview</h3>
        <StatusBar down={down} text={statusText({ message: msg }, backIso)} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          <button type="button" className="adm-btn primary" onClick={post}>Post notice</button>
          <button type="button" className="adm-btn danger" onClick={clear}>Clear notice</button>
        </div>
      </div>
    </>
  );
}

// ---------- switches ----------
// Creator accounts only (server/switches.js). A switch that is off closes that part of Aduna for everybody who is not an admin; admins and creators
// can still use it, so they can test and fix it while it is closed. Everything is on until someone turns it off. Changes apply to the next request.
function Switches() {
  const { me, say, run, ask } = useAdm();
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/admin/switches').then(setData).catch((e) => { setData({ switches: [] }); say(e.message, 'error'); }), [say]);
  useEffect(() => { if (me.canManageFeatures) load(); }, [load, me.canManageFeatures]);
  if (!me.canManageFeatures) return <Empty text="Only a creator account can change switches." />;
  if (!data) return <p className="adm-muted">Loading…</p>;
  const flip = async (s) => {
    const off = s.on; // on now: this turns it off
    const ok = await ask(off
      ? { title: `Turn off ${s.name}?`, body: 'It closes right away for everyone who is not an admin. You and the other admins can still use it.', lines: s.keeps ? [s.keeps] : [], confirmLabel: 'Turn off', danger: true }
      : { title: `Turn on ${s.name}?`, body: 'It opens again for everyone right away.', confirmLabel: 'Turn on' });
    if (ok) await run(() => api('/admin/switches/' + encodeURIComponent(s.id), { method: 'POST', body: { on: !s.on } }).then(setData), () => (off ? `${s.name} is off for the public` : `${s.name} is on`));
  };
  return (
    <>
      <div className="adm-card">
        <h3>How switches work</h3>
        <ul className="adm-lines">
          <li>A switch that is <b>off</b> closes that part of Aduna for everybody who is not an admin. Admins and creators are never closed out, so you can still test it.</li>
          <li>Everything is on until you turn it off. Every change is written to the Log.</li>
        </ul>
      </div>
      <div className="adm-card">
        {!data.switches.length && <p className="adm-muted">No switches yet.</p>}
        {data.switches.map((s) => (
          <div className="adm-row adm-line" key={s.id}>
            <div>
              <b>{s.name}</b> <span className="adm-muted">{s.on ? 'On' : 'Off for the public'}{!s.on && s.at ? ` · since ${when(s.at)}${s.by ? ` by ${s.by}` : ''}` : ''}</span>
              <p className="adm-muted">{s.desc}</p>
              {s.keeps && <p className="adm-muted">{s.keeps}</p>}
            </div>
            <button type="button" className={'adm-btn small' + (s.on ? ' danger' : ' primary')} onClick={() => flip(s)}>{s.on ? 'Turn off' : 'Turn on'}</button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- yearly recap ----------
// Creator accounts only (server/recap.js). Builds a recap from the live data to try it. Nothing is saved, so it cannot stand in for the real one that
// is built in January. You see the global recap and one person's: your own, or any account you pick to try it as.
const GLOBAL_ROWS = [
  ['Messages sent', 'messages'], ['Hours in voice', 'vcHours'], ['People', 'users'], ['Joined this year', 'joinedThisYear'], ['Credits earned', 'credits', 'counted'],
  ['Quests finished', 'quests', 'counted'], ['Busiest day', 'busiestDay'], ['Busiest hour (UTC)', 'busiestHour', 'hour'], ['Most-used emoji', 'topEmoji'],
  ['Most popular song', 'topSong', 'song'], ['Most-used theme', 'topTheme'], ['Friendships made', 'friendships'], ['Servers created', 'serversCreated'],
  ['Files shared', 'files'], ['Wordle solves', 'wordle'], ['Contexto solves', 'contexto'], ['Puzzle solves', 'puzzle'],
  ['Badges earned', 'badges', 'counted'], ['Longest call (min)', 'longestCallMin'],
];
const USER_ROWS = [
  ['Messages sent', 'messages'], ['Hours in voice', 'vcHours'], ['Credits earned', 'credits', 'counted'], ['Quests finished', 'quests', 'counted'], ['Busiest day', 'busiestDay'],
  ['Favourite hour (UTC)', 'favoriteHour', 'hour'], ['Title', 'title'], ['Most-used emoji', 'topEmoji'], ['Longest call (min)', 'longestCallMin'], ['Friends made', 'friends'],
  ['Badges earned', 'badges', 'counted'], ['Badges held', 'badgesHeld'], ['Files shared', 'files'], ['Wordle solves', 'wordle'], ['Contexto solves', 'contexto'],
  ['Puzzle solves', 'puzzle'], ['Best streak', 'bestStreak'], ['Top % in voice time', 'topPercent.vc', 'percent'], ['Top % in messages', 'topPercent.messages', 'percent'], ['Profile song', 'song', 'song'],
];
function recapValue(data, key, kind) {
  const v = key.split('.').reduce((o, k) => (o ? o[k] : undefined), data);
  if (v === null || v === undefined) return kind === 'counted' ? 'not counted yet' : '—';
  if (kind === 'hour') return String(v).padStart(2, '0') + ':00';
  if (kind === 'percent') return 'top ' + v + '%';
  if (kind === 'song') return v.title || '—';
  return typeof v === 'number' ? v.toLocaleString() : String(v);
}
function Recap() {
  const { me, say } = useAdm();
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState(0); // new key for the player on every Generate, so it starts again from the poster
  const [profile, setProfile] = useState(null); // the admin page's own `me` has no theme or song; the player wants the real profile
  const [target, setTarget] = useState(null); // a person to try it as, or null for yourself
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  useEffect(() => { api('/me').then((r) => setProfile(r.user)).catch(() => {}); }, []);
  useEffect(() => {
    if (!q.trim()) { setFound(null); return undefined; }
    const id = setTimeout(() => api('/admin/users?q=' + encodeURIComponent(q.trim())).then((r) => setFound(r.users)).catch((e) => say(e.message, 'error')), 250);
    return () => clearTimeout(id);
  }, [q, say]);
  if (!me.canManageFeatures) return <Empty text="Only a creator account can generate a test recap." />;
  const generate = async () => {
    setBusy(true);
    try { setData(await api('/admin/recap/test', { method: 'POST', body: { year, ...(target ? { userId: target.id } : {}) } })); setBuilt((n) => n + 1); } catch (e) { say(e.message, 'error'); }
    setBusy(false);
  };
  const table = (rows, source) => rows.map(([name, key, kind]) => (
    <div className="adm-row adm-line" key={key}><span>{name}</span><b>{recapValue(source, key, kind)}</b></div>
  ));
  const who = data && data.user ? data.user.displayName || data.user.username : null;
  return (
    <>
      <div className="adm-card">
        <h3>Generate a test recap</h3>
        <p className="adm-muted">Builds the recap from the data Aduna has right now. Nothing is saved or shown to anyone else. The real one is built by itself in January.</p>
        <div className="adm-row">
          <label className="adm-field"><span>Year</span>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[...Array(thisYear - 2023)].map((_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <button type="button" className="adm-btn primary" disabled={busy} onClick={generate}>{busy ? 'Building…' : 'Generate'}</button>
        </div>
        <p className="adm-muted">Recap as: {target ? <><b>{target.displayName}</b> <span>@{target.username}</span> <button type="button" className="adm-btn small" onClick={() => setTarget(null)}>Back to me</button></> : 'you'}</p>
        <input className="adm-input" type="search" placeholder="Search for a person to try it as" value={q} onChange={(e) => setQ(e.target.value)} />
        {found && !found.length && <p className="adm-muted">No one matches.</p>}
        {found && found.map((u) => (
          <div className="adm-row adm-line" key={u.id}>
            <div className="adm-who"><Face u={u} /><div><b>{u.displayName}</b> <span className="adm-muted">@{u.username}</span></div></div>
            <button type="button" className="adm-btn small" onClick={() => { setTarget(u); setQ(''); }}>Use</button>
          </div>
        ))}
      </div>
      {data && (
        <>
          <div className="adm-card">
            <h3>Watch it</h3>
            <p className="adm-muted">The same 30 second video people get in Settings, played from this test recap. Switch between {who ? `${who}'s` : 'your'} year and everyone's.</p>
            <RecapSettings key={built} me={data.user || profile || me} recap={data} />
          </div>
          <div className="adm-card">
            <h3>Global recap {data.year}</h3>
            {table(GLOBAL_ROWS, data.global)}
          </div>
          <div className="adm-card">
            <h3>{who ? `${who}'s recap` : 'Your recap'} {data.year}</h3>
            {data.mine ? table(USER_ROWS, data.mine) : <p className="adm-muted">{who ? `${who} has` : 'Your account has'} nothing to show for {data.year} yet, so there would be no recap.</p>}
          </div>
        </>
      )}
    </>
  );
}

// ---------- IP bans ----------
// Creator accounts only (server/moderation.js). Aduna keeps no address per account, so a ban cannot be made from a person: type the address in, for example
// from the host's logs. A banned address gets a "blocked" page and cannot open a live connection. Your own address and very wide ranges are refused.
function IpBans() {
  const { me, say, ask } = useAdm();
  const [data, setData] = useState(null);
  const [rule, setRule] = useState('');
  const [reason, setReason] = useState('');
  const [hrs, setHrs] = useState('720');
  const load = useCallback(() => api('/admin/ip-bans').then(setData).catch((e) => { setData({ bans: [], enabled: true, yourIp: '', max: 0 }); say(e.message, 'error'); }), [say]);
  useEffect(() => { if (me.canManageFeatures) load(); }, [load, me.canManageFeatures]);
  if (!me.canManageFeatures) return <Empty text="Only a creator account can manage IP bans." />;
  if (!data) return <p className="adm-muted">Loading…</p>;
  const submit = async (confirmLarge) => {
    try {
      setData(await api('/admin/ip-bans', { method: 'POST', body: { rule, reason, hours: hrs === 'forever' ? null : Number(hrs), confirmLarge: confirmLarge === true } }));
      say('Banned'); setRule(''); setReason('');
    } catch (e) {
      if (e.code === 'large_range') { if (await ask({ title: 'Ban a very wide range?', body: e.message, confirmLabel: 'Ban the range', danger: true })) submit(true); } else say(e.message, 'error');
    }
  };
  const lift = async (b) => {
    const ok = await ask({ title: `Lift the ban on ${b.rule}?`, body: 'That address can use Aduna again straight away.', confirmLabel: 'Lift ban' });
    if (!ok) return;
    try { setData(await api('/admin/ip-bans/' + encodeURIComponent(b.id), { method: 'DELETE' })); say('Ban lifted'); } catch (e) { say(e.message, 'error'); }
  };
  return (
    <>
      <div className="adm-card">
        <h3>How IP bans work</h3>
        <ul className="adm-lines">
          <li>A banned address, or any address inside a banned range like <span className="adm-mono">1.2.3.0/24</span>, gets a plain “blocked” answer on every page and cannot open a live connection.</li>
          <li>Aduna does not keep an address for each account, so you cannot ban “this person’s IP”. Copy the address from your host’s logs and type it here.</li>
          <li>Many people share one address (a school, a phone network). Prefer a short ban, and a single address over a range.</li>
          <li>The server sees you as <b className="adm-mono">{data.yourIp || 'unknown'}</b>. A ban that would cover it is refused.</li>
          <li>{data.enabled ? 'IP bans are on.' : <b>IP bans are switched off (IP_BAN=off on Render), so nothing below is enforced.</b>} If a mistake ever blocks everybody, set IP_BAN=off on Render and restart.</li>
        </ul>
      </div>
      <form className="adm-card" onSubmit={(e) => { e.preventDefault(); if (rule.trim() && reason.trim()) submit(false); }}>
        <h3>Ban an address</h3>
        <input className="adm-input" placeholder="203.0.113.7 or 203.0.113.0/24" value={rule} maxLength={64} onChange={(e) => setRule(e.target.value)} aria-label="Address or range to ban" autoComplete="off" spellCheck={false} />
        <input className="adm-input" placeholder="Reason (kept in the log)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
        <label className="adm-field"><span>For how long</span>
          <select className="adm-input" value={hrs} onChange={(e) => setHrs(e.target.value)}>{BAN_FOR.map(([v, name]) => <option key={v} value={String(v)}>{name}</option>)}</select>
        </label>
        <div className="adm-actions"><button className="adm-btn primary" disabled={!rule.trim() || !reason.trim()}>Ban it</button></div>
      </form>
      <div className="adm-card">
        <h3>Banned now ({data.bans.length}{data.max ? ` of ${data.max}` : ''})</h3>
        {!data.bans.length && <p className="adm-muted">Nothing yet.</p>}
        {data.bans.map((b) => (
          <div className="adm-row adm-line" key={b.id}>
            <div><b className="adm-mono">{b.rule}</b> <span className="adm-muted">{b.by ? `by ${b.by} · ` : ''}{when(b.at)} · {b.until ? `until ${when(b.until)}` : 'until lifted'} · {b.reason}</span></div>
            <button type="button" className="adm-btn small danger" onClick={() => lift(b)}>Lift</button>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- log ----------
function Log() {
  const { say } = useAdm();
  const [rows, setRows] = useState(null);
  useEffect(() => { api('/admin/log').then((r) => setRows(r.log)).catch((e) => { setRows([]); say(e.message, 'error'); }); }, [say]);
  if (!rows) return <p className="adm-muted">Loading…</p>;
  if (!rows.length) return <Empty text="Nothing has been done yet." />;
  return (
    <div className="adm-card adm-scroll">
      <table className="adm-table">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>About</th><th>Note</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}><td>{when(r.at)}</td><td>{r.by}</td><td>{label(r.action)}</td><td>{r.target}</td><td>{r.note}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

// ---------- overview ----------
function Overview({ go }) {
  const { summary } = useAdm();
  if (!summary) return <p className="adm-muted">Loading…</p>;
  const r = summary.reports;
  const open = (sub) => go('reports', sub);
  const mod = summary.users === undefined; // moderators get the report counts only
  return (
    <>
      <div className="adm-stats">
        {!mod && <button className={'adm-stat' + (summary.applications ? ' hot' : '')} onClick={() => go('applications')}><b>{summary.applications || 0}</b><span>Applications waiting</span></button>}
        {!mod && <button className="adm-stat" onClick={() => go('people')}><b>{summary.users}</b><span>People</span></button>}
        {!mod && <button className="adm-stat" onClick={() => go('people')}><b>{summary.suspended}</b><span>Suspended</span></button>}
        <button className={'adm-stat' + (r.users ? ' hot' : '')} onClick={() => open('users')}><b>{r.users}</b><span>People and messages reported</span></button>
        <button className={'adm-stat' + (r.servers ? ' hot' : '')} onClick={() => open('servers')}><b>{r.servers}</b><span>Servers reported</span></button>
        <button className={'adm-stat' + (r.bots ? ' hot' : '')} onClick={() => open('bots')}><b>{r.bots}</b><span>Bots reported</span></button>
        <button className={'adm-stat' + (r.clips ? ' hot' : '')} onClick={() => open('clips')}><b>{r.clips}</b><span>Clips reported or hidden</span></button>
      </div>
      {mod ? (
        <div className="adm-card">
          <h3>How this works</h3>
          <ul className="adm-lines">
            <li><b>Dismiss</b> clears the reports about something and changes nothing else.</li>
            <li><b>Restore</b> puts a hidden listing, bot or clip back where it was and clears its reports.</li>
            <li>If something needs a warning, a takedown or a delete, tell an admin.</li>
            <li>Reports never tell the person who reported them.</li>
          </ul>
        </div>
      ) : (
      <div className="adm-card">
        <h3>How this works</h3>
        <ul className="adm-lines">
          <li><b>Warn</b> shows the person a message they must read before they can send anything. The 3rd warning in 90 days is a 24 hour mute and the 5th a 7 day suspension.</li>
          <li><b>Mute</b> stops someone sending messages for a set time. They can still read.</li>
          <li><b>Suspend</b> locks an account out right away and keeps its username and email reserved. You can lift it, or pick a length and it ends by itself.</li>
          <li><b>Delete account</b> is permanent: it signs them out, removes their servers, clips and bots, and (optionally) their messages.</li>
          <li>Reports never tell the person who reported them. Everything you do here is recorded in the Log.</li>
        </ul>
      </div>
      )}
    </>
  );
}

// ---------- shop ----------
// Every item that has a price, with a Remove button. Remove takes the item off sale for good (people who already own it keep it). The shop itself
// has no edit or remove controls any more; this is the only place. The server checks admin on every call, so this page is just the buttons.
const SHOP_STATE = { live: 'On sale', resting: 'Resting today', ended: 'Ended', review: 'Awaiting review' };
function ShopItems() {
  const { say, run, ask } = useAdm();
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/admin/shop').then(setData).catch((e) => { setData({ items: [] }); say(e.message, 'error'); }), [say]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <p className="adm-muted">Loading…</p>;
  const remove = async (i) => {
    const ok = await ask({
      title: `Remove ${i.name} from the shop?`,
      body: i.owners > 0 ? `It is taken off sale and nobody can buy it. The ${i.owners} ${i.owners === 1 ? 'person' : 'people'} who own it keep it.` : 'It is taken off sale and nobody can buy it.',
      confirmLabel: 'Remove from shop', danger: true,
    });
    if (ok) await run(() => api('/admin/shop/' + encodeURIComponent(i.id) + '/remove', { method: 'POST' }).then(setData), () => `${i.name} is off the shop`);
  };
  return (
    <div className="adm-card">
      <h3>In the shop ({data.items.length})</h3>
      {!data.items.length && <p className="adm-muted">Nothing is for sale right now.</p>}
      {data.items.map((i) => {
        const src = imageUrl(i.image);
        return (
          <div className="adm-row adm-line" key={i.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <span className="adm-face" style={{ width: 40, height: 40, flex: 'none', background: src ? 'transparent' : i.color, fontSize: 20 }}>
                {src ? <img src={src} alt="" /> : i.emoji || Array.from(i.name || '?')[0]}
              </span>
              <div style={{ minWidth: 0 }}>
                <b>{i.name}</b> <span className="adm-muted">{i.kind === 'frame' ? 'frame' : i.kind === 'stickers' ? 'sticker pack' : 'badge'} · {i.price.toLocaleString()} credits · {SHOP_STATE[i.state] || i.state}{i.pinned ? ' · pinned' : ''}{i.daily ? ' · daily' : ''}</span>
                <div className="adm-muted">{i.owners} owner{i.owners === 1 ? '' : 's'}{i.by ? ` · by ${i.by}` : ''}{i.ends ? ` · ends ${when(i.ends)}` : ''}</div>
              </div>
            </div>
            <button type="button" className="adm-btn small danger" onClick={() => remove(i)}>Remove</button>
          </div>
        );
      })}
    </div>
  );
}

// ---------- the page ----------
export default function AdminPage() {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState(tabFromHash());
  const [sub, setSub] = useState('users');
  const [focusId, setFocusId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [toasts, setToasts] = useState([]);

  const say = useCallback((text, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text: String(text), kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  const ask = useCallback((d) => new Promise((resolve) => setDlg({ d, resolve })), []);
  const refresh = useCallback(() => { api('/admin/summary').then(setSummary).catch(() => {}); }, []);
  // runs an action: a message on success or the server's reason on failure; true when it worked
  const run = useCallback(async (fn, ok) => {
    try { const r = await fn(); if (ok) say(typeof ok === 'function' ? ok(r) : ok); refresh(); return true; } catch (e) { say(e.message, 'error'); return false; }
  }, [say, refresh]);

  useEffect(() => {
    document.title = 'Admin · Aduna';
    api('/admin/me').then((m) => { setMe(m); refresh(); }).catch(() => location.replace('/')); // not an admin (or not signed in): home page
    const h = () => setTab(tabFromHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, [refresh]);

  const go = (t, reportSub) => {
    if (reportSub) setSub(reportSub);
    setTab(t);
    try { history.pushState(null, '', t === 'overview' ? location.pathname : '#' + t); } catch { /* the tab still switched */ }
    window.scrollTo(0, 0);
  };
  const openUser = (id) => { setFocusId(id); go('people'); };
  const clearFocus = useCallback(() => setFocusId(null), []);

  if (!me) return <div className="adm"><p className="adm-muted adm-pad">Checking access…</p></div>;
  const ctx = { me, summary, say, ask, run, refresh };
  const reportCount = summary ? Object.values(summary.reports).reduce((a, b) => a + b, 0) : 0;
  const modOnly = me.role === 'moderator';
  const cur = modOnly && !MOD_TABS.includes(tab) ? 'overview' : tab;

  return (
    <Ctx.Provider value={ctx}>
      <div className="adm">
        <header className="adm-top">
          <a className="adm-logo" href="/admin" onClick={(e) => { e.preventDefault(); go('overview'); }}>Aduna <small>{modOnly ? 'Moderation' : 'Admin'}</small></a>
          <nav className="adm-nav" aria-label="Admin pages">
            {TABS.filter(([id]) => (!modOnly || MOD_TABS.includes(id)) && ((id !== 'releases' && id !== 'switches' && id !== 'recap' && id !== 'sales' && id !== 'links' && id !== 'ipbans') || me.canManageFeatures)).map(([id, name]) => (
              <button key={id} className={'adm-tab' + (cur === id ? ' on' : '')} aria-current={cur === id ? 'page' : undefined} onClick={() => go(id)}>
                {name}{id === 'reports' && reportCount > 0 && <b>{reportCount}</b>}{id === 'applications' && summary && summary.applications > 0 && <b>{summary.applications}</b>}
              </button>
            ))}
          </nav>
          <span className="adm-me">{me.username} · {ROLE[me.role]}</span>
          <a className="adm-btn small" href="/app">Back to Aduna</a>
        </header>
        <main className="adm-main">
          <h1>{TABS.find((t) => t[0] === cur)[1]}</h1>
          {cur === 'overview' && <Overview go={go} />}
          {cur === 'applications' && <Applications />}
          {cur === 'artists' && <ArtistReview />}
          {cur === 'shop' && <ShopItems />}
          {cur === 'people' && <People focusId={focusId} clearFocus={clearFocus} refresh={refresh} />}
          {cur === 'bots' && <BotVerify />}
          {cur === 'themes' && <ThemeReview />}
          {cur === 'reports' && <Reports sub={sub} setSub={setSub} openUser={openUser} />}
          {cur === 'status' && <StatusNotice />}
          {cur === 'releases' && <Releases />}
          {cur === 'switches' && <Switches />}
          {cur === 'recap' && <Recap />}
{cur === 'sales' && <Sales />}
          {cur === 'links' && <Links />}
          {cur === 'ipbans' && <IpBans />}
          {cur === 'admins' && <Admins openUser={openUser} />}
          {cur === 'log' && <Log />}
        </main>
        {dlg && <Dialog d={dlg.d} onDone={(v) => { dlg.resolve(v); setDlg(null); }} />}
        <div className="adm-toasts" role="status" aria-live="polite">
          {toasts.map((t) => <div key={t.id} className={'adm-toast ' + t.kind}>{t.text}</div>)}
        </div>
      </div>
    </Ctx.Provider>
  );
}
