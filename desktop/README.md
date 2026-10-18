# Aduna desktop app

A Windows app that opens straight to Aduna's login / register screen. It is only a window onto your Aduna server
(the one on Render): all secrets and environment variables (database, Stripe, Brevo, ...) stay on the server, and
nothing sensitive is stored in the app. Updates to the website show up in the app automatically.

## Server address
The app needs your server's address (https://....onrender.com).
- Easiest: leave `config.json` empty. On first launch the app asks for the address and remembers it
  (Aduna menu > "Change server address…" changes it later).
- Or bake it in before building: put it in `config.json` (`{ "url": "https://your-app.onrender.com" }`).

## Building the installer
- On GitHub (recommended): push this project, then Actions > "Build desktop app" > Run workflow, and download `Aduna-Setup`.
  Set a repository variable `ADUNA_URL` first to bake your address in.
- On a Windows PC: `cd desktop && npm install && npm run dist` (output in `desktop/dist/`).

## Notes
- The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC": More info > Run anyway.
  Removing the warning needs a paid code-signing certificate.
- Calls use the microphone/camera and mentions use notifications; both are allowed only for your own server.
- Links to other websites open in the normal browser.
