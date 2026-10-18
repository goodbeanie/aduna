# Aduna desktop app

A Windows app that opens https://aduna.onrender.com/app in its own window. That is all it does: all secrets and
settings stay on the server, and nothing sensitive is stored in the app. Website updates show up in the app automatically.
If there is no connection it shows a small page and keeps retrying.

To point it at a different server, change `ORIGIN` at the top of `main.js`.

## Building the installer
- On GitHub (recommended): push this project, then Actions > "Build desktop app" > Run workflow, and download `Aduna-Setup`
  (it downloads as a zip; unzip it to get the .exe).
- On a Windows PC: double-click `build-installer.bat` (installs the build tools, builds, and opens `desktop/dist/`). Needs Node.js from nodejs.org.

## Running in the background + notifications
Closing the window (the X) hides Aduna to the system tray instead of quitting, so the page stays connected and mentions, DMs, calls,
announcements and friend requests still pop up. Notifications are small cards in the bottom-right corner of the screen, drawn in the
current Aduna theme (including server themes) by `toast.html` in its own transparent always-on-top window; clicking one opens that chat,
the X on a card dismisses it, they fade after 7 s (a ringing call stays until answered), and up to 4 stack. Nothing is shown while the
Aduna window is open and in front. If that window ever fails, it falls back to a native Windows notification.

Tray icon: click = open, right-click = Open / Check for updates / Start with Windows / Quit. A fresh install turns on "Start with Windows"
(starts hidden in the tray with `--hidden`), and the tray menu turns it off. Only "Quit Aduna" in the tray (or an update install) really
exits. The first time the window is closed, a card explains that Aduna is still running.

## Window and updates
The window is frameless with its own top bar (`titlebar.html`): logo, a scan-for-updates button, and custom SVG minimize / maximize-restore /
close buttons. The bar reads its colours from the page, so it follows the theme (including server themes) automatically.

Update status shows on the right of the server bar. The app scans 10 seconds after it opens, every 30 minutes (quietly), and when you press the
refresh icon in the top bar or Ctrl+Shift+U:
- "Checking for update..." while scanning
- "No update available" for 10 seconds, then it fades away
- "Update available 1.2.1 [Install]" stays until you act. Install downloads (with a percentage), then restarts into the new version.

To try the chip without a packaged build: `set ADUNA_FAKE_UPDATE=available` (or `none`) and run `npm start`.

To release an update:
1. Raise `"version"` in `desktop/package.json` (for example 1.1.0 to 1.1.1). Updates are only offered when the number goes up.
2. Run `build-installer.bat`. It copies the small `latest.yml` into `client/public/updates/`.
3. Upload the new `Aduna-Setup.exe` and its `Aduna-Setup.exe.blockmap` (both in `desktop/dist/`) to your public R2 "downloads" bucket.
4. Commit and deploy the site. Installed apps read the update list from https://aduna.onrender.com/updates/latest.yml and
   download the installer from R2.

The installer lives in a separate public R2 bucket, never the bucket that holds user uploads. Set `DOWNLOAD_BASE_URL` on Render
to that bucket's public address. If it is not set, the site serves the installer from `client/public/updates/` instead.

The installer is always named `Aduna-Setup.exe` (no version in the name), and `latest.yml` points at that name, so the file in the bucket must have exactly that name. Replace it on every release; if an update ever fails its checksum, the bucket or a CDN is still serving the old copy (purge its cache).

Only versions 1.1.0 and newer can update themselves, so anyone on an older install needs to install once by hand.
The installer config does not change for this feature: `toast.html` and `toast-preload.js` are listed under `build.files` in package.json, so a normal build includes them. Release it as a new version (1.4.0) like any update.

## Notes
- The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC": More info > Run anyway.
  Removing the warning needs a paid code-signing certificate.
- Calls use the microphone/camera and mentions use notifications; both are allowed only for aduna.onrender.com.
- Links to other websites open in the normal browser.
