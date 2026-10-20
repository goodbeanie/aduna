// Keeps the page sized to what is visible when the on-screen keyboard is open, so the message box rides above the keyboard.
//  - Android app (native shell) and Chrome with interactive-widget=resizes-content: the layout already shrinks, nothing to do here.
//  - iOS Safari / any browser that only shrinks the *visual* viewport: we copy its height into --app-h and undo the page scroll.
export function initKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const editing = () => { const a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(checkbox|radio|button|file|range|color|submit)$/.test(a.type))); };
  let raf = 0;
  const update = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const covered = window.innerHeight - vv.height; // > 0 only when the layout viewport was NOT resized by the keyboard
      if (editing() && covered > 80) {
        root.style.setProperty('--app-h', Math.round(vv.height) + 'px');
        root.classList.add('kb-open');
        if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0);
      } else {
        root.style.removeProperty('--app-h');
        root.classList.remove('kb-open');
      }
    });
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => setTimeout(update, 50));
}
