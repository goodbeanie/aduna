# Aduna desktop app

A Windows app that opens https://aduna.onrender.com/app in its own window. That is all it does: all secrets and
settings stay on the server, and nothing sensitive is stored in the app. Website updates show up in the app automatically.
If there is no connection it shows a small page and keeps retrying.

To point it at a different server, change `ORIGIN` at the top of `main.js`.

## Building the installer
- On GitHub (recommended): push this project, then Actions > "Build desktop app" > Run workflow, and download `Aduna-Setup`
  (it downloads as a zip; unzip it to get the .exe).
- On a Windows PC: double-click `build-installer.bat` (installs the build tools, builds, and opens `desktop/dist/`). Needs Node.js from nodejs.org.

## Updates (like Discord)
The installed app checks for updates 10 seconds after it opens and every 30 minutes. A new version downloads in the
background, then a small popup appears in the bottom-right corner of the window: "Restart & update" installs it now, "Later"
installs it automatically the next time Aduna is closed. Aduna menu > "Check for updates…" checks on demand.

To release an update:
1. Raise `"version"` in `desktop/package.json` (for example 1.1.0 to 1.1.1). Updates are only offered when the number goes up.
2. Run `build-installer.bat`. It copies the small `latest.yml` into `client/public/updates/`.
3. Upload the new `Aduna-Setup-x.y.z.exe` and its `.blockmap` (both in `desktop/dist/`) to your public R2 "downloads" bucket.
4. Commit and deploy the site. Installed apps read the update list from https://aduna.onrender.com/updates/latest.yml and
   download the installer from R2.

The installer lives in a separate public R2 bucket, never the bucket that holds user uploads. Set `DOWNLOAD_BASE_URL` on Render
to that bucket's public address. If it is not set, the site serves the installer from `client/public/updates/` instead.

Only versions 1.1.0 and newer can update themselves, so anyone on an older install needs to install once by hand.

## Notes
- The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC": More info > Run anyway.
  Removing the warning needs a paid code-signing certificate.
- Calls use the microphone/camera and mentions use notifications; both are allowed only for aduna.onrender.com.
- Links to other websites open in the normal browser.
