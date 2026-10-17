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

- Accounts with hashed passwords (bcrypt) and 30-day sessions
- Accounts, servers, channel messages, DMs and friendships stored in Postgres (Neon), every record encrypted at rest (AES-256-GCM)
- Profile pictures and banners: upload a PNG, JPEG, WebP or GIF; it is cropped and resized in the browser, then stored encrypted
- Servers with invite codes, text channels (owner can add channels), member list with live presence
- Real-time messages, typing indicators, unread badges
- Replies and emoji reactions in channels and DMs
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

There is no default server: a new account starts in your DMs and can create a server or join one with an invite code.

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

Everything lives in Postgres (tables `users`, `servers`, `messages`, `dms`, `friendships`, `emojis`, `images`, `files`, `meta`). Each record is encrypted with **AES-256-GCM** by the server *before* it is sent to the database, and the table and row id are bound into the ciphertext so rows can't be swapped around. Neon only ever stores ciphertext. Passwords are never stored: only a **bcrypt hash**, which is itself inside an encrypted record.

Environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon connection string (Neon dashboard > Connect). |
| `DB_ENCRYPTION_KEY` | yes in production | 64 hex characters. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `JWT_SECRET` | no | Session signing secret. If unset, a random one is created and stored (encrypted) in the database, so logins survive restarts. |
| `R2_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | no | Keep images and attachments in a Cloudflare R2 bucket instead of Postgres (see below). Set all four or none. |
| `STORAGE_LIMIT_GB` | no | With R2: refuse new uploads once this many GB are stored (default **9**, to stay inside R2's 10 GB free tier; `0` = no limit). |
| `GIPHY_API_KEY` | no | GIF search. |
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

Calls: add a TURN server via `ICE_SERVERS` if calls fail between some networks.

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
- By default the browsers use Google's public STUN server to find each other. Set `ICE_SERVERS` to a JSON list (for example `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`) to use your own STUN/TURN. **Without a TURN server, calls fail between some networks** (strict NATs, some mobile and corporate networks). Running coturn is the usual fix.
- The camera and microphone need https or localhost. Both people see each other's IP address, as in any peer-to-peer call.
- Not built yet: group and voice-channel calls, call history messages in the DM, push notifications for calls when the tab is closed.

## Layout

```
server/index.js        REST API + Socket.IO
server/db.js           encrypted Postgres/Neon persistence (records, images, files)
server/images.js       checks uploaded images (file signature + dimensions)
server/r2-test.js      R2 storage test (uses a local S3 stand-in)
server/smoke-test.js   end-to-end tests (npm test)
render.yaml            Render Blueprint
client/src/crypto.js   all E2EE code
client/src/image.js    resizes and uploads profile pictures
client/src/App.jsx     app state and layout (top server bar)
client/src/Chat.jsx    message list, replies, reactions, composer
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
