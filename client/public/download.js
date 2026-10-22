// Download page: works out the visitor's system. A Windows PC gets the installer and an Android phone gets the APK.
// iPhone/iPad, Mac, Linux and Chromebook have no installer yet, so they see how to install Aduna from their browser instead.
(function () {
  var ua = navigator.userAgent;
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  var touch = navigator.maxTouchPoints || 0;
  var os = 'other';
  if (/Android/.test(ua)) os = 'android';                                                       // first: Android's user agent also says Linux
  else if (/iPhone|iPad|iPod/.test(ua) || (/Mac/.test(platform + ua) && touch > 1)) os = 'ios'; // iPadOS pretends to be a Mac, but a Mac has no touch screen
  else if (/CrOS/.test(ua)) os = 'chromeos';                                                    // before Linux: Chromebooks say Linux too
  else if (/Windows NT/.test(ua) && !/Mobile/.test(ua)) os = 'windows';
  else if (/Mac/.test(platform + ua)) os = 'mac';
  else if (/Linux|X11/.test(ua)) os = 'linux';

  var $ = function (id) { return document.getElementById(id); };

  if (os === 'android') {
    $('win').className = 'hide';
    $('android').className = '';
    setTimeout(function () { window.location.href = '/download/android'; }, 900);
    return;
  }
  if (os === 'windows') {
    setTimeout(function () { window.location.href = '/download/file'; }, 900);
    return;
  }

  // everything else: the browser-install page, worded for this system
  var words = {
    ios: ['Aduna on iPhone and iPad', 'There is no App Store app yet. Add Aduna to your home screen and it opens full screen like an app.'],
    mac: ['Aduna on Mac', 'There is no Mac installer yet. Install Aduna from your browser and it gets its own window and a Dock icon.'],
    linux: ['Aduna on Linux', 'There is no Linux installer yet. Install Aduna from your browser and it gets its own window and a launcher icon.'],
    chromeos: ['Aduna on Chromebook', 'Install Aduna from Chrome and it gets its own window and a shelf icon.']
  }[os];
  $('win').className = 'hide';
  $('other').style.display = 'block';
  if (words) {
    $('other-h').textContent = words[0];
    $('other-p').textContent = words[1];
    var steps = document.querySelectorAll('#other [data-os]');
    for (var i = 0; i < steps.length; i++) {
      if ((' ' + steps[i].getAttribute('data-os') + ' ').indexOf(' ' + os + ' ') < 0) steps[i].style.display = 'none';
    }
  }
})();
