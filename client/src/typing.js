import { useEffect, useRef } from 'react';

// Records HOW a message was written, to send along with it: how many characters came from key presses,
// how many were pasted or dropped, how long it took and how uneven the gaps between key presses were.
// The server uses this to decide whether a message earns credits. It only counts real (trusted) browser events,
// but it is still just a hint from the browser: the server's own limits (cooldown, daily cap, similarity) are what
// really stop abuse. Text added by the emoji picker or @mention menu is not typed and is not counted as typed.
const PASTED = new Set(['insertFromPaste', 'insertFromDrop', 'insertFromYank', 'insertFromPasteAsQuotation']);
const fresh = () => ({ typed: 0, pasted: 0, events: 0, first: 0, last: 0, n: 0, mean: 0, m2: 0, comp: 0 });

export function useTypingProof(inputRef, dep) {
  const s = useRef(fresh());
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return undefined;
    const onBefore = (e) => {
      if (!e.isTrusted) return; // events made by scripts do not count
      const type = e.inputType || '';
      const text = e.data ?? e.dataTransfer?.getData?.('text/plain') ?? '';
      const p = s.current;
      if (PASTED.has(type)) { p.pasted += Math.max(text.length, 1); return; }
      const t = performance.now();
      if (type === 'insertText' || type === 'insertReplacementText') p.typed += text.length;
      else if (type === 'insertCompositionText') { // IME / swipe typing repeats the whole word each time: count only what it grew by
        p.typed += Math.max(0, text.length - p.comp);
        p.comp = text.length;
      }
      if (!p.first) p.first = t;
      if (p.last && t - p.last < 5000) { // gaps over 5 s are pauses, not rhythm
        const gap = t - p.last;
        p.n++;
        const d = gap - p.mean;
        p.mean += d / p.n;
        p.m2 += d * (gap - p.mean);
      }
      p.last = t;
      p.events++;
    };
    const endComp = () => { s.current.comp = 0; };
    const onInput = () => { if (!el.value) s.current = fresh(); }; // emptied the box: start over
    el.addEventListener('beforeinput', onBefore);
    el.addEventListener('compositionstart', endComp);
    el.addEventListener('compositionend', endComp);
    el.addEventListener('input', onInput);
    return () => {
      el.removeEventListener('beforeinput', onBefore);
      el.removeEventListener('compositionstart', endComp);
      el.removeEventListener('compositionend', endComp);
      el.removeEventListener('input', onInput);
    };
  }, [inputRef, dep]);

  return {
    proof: () => {
      const p = s.current;
      return { t: p.typed, p: p.pasted, ms: p.first ? Math.round(performance.now() - p.first) : 0, ev: p.events, j: p.n > 1 ? Math.round(Math.sqrt(p.m2 / (p.n - 1))) : 0 };
    },
    reset: () => { s.current = fresh(); },
  };
}
