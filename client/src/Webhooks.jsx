import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { Icon } from './ui.jsx';
import { askConfirm } from './Dialogs.jsx';
import { BotTag } from './Bots.jsx';

// Server settings > Webhooks. A webhook is a secret address another service posts to (rules and limits: server/webhooks.js). It posts a
// message in a text channel, or hands the data to one of the server's bots. The address (and the GitHub signing secret) is shown once,
// when it is made or renewed: only a hash of it is kept, so it cannot be shown again.

function CopyRow({ label, value }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* blocked: the text is selectable below */ }
  };
  return (
    <div className="hook-copy">
      <span className="muted small">{label}</span>
      <div className="hook-copy-row">
        <input readOnly value={value} onFocus={(e) => e.target.select()} aria-label={label} />
        <button type="button" className="btn small-btn" onClick={copy}><Icon name="copy" size={14} className="inline-icon" /> {done ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

// Shown right after a webhook is made or renewed, and gone for good once it is closed.
function Reveal({ made, onClose }) {
  const gh = made.webhook.kind === 'github';
  return (
    <div className="hook-reveal" role="status">
      <b>{made.webhook.name}</b>
      <p className="muted small hint">Copy {gh ? 'these' : 'this'} now. For your safety {gh ? 'they are' : 'it is'} not stored and cannot be shown again. If {gh ? 'they are' : 'it is'} lost, renew the webhook to get new ones.</p>
      <CopyRow label={gh ? 'Payload URL' : 'Webhook address'} value={made.url} />
      {gh && <CopyRow label="Secret" value={made.secret} />}
      {gh
        ? <p className="muted small hint">In the GitHub repository open Settings &rsaquo; Webhooks &rsaquo; Add webhook. Paste the payload URL, set the content type to <code>application/json</code>, paste the secret, then choose the events you want (push, pull requests, issues, releases and more are shown as messages).</p>
        : <p className="muted small hint">Send a <code>POST</code> with a JSON body. <code>{'{"text": "Hello"}'}</code> posts that text; anything else is shown as a short summary.</p>}
      <button type="button" className="btn small-btn primary" onClick={onClose}>I have copied {gh ? 'them' : 'it'}</button>
    </div>
  );
}

function Destination({ server, value, onChange }) {
  const channels = server.channels.filter((c) => (c.type || 'text') === 'text');
  const bots = (server.bots || []).map((i) => ({ id: i.botId, user: server.members.find((m) => m.id === i.userId) })).filter((b) => b.user);
  return (
    <>
      <label>POST TO CHANNEL</label>
      <select value={value.channelId} onChange={(e) => onChange({ ...value, channelId: e.target.value })} aria-label="Channel">
        <option value="">{bots.length ? 'No channel (bot only)' : 'Pick a channel'}</option>
        {channels.map((c) => <option key={c.id} value={c.id}># {c.name}</option>)}
      </select>
      {bots.length > 0 && (
        <>
          <label>OR HAND THE DATA TO A BOT (OPTIONAL)</label>
          <select value={value.botId} onChange={(e) => onChange({ ...value, botId: e.target.value })} aria-label="Bot">
            <option value="">No bot: post the message myself</option>
            {bots.map((b) => <option key={b.id} value={b.id}>{b.user.displayName}</option>)}
          </select>
          <p className="muted small hint">A bot gets a <code>webhook</code> event with the data and decides what to post. When both are set the bot wins, and the channel is used if the bot is removed.</p>
        </>
      )}
    </>
  );
}

const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export function WebhooksTab({ server }) {
  const [list, setList] = useState(null);
  const [limits, setLimits] = useState({ perServer: 10, perMin: 30, name: 32 });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [made, setMade] = useState(null); // { webhook, url, secret? } shown once
  const [form, setForm] = useState(null); // the create form, or null
  const [editing, setEditing] = useState(null); // { id, name, channelId, botId }

  const load = () => api(`/servers/${server.id}/webhooks`).then((r) => { setList(r.webhooks); if (r.limits) setLimits(r.limits); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(key, fn) {
    setErr(''); setBusy(key);
    try { await fn(); return true; } catch (e) { setErr(e.message || 'That did not work'); return false; } finally { setBusy(''); }
  }
  const create = (e) => {
    e.preventDefault();
    return run('create', async () => {
      const r = await api(`/servers/${server.id}/webhooks`, { method: 'POST', body: { name: form.name, kind: form.kind, channelId: form.channelId || null, botId: form.botId || null } });
      setMade(r); setForm(null); await load();
    });
  };
  const save = (e) => {
    e.preventDefault();
    return run('save', async () => {
      await api(`/servers/${server.id}/webhooks/${editing.id}`, { method: 'PATCH', body: { name: editing.name, channelId: editing.channelId || null, botId: editing.botId || null } });
      setEditing(null); await load();
    });
  };
  const renew = async (h) => {
    if (!(await askConfirm({ title: 'Renew address', body: `Make a new address for "${h.name}"? The old one stops working at once, so update the other service with the new one.`, confirmLabel: 'Renew', danger: true }))) return;
    run('renew' + h.id, async () => { setMade(await api(`/servers/${server.id}/webhooks/${h.id}/renew`, { method: 'POST' })); await load(); });
  };
  const del = async (h) => {
    if (!(await askConfirm({ title: 'Delete webhook', body: `Delete "${h.name}"? The other service will stop being able to post here. Messages it already posted stay.`, confirmLabel: 'Delete', danger: true }))) return;
    run('del' + h.id, async () => { await api(`/servers/${server.id}/webhooks/${h.id}`, { method: 'DELETE' }); if (made?.webhook.id === h.id) setMade(null); await load(); });
  };

  const firstChannel = server.channels.find((c) => (c.type || 'text') === 'text')?.id || '';
  const full = list && list.length >= limits.perServer;

  return (
    <div className="hooks-tab">
      <p className="muted small hint">A webhook is a secret address another service (GitHub, a build server, a script) can post to. It shows up in a channel as a message with a BOT tag, or goes to one of your bots. Anyone who has the address can post, so keep it private.</p>
      {err && <div className="error" role="alert">{err}</div>}
      {made && <Reveal made={made} onClose={() => setMade(null)} />}

      <label>WEBHOOKS{list ? ` (${list.length} of ${limits.perServer})` : ''}</label>
      {!list && !err && <p className="muted small" role="status">Loading…</p>}
      {list && list.length === 0 && <div className="empty">No webhooks yet.</div>}
      {(list || []).map((h) => {
        const botName = h.botId ? (h.botName || 'a bot') : null;
        const isEditing = editing?.id === h.id;
        return (
          <div key={h.id} className="bot-inst hook-row">
            <div className="bot-inst-row">
              <div className="bot-inst-who">
                <div className="bot-head"><b className="bot-name">{h.name}</b><BotTag /><span className="bchip">{h.kind === 'github' ? 'GitHub' : 'Generic'}</span></div>
                <div className="muted small">
                  {h.botId && !h.botMissing ? <>To bot <b>{botName}</b>{h.channelName ? <>, fallback # {h.channelName}</> : null}</> : h.channelName ? <>To # {h.channelName}</> : null}
                  {' · '}{h.uses} {h.uses === 1 ? 'delivery' : 'deliveries'} · last {when(h.lastUsedAt)}
                </div>
                {h.botMissing && h.botId && <div className="error small">{botName ? `${botName} is no longer in this server.` : 'The bot is no longer in this server.'} {h.channelName ? 'The channel is used instead.' : 'Pick a channel or another bot below.'}</div>}
                {h.broken && !h.botMissing && <div className="error small">This webhook has nowhere to send to. Edit it and pick a text channel.</div>}
              </div>
              <button className="btn small-btn" onClick={() => setEditing(isEditing ? null : { id: h.id, name: h.name, channelId: h.channelId || '', botId: h.botMissing ? '' : h.botId || '' })} aria-expanded={isEditing}>Edit</button>
              <button className="btn small-btn" disabled={busy === 'renew' + h.id} onClick={() => renew(h)}>Renew</button>
              <button className="btn small-btn danger" disabled={busy === 'del' + h.id} onClick={() => del(h)}>Delete</button>
            </div>
            {isEditing && (
              <form className="bot-scope" onSubmit={save}>
                <label>NAME</label>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={limits.name} required />
                <Destination server={server} value={editing} onChange={(v) => setEditing({ ...editing, ...v })} />
                <div className="modal-foot">
                  <button type="button" className="btn small-btn" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn small-btn primary" disabled={busy === 'save' || !editing.name.trim() || (!editing.channelId && !editing.botId)}>Save</button>
                </div>
              </form>
            )}
          </div>
        );
      })}

      {form ? (
        <form className="bot-scope hook-new" onSubmit={create}>
          <label>NAME</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={limits.name} placeholder="GitHub releases" autoFocus required />
          <label>KIND</label>
          <div className="mode-pick" role="radiogroup" aria-label="Kind">
            {[['generic', 'Generic'], ['github', 'GitHub']].map(([id, label]) => (
              <button type="button" role="radio" key={id} aria-checked={form.kind === id} className={form.kind === id ? 'on' : ''} onClick={() => setForm({ ...form, kind: id })}>{label}</button>
            ))}
          </div>
          <p className="muted small hint">{form.kind === 'github' ? 'GitHub signs each delivery with a secret, and Aduna checks the signature. You will get the address and the secret.' : 'Any service or script that can send a JSON POST. You will get an address.'}</p>
          <Destination server={server} value={form} onChange={(v) => setForm({ ...form, ...v })} />
          <div className="modal-foot">
            <button type="button" className="btn small-btn" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn small-btn primary" disabled={busy === 'create' || !form.name.trim() || (!form.channelId && !form.botId)}>{busy === 'create' ? 'Creating…' : 'Create webhook'}</button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn small-btn primary hook-add" disabled={!list || full} onClick={() => { setMade(null); setForm({ name: '', kind: 'generic', channelId: firstChannel, botId: '' }); }}>
          <Icon name="plus" size={14} className="inline-icon" /> New webhook
        </button>
      )}
      {full && <p className="muted small hint">A server can have up to {limits.perServer} webhooks.</p>}
      <p className="muted small hint">Each webhook accepts up to {limits.perMin} deliveries a minute.</p>
    </div>
  );
}
