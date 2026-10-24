import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';

// "Build with AI on this PC": a panel in the bot editor, only in the Aduna desktop app (window.adunaDesktop.ai, see desktop/ai/ai-service.js).
// A coding model that runs on this PC (through Ollama) writes bot.js and a test, runs both in the same sandbox the Aduna server uses, and keeps
// going until the test passes and every handler is covered. Nothing is sent to Aduna. The build lives in the desktop app, not in this panel:
// leave the page, close the panel or hide Aduna to the tray and it keeps working; a notification says when it is done.

const desk = () => (typeof window !== 'undefined' ? window.adunaDesktop?.ai : undefined);
export const hasAiBuilder = () => !!desk();

const KEEP = 300;
const mem = (k, v) => { try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch { /* private mode */ } return ''; };
const pct = (p) => (p == null ? null : Math.round(p));
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; };

// ---------- what the build is doing right now (rebuilt from the events the desktop app sends) ----------
const EMPTY = { jobId: null, running: false, items: [], stream: '', waiting: null, done: null };
function step(s, e) {
  const add = (item) => ({ ...s, waiting: null, items: [...s.items, item].slice(-KEEP) });
  switch (e.kind) {
    case 'start': return { ...EMPTY, jobId: e.jobId, running: true, items: e.resumed ? [{ k: 'note', text: 'Continuing a saved build.' }] : [] };
    case 'attempt': return { ...add({ k: 'attempt', n: e.n }), stream: '' };
    case 'token': return { ...s, waiting: null, stream: (s.stream + e.text).slice(-6000) };
    case 'reset': return { ...s, stream: '', waiting: null };
    case 'wait': return { ...s, waiting: { reason: e.reason, seconds: e.seconds } };
    case 'note': return add({ k: 'note', text: e.text });
    case 'hint': return add({ k: 'hint', text: e.text });
    case 'files': return add({ k: 'files', ...e });
    case 'testing': return add({ k: 'testing', n: e.n });
    case 'result': return add({ k: 'result', ...e });
    case 'finished': return { ...s, running: false, waiting: null, done: e, items: [...s.items, { k: 'finished', ...e }].slice(-KEEP) };
    default: return s;
  }
}
function reduce(s, a) {
  if (a.type === 'clear') return EMPTY;
  if (a.type === 'idle') return s.running ? { ...s, running: false, waiting: null } : s;   // nothing is building: keep what is on screen
  if (a.type === 'restore') { let n = { ...EMPTY, jobId: a.jobId, running: a.running }; for (const e of a.log) n = step(n, e); return { ...n, running: a.running, stream: a.stream || '' }; }
  return step(s, a.e);
}

function Item({ e }) {
  if (e.k === 'attempt') return <div className="ai-ev ai-head">Attempt {e.n}</div>;
  if (e.k === 'note') return <div className="ai-ev">{e.text}</div>;
  if (e.k === 'hint') return <div className="ai-ev ai-hint">{e.text}</div>;
  if (e.k === 'testing') return <div className="ai-ev ai-dim">Running the test in the bot sandbox{'\u2026'}</div>;
  if (e.k === 'files') {
    const bits = [];
    if (e.wrote.includes('bot.js')) bits.push(`bot.js (+${e.botAdded} \u2212${e.botRemoved})`);
    if (e.wrote.includes('test.js')) bits.push(`test.js (+${e.testAdded} \u2212${e.testRemoved})`);
    return <div className="ai-ev">Wrote {bits.join(', ')}</div>;
  }
  if (e.k === 'result') {
    if (e.passed) return <div className="ai-ev ok">{'\u2713'} Passed: {plural(e.testsPassed, 'test', 'tests')} of {e.testsTotal}, {plural(e.assertions, 'check', 'checks')}, every handler covered.</div>;
    const why = e.ok && e.gaps?.length ? 'The test passes but the bot is not finished: ' + e.gaps[0] : e.problem || 'The test failed.';
    return (
      <div className={'ai-ev ' + (e.ok ? 'warn' : 'bad')}>
        {e.ok ? '\u25D0' : '\u2717'} {why}
        {e.detail ? <details><summary>What happened</summary><pre>{e.detail}</pre></details> : null}
      </div>
    );
  }
  if (e.k === 'finished') {
    return <div className={'ai-ev ai-end ' + (e.ok ? 'ok' : e.status === 'stopped' ? '' : 'bad')}>{e.ok ? '\u2713 ' : ''}{e.summary}{e.ok ? ` (${plural(e.attempts, 'attempt', 'attempts')}${e.learned ? `, ${plural(e.learned, 'lesson', 'lessons')} learned` : ''})` : ''}</div>;
  }
  return null;
}

