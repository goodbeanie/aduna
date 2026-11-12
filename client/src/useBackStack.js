import { useEffect, useRef, useState } from 'react';

// Phones: the Back button (Android hardware / gesture button, the browser's Back, an iPhone swipe) steps back one screen at a time:
// an open dialog, then the member list, then the chat (back to the channel / DM list). Without this the app is a single page with
// nothing to go back to, so Back closed the whole app.
//
// How: every layer that opens gets one browser history entry (pushState). Pressing Back pops it ("popstate") and we close the top layer.
// When a layer closes some other way (the in-app arrow, tapping outside a dialog) its history entry is removed again with history.go(-n),
// so the history always has exactly one entry per open layer. Nothing is pushed on wide screens, where Back keeps its normal job.
//
//   layers: [{ open: boolean, close: () => void }], bottom screen first, the one on top last.
const PHONE = '(max-width: 720px)';

export function useBackStack(layers) {
  const [phone, setPhone] = useState(() => { try { return window.matchMedia(PHONE).matches; } catch { return false; } });
  useEffect(() => {
    let mq; try { mq = window.matchMedia(PHONE); } catch { return undefined; }
    const on = () => setPhone(mq.matches);
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on); };
  }, []);

  const open = layers.filter((l) => l.open);
  const want = phone ? open.length : 0;
  const depth = useRef(0);  // history entries this hook has added
  const skip = useRef(0);   // popstate events caused by our own history.go(): not the person pressing Back
  const top = useRef(null); // closes the top layer
  top.current = open.length ? open[open.length - 1].close : null;

  useEffect(() => {
    if (want > depth.current) {
      while (depth.current < want) {
        try { history.pushState({ aduna: depth.current + 1 }, ''); } catch { break; }
        depth.current += 1;
      }
    } else if (want < depth.current) {
      const n = depth.current - want;
      depth.current = want;
      skip.current += 1;
      try { history.go(-n); } catch { skip.current -= 1; }
    }
  }, [want]);

  useEffect(() => {
    const onPop = () => {
      if (skip.current > 0) { skip.current -= 1; return; }
      if (depth.current === 0) return; // not ours (an old entry from before a reload): let it be
      depth.current -= 1;
      if (top.current) top.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
}
