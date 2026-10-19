// Download page: a Windows PC gets the installer, an Android phone gets the APK; other devices see how to use Aduna there instead.
(function () {
  var ua = navigator.userAgent;
  var isAndroid = /Android/.test(ua);
  var isWindowsPC = /Windows NT/.test(ua) && !/Mobile/.test(ua);
  if (isAndroid) {
    document.getElementById('win').className = 'hide';
    document.getElementById('android').className = '';
    setTimeout(function () { window.location.href = '/download/android'; }, 900);
    return;
  }
  if (!isWindowsPC) {
    document.getElementById('win').className = 'hide';
    document.getElementById('other').style.display = 'block';
    return;
  }
  setTimeout(function () { window.location.href = '/download/file'; }, 900);
})();
