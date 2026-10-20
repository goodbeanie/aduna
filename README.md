# Aduna

*Aduna: to gather.* Brand assets are in `client/public/` (`aduna-icon.png`, `aduna-wordmark.png`).

A Discord-style chat app: servers, channels, direct messages, reactions, replies, profile customization and **end-to-end encrypted DMs**. The server bar runs along the top.

Stack: Node.js, Express, Socket.IO, React (Vite). Data is stored in **PostgreSQL** (built for [Neon](https://neon.tech)), every record encrypted before it is written.

## Run it

Requires Node 18+ and a Postgres database (a free Neon project is fine).

```bash
npm install
npm run build      # installs and builds the React client
export DATABASE_URL='postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require'
export DB_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")   # keep a copy!
npm start          # http://localhost:3000
```

For local development you can skip `DB_ENCRYPTION_KEY`; a key is then created in `data/db.key`. In production it is required.

Open http://localhost:3000, create two accounts in two browsers (or one normal and one private window) and chat.

For development with hot reload: `npm run dev` (client on http://localhost:5173, server on :3000).

Run the automated checks with `TEST_DATABASE_URL=postgres://... npm test` (use a scratch database or a Neon dev branch; each run works in its own temporary schema and drops it, and it never touches `DATABASE_URL`).

## Features

- Accounts need an email address (private, never shown to anyone, pre-fills Stripe receipts), a username and a password; existing accounts can add one in Settings
- Accounts with hashed passwords (bcrypt) and 30-day sessions
- Accounts, servers, channel messages, DMs and friendships stored in Postgres (Neon), every record encrypted at rest (AES-256-GCM)
- Profile pictures and banners: upload a PNG, JPEG, WebP or GIF; it is cropped and resized in the browser, then stored encrypted
- Servers with invite codes, text channels (owner can add channels), member list with live presence
- Real-time messages, typing indicators, unread badges
- Replies and emoji reactions in channels and DMs
- @mentions: type `@` for a member list (arrow keys + Tab/Enter), in channels and DMs. Mentioned people see the message highlighted, a gold `@n` badge on the channel and server, and a desktop notification if the tab is hidden. The server owner can use `@everyone`. In DMs only the highlight shows (the server cannot read DMs, so it cannot notify)
- Edit (shows "(edited)"; press Up in an empty composer to edit your last message) and delete your own messages; server owners can delete any channel message. DM edits are re-encrypted in the browser
- Images, videos, audio and any other file (up to 20 MB, 4 per message; files over 10 MB are deleted 5 days after upload, smaller ones after 14, and the message shows an "expired" note) in channels and DMs: attach button, drag and drop, or paste. Images open in a viewer; other files download. Uploaded GIFs keep animating
- GIF search: the GIF button is always in the composer. Set `GIPHY_API_KEY` (free at developers.giphy.com) and it opens a searchable, endlessly scrolling GIF library (trending by default); without a key it explains how to set one up. The server proxies the search so the key never reaches the browser.
- Custom emoji: upload your own (checked for type, size, shape and name, duplicates detected), click anyone's emoji to save or report it, type `:name:` with autocomplete, use them in reactions. Three reports switch an emoji off for everyone
- Emoji picker in the composer, clickable links in messages
- Voice and video calls between friends (phone and camera buttons in a DM): ringing, accept or decline, mute, camera on/off, screen share, in-call timer. Media goes peer to peer (WebRTC); the signalling is encrypted with the DM key
- Server settings (owner: open the server name > Server settings): name, icon, banner and a server theme. The icon shows on the server bar, the banner sits at the top of the channel list, and the app fades to the server's theme while you are on that server. Members can turn server themes off in Appearance
- Friend requests (send by username, accept, decline, cancel) and a Friends page
- Direct messages between friends, end-to-end encrypted
- Profile customization: display name, bio, emoji avatar, avatar/banner/name colors, status (online, idle, do not disturb, invisible)
- Credits: a currency you buy with real money (Stripe) or earn by chatting and finishing quests. See "Credits" below

New accounts automatically join the official Aduna server (see `DEFAULT_SERVER_INVITE`); if it doesn't exist they start in their DMs and can create a server or join one with an invite code.

## How the encryption works

- At sign-up the browser generates an ECDH P-256 keypair. The public key goes to the server.
- Each conversation uses an AES-256-GCM key both people derive independently from their own private key and the other's public key. The server stores only ciphertext and a random IV.
- Your private key is locked with a key derived from your password (PBKDF2, 250k iterations) and the locked copy is stored on the server so you can sign in on another device. The server cannot open it without your password. In the browser the unlocked key is kept as a non-extractable key in IndexedDB.
- The lock button in a DM shows a **safety number**. Compare it with the other person over a call to be sure nobody swapped keys.

### What is and isn't protected

- Channel messages are **not** end-to-end encrypted. The server can read them, like Discord.
- In DMs the server can still see who talked to whom, when, and which emoji were used for reactions. It cannot see message text.
- **There is no password reset.** If you forget your password your encrypted history is gone for good.
- If someone gets your password they can unlock your key. Use a strong, unique one.
- Encryption needs a secure browser context: `http://localhost` or HTTPS. Opening the app over plain HTTP from another machine on your network will not work.

## Database and encryption at rest

Everything lives in Postgres (tables `users`, `servers`, `messages`, `dms`, `friendships`, `emojis`, `payments`, `images`, `files`, `meta`). Each record is encrypted with **AES-256-GCM** by the server *before* it is sent to the database, and the table and row id are bound into the ciphertext so rows can't be swapped around. Neon only ever stores ciphertext. Passwords are never stored: only a **bcrypt hash**, which is itself inside an encrypted record.

Environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon connection string (Neon dashboard > Connect). |
| `DB_ENCRYPTION_KEY` | yes in production | 64 hex characters. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `JWT_SECRET` | no | Session signing secret. If unset, a random one is created and stored (encrypted) in the database, so logins survive restarts. |
| `DOWNLOAD_BASE_URL` | no | Public address of a separate public R2 bucket holding the Windows installer. The home page's Download button and the desktop app's updates use it. |
| `FCM_SERVICE_ACCOUNT` | no | Firebase service-account JSON (or its base64): lets the server send push notifications to the Android app. See `mobile/README.md`. |
| `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | no | Keep images and attachments in a Cloudflare R2 bucket instead of Postgres (see below). Set all four or none. |
| `STORAGE_LIMIT_GB` | no | With R2: refuse new uploads once this many GB are stored (default **9**, to stay inside R2's 10 GB free tier; `0` = no limit). |
| `GIPHY_API_KEY` | no | GIF search. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | Buying credits with real money (see Credits). Set both or neither; without them the Buy buttons are disabled. |
| `PUBLIC_URL` | no | Your site's address (e.g. `https://aduna.onrender.com`), used for the links Stripe sends people back to. Defaults to the address of the request. |
| `CSP_MODE` | no | `enforce` (default), `report-only` (the browser only logs policy violations: use this if a page ever looks broken after an update) or `off`. |
| `SIGNUPS_PER_HOUR` | no | New accounts allowed per IP address per hour (default 10). |
| `STRIPE_MANAGED_PAYMENTS` | no | Set to `on` only if you want Stripe's Managed Payments (Stripe handles sales tax). Aduna opts out of it per checkout by default because Managed Payments needs a tax code on every product, which Aduna does not send. |
| `DEFAULT_SERVER_INVITE` | no | Invite code of the server every new account joins automatically at sign-up (default `aduna`; falls back to a server named "Aduna"). Set to `off` to disable. |
| `ATTACHMENT_TTL_DAYS` | no | Days to keep attachments of 10 MB or less (default 14). |
| `LARGE_ATTACHMENT_TTL_DAYS` | no | Days to keep attachments over `LARGE_ATTACHMENT_MB` (default 5). |
| `LARGE_ATTACHMENT_MB` | no | The size, in MB, above which the shorter expiry applies (default 10). |

**Back up `DB_ENCRYPTION_KEY`.** Without it nothing in the database can be read, and the server refuses to start if the key doesn't match the data (it will not quietly start a fresh, empty database).

How this layers with E2EE: DMs are encrypted in the browser first, then encrypted again by the server when stored. Channel messages are readable by the server (it holds the key), but not by anyone who only gets hold of the database or a backup of it, including Neon staff.

Limits: the whole dataset is held in memory and written through on change, so **run a single instance** (one Render web service, no scaling out). Neon's free tier is 0.5 GB, which is why attachments expire. There is no key rotation yet. The old `data/db.json` import was removed.

## Deploy: GitHub + Render + Neon

1. **Neon**: create a project at neon.tech, then copy the connection string (Connect > pooled or direct both work).
2. **GitHub**: push this folder to a repository. `.gitignore` already excludes `node_modules`, `client/dist`, `data` and `.env`.
3. **Render**: New > Blueprint, pick the repo (it reads `render.yaml`), or New > Web Service with build command `npm install && npm run build`, start command `npm start`, health check path `/healthz`.
4. In the service's Environment tab set `DATABASE_URL` and `DB_ENCRYPTION_KEY` (and `NODE_ENV=production`, already in the blueprint).
5. Deploy. Render's free tier sleeps after inactivity (first request takes about a minute to wake), which also drops live sockets; the data is safe in Neon. Neon's free compute also pauses when idle and wakes on the first query.

Calls and voice: add a TURN relay, otherwise they fail between some networks. See **Calls: TURN relay** below.

## Calls: TURN relay
Set up ONE of these on the server (checked in this order). `GET /api/call/config` returns the result to signed-in users; the response has `relay: true` when a relay is configured.

1. **Cloudflare Realtime TURN (easiest, and you already use Cloudflare for R2).** Cloudflare dashboard > Realtime > TURN Server > create a key. Set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` (the token is shown once). The server mints short-lived credentials from it and caches them; the token never reaches the browser.
2. **Your own coturn.** Run coturn with `use-auth-secret` and `static-auth-secret=<secret>`, then set `TURN_URLS` (comma separated, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp`) and `TURN_SECRET`. Credentials are generated per user and expire.
3. **A fixed login** (Metered, Twilio static, etc.): `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
4. **Raw JSON** (the old setting): `ICE_SERVERS='[{"urls":"turn:...","username":"..","credential":".."}]'`.

`TURN_TTL_SECONDS` (default 86400) is how long credentials last; keep it longer than your longest call, because TURN rechecks the login while a call is running. In production the server logs a warning once if no relay is set up.

How a dropped connection is handled: if the path breaks (Wi-Fi to mobile, a short outage) both calls and voice wait a few seconds, then ask for fresh credentials and look for a new route (an ICE restart), up to 3 times, before giving up. If a call cannot connect and no relay is configured, the message says so.

To check it works: open a call between two devices on different networks (one on mobile data). In Chrome, `chrome://webrtc-internals` shows a `relay` candidate pair when TURN was needed.

## Cloudflare R2 for images and files (optional)

Profile pictures, banners, custom emoji and message attachments can be kept in a Cloudflare R2 bucket so your Neon database stays small. Everything is still encrypted by the server (AES-256-GCM, same key) before it is uploaded, so R2 only holds ciphertext, and files are still served only through the app's access checks. Postgres keeps a small index row for each file. R2's free tier is 10 GB with free downloads; after that about $0.015 per GB per month.

Set up:

1. Cloudflare dashboard > **R2 Object Storage** > create a bucket (any name, keep it private; do not enable public access). R2 asks for a payment card on file even for the free tier.
2. **R2 > Manage API tokens > Create API token**, permission *Object Read & Write*, limited to that bucket. Copy the **Access Key ID** and **Secret Access Key**. Your **Account ID** is on the R2 overview page.
3. In Render's Environment tab add `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`, then redeploy.

**Storage limit:** the app counts the bytes it keeps in R2 and refuses new uploads (HTTP 507, "Uploads are paused: the storage limit has been reached") once the total would pass `STORAGE_LIMIT_GB` (9 by default). Deleting files, replacing pictures and attachment expiry free room again. The limit only counts what Aduna uploaded; anything else you put in the bucket is not included.

Pictures and files uploaded before you switch R2 on stay in Postgres and keep working. Only new uploads go to R2. Deleting a picture, deleting a message or an attachment expiring also deletes its R2 object.

## Profile pictures and banners

In **Edit profile**, choose *Upload image* for the profile picture and/or the banner. Changes are previewed live and only saved when you click *Save changes*.

- The browser crops the image to fit (500×500 for pictures, 1200×300 for banners), re-encodes it as WebP (JPEG on browsers that can't), and strips metadata such as EXIF/GPS location. Animated GIFs become still images.
- The server never trusts the browser: it checks the real file signature and pixel dimensions, accepts only PNG, JPEG and WebP (no SVG), and limits uploads to 1 MB and 10 per minute per user.
- Images are stored encrypted (in Postgres, or in R2 if configured) and served from `/api/images/<random id>` with `nosniff` and long-lived caching. The id is random (128 bits) and only shared through the logged-in API, which is what lets them work in plain `<img>` tags. Anyone who has the exact URL can view the image, the same as any profile picture.
- Replacing or removing a picture deletes the old file. Images that no profile points to are cleaned up when the server starts.

## Attachments

- Upload first, then send: files are uploaded as raw bytes and referenced by id when the message is sent. Unsent uploads are discarded after an hour; deleting a message deletes its files.
- **DM files are end-to-end encrypted.** The browser encrypts the bytes (and the file name, type and size inside the message) with the conversation key before upload, so the server only holds ciphertext. In channels the server can read files, like channel text.
- Files are served only to people who can see the conversation, always as `application/octet-stream` with `nosniff`. The browser decides how to show a file from the type recorded in the message, only for a short allowlist (PNG, JPEG, WebP, GIF, AVIF, MP4/WebM, common audio). Everything else is a download. SVG and HTML are never rendered.
- Limits: 20 MB per file, 20 uploads per minute per user. Attachments are deleted automatically (checked at startup and every hour): files over 10 MB after 5 days, smaller ones after 14 days. Change this with `ATTACHMENT_TTL_DAYS` (default 14), `LARGE_ATTACHMENT_TTL_DAYS` (default 5) and `LARGE_ATTACHMENT_MB` (default 10). The message stays, and shows an "expired" placeholder where the file was. There is no per-user storage quota yet.
- GIFs from the picker are not downloaded by the server: the message stores the GIPHY link, and each viewer's browser loads it from GIPHY (which can see their IP). Only `*.giphy.com` links are accepted.

## Calls

- 1:1 only, between friends, who must both be online. One call at a time per person. Unanswered calls stop ringing after 45 s (`CALL_RING_MS`).
- The server rings, tracks who is on a call and relays signalling. The offer, answer and ICE candidates are encrypted in the browser with the conversation key, so the server cannot read or tamper with them. Audio and video go directly between the two browsers, encrypted by WebRTC (DTLS-SRTP).
- The browsers find each other with public STUN servers. **Without a TURN relay, calls and voice channels fail between some networks** (strict NATs, many mobile carriers, school and office firewalls). See **Calls: TURN relay** below.
- The camera and microphone need https or localhost. Both people see each other's IP address, as in any peer-to-peer call.
- Not built yet: group and voice-channel calls, call history messages in the DM, push notifications for calls when the tab is closed.

## Security

- **HTTPS everywhere** on Render, plus `Strict-Transport-Security` so browsers stay on it.
- **Browser protections** on every response (`server/security.js`): a Content-Security-Policy that only runs scripts, styles and fonts from the site itself (images and media also from GIPHY, `blob:` and `data:` for previews), no framing of the site (clickjacking), `nosniff`, a strict referrer policy, and camera/microphone/screen share limited to the site (calls need them). The two small scripts the pages used to inline now live in `client/public/theme-init.js` and `landing.js` for this reason. This is what stops an injected script from running, which matters because the login token is kept in the browser's localStorage.
- **Login lockout:** 5 wrong passwords for one username from one address lock that pair for 15 minutes; 25 from anywhere lock the username for 15 minutes (so guessing spread across many addresses fails; the cost is that someone can annoy a user by spamming their name from many addresses). A wrong username takes as long to answer as a wrong password.
- **Sign-up:** valid email required and unique (`name+tag@` and Gmail dots count as the same mailbox), common, repetitive or username-containing passwords refused, at most 10 new accounts per IP per hour.
- **Privacy of API answers:** `Cache-Control: no-store` on API responses.

Email verification: set `BREVO_API_KEY` + `EMAIL_FROM` (free, 300 emails a day, works on Render's free plan), or `GMAIL_USER` + `GMAIL_APP_PASSWORD` (SMTP: blocked on Render's free plan), or `RESEND_API_KEY` + `EMAIL_FROM` (needs a verified domain) (an address on a domain verified in Resend) and new accounts, and accounts that change their email, must enter a 6-digit code (15 min expiry, 5 tries, 60s resend cooldown, 5 emails/hour) before they can use the app. With none of these set, verification is off. Accounts created before verification existed are asked to verify at their next sign-in (those with no email are asked to add one).

Login is an httpOnly cookie, sessions can be revoked (log out everywhere, change password), two-factor (authenticator app) is optional, a forgotten password can be reset with a recovery key (keeps messages) or, if switched on, with an emailed code (new encryption key: older DMs become unreadable). Not covered: an account with neither a recovery key nor email recovery cannot be recovered; 2FA is not enforced; rate limits assume a single instance; no audit by an outside party. Treat this as a solid base, not a guarantee.

## Credits

Credits are Aduna's currency. Everyone has a balance (private to them) shown in the sidebar and on the **Credits** page, which also lists quests and recent activity. Nothing in the app spends credits yet: the server has `spend()` ready in `server/credits.js` for whatever you add next.

**Earning**

- **Messages**: a message in a server text channel earns 2 credits, up to 40 a day (resets at 00:00 UTC). It only counts if it is typed (the browser reports key presses vs paste/drop; scripted events are ignored), is a real sentence (about 16+ letters and 4+ words; not repeated words, key mashing, emoji, links or mentions only), is different from your last 20 messages (similar wording counts as the same) and from text another account sent in the last hour, comes at least 45 seconds after your last rewarded message, is sent in a server with 3+ members, and someone else has spoken in that channel in the last 30 minutes. Accounts under 30 minutes old earn and claim nothing. Direct messages never earn (the server cannot read them). All of it is checked on the server; every number is in `EARN` at the top of `server/credits.js`.
- **Quests**: daily (check-in with a streak bonus, have a conversation, react to 3 messages) and one-time (profile picture, bio, first friend, join a second server, create a server, upload an emoji, first rewarded message). Progress is read from real data on the server and each reward is claimed once.

**Buying** uses [Stripe Checkout](https://stripe.com/payments/checkout); card details never touch Aduna. Packs are in `PACKS` in `server/credits.js` (price in cents, USD). To switch it on:

1. In Stripe, copy your secret key (use test mode first: `sk_test_...`) into `STRIPE_SECRET_KEY`.
2. Developers > Webhooks > Add endpoint: `https://<your site>/api/credits/webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded` and `charge.dispute.created`. Copy its signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
3. Optionally set `PUBLIC_URL`, redeploy, and try a test purchase with card `4242 4242 4242 4242`.

Credits are added by the signed webhook, never by the browser's return to the site, once per checkout session, and only if the amount paid matches the pack. A full refund or a dispute takes the credits back (the balance can go below zero until it is earned back). Partial refunds are not handled.

**Limits to know about**: the typing check comes from the browser, so a determined person with a script can fake it; the daily cap, cooldown, similarity, account age and conversation rules are what bound the damage (at most 40 credits a day per account from messages; one-time quests are claimable once per account, so many fake accounts can still farm them). Dictation and some swipe keyboards will not earn because they insert whole words without key presses. Counters used by the checks (who spoke in a channel, recently seen messages) live in memory and reset on restart.

## Layout

```
server/index.js        REST API + Socket.IO
server/db.js           encrypted Postgres/Neon persistence (records, images, files)
server/security.js     browser headers, email rules, login lockout, password checks
server/credits.js      credits: balances, earning rules, quests, Stripe checkout + webhook
server/images.js       checks uploaded images (file signature + dimensions)
server/r2-test.js      R2 storage test (uses a local S3 stand-in)
server/smoke-test.js   end-to-end tests (npm test)
render.yaml            Render Blueprint
client/src/crypto.js   all E2EE code
client/src/image.js    resizes and uploads profile pictures
client/src/App.jsx     app state and layout (top server bar)
client/src/Chat.jsx    message list, replies, reactions, composer
client/src/Mentions.jsx  @mention tokens, chips, autocomplete menu
client/src/Attachments.jsx  attachment display, viewer, emoji and GIF pickers
client/src/files.js    upload, download and decrypt helpers
client/src/Modals.jsx  server/DM dialogs, profile editor, safety number
client/src/ServerSettings.jsx  owner-only server name, icon, banner and theme (live preview)
```

## Ideas for next steps

Voice channels (WebRTC), roles and permissions, push notifications, group DMs.


## Emoji picker
The picker (composer and message reactions) has the full Unicode emoji set with search, categories, skin tones and a frequently-used row, plus your custom emoji. The data is generated from the `emojibase-data` package into `client/src/emoji-data.json` and loaded on first open; regenerate with `npm --prefix client run emoji-data` after upgrading that package.

## Themes

Open the palette icon in the sidebar footer to choose an appearance: Parchment (default), five light colour themes, five dark themes, "match my device", or a Custom theme (pick a light/dark base, background and accent; the rest is generated). The choice is stored in `localStorage` on the device. A server owner can also give their server a theme (Server settings > Server theme); while you are on that server the whole app fades to it, and fades back in DMs. Turn that off under *Server themes* in Appearance. The fade works by registering the palette variables with `@property` in `styles.css` and transitioning them on `<html>`; `setServerTheme()` in `themes.js` swaps the palette. Theme logic lives in `client/src/themes.js`; the picker is `client/src/Appearance.jsx`. All colours in `styles.css` are CSS variables, so new themes only need a seed entry in `THEMES`.

## Installing Aduna as an app (no download)
Aduna is an installable web app. In Chrome or Edge the "Download Aduna" button on the home page (or the install icon in the
address bar) installs it with its own window, shortcut and taskbar icon. This goes through the browser, so there is no .exe and
no Windows SmartScreen warning. Files: `client/public/manifest.webmanifest`, `sw.js` (does not cache anything), `pwa.js`, icons.
The separate Windows installer in `desktop/` still works but is unsigned, so Windows warns about it.

## Android app
`mobile/` builds an Android app (Capacitor shell around the live site) with native Firebase push notifications, because Web Push is unreliable on phones. Setup, publishing to Google Play and known limits are in `mobile/README.md`. Server side: `server/fcm.js` (tested by `server/fcm-test.js`), the `POST /api/push/fcm` route and `fcm` flag on `GET /api/push/key`; client side: the native branch of `client/src/notify.js`. After login the app asks for notification permission by itself (`client/src/NotifyPrompt.jsx`).
