import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { imageUrl } from './image.js';
import './admin.css';

// /admin: for admins only. The server already redirects anyone else to the home page before this loads, and every /api/admin route answers
// non-admins with a 404; if /api/admin/me fails here anyway, the page sends the visitor to the home page itself.
// The page has its own small dialogs and messages (no dependence on the app's theme), and shows everything people wrote as plain text.

const TABS = [['overview', 'Overview'], ['applications', 'Applications'], ['artists', 'Artist review'], ['people', 'People'], ['reports', 'Reports'], ['features', 'Features'], ['releases', 'Releases'], ['admins', 'Admins'], ['log', 'Log']];
const REPORT_TABS = [['users', 'People and messages'], ['servers', 'Servers'], ['bots', 'Bots'], ['clips', 'Clips']];
const ROLE = { creator: 'Founder', config: 'Admin (server settings)', admin: 'Admin' };
const when = (t) => (t ? new Date(t).toLocaleString() : '—');
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

// A question in the page's own style. d: { title, body, lines, match (type this to confirm), textarea (label), checkbox: { label, on }, confirmLabel, danger }
function Dialog({ d, onDone }) {
  const [text, setText] = useState('');
  const [checked, setChecked] = useState(!!(d.checkbox && d.checkbox.on));
  const ready = d.match ? text.trim().toLowerCase() === String(d.match).toLowerCase() : true;
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
        {d.checkbox && <label className="adm-check"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /><span>{d.checkbox.label}</span></label>}
        <div className="adm-actions">
          <button className="adm-btn" onClick={() => onDone(null)}>Cancel</button>
          <button className={'adm-btn ' + (d.danger ? 'danger' : 'primary')} disabled={!ready} onClick={() => onDone({ text: text.trim(), checked })}>{d.confirmLabel || 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- reports ----------
function ReportItems({ list, onChanged }) {
  const { ask, run } = useAdm();
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
              <button className="adm-btn small danger" onClick={() => dropMessage(r.message.id)}>Delete message</button>
            </blockquote>
          )}
        </li>
      ))}
    </ul>
  );
}

function Empty({ text }) { return <div className="adm-card"><p className="adm-muted">{text}</p></div>; }

function UserReports({ openUser }) {
  const { say, run, ask, refresh } = useAdm();
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
  const { say, run, ask, refresh } = useAdm();
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
              {s.visibility === 'public' && <button className="adm-btn small" onClick={() => listing(s, 'remove', 'Taken off the explorer')}>Unlist</button>}
              <button className="adm-btn small danger" onClick={() => remove(s)}>Delete server</button>
            </div>
          </div>
          {s.reports.length > 0 && <ReportItems list={s.reports} onChanged={changed} />}
        </div>
      ))}
      <ServerSearch onChanged={changed} />
    </>
  );
}

function BotReports() {
  const { say, run, refresh } = useAdm();
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
          <button className="adm-btn small danger" onClick={() => act(b, 'remove', 'Bot removed from every server')}>Remove bot</button>
        </div>
      </div>
      {b.reports.length > 0 && <ReportItems list={b.reports} onChanged={changed} />}
    </div>
  ));
}

