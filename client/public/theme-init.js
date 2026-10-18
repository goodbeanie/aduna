// Apply the saved theme before first paint so dark themes don't flash light.
try {
  var c = JSON.parse(localStorage.getItem('aduna-theme-vars') || 'null');
  if (c) {
    var r = document.documentElement;
    for (var k in c.vars) r.style.setProperty(k, c.vars[k]);
    r.style.colorScheme = c.scheme;
    if (c.meta) document.querySelector('meta[name="theme-color"]').setAttribute('content', c.meta);
  }
} catch (e) {}
