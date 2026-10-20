// Runs during the build. Stamps the Aduna icon and name onto Aduna.exe (otherwise Windows shows Electron's atom icon).
// Uses rcedit directly so the build doesn't need Windows code-signing tools.
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  const rcedit = path.join(__dirname, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
  const icon = path.join(__dirname, 'build', 'icon.ico');
  const v = ctx.packager.appInfo.version;
  execFileSync(rcedit, [
    exe, '--set-icon', icon,
    '--set-version-string', 'ProductName', 'Aduna',
    '--set-version-string', 'FileDescription', 'Aduna',
    '--set-version-string', 'CompanyName', 'Aduna',
    '--set-version-string', 'OriginalFilename', 'Aduna.exe',
    '--set-file-version', v, '--set-product-version', v,
  ]);
};