function ClipReports() {
  const { say, run, ask, refresh } = useAdm();
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
          <button className="adm-btn small danger" onClick={() => remove(c)}>Remove</button>
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
  const after = () => { load(); onChanged(); };

  const suspend = async () => {
    const r = await ask({ title: `Suspend ${u.username}?`, body: 'They are signed out everywhere right away and cannot sign in. Nothing of theirs is removed, and their username and email stay reserved. You can lift this later.', textarea: 'Reason (they see it when they try to sign in)', confirmLabel: 'Suspend', danger: true });
    if (r && await run(() => api(`/admin/users/${u.id}/suspend`, { method: 'POST', body: { reason: r.text } }), 'Account suspended')) after();
  };
  const unsuspend = async () => { if (await run(() => api(`/admin/users/${u.id}/unsuspend`, { method: 'POST' }), 'Suspension lifted')) after(); };
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

  return (
    <div className="adm-card adm-detail">
      <div className="adm-row">
        <div className="adm-who"><Face u={u} size={56} /><div><h2>{u.displayName}</h2><span className="adm-muted">@{u.username}</span></div></div>
        <button className="adm-btn small" onClick={onClose}>Close</button>
      </div>
      <div className="adm-tags">
        {u.role && <span className="adm-tag">{ROLE[u.role]}</span>}
        {u.suspended && <span className="adm-tag bad">Suspended</span>}
      </div>
      {u.suspended && <p className="adm-details">Suspended {when(u.suspended.at)}{u.suspended.reason ? `: ${u.suspended.reason}` : ''}</p>}
      {u.bio && <p className="adm-details">{u.bio}</p>}
      <dl className="adm-facts">
        <div><dt>Joined</dt><dd>{when(u.createdAt)}</dd></div>
        <div><dt>Servers</dt><dd>{u.servers} ({u.owned.length} owned)</dd></div>
        <div><dt>Clips</dt><dd>{u.clips} ({u.liveClips} live)</dd></div>
        <div><dt>Bots</dt><dd>{u.bots}</dd></div>
        <div><dt>Reports</dt><dd>{u.reports}</dd></div>
        <div><dt>User id</dt><dd className="adm-mono">{u.id}</dd></div>
      </dl>
      {u.owned.length > 0 && <p className="adm-muted">Owns: {u.owned.map((s) => `${s.name} (${s.members})`).join(', ')}</p>}

      {u.canModerate ? (
        <div className="adm-actions">
          {u.suspended ? <button className="adm-btn" onClick={unsuspend}>Lift suspension</button> : <button className="adm-btn" onClick={suspend}>Suspend</button>}
          <button className="adm-btn danger" onClick={del}>Delete account</button>
          {me.canManageAdmins && (u.role === 'admin' ? <button className="adm-btn" onClick={dropAdmin}>Remove as admin</button> : !u.role && !u.suspended && <button className="adm-btn" onClick={makeAdmin}>Make admin</button>)}
        </div>
      ) : (
        <p className="adm-muted">{u.id === me.id ? 'This is you.' : u.role === 'creator' ? 'Founder accounts cannot be moderated here.' : 'Only a founder can act on an admin.'}</p>
      )}
      {u.ownsOfficialServer && <p className="adm-muted">This account owns the official Aduna server, so it cannot be deleted until that is transferred.</p>}

      <h3>Reports about them</h3>
      {d.reports.length ? <ReportItems list={d.reports} onChanged={after} /> : <p className="adm-muted">None.</p>}
    </div>
  );
}