export default function AiBuilder({ fetchHosts, defaultOpen, onUse }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [model, setModel] = useState(mem('aduna.ai.model'));
  const [req, setReq] = useState('');
  const [live, dispatch] = useReducer(reduce, EMPTY);
  const [jobs, setJobs] = useState([]);
  const [pulls, setPulls] = useState({});
  const [install, setInstall] = useState(null);
  const [setup, setSetup] = useState('');
  const [busyJob, setBusyJob] = useState('');
  const [custom, setCustom] = useState('');
  const logRef = useRef(null);

  const installed = (st?.models || []).map((m) => m.name);
  const isInstalled = (tag) => installed.includes(tag);

  const loadJobs = useCallback(() => desk()?.jobs().then((r) => { if (r?.ok) setJobs(r.jobs); }), []);
  const refresh = useCallback(() => desk()?.status().then((s) => {
    if (!s || s.ok === false) { setErr((s && s.error) || 'The AI builder is not available.'); return; }
    setSt(s);
    if (s.busy) dispatch({ type: 'restore', jobId: s.jobId, running: true, log: s.log || [], stream: s.stream });
    else dispatch({ type: 'idle' });
  }), []);

  useEffect(() => {
    const a = desk(); if (!a) return undefined;
    a.panel(true);
    refresh(); loadJobs();
    const off = a.onEvent((e) => {
      if (e.type === 'agent') { dispatch({ e }); if (e.kind === 'finished') { loadJobs(); refresh(); } }
      else if (e.type === 'pull') setPulls((p) => ({ ...p, [e.name]: { pct: e.pct, status: e.status } }));
      else if (e.type === 'pull-done') { setPulls((p) => { const n = { ...p }; delete n[e.name]; return n; }); if (!e.ok && e.error && e.error !== 'Cancelled.') setErr(`Could not install ${e.name}: ${e.error}`); refresh(); }
      else if (e.type === 'ollama-install') { setInstall(e.done ? (e.error ? { status: e.status, error: true } : null) : { status: e.status, pct: e.pct }); if (e.done) refresh(); }
      else if (e.type === 'setup') { if (e.status) setSetup(e.status); if (e.done) setSetup(''); }
    });
    return () => { off?.(); a.panel(false); };
  }, [refresh, loadJobs]);

  // the model picked last time, or the first one installed
  useEffect(() => { if (!installed.includes(model)) setModel(installed[0] || ''); }, [st]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const el = logRef.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 140) el.scrollTop = el.scrollHeight; }, [live.items, live.stream]);

  const guard = (fn) => async (...a) => { setErr(''); try { return await fn(...a); } catch (e) { setErr(e.message || 'Something went wrong.'); return null; } };

  const autoSetup = guard(async () => {
    setSetup('Starting\u2026');
    const r = await desk().autoSetup();
    setSetup('');
    if (!r?.ok) setErr(r?.error || 'Setup did not finish.');
    else { setModel(r.model); mem('aduna.ai.model', r.model); }
    refresh();
  });
  const pick = (tag) => { setModel(tag); mem('aduna.ai.model', tag); };
  const pullModel = guard(async (tag) => {
    setPulls((p) => ({ ...p, [tag]: { pct: null, status: 'Starting\u2026' } }));
    const r = await desk().pull(tag);
    if (r && !r.ok && r.error !== 'Cancelled.') setErr(`Could not install ${tag}: ${r.error}`);
    refresh();
  });
  const build = guard(async () => {
    if (!req.trim() || !model) return;
    const r = await desk().run({ request: req.trim(), model, fetchHosts });
    if (!r?.ok) { setErr(r?.error || 'Could not start.'); return; }
    mem('aduna.ai.model', model); setReq('');
    dispatch({ type: 'clear' }); refresh(); loadJobs();
  });
  const resume = guard(async (id) => {
    const r = await desk().resume({ id, model, fetchHosts });
    if (!r?.ok) { setErr(r?.error || 'Could not continue.'); return; }
    dispatch({ type: 'clear' }); refresh(); loadJobs();
  });
  const use = guard(async (id) => {
    setBusyJob(id);
    try {
      const r = await desk().job(id);
      if (!r?.ok || !r.use) { setErr(r?.error || 'There is no usable code in this build yet.'); return; }
      onUse(r.use);
    } finally { setBusyJob(''); }
  });
  const del = guard(async (id) => { const r = await desk().deleteJob(id); if (!r?.ok) setErr(r?.error || 'Could not delete it.'); loadJobs(); });

  const ollamaOk = !!st?.ollama?.running;
  const busy = !!st?.busy || live.running;
  const anyPull = Object.keys(pulls).length > 0;
  const doneJob = live.done && live.done.ok ? live.done : null;

  return (
    <details className="bot-panel ai-panel" open={defaultOpen}>
      <summary>Build with AI on this PC</summary>
      <p className="muted small hint">Describe the bot in plain words. A coding model that runs on your own PC writes it and a test, tries them in the same sandbox as Aduna&rsquo;s servers, and keeps fixing it until the test passes. Nothing is sent to Aduna, and the AI never runs code on your PC. It keeps working if you leave this page or hide Aduna to the tray, and tells you when it is done.</p>
      {err && <div className="error">{err}</div>}
      {!st && !err && <p className="muted small">Checking this PC{'\u2026'}</p>}

      {st && !installed.length && (
        <div className="ai-box">
          <b>Set up first</b>
          <p className="muted small">The easy way installs Ollama (the free program that runs AI models), checks your graphics card, and downloads the best coding model that fits it. It is a large download.</p>
          <button type="button" className="btn primary" disabled={!!setup || !!install || anyPull} onClick={autoSetup}>Set up automatically</button> <span className="muted small">{setup}</span>
        </div>
      )}
      {st && !ollamaOk && (
        <div className="ai-box">
          {install && !install.error ? (
            <><b>Installing Ollama</b><div className="muted small">{install.status}</div><div className="ai-bar"><i style={{ width: (install.pct || 0) + '%' }} /></div></>
          ) : st.ollama.installed ? (
            <><b>Ollama is installed but not running</b> <button type="button" className="btn small-btn" onClick={guard(async () => { const r = await desk().startOllama(); if (!r?.ok) setErr(r?.error); refresh(); })}>Start Ollama</button></>
          ) : (
            <><b>Ollama is not installed</b> <button type="button" className="btn small-btn" disabled={!!setup} onClick={guard(async () => { setInstall({ status: 'Starting\u2026', pct: 0 }); const r = await desk().installOllama(); if (!r?.ok) setInstall({ status: r?.error, error: true }); refresh(); })}>Install Ollama</button>
              {install?.error && <div className="error">{install.status}</div>}</>
          )}
        </div>
      )}

      {st && installed.length > 0 && (
        <div className="ai-box">
          <label>WHAT SHOULD THE BOT DO?</label>
          <textarea rows={4} value={req} maxLength={4000} disabled={busy} onChange={(e) => setReq(e.target.value)} aria-label="What should the bot do" placeholder={'e.g. A dice bot. !roll gives a number from 1 to 6, !roll 20 uses a 20-sided die, and it keeps a count of how many times each person rolled.'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) build(); }} />
          <div className="ai-controls">
            <label className="muted small">Model <select value={model} onChange={(e) => pick(e.target.value)} disabled={busy} aria-label="Model">{installed.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
            {busy
              ? <button type="button" className="btn danger" onClick={() => desk().stop()}>Stop</button>
              : <button type="button" className="btn primary" disabled={!req.trim() || !model || !ollamaOk} onClick={build}>Build it</button>}
            {st.lessons > 0 && <span className="muted small">{plural(st.lessons, 'lesson', 'lessons')} learned from earlier builds</span>}
          </div>
        </div>
      )}

      {(live.items.length > 0 || live.running) && (
        <div className="ai-log" ref={logRef} aria-live="polite">
          {live.items.map((e, i) => <Item key={i} e={e} />)}
          {live.waiting && <div className="ai-ev warn">{live.waiting.reason}. Trying again in {live.waiting.seconds} s{'\u2026'}</div>}
          {live.running && !live.waiting && <div className="ai-ev ai-dim">{live.stream ? 'The model is writing\u2026' : 'Waiting for the model (the first reply can take a minute while it loads)\u2026'}</div>}
          {live.stream && live.running && <details><summary className="muted small">Show what the model is writing</summary><pre>{live.stream}</pre></details>}
        </div>
      )}
      {doneJob && live.jobId && (
        <div className="ai-box ai-ready">
          <b>{doneJob.name || 'Your bot'} is ready.</b>
          <div className="muted small">It passed its test in the bot sandbox. Check it in the chat simulator below, then save it.</div>
          <button type="button" className="btn primary" disabled={busyJob === live.jobId} onClick={() => use(live.jobId)}>Use this bot</button>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="ai-jobs">
          <label>YOUR AI BUILDS</label>
          {jobs.map((j) => {
            const running = st?.jobId === j.id && busy;
            return (
              <div key={j.id} className="ai-job">
                <div className="ai-job-who">
                  <b>{j.name || clip(j.request, 50)}</b> <span className={'bchip ' + (j.status === 'done' ? 'bchip-pub' : '')}>{running ? 'Working' : j.status === 'done' ? 'Finished' : j.status === 'error' ? 'Problem' : 'Not finished'}</span>
                  <div className="muted small">{clip(j.request, 110)} {'\u00B7'} {plural(j.attempts, 'attempt', 'attempts')} {'\u00B7'} {ago(j.updatedAt)}</div>
                </div>
                <div className="ai-job-act">
                  {j.status === 'done' && <button type="button" className="btn small-btn primary" disabled={busyJob === j.id} onClick={() => use(j.id)}>Use this bot</button>}
                  {j.status !== 'done' && !running && <button type="button" className="btn small-btn" disabled={busy || !ollamaOk || !model} onClick={() => resume(j.id)}>Continue</button>}
                  {j.status !== 'done' && j.hasBot && !running && <button type="button" className="btn small-btn" disabled={busyJob === j.id} onClick={() => use(j.id)} title="Use the code as it is now, even though it is not finished">Use code so far</button>}
                  {!running && <button type="button" className="btn small-btn danger" onClick={() => del(j.id)}>Delete</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {st && (
        <details className="ai-models">
          <summary>Models on this PC</summary>
          {st.gpu ? <p className="muted small">Your PC: {st.gpu.name} with {st.gpu.vramGB} GB of video memory, {st.ramGB} GB of system memory.</p> : <p className="muted small">The graphics card could not be read ({st.ramGB} GB of system memory). Check each model&rsquo;s memory against your card.</p>}
          <p className="muted small">Bigger models write better bots but need more video memory. If a card is too small, a model may fail to load or run very slowly.</p>
          {st.catalog.map((m) => {
            const fit = !st.gpu ? '' : m.vramGB <= st.gpu.vramGB ? 'Should run well.' : m.vramGB <= st.gpu.vramGB * 1.3 ? 'A tight fit: may be slow.' : 'Probably too big for your card.';
            const p = pulls[m.tag];
            return (
              <div key={m.tag} className="ai-model">
                <div><b>{m.tag}</b> <span className="muted small">{m.tier} {'\u00B7'} {m.sizeGB} GB download {'\u00B7'} wants ~{m.vramGB} GB {fit && '\u00B7 ' + fit}</span></div>
                <div className="ai-job-act">
                  {p ? <><span className="muted small">{pct(p.pct) == null ? p.status : pct(p.pct) + '%'}</span><button type="button" className="btn small-btn" onClick={() => desk().cancelPull()}>Cancel</button></>
                    : isInstalled(m.tag) ? <>{model === m.tag ? <span className="muted small">In use</span> : <button type="button" className="btn small-btn" onClick={() => pick(m.tag)}>Use</button>}
                      <button type="button" className="btn small-btn danger" disabled={busy} onClick={guard(async () => { if (window.confirm(`Remove ${m.tag} from this PC?`)) { const r = await desk().remove(m.tag); if (!r?.ok) setErr(r?.error); refresh(); } })}>Remove</button></>
                      : <button type="button" className="btn small-btn primary" disabled={anyPull || !ollamaOk} onClick={() => pullModel(m.tag)}>Install</button>}
                </div>
              </div>
            );
          })}
          <div className="ai-controls">
            <input value={custom} maxLength={100} onChange={(e) => setCustom(e.target.value)} placeholder="Another model, e.g. codellama:13b" aria-label="Another model name" spellCheck={false} />
            <button type="button" className="btn small-btn" disabled={!custom.trim() || anyPull || !ollamaOk} onClick={() => { pullModel(custom.trim()); setCustom(''); }}>Install</button>
          </div>
        </details>
      )}
    </details>
  );
}
