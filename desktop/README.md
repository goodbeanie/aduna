# Aduna desktop app

A Windows app that opens https://aduna.onrender.com/app in its own window. That is all it does: all secrets and
settings stay on the server, and nothing sensitive is stored in the app. Website updates show up in the app automatically.
If there is no connection it shows a small page and keeps retrying.

To point it at a different server, change `ORIGIN` at the top of `main.js`.

## Building the installer
- On GitHub (recommended): push this project, then Actions > "Build desktop app" > Run workflow, and download `Aduna-Setup`
  (it downloads as a zip; unzip it to get the .exe).
- On a Windows PC: `cd desktop && npm install && npm run dist` (output in `desktop/dist/`).

## Notes
- The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC": More info > Run anyway.
  Removing the warning needs a paid code-signing certificate.
- Calls use the microphone/camera and mentions use notifications; both are allowed only for aduna.onrender.com.
- Links to other websites open in the normal browser.