function People({ focusId, clearFocus, refresh }) {
  const { say } = useAdm();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(0);
  const [sel, setSel] = useState(focusId || null);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (focusId) { setSel(focusId); clearFocus(); } }, [focusId, clearFocus]);
  useEffect(() => {
    const id = setTimeout(() => api('/admin/users?q=' + encodeURIComponent(q.trim())).then((r) => { setRows(r.users); setTotal(r.total); }).catch((e) => say(e.message, 'error')), q ? 250 : 0);
    return () => clearTimeout(id);
  }, [q, tick, say]);
  const changed = () => { setTick((t) => t + 1); refresh(); };
  return (
    <div className="adm-split">
      <div className="adm-card adm-list">
        <input className="adm-input" type="search" placeholder="Search by username, name or id" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
        {!rows ? <p className="adm-muted">Loading…</p> : !rows.length ? <p className="adm-muted">No one matches.</p> : (
          <>
            <ul>
              {rows.map((u) => (
                <li key={u.id}>
                  <button className={'adm-person' + (sel === u.id ? ' on' : '')} onClick={() => setSel(u.id)}>
                    <Face u={u} />
                    <span><b>{u.displayName}</b><small className="adm-muted"> @{u.username}</small></span>
                    {u.role && <span className="adm-tag">{u.role === 'creator' ? 'Founder' : 'Admin'}</span>}
                    {u.suspended && <span className="adm-tag bad">Suspended</span>}
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
  const load = useCallback(() => api('/admin/admins').then((r) => setList(r.admins)).catch((e) => say(e.message, 'error')), [say]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!q.trim()) { setFound(null); return undefined; }
    const id = setTimeout(() => api('/admin/users?q=' + encodeURIComponent(q.trim())).then((r) => setFound(r.users)).catch((e) => say(e.message, 'error')), 250);
    return () => clearTimeout(id);
  }, [q, say]);
  const add = async (u) => {
    const r = await ask({ title: `Make ${u.username} an admin?`, body: 'They can open this page, read every report, suspend or delete accounts, and delete servers. They cannot act on creators or other admins.', confirmLabel: 'Make admin' });
    if (r && await run(() => api('/admin/admins', { method: 'POST', body: { userId: u.id } }), `${u.username} is now an admin`)) { setQ(''); load(); refresh(); }
  };
  const drop = async (u) => {
    const r = await ask({ title: `Remove ${u.username} as admin?`, body: 'They lose access to this page right away.', confirmLabel: 'Remove admin', danger: true });
    if (r && await run(() => api('/admin/admins/' + u.id, { method: 'DELETE' }), 'Admin removed')) { load(); refresh(); }
  };
  return (
    <>
      {me.canManageAdmins ? (
        <div className="adm-card">
          <h3>Add an admin</h3>
          <input className="adm-input" type="search" placeholder="Search for the person by username" value={q} onChange={(e) => setQ(e.target.value)} />
          {found && !found.length && <p className="adm-muted">No one matches.</p>}
          {found && found.map((u) => (
            <div className="adm-row adm-line" key={u.id}>
              <div className="adm-who"><Face u={u} /><div><b>{u.displayName}</b> <span className="adm-muted">@{u.username}</span></div></div>
              {u.role ? <span className="adm-tag">{ROLE[u.role]}</span> : u.suspended ? <span className="adm-tag bad">Suspended</span> : <button className="adm-btn small primary" onClick={() => add(u)}>Make admin</button>}
            </div>
          ))}
        </div>
      ) : <div className="adm-card"><p className="adm-muted">Only a creator account can add or remove admins.</p></div>}
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

// ---------- features ----------
// Creator accounts only. A feature is off, in testing (only creator accounts see it, so you can try it on the real site) or live (everyone).
// A feature can only go live from testing; one or several can be released together. The list of features lives in the code (server/features.js).
const FSTATE = { off: 'Off', testing: 'Testing · creators only', live: 'Live · everyone' };
function Features() {
  const { me, say, run, ask } = useAdm();
  const [rows, setRows] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const load = useCallback(() => api('/admin/features').then((r) => setRows(r.features)).catch((e) => { setRows([]); say(e.message, 'error'); }), [say]);
  useEffect(() => { if (me.canManageFeatures) load(); }, [load, me.canManageFeatures]);
  if (!me.canManageFeatures) return <Empty text="Only a creator account can test and release features." />;
  if (!rows) return <p className="adm-muted">Loading…</p>;

  const chosen = (state) => rows.filter((f) => sel.has(f.id) && f.state === state);
  const toggle = (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const names = (list) => list.map((f) => f.name);

  // list: the features to move, state: where to. Releasing and pulling back are asked about first, because everyone sees the result.
  const move = async (list, state) => {
    if (!list.length) return;
    let ok = true;
    if (state === 'live') {
      ok = await ask({ title: list.length === 1 ? `Release “${list[0].name}” to everyone?` : `Release ${list.length} features to everyone?`, body: 'Everyone sees it right away, in every open app. You can pull it back to testing at any time.', lines: names(list), confirmLabel: list.length === 1 ? 'Release' : 'Release all' });
    } else if (list.some((f) => f.state === 'live')) {
      ok = await ask({ title: state === 'off' ? 'Switch off a live feature?' : 'Pull back to testing?', body: 'It disappears for everyone else right away' + (state === 'testing' ? ', and stays on for creator accounts.' : '.'), lines: names(list), confirmLabel: state === 'off' ? 'Switch off' : 'Pull back', danger: true });
    }
    if (!ok) return;
    const verb = state === 'live' ? 'released' : state === 'testing' ? 'in testing' : 'switched off';
    const worked = await run(() => api('/admin/features', { method: 'POST', body: { ids: list.map((f) => f.id), state } }).then((x) => { setRows(x.features); return x; }),
      (x) => (x.changed.length ? `${x.changed.length === 1 ? x.changed[0].name : x.changed.length + ' features'} ${verb}` : 'Nothing to change'));
    if (worked) setSel(new Set());
  };

  const readyToRelease = chosen('testing'), readyToTest = chosen('off');
  return (
    <>
      <div className="adm-card">
        <h3>How releasing works</h3>
        <ul className="adm-lines">
          <li><b>Off</b>: nobody sees it. <b>Testing</b>: only creator accounts see it, so you can try it on the real site first. <b>Live</b>: everyone sees it.</li>
          <li>A feature goes live only from testing. Tick several and release them together, or release one at a time.</li>
          <li>Changes reach every open app straight away, and you can pull a live feature back to testing or off. Everything is written to the Log.</li>
        </ul>
      </div>
      <div className="adm-card">
        <div className="adm-row">
          <h3>Features</h3>
          <div className="adm-actions">
            <button className="adm-btn small" disabled={!readyToTest.length} onClick={() => move(readyToTest, 'testing')}>Start testing{readyToTest.length ? ` (${readyToTest.length})` : ''}</button>
            <button className="adm-btn small primary" disabled={!readyToRelease.length} onClick={() => move(readyToRelease, 'live')}>Release selected{readyToRelease.length ? ` (${readyToRelease.length})` : ''}</button>
          </div>
        </div>
        {rows.map((f) => (
          <div className="adm-row adm-line" key={f.id}>
            <div>
              <label className="adm-check">
                <input type="checkbox" checked={sel.has(f.id)} onChange={() => toggle(f.id)} aria-label={`Select ${f.name}`} />
                <span><b>{f.name}</b> <span className={'adm-tag' + (f.state === 'testing' ? ' warn' : '')}>{FSTATE[f.state]}</span>
                  <span className="adm-muted"> {f.desc}{f.at ? ` · changed ${when(f.at)}` : ''}</span></span>
              </label>
            </div>
            <div className="adm-actions">
              {f.state === 'off' && <button className="adm-btn small" onClick={() => move([f], 'testing')}>Start testing</button>}
              {f.state === 'testing' && <button className="adm-btn small primary" onClick={() => move([f], 'live')}>Release</button>}
              {f.state === 'testing' && <button className="adm-btn small" onClick={() => move([f], 'off')}>Switch off</button>}
              {f.state === 'live' && <button className="adm-btn small" onClick={() => move([f], 'testing')}>Pull back to testing</button>}
              {f.state === 'live' && <button className="adm-btn small danger" onClick={() => move([f], 'off')}>Switch off</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- releases ----------
// Creator accounts only. Every release is added here by itself as a private DRAFT (the server does it on every deploy). Nobody else sees a draft:
// it shows up in What's new for everybody only once a creator account presses Publish. The notes can be edited before and after.
function Releases() {
  const { me, say, run, ask } = useAdm();
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null); // { id, title, items: [{ title, text }] } while a release is being edited
  const load = useCallback(() => api('/admin/releases').then((r) => setRows(r.releases)).catch((e) => { setRows([]); say(e.message, 'error'); }), [say]);
  useEffect(() => { if (me.canManageFeatures) load(); }, [load, me.canManageFeatures]);
  if (!me.canManageFeatures) return <Empty text="Only a creator account can publish releases." />;
  if (!rows) return <p className="adm-muted">Loading…</p>;

  const startEdit = (r) => setEdit({ id: r.id, title: r.title, items: r.items.length ? r.items.map((i) => ({ ...i })) : [{ title: '', text: '' }] });
  const setItem = (i, k, v) => setEdit((e) => ({ ...e, items: e.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)) }));
  const save = async () => {
    const ok = await run(() => api('/admin/releases/' + encodeURIComponent(edit.id), { method: 'PATCH', body: { title: edit.title, items: edit.items.filter((i) => i.title.trim() || i.text.trim()) } }).then((x) => { setRows(x.releases); return x; }), () => 'Release saved');
    if (ok) setEdit(null);
  };
  const publish = async (r) => {
    const ok = await ask({ title: `Publish “${r.title}”?`, body: 'Everyone sees it in What’s new, and people who have the popup on are told about it the next time they open Aduna. You can pull it back to a draft at any time.', confirmLabel: 'Publish' });
    if (ok) await run(() => api(`/admin/releases/${encodeURIComponent(r.id)}/publish`, { method: 'POST' }).then((x) => { setRows(x.releases); return x; }), () => 'Release published');
  };
  const unpublish = async (r) => {
    const ok = await ask({ title: `Make “${r.title}” a draft again?`, body: 'It disappears from What’s new for everyone except creator accounts.', confirmLabel: 'Back to draft', danger: true });
    if (ok) await run(() => api(`/admin/releases/${encodeURIComponent(r.id)}/unpublish`, { method: 'POST' }).then((x) => { setRows(x.releases); return x; }), () => 'Release is a draft again');
  };

  return (
    <>
      <div className="adm-card">
        <h3>How releases work</h3>
        <ul className="adm-lines">
          <li>Every release is added here by itself, as a <b>draft</b>. A draft is private: only creator accounts can see it.</li>
          <li>Check the notes (edit them if you want), then <b>Publish</b>. Only then does it appear in What’s new for everyone.</li>
          <li>You can pull a published release back to a draft. Everything is written to the Log.</li>
        </ul>
      </div>
      {!rows.length && <Empty text="No releases yet. The next release will show up here as a draft." />}
      {rows.map((r) => (
        <div className="adm-card" key={r.id}>
          <div className="adm-row">
            <div>
              <h3>{r.title} <span className={'adm-tag' + (r.status === 'draft' ? ' warn' : '')}>{r.status === 'draft' ? 'Draft · private' : 'Public · everyone'}</span></h3>
              <span className="adm-muted">{r.date}{r.desktop ? ` · desktop ${r.desktop}` : ''}{r.android ? ` · Android ${r.android}` : ''}{r.publishedAt ? ` · published ${when(r.publishedAt)}` : ''}</span>
            </div>
            <div className="adm-actions">
              {edit?.id !== r.id && <button className="adm-btn small" onClick={() => startEdit(r)}>Edit notes</button>}
              {r.status === 'draft' && <button className="adm-btn small primary" onClick={() => publish(r)}>Publish</button>}
              {r.status === 'public' && <button className="adm-btn small danger" onClick={() => unpublish(r)}>Back to draft</button>}
            </div>
          </div>
          {edit?.id === r.id ? (
            <>
              <label className="adm-field"><span><b>Title</b></span><input value={edit.title} maxLength={80} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label>
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
        </div>
      ))}
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
  return (
    <>
      <div className="adm-stats">
        <button className={'adm-stat' + (summary.applications ? ' hot' : '')} onClick={() => go('applications')}><b>{summary.applications || 0}</b><span>Applications waiting</span></button>
        <button className="adm-stat" onClick={() => go('people')}><b>{summary.users}</b><span>People</span></button>
        <button className="adm-stat" onClick={() => go('people')}><b>{summary.suspended}</b><span>Suspended</span></button>
        <button className={'adm-stat' + (r.users ? ' hot' : '')} onClick={() => open('users')}><b>{r.users}</b><span>People and messages reported</span></button>
        <button className={'adm-stat' + (r.servers ? ' hot' : '')} onClick={() => open('servers')}><b>{r.servers}</b><span>Servers reported</span></button>
        <button className={'adm-stat' + (r.bots ? ' hot' : '')} onClick={() => open('bots')}><b>{r.bots}</b><span>Bots reported</span></button>
        <button className={'adm-stat' + (r.clips ? ' hot' : '')} onClick={() => open('clips')}><b>{r.clips}</b><span>Clips reported or hidden</span></button>
      </div>
      <div className="adm-card">
        <h3>How this works</h3>
        <ul className="adm-lines">
          <li><b>Suspend</b> locks an account out right away and keeps its username and email reserved. You can lift it.</li>
          <li><b>Delete account</b> is permanent: it signs them out, removes their servers, clips and bots, and (optionally) their messages.</li>
          <li>Reports never tell the person who reported them. Everything you do here is recorded in the Log.</li>
        </ul>
      </div>
    </>
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

  return (
    <Ctx.Provider value={ctx}>
      <div className="adm">
        <header className="adm-top">
          <a className="adm-logo" href="/admin" onClick={(e) => { e.preventDefault(); go('overview'); }}>Aduna <small>Admin</small></a>
          <nav className="adm-nav" aria-label="Admin pages">
            {TABS.filter(([id]) => (id !== 'features' && id !== 'releases') || me.canManageFeatures).map(([id, name]) => (
              <button key={id} className={'adm-tab' + (tab === id ? ' on' : '')} aria-current={tab === id ? 'page' : undefined} onClick={() => go(id)}>
                {name}{id === 'reports' && reportCount > 0 && <b>{reportCount}</b>}{id === 'applications' && summary && summary.applications > 0 && <b>{summary.applications}</b>}
              </button>
            ))}
          </nav>
          <span className="adm-me">{me.username} · {ROLE[me.role]}</span>
          <a className="adm-btn small" href="/app">Back to Aduna</a>
        </header>
        <main className="adm-main">
          <h1>{TABS.find((t) => t[0] === tab)[1]}</h1>
          {tab === 'overview' && <Overview go={go} />}
          {tab === 'applications' && <Applications />}
          {tab === 'artists' && <ArtistReview />}
          {tab === 'people' && <People focusId={focusId} clearFocus={clearFocus} refresh={refresh} />}
          {tab === 'reports' && <Reports sub={sub} setSub={setSub} openUser={openUser} />}
          {tab === 'features' && <Features />}
          {tab === 'releases' && <Releases />}
          {tab === 'admins' && <Admins openUser={openUser} />}
          {tab === 'log' && <Log />}
        </main>
        {dlg && <Dialog d={dlg.d} onDone={(v) => { dlg.resolve(v); setDlg(null); }} />}
        <div className="adm-toasts" role="status" aria-live="polite">
          {toasts.map((t) => <div key={t.id} className={'adm-toast ' + t.kind}>{t.text}</div>)}
        </div>
      </div>
    </Ctx.Provider>
  );
}
