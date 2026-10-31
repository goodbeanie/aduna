// If you're already signed in, the buttons just open the app.
try{
  if(localStorage.getItem('aduna_in')||localStorage.getItem('aduna_token')){ // aduna_token: people who signed in before cookies existed
    document.querySelectorAll('a.go').forEach(function(a){a.textContent='Open Aduna';a.setAttribute('href','/app');});
    document.querySelectorAll('a.login').forEach(function(a){a.style.display='none'});
  }
}catch(e){}

// Click a theme under the headline to try it on this page. Same seeds as the app's themes (client/src/themes.js).
// A pick is remembered in the same place the app keeps its theme, so sign-up and the app open in it. People who are already signed in keep the theme they saved in the app.
(function () {
  var THEMES = {
    zen: [1, '#1d1a17', '#ecd5b6'], 'zen-light': [0, '#f6f0e4', '#6f5233'],
    ocean: [0, '#f3f8fb', '#1f5f8b'], forest: [0, '#f4f8f1', '#2f6b45'], rose: [0, '#fcf4f4', '#b4435a'], lavender: [0, '#f7f4fc', '#6a4fb3'],
    sunset: [0, '#fdf5ec', '#c2551d'], charcoal: [1, '#2a2a2d', '#e8e4da'], midnight: [1, '#161b2a', '#7aa2ff'],
    evergreen: [1, '#17221d', '#6fcf97'], plum: [1, '#241a2b', '#d68cf0'], ember: [1, '#271c17', '#f09a5a']
  }; // [dark, background, accent]; parchment is the page's own look, so it just clears the overrides
  var NAMES = ['--cream', '--fg', '--muted', '--line', '--accent', '--on-accent', '--band', '--band-fg', '--band-muted',
    '--d-bg', '--d-bg2', '--d-bg3', '--d-field', '--d-line', '--d-text', '--d-muted', '--d-sel', '--d-head'];
  var root = document.documentElement;
  var meta = document.querySelector('meta[name="theme-color"]');
  var metaOrig = meta && meta.getAttribute('content');

  function rgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); }); }
  function hex(a) { return '#' + a.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function mix(a, b, t) { var A = rgb(a), B = rgb(b); return hex(A.map(function (v, i) { return v + (B[i] - v) * t; })); }
  function lum(h) { var c = rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function readable(bg) { return contrast(bg, '#14110d') >= contrast(bg, '#fbf8f1') ? '#14110d' : '#fbf8f1'; }

  function apply(id) {
    var t = THEMES[id], v = {};
    if (t) {
      var dark = !!t[0], bg = t[1], ac = t[2], k = dark ? '#ffffff' : '#000000';
      var fg = mix(bg, k, dark ? 0.97 : 0.93), band = dark ? mix(bg, '#000000', 0.38) : ac, bandFg = dark ? fg : readable(ac);
      v = {
        '--cream': bg, '--fg': fg, '--muted': mix(bg, k, dark ? 0.55 : 0.52), '--line': mix(bg, k, dark ? 0.13 : 0.11),
        '--accent': ac, '--on-accent': readable(ac), '--band': band, '--band-fg': bandFg, '--band-muted': mix(band, bandFg, 0.65),
        '--d-bg': dark ? mix(bg, '#000000', 0.1) : mix(bg, '#ffffff', 0.55),
        '--d-bg2': dark ? mix(bg, '#000000', 0.26) : mix(bg, k, 0.04), '--d-bg3': dark ? mix(bg, '#000000', 0.42) : mix(bg, k, 0.09),
        '--d-field': mix(bg, k, dark ? 0.07 : 0.05), '--d-line': mix(bg, k, dark ? 0.16 : 0.12), '--d-text': mix(bg, k, dark ? 0.88 : 0.84),
        '--d-muted': mix(bg, k, dark ? 0.58 : 0.55), '--d-sel': mix(bg, k, dark ? 0.14 : 0.1), '--d-head': fg
      };
    }
    NAMES.forEach(function (n) { if (v[n]) root.style.setProperty(n, v[n]); else root.style.removeProperty(n); });
    root.style.colorScheme = t ? (t[0] ? 'dark' : 'light') : '';
    root.classList.toggle('lt', !!t && !t[0]);
    if (meta) meta.setAttribute('content', t ? t[1] : metaOrig);
    document.querySelectorAll('.sw[data-theme]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-theme') === id)); });
  }

  var KEY = 'aduna-theme'; // the app's own key (themes.js STORE): { id, custom, serverThemes }
  function signedIn() { try { return !!(localStorage.getItem('aduna_in') || localStorage.getItem('aduna_token')); } catch (e) { return false; } }
  function remember(id) {
    if (signedIn()) return;
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (!s || typeof s !== 'object') s = {};
      s.id = id; // keeps a custom theme and the server-theme switch if the browser already had them
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) { /* storage blocked: the pick still applies to this page */ }
  }

  // someone who picked a look before sees it here too; anything this page cannot draw (gradient, custom, device) leaves the default
  var saved = null;
  try { saved = (JSON.parse(localStorage.getItem(KEY) || 'null') || {}).id; } catch (e) { /* ignore */ }
  var start = saved && (saved === 'parchment' || THEMES[saved]) ? saved : 'parchment';
  apply(start);

  document.querySelectorAll('.sw[data-theme]').forEach(function (b) {
    b.addEventListener('click', function () { var id = b.getAttribute('data-theme'); apply(id); remember(id); });
  });
})();
