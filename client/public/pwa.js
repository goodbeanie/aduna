// Registers the service worker and powers the "Download Aduna" button.
// Windows PCs download the installer (/download). Other devices install Aduna as a web app instead.
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', function () { deferred = null; if (document.querySelector('a.dl')) toast('Aduna is installed. Find it in your Start menu or apps list.'); });

  var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var btns = document.querySelectorAll('a.dl');
  if (!btns.length) return;

  if (standalone) {
    btns.forEach(function (b) { b.textContent = 'Open Aduna'; b.setAttribute('href', '/app'); });
    return;
  }

  function toast(msg) {
    var t = document.getElementById('pwa-toast');
    if (!t) { t = document.createElement('div'); t.id = 'pwa-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.className = 'show';
    clearTimeout(toast.h); toast.h = setTimeout(function () { t.className = ''; }, 9000);
  }

  var isWindowsPC = /Windows NT/.test(navigator.userAgent) && !/Mobile/.test(navigator.userAgent);
  if (isWindowsPC) return; // the link itself downloads the installer

  btns.forEach(function (b) {
    b.removeAttribute('download');
    b.addEventListener('click', function (e) {
      e.preventDefault();
      if (deferred) {
        var p = deferred; deferred = null;
        p.prompt();
        return;
      }
      var ua = navigator.userAgent;
      if (/iPhone|iPad|iPod/.test(ua)) toast('To install: tap the Share button, then "Add to Home Screen".');
      else if (/Firefox\//.test(ua)) toast('Firefox can\'t install web apps. Open Aduna in Chrome or Edge to install it, or just use it in your browser.');
      else if (/Chrome\/|Edg\//.test(ua)) toast('To install: click the install icon at the right of the address bar, or open the browser menu and choose "Install Aduna".');
      else toast('Open Aduna in Chrome or Edge to install it as an app, or just use it in your browser.');
    });
  });
})();
