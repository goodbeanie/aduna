import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMOJIS, Icon } from './ui.jsx';
import { useEmoji } from './Emoji.jsx';

// The full Unicode emoji set lives in its own chunk and is only fetched the first time a picker opens.
let dataPromise;
const loadData = () => dataPromise || (dataPromise = import('./emoji-data.json').then((m) => m.default));

const TABS = [
  { id: 'custom', label: 'Your emoji', icon: 'star' },
  { id: 0, label: 'Smileys & Emotion', icon: 'smile' },
  { id: 1, label: 'People & Body', icon: 'users' },
  { id: 3, label: 'Animals & Nature', icon: 'leaf' },
  { id: 4, label: 'Food & Drink', icon: 'cup' },
  { id: 5, label: 'Travel & Places', icon: 'globe' },
  { id: 6, label: 'Activities', icon: 'ball' },
  { id: 7, label: 'Objects', icon: 'bulb' },
  { id: 8, label: 'Symbols', icon: 'hash' },
  { id: 9, label: 'Flags', icon: 'flag' },
];
const TONES = ['#f2c14e', '#f6dcc0', '#e8c29c', '#c89868', '#9a6b43', '#5b3d26'];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: just don't remember */ } },
};

// Newer multi-part emoji (ZWJ sequences) show up as several separate glyphs on systems that predate them; hide those.
let probe;
const rendersCache = new Map();
function renders(emoji, version) {
  if (version < 11 || !emoji.includes('\u200d')) return true;
  if (rendersCache.has(emoji)) return rendersCache.get(emoji);
  let ok = true;
  try {
    probe = probe || document.createElement('canvas').getContext('2d');
    probe.font = '32px sans-serif';
    ok = probe.measureText(emoji).width < probe.measureText('\u{1F600}').width * 1.6;
  } catch { /* if the check itself fails, show everything */ }
  rendersCache.set(emoji, ok);
  return ok;
}

