// The behaviour a strip needs (the side list, the member list or the shortcuts when they sit on the top or bottom): they scroll sideways,
// so the mouse wheel scrolls them that way, an edge fades while there is more to see on it, and the channel you are in stays in view.
// Only the look is in panels.css. Nothing here runs in the standard layout or on a tablet-sized window (there are no strips there). A phone only has the Shortcuts strip.
const SEL = [
  'html[data-pan] .side:is([data-slot=top], [data-slot=bottom]) > .side-list',
  'html[data-pan] :is(.members, .quick):is([data-slot=top], [data-slot=bottom])',
].join(', ');
const WIDE = '(min-width: 1051px), (max-width: 720px)'; // a wide window or a phone: where the layout is on
const EDGE = 2; // pixels of slack before an edge counts as reached

const wide = () => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(WIDE).matches;

function edgeOf(el) {
  const max = el.scrollWidth - el.clientWidth;
  const start = el.scrollLeft > EDGE, end = el.scrollLeft < max - EDGE;
  return start && end ? 'both' : start ? 'start' : end ? 'end' : '';
}

function setEdge(el, value) {
  if ((el.dataset.edge || '') === value) return;
  if (value) el.dataset.edge = value; else delete el.dataset.edge;
}

// The channel (or conversation) you are in stays inside the strip: when it changes, the strip scrolls just far enough to show it.
const lastActive = new WeakMap();
function reveal(el) {
  const on = el.querySelector(':scope > .chan.on, :scope > .chan-wrap > .chan.on, :scope > .cat > .chan.on');
  if (!on || lastActive.get(el) === on) return;
  lastActive.set(el, on);
  const r = on.getBoundingClientRect(), b = el.getBoundingClientRect(), pad = 40;
  if (r.left < b.left + pad) el.scrollLeft -= b.left + pad - r.left;
  else if (r.right > b.right - pad) el.scrollLeft += r.right - (b.right - pad);
}

// Called after every render of the app and whenever the window or a strip changes: cheap (a handful of elements).
export function syncStrips() {
  if (typeof document === 'undefined') return;
  const on = wide();
  for (const el of document.querySelectorAll('[data-edge]')) if (!on || !el.matches(SEL)) setEdge(el, '');
  if (!on) return;
  for (const el of document.querySelectorAll(SEL)) {
    if (el.classList.contains('side-list')) reveal(el);
    setEdge(el, edgeOf(el));
  }
}

let ticking = false;
const later = () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => { ticking = false; syncStrips(); });
};

let started = false;
export function initPanelFx() {
  if (started || typeof window === 'undefined') return;
  started = true;
  // scroll events do not bubble, but they can be caught on the way down
  document.addEventListener('scroll', (e) => {
    const el = e.target;
    if (el instanceof Element && el.matches(SEL)) setEdge(el, edgeOf(el));
  }, true);
  // a vertical wheel turn scrolls a strip sideways (the scrollbar is hidden, and nothing else would use it)
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey || !(e.target instanceof Element) || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const el = e.target.closest(SEL);
    if (!el || el.scrollWidth <= el.clientWidth) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  }, { passive: false });
  window.addEventListener('resize', later);
  // Switching channel changes a class, loading channels or members changes the width: either way a strip may need its fade or a scroll.
  // Does nothing in the standard layout, and only looks at changes that happen inside a top or bottom section.
  const STRIP_AREA = '[data-panel][data-slot=top], [data-panel][data-slot=bottom]';
  new MutationObserver((records) => {
    if (!document.documentElement.hasAttribute('data-pan')) return;
    for (const m of records) {
      const t = m.target instanceof Element ? m.target : m.target.parentElement;
      if (t?.closest(STRIP_AREA)) { later(); return; }
    }
  }).observe(document.body || document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  later();
}

// Called by panels.js after a layout change: the strips are new elements or have a new width.
export const strips = later;
