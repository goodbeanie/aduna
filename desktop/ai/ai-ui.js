(function () {
  'use strict';
  var api = window.adunaAI;
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    for (var k in (props || {})) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch (e) { return ''; } }

  var S = { st: null, model: store('ai.model'), pulls: {}, install: null, busy: false, stream: '' };

  // ---------- tabs ----------
  function tab(name) {
    $('models').hidden = name !== 'models'; $('build').hidden = name !== 'build';
    $('t-models').classList.toggle('on', name === 'models'); $('t-build').classList.toggle('on', name === 'build');
  }
  $('t-models').onclick = function () { tab('models'); refresh(); };
  $('t-build').onclick = function () { tab('build'); };
  $('go-models').onclick = function () { tab('models'); };

  // ---------- helpers ----------
  function installedNames() { return ((S.st && S.st.models) || []).map(function (m) { return m.name; }); }
  function isInstalled(tag) { return installedNames().indexOf(tag) >= 0; }
  function say(id, text) { $(id).textContent = text || ''; }
  function fitOf(m) {
    var g = S.st && S.st.gpu;
    if (!g) return { cls: 'unk', text: 'Needs about ' + m.vramGB + ' GB of video memory. We couldn\u2019t read your graphics card, so check that it has enough.' };
    if (m.vramGB <= g.vramGB) return { cls: 'ok', text: 'Should run well on your ' + g.vramGB + ' GB card.' };
    if (m.vramGB <= g.vramGB * 1.3) return { cls: 'warn', text: 'A tight fit for your ' + g.vramGB + ' GB card: it may be slow or fail to load.' };
    return { cls: 'bad', text: 'Needs about ' + m.vramGB + ' GB and your card has ' + g.vramGB + ' GB, so it will probably be very slow or not load.' };
  }
  function pct(p) { return p == null ? null : Math.round(p); }

  // ---------- Ollama + hardware ----------
  function renderOllama() {
    var o = S.st.ollama, box = $('ollama-box'); box.textContent = '';
    var pill = $('pill');
    if (S.install && !S.install.error) {
      pill.textContent = 'Installing Ollama\u2026'; pill.className = 'pill';
      box.appendChild(el('h2', { text: 'Installing Ollama' }));
      box.appendChild(el('div', { text: S.install.status || 'Working\u2026' }));
      var bar = el('div', { class: 'bar', style: 'margin-top:8px;width:100%' }, [el('i', { id: 'install-bar', style: 'width:' + (S.install.pct || 0) + '%' })]);
      box.appendChild(bar);
      return;
    }
    if (o.running) {
      pill.textContent = 'Ollama running'; pill.className = 'pill ok';
      box.appendChild(el('div', { text: '\u2713 Ollama is running. Models you install run on this PC and work offline.' }));
    } else if (o.installed) {
      pill.textContent = 'Ollama stopped'; pill.className = 'pill bad';
      box.appendChild(el('h2', { text: 'Ollama is installed but not running' }));
      box.appendChild(el('button', { class: 'primary', text: 'Start Ollama', onclick: function () { api.startOllama().then(function (r) { if (!r.ok) say('msg-models', r.error); refresh(); }); } }));
    } else {
      pill.textContent = 'Ollama not installed'; pill.className = 'pill bad';
      box.appendChild(el('h2', { text: 'First, install Ollama' }));
      box.appendChild(el('p', { class: 'muted', text: 'Ollama is the free program that runs AI models on your own PC. This downloads the official installer from ollama.com (a large download) and runs it for you.' }));
      if (S.install && S.install.error) box.appendChild(el('p', { class: 'fit bad', text: S.install.status }));
      box.appendChild(el('button', { class: 'primary', text: 'Install Ollama', onclick: function () { S.install = { status: 'Starting\u2026', pct: 0 }; renderOllama(); api.installOllama().then(function (r) { if (!r.ok) { S.install = { status: r.error, error: true }; } refresh(); }); } }));
    }
  }
  function renderGpu() {
    var s = S.st, g = s.gpu;
    $('gpu-box').textContent = g
      ? 'Your PC: ' + g.name + ' with ' + g.vramGB + ' GB of video memory, ' + s.ramGB + ' GB of system memory.'
      : 'We couldn\u2019t read your graphics card\u2019s video memory (' + s.ramGB + ' GB of system memory). Check the memory shown for each model below against your card.';
  }

  // ---------- models ----------
  function pullControls(name) {
    var p = S.pulls[name];
    var bar = el('div', { class: 'bar' }, [el('i', { 'data-bar': name, style: 'width:' + (pct(p.pct) || 0) + '%' })]);
    return [bar, el('span', { class: 'small muted', 'data-label': name, text: (pct(p.pct) == null ? p.status : pct(p.pct) + '%') }), el('button', { text: 'Cancel', onclick: function () { api.cancelPull(); } })];
  }
  function modelRow(m, extra) {
    var inst = isInstalled(m.tag), pulling = !!S.pulls[m.tag], anyPull = Object.keys(S.pulls).length > 0;
    var info = el('div', { class: 'info' }, [el('div', { class: 'name' }, [m.tag, m.tier ? el('span', { class: 'tier', text: m.tier }) : null])]);
    if (m.note) info.appendChild(el('div', { class: 'muted small', text: m.note }));
    if (m.vramGB) {
      var f = fitOf(m);
      info.appendChild(el('div', { class: 'small' }, [el('span', { class: 'muted', text: 'Download ' + m.sizeGB + ' GB \u00B7 wants ~' + m.vramGB + ' GB VRAM \u00B7 ' }), el('span', { class: 'fit ' + f.cls, text: f.text })]));
    }
    var actions = el('div', { class: 'actions' });
    if (pulling) pullControls(m.tag).forEach(function (n) { actions.appendChild(n); });
    else if (inst) {
      actions.appendChild(el('button', S.model === m.tag ? { class: 'primary', text: 'In use', disabled: 'disabled' } : { text: 'Use', onclick: function () { pick(m.tag); } }));
      actions.appendChild(el('button', { text: 'Remove', onclick: function () { if (confirm('Remove ' + m.tag + ' from this PC?')) api.remove(m.tag).then(function (r) { if (!r.ok) say('msg-models', r.error); refresh(); }); } }));
    } else {
      var b = el('button', { class: 'primary', text: 'Install', onclick: function () { install(m.tag); } });
      if (anyPull || !S.st.ollama.running) { b.setAttribute('disabled', 'disabled'); b.title = S.st.ollama.running ? 'Wait for the current download to finish' : 'Install or start Ollama first'; }
      actions.appendChild(b);
    }
    return el('div', { class: 'row', 'data-row': m.tag }, [info, actions]);
  }
  function renderModels() {
    var cat = $('catalog'); cat.textContent = '';
    S.st.catalog.forEach(function (m) { cat.appendChild(modelRow(m)); });
    var known = S.st.catalog.map(function (m) { return m.tag; });
    var others = S.st.models.filter(function (m) { return known.indexOf(m.name) < 0; });
    $('other-box').hidden = !others.length && !Object.keys(S.pulls).some(function (n) { return known.indexOf(n) < 0; });
    var o = $('other'); o.textContent = '';
    others.forEach(function (m) { o.appendChild(modelRow({ tag: m.name, note: m.sizeGB + ' GB on disk' })); });
    Object.keys(S.pulls).filter(function (n) { return known.indexOf(n) < 0 && !isInstalled(n); }).forEach(function (n) { o.appendChild(modelRow({ tag: n })); });
  }
  function install(tag) {
    say('msg-models', '');
    S.pulls[tag] = { pct: null, status: 'Starting\u2026' }; renderModels();
    api.pull(tag).then(function (r) { if (!r.ok && r.error !== 'Cancelled.') say('msg-models', 'Couldn\u2019t install ' + tag + ': ' + r.error); });
  }
  $('custom-go').onclick = function () { var v = $('custom').value.trim(); if (v) { install(v); $('custom').value = ''; } };
  function pick(tag) { S.model = tag; store('ai.model', tag); renderModels(); renderModelSelect(); }
  function renderModelSelect() {
    var sel = $('model'), names = installedNames();
    if (names.indexOf(S.model) < 0) S.model = names[0] || '';
    sel.textContent = '';
    names.forEach(function (n) { var o = el('option', { value: n, text: n }); if (n === S.model) o.selected = true; sel.appendChild(o); });
    sel.disabled = !names.length;
    $('need-model').hidden = names.length > 0;
    $('go').disabled = S.busy || !names.length;
  }
  $('model').onchange = function () { pick($('model').value); };

  function refresh() {
    return api.status().then(function (s) {
      if (!s || s.ok === false) { $('pill').textContent = 'Error'; return; }
      S.st = s;
      if (!S.busy && s.busy) setBusy(true);
      renderOllama(); renderGpu(); renderModels(); renderModelSelect();
      if (!installedNames().length && !S.firstTabDone) { tab('models'); }
      S.firstTabDone = true;
    });
  }

  // ---------- building ----------
  var log = $('log');
  function add(cls, text, extra) {
    var near = (document.querySelector('main').scrollHeight - document.querySelector('main').scrollTop - document.querySelector('main').clientHeight) < 120;
    var n = el('div', { class: 'ev ' + cls }, [text]); if (extra) n.appendChild(extra);
    log.appendChild(n);
    if (near) document.querySelector('main').scrollTop = 1e9;
    return n;
  }
  function setBusy(b) {
    S.busy = b; $('stop').hidden = !b; $('go').hidden = b; $('new').disabled = b; $('req').disabled = b; $('go').disabled = b || !installedNames().length;
  }
  function output(text) { return text ? el('details', {}, [el('summary', { text: 'Show output' }), el('pre', { text: text })]) : null; }

  function onAgent(e) {
    if (e.kind === 'start') { setBusy(true); add('iter', 'Project folder: ' + e.dir); }
    else if (e.kind === 'iter') { S.stream = ''; $('stream').textContent = ''; $('streambox').hidden = false; add('iter', 'Attempt ' + e.n + ' of ' + e.max + ': waiting for the model (the first reply can take a minute while it loads)\u2026'); }
    else if (e.kind === 'token') { S.stream = (S.stream + e.text).slice(-6000); $('stream').textContent = S.stream; }
    else if (e.kind === 'file') add('', '\u270E Wrote ' + e.path + ' (' + e.bytes + ' bytes)');
    else if (e.kind === 'run') add('', '\u25B6 Running ' + e.cmd);
    else if (e.kind === 'result') add(e.ok ? 'ok' : 'bad', e.ok ? '\u2713 Test passed' : (e.timedOut ? '\u2717 Test timed out' : '\u2717 Test failed (exit code ' + e.code + '). The AI will try to fix it.'), output(e.output));
    else if (e.kind === 'note') add('bad', e.text);
    else if (e.kind === 'confirm') {
      var row = add('', 'The AI wants to run: ' + e.cmd + ' ');
      var yes = el('button', { class: 'primary', text: 'Allow', onclick: function () { api.confirm(true); row.removeChild(btns); } });
      var no = el('button', { text: 'Stop', onclick: function () { api.confirm(false); row.removeChild(btns); } });
      var btns = el('span', {}, [yes, ' ', no]); row.appendChild(btns);
    }
    else if (e.kind === 'finished') {
      setBusy(false);
      var tip = !e.ok && /memory/i.test(e.summary || '') ? ' Try a smaller model on the Models tab.' : '';
      add(e.ok ? 'ok final' : 'bad final', (e.ok ? '\u2713 ' : '\u2717 ') + (e.summary || '') + tip + (e.ok ? ' (' + e.attempts + ' attempt' + (e.attempts === 1 ? '' : 's') + ')' : ''));
      if (e.ok) add('', 'Your files are in the project folder. Type another request to change it, or press New project to start fresh.');
    }
  }

  $('go').onclick = function () {
    var req = $('req').value.trim(); if (!req || S.busy) return;
    if (!S.model) { say('msg', 'Install and choose a model first.'); return; }
    say('msg', ''); add('you', req); setBusy(true);
    api.run({ request: req, model: S.model, autoRun: $('auto').checked, maxIter: Number($('iters').value) }).then(function (r) {
      if (!r.ok) { setBusy(false); say('msg', r.error); } else $('req').value = '';
    });
  };
  $('req').addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('go').click(); });
  $('stop').onclick = function () { api.stop(); $('stop').disabled = true; setTimeout(function () { $('stop').disabled = false; }, 1500); };
  $('new').onclick = function () { api.newProject().then(function (r) { if (r.ok) { log.textContent = ''; $('streambox').hidden = true; add('', 'New project. Your next request starts in a fresh folder.'); } else say('msg', r.error); }); };
  $('open').onclick = function () { api.openFolder().then(function (r) { if (!r.ok) say('msg', r.error || 'Could not open the folder.'); }); };

  // ---------- events from the app ----------
  api.onEvent(function (e) {
    if (e.type === 'pull') {
      var p = S.pulls[e.name] = { pct: e.pct, status: e.status };
      var bar = document.querySelector('[data-bar="' + e.name.replace(/"/g, '') + '"]'), label = document.querySelector('[data-label="' + e.name.replace(/"/g, '') + '"]');
      if (bar && label) { bar.style.width = (pct(p.pct) || 0) + '%'; label.textContent = pct(p.pct) == null ? p.status : pct(p.pct) + '%'; } else renderModels();
    } else if (e.type === 'pull-done') {
      delete S.pulls[e.name];
      if (e.ok) { if (!S.model) { S.model = e.name; store('ai.model', e.name); } } else if (e.error && e.error !== 'Cancelled.') say('msg-models', 'Couldn\u2019t install ' + e.name + ': ' + e.error);
      refresh();
    } else if (e.type === 'ollama-install') {
      S.install = e.done ? (e.error ? { status: e.status, error: true } : null) : { status: e.status, pct: e.pct };
      if (e.done) refresh(); else if (S.st) { var ib = $('install-bar'); if (ib) { ib.style.width = (e.pct || 0) + '%'; ib.parentNode.previousSibling.textContent = e.status; } else renderOllama(); }
    } else if (e.type === 'agent') onAgent(e);
  });
  window.addEventListener('focus', function () { if (S.st && !S.busy && Object.keys(S.pulls).length === 0 && !S.install) refresh(); });

  setBusy(false);
  refresh().then(function () { tab(installedNames().length ? 'build' : 'models'); });
})();