export default function EmojiPicker({ onPick, onCustom, onManage }) {
  const { lib } = useEmoji();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [tone, setTone] = useState(() => store.get('aduna_skin', 0));
  const [toneOpen, setToneOpen] = useState(false);
  const [recent, setRecent] = useState(() => store.get('aduna_recent', []));
  const [active, setActive] = useState(null);
  const hoverEl = useRef(null);
  const scroller = useRef(null);
  const sections = useRef({});

  useEffect(() => { let dead = false; loadData().then((d) => !dead && setData(d)); return () => { dead = true; }; }, []);

  const groups = useMemo(() => data && data.groups.map((g) => ({ ...g, items: g.items.filter((it) => renders(it[0], it[3])) })), [data]);
  const glyph = useCallback((it) => (tone && it[4] ? it[4][tone - 1] : it[0]), [tone]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || !groups) return null;
    const words = t.split(/\s+/);
    const hit = (it) => { const hay = (it[1] + ' ' + it[2]).toLowerCase(); return words.every((w) => hay.includes(w)); };
    const emoji = groups.flatMap((g) => g.items.filter(hit)).slice(0, 240);
    const custom = lib.filter((c) => words.every((w) => c.name.includes(w)));
    return { emoji, custom };
  }, [q, groups, lib]);

  // The row pinned under the search box: what you picked last (unicode and custom emoji), or a few quick picks until you have picked something.
  const quick = useMemo(() => {
    const list = recent.length ? recent : EMOJIS;
    return list.filter((e) => !String(e).startsWith('c:') || lib.some((c) => c.id === e.slice(2))).slice(0, 9);
  }, [recent, lib]);

  function remember(key) {
    const next = [key, ...recent.filter((x) => x !== key)].slice(0, 24);
    setRecent(next); store.set('aduna_recent', next);
  }
  function choose(emoji) { remember(emoji); onPick(emoji); }
  function chooseCustom(c) { remember('c:' + c.id); onCustom(c); }
  function pickTone(n) { setTone(n); store.set('aduna_skin', n); setToneOpen(false); }

  function jump(id) {
    const el = sections.current[id];
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - scroller.current.offsetTop, behavior: 'smooth' });
    setActive(id);
  }
  const onScroll = useCallback(() => {
    const box = scroller.current; if (!box) return;
    const y = box.scrollTop + 8;
    let cur = TABS[0].id;
    for (const t of TABS) { const el = sections.current[t.id]; if (el && el.offsetTop - box.offsetTop <= y) cur = t.id; }
    setActive((a) => (a === cur ? a : cur));
  }, []);

  const hasCustom = lib.length > 0 || !!onManage;
  const tabs = TABS.filter((t) => t.id !== 'custom' || hasCustom);
  const showHover = (label) => { if (hoverEl.current) hoverEl.current.textContent = label; };

  const btn = (emoji, label) => (
    <button key={emoji} type="button" className="ep-e" title={label} aria-label={label} onMouseEnter={() => showHover(label)} onFocus={() => showHover(label)} onClick={() => choose(emoji)}>{emoji}</button>
  );
  const custom = (c) => (
    <button key={c.id} type="button" className="ep-e ep-c" title={':' + c.name + ':'} aria-label={c.name} onMouseEnter={() => showHover(':' + c.name + ':')} onClick={() => chooseCustom(c)}>
      <img src={`/api/emoji/${c.id}/image`} alt={c.name} loading="lazy" />
    </button>
  );

  return (
    <div className="ep">
      <div className="ep-top">
        <Icon name="search" size={16} className="ep-search-ic" />
        <input className="ep-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search emoji" maxLength={40} autoComplete="off" />
      </div>
      {!results && (
        <div className="ep-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={active === t.id} className={'ep-tab' + (active === t.id ? ' on' : '')} title={t.label} onClick={() => jump(t.id)}>
              <Icon name={t.icon} size={17} />
            </button>
          ))}
        </div>
      )}
      {!results && quick.length > 0 && (
        <div className="ep-recent" aria-label={recent.length ? 'Recently used' : 'Quick picks'}>
          {quick.map((e) => (String(e).startsWith('c:') ? custom(lib.find((c) => c.id === e.slice(2))) : btn(e, e)))}
        </div>
      )}
      <div className="ep-scroll" ref={scroller} onScroll={results ? undefined : onScroll}>
        {!groups && <div className="muted pad center">Loading emoji…</div>}
        {groups && results && (
          <>
            {results.custom.length > 0 && <><div className="ep-label">YOUR EMOJI</div><div className="ep-grid">{results.custom.map(custom)}</div></>}
            {results.emoji.length > 0 && <div className="ep-grid">{results.emoji.map((it) => btn(glyph(it), it[1]))}</div>}
            {!results.emoji.length && !results.custom.length && <div className="muted pad center">No emoji match “{q.trim()}”.</div>}
          </>
        )}
        {groups && !results && (
          <>
            {hasCustom && (
              <section ref={(el) => { sections.current.custom = el; }}>
                <div className="ep-label">YOUR EMOJI</div>
                {lib.length > 0 && <div className="ep-grid">{lib.map(custom)}</div>}
                {onManage && <button type="button" className="pop-add" onClick={onManage}><Icon name="plus" size={15} /> Add custom emoji</button>}
              </section>
            )}
            {groups.map((g) => (
              <section key={g.id} className="ep-sec" ref={(el) => { sections.current[g.id] = el; }}>
                <div className="ep-label">{g.name.toUpperCase()}</div>
                <div className="ep-grid">{g.items.map((it) => btn(glyph(it), it[1]))}</div>
              </section>
            ))}
          </>
        )}
      </div>
      <div className="ep-foot">
        <div className="ep-hover" ref={hoverEl}>Pick an emoji</div>
        <div className="ep-tone">
          {toneOpen
            ? TONES.map((c, i) => <button key={i} type="button" className={'ep-sw' + (tone === i ? ' on' : '')} style={{ background: c }} title={i ? `Skin tone ${i}` : 'Default'} aria-label={i ? `Skin tone ${i}` : 'Default skin tone'} onClick={() => pickTone(i)} />)
            : <button type="button" className="ep-sw on" style={{ background: TONES[tone] }} title="Skin tone" aria-label="Choose skin tone" onClick={() => setToneOpen(true)} />}
        </div>
      </div>
    </div>
  );
}
