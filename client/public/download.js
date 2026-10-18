// Download page: on a Windows PC the installer starts by itself; on other devices we show how to use Aduna there instead.
(function () {
  var isWindowsPC = /Windows NT/.test(navigator.userAgent) && !/Mobile/.test(navigator.userAgent);
  if (!isWindowsPC) {
    document.getElementById('win').className = 'hide';
    document.getElementById('other').style.display = 'block';
    return;
  }
  setTimeout(function () { window.location.href = '/download/file'; }, 900);
})();
