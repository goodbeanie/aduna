# Reference

Operational details that don't fit in the README. Each section says where the code is.

## Calls and TURN

Direct calls are one-to-one, between friends who are both online, one call at a time per person. Unanswered calls stop ringing after 45 seconds (`CALL_RING_MS`). The server rings, tracks who is on a call and relays signalling. In DMs the offer, answer and ICE candidates are encrypted in the browser with the conversation key. Audio and video go directly between the two browsers, encrypted by WebRTC (DTLS-SRTP). Both people can see each other's IP address, as in any peer-to-peer call. Camera and microphone need HTTPS or localhost.

Voice channels use a WebRTC mesh (up to 8 people). Their signalling is not encrypted, so the server can read the connection setup but never the audio.

Without a TURN relay, calls fail between some networks (strict NATs, many mobile carriers, school and office firewalls). Set up one of these, checked in this order. `GET /api/call/config` returns the result to signed-in users, with `relay: true` when a relay is configured.

1. **Cloudflare Realtime TURN.** Create a key in the Cloudflare dashboard under Realtime > TURN Server. Set `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`. The server mints short-lived credentials and caches them. The token never reaches the browser.
2. **Your own coturn.** Run it with `use-auth-secret`, then set `TURN_URLS` (comma separated, for example `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp`) and `TURN_SECRET`. Credentials are generated per user and expire.
3. **A fixed login** (Metered, Twilio static and similar): `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.
4. **Raw JSON:** `ICE_SERVERS='[{"urls":"turn:...","username":"..","credential":".."}]'`.

`TURN_TTL_SECONDS` (default 86400) is how long credentials last. Keep it longer than your longest call, because TURN rechecks the login while a call runs. If the connection breaks (Wi-Fi to mobile, a short outage), calls and voice wait a few seconds, ask for fresh credentials and look for a new route, up to 3 times. To test, call between two devices on different networks and look for a `relay` candidate pair in `chrome://webrtc-internals`.

## Cloudflare R2 for images and files (optional)

Profile pictures, banners, custom emoji and attachments can live in an R2 bucket so the Postgres database stays small. The server still encrypts everything (same AES-256-GCM key) before upload, so R2 holds only ciphertext, and files are only served through the app's access checks. Postgres keeps a small index row per file.

1. Create a private R2 bucket. Don't enable public access.
2. Create an API token with Object Read & Write, limited to that bucket. Note the Access Key ID, Secret Access Key and your Account ID.
3. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`, then redeploy.

The app counts the bytes it keeps in R2 and refuses new uploads (HTTP 507) once the total would pass `STORAGE_LIMIT_GB` (default 9, to stay inside R2's 10 GB free tier). Deleting files, replacing pictures and attachment expiry free room again. Only what Aduna uploaded is counted. Files uploaded before you switched R2 on stay in Postgres and keep working. Deleting a picture, a message or an expired attachment also deletes its R2 object.

## Images and attachments

**Profile pictures and banners.** The browser crops to 500×500 (pictures) or 1200×300 (banners), re-encodes as WebP and strips metadata such as EXIF and GPS location. The server doesn't trust that: it checks the real file signature and pixel size, accepts only PNG, JPEG and WebP (no SVG), and limits uploads to 1 MB and 10 a minute per user. Animated profile pictures and banners are cut to size on the server with ffmpeg. Images are served from `/api/images/<random id>` with `nosniff`. The id is 128 random bits and is only handed out by the logged-in API, but anyone with the exact URL can view the image, like any profile picture. Replacing a picture deletes the old file, and unreferenced images are cleaned up at startup.

**Attachments.** Files are uploaded first as raw bytes, then referenced by id when the message is sent. Unsent uploads are discarded after an hour, and deleting a message deletes its files. In DMs and groups the browser encrypts the bytes, and the file name, type and size, with the conversation key before upload. In channels the server can read files, like channel text.

Files are served only to people who can see the conversation, always as `application/octet-stream` with `nosniff`. The browser decides how to show a file from the type recorded in the message, only for a short allowlist (PNG, JPEG, WebP, GIF, AVIF, MP4/WebM, common audio). Everything else is a download. SVG and HTML are never rendered.

Limits: 20 MB per file, 20 uploads a minute per user. Files over 10 MB are deleted after 5 days and smaller ones after 14, checked at startup and hourly (`ATTACHMENT_TTL_DAYS`, `LARGE_ATTACHMENT_TTL_DAYS`, `LARGE_ATTACHMENT_MB`). The message stays and shows an "expired" note. There is no per-user quota for people on the free plan beyond the storage rules in `server/storage-budget.js`.

GIFs from the picker aren't downloaded by the server. The message stores the GIPHY link and each viewer's browser loads it from GIPHY, which can see their IP. Only `*.giphy.com` links are accepted.

## Accounts and sign-in

- Sign-up needs a unique email address (`name+tag@` and Gmail dots count as the same mailbox), refuses common, repetitive or username-containing passwords, and allows at most 10 new accounts per IP per hour.
- Login lockout: 5 wrong passwords for one username from one address lock that pair for 15 minutes. 25 from anywhere lock the username for 15 minutes. The downside is that someone can annoy a user by spamming their name. A wrong username takes as long to answer as a wrong password.
- Sessions are an httpOnly cookie. They can be revoked (log out everywhere, change password). Two-factor login with an authenticator app is optional, and passkeys are supported.
- Email verification needs one of the email settings in the README. New accounts, and accounts that change their email, enter a 6-digit code (15 minute expiry, 5 tries, 60 second resend cooldown, 5 emails an hour). With no email provider set, verification is off.
- Password reset by email link: if a person turned on email recovery, "Forgot your password?" sends a single-use link valid for 30 minutes to the address on the account. An email can't bring back the old encryption key, so this creates a new one and older DMs become unreadable. People with their recovery key should use that instead, which keeps their messages. Set `PUBLIC_URL` so the link points at your site.

## Credits

Credits are the in-app currency. Each person's balance is private to them.

**Spending.** The Credits page has a shop. Catalogue and prices are `ITEMS` at the top of `server/shop.js`. Prices come from the server (`POST /api/credits/shop/:id/buy` takes only an item id, never an amount). Each item is bought once, and the credits are taken and the item handed over in a single step, so a double click can't charge twice. A balance below zero (after a refund) can't shop. Tests: `server/shop-test.js`.

**Earning.** The numbers are in `EARN` at the top of `server/credits.js`.
- A message in a server text channel earns 2 credits, up to 40 a day (resets 00:00 UTC). It only counts if it was typed (the browser reports key presses versus paste), reads like a real sentence, differs from your last 20 messages and from text any other account sent in the last hour, comes at least 45 seconds after your last rewarded message, is in a server with 3 or more members, and someone else spoke in that channel in the last 30 minutes. Accounts under 30 minutes old earn nothing. DMs never earn, because the server can't read them.
- Quests: daily (check-in with a streak bonus, have a conversation, react to 3 messages) and one-time (profile picture, bio, first friend, join a second server, create a server, upload an emoji, first rewarded message). Progress is read from real data on the server and each reward is claimed once.

The typing check comes from the browser, so a determined person with a script can fake it. The daily cap, cooldown, similarity rules and account age are what limit the damage. One-time quests can still be farmed with many accounts.

**Stripe.** Pressing a pack sends the buyer to Stripe Checkout (a page hosted by Stripe), so card details never touch Aduna. Packs are `PACKS` in `server/credits.js`, each with a fixed price in USD (`cents`) and CAD (`cadCents`); Canada pays in CAD and the US in USD, and the prices already include Stripe's fee, so checkout adds no fee line. The server picks the pack's price and the buyer's currency; the browser never sends an amount. Credits are added only by Stripe's signed webhook (never by the buyer returning to the site), once per checkout session, and only when the amount paid matches the pack's price. A full refund or a dispute takes the credits back; partial refunds are ignored.

The $4.99/month storage plan uses Stripe Billing (a subscription Checkout session). Aduna keeps only Stripe's customer and subscription ids. Renewals, failed payments and cancellations arrive as signed events, and people update their card or cancel in Stripe's customer portal.

To set it up:
1. In the Stripe dashboard, copy your secret key into `STRIPE_SECRET_KEY`. Start with a test-mode key.
2. Add a webhook endpoint at `https://<your site>/api/credits/webhook` listening for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` and `customer.subscription.deleted`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Turn on the customer portal (Settings > Billing > Customer portal) so people can update their card and cancel.
4. Buy a pack and subscribe with Stripe's test card `4242 4242 4242 4242` and check the credits and plan arrive.
5. For real money, repeat steps 1 and 2 with live-mode keys.

If your Stripe account has Managed Payments on, Aduna opts each session out of it (it needs tax codes on products). Set `STRIPE_MANAGED_PAYMENTS=on` only after adding tax codes.

`node server/stripe-test.js` and `node server/storage-stripe-test.js` check all of this against a fake Stripe. Only a test-mode purchase proves your own Stripe settings.

**Sales tax.** `TAX_COLLECT_IN` lists where Aduna adds tax to Stripe purchases, for example `CA-BC=12,CA-ON,GB`. Use country codes (`GB`), Canadian provinces (`CA-ON`, or `CA` for all), US states (`US-WA`) or `EU`. `=rate` sets the percent yourself. Built-in rates are standard digital-goods rates and change over time, so confirm them with an accountant. Only list places you are registered to collect tax in.

## Bots

Anyone can turn on a developer account in Settings > Developer and make up to 5 bots. A bot is the body of a JavaScript function that receives `bot`. It starts private. A description makes it eligible to be public, and public bots appear in the Explorer. Someone with Manage server adds a bot and chooses which text channels it may use.

**Sandbox.** Bot code never runs on the main thread. Each event runs in a fresh QuickJS (WebAssembly) sandbox in a worker thread, with 16 MB of memory and about 100 ms, and is killed if it hangs. Inside there is no file access, no `process`, no direct internet and no console. The only way out is a list of requests (messages, reactions, saved data, timers, web requests) that the server re-checks before acting. A bot can only act in the server and channels it was added to, can only ping the person it is answering, and never `@everyone`. Per bot in each server: 30 events, 20 messages, 30 reactions and 10 web requests a minute, 3 seconds of sandbox time a minute, and a pause after 3 timeouts in a row.

| Call | What it does |
| --- | --- |
| `bot.on(event, fn)` | Events: `message`, `messageEdit`, `reactionAdd`, `memberJoin`, `memberLeave`, `install`, `timer`, `fetch`, `webhook`. Bots never receive other bots' messages. |
| `bot.reply`, `bot.send`, `bot.react`, `bot.log` | Up to 5 messages, 5 reactions and 20 log lines per event. |
| `bot.store.get / set / incr / delete / keys` | Saved data for this bot in this server: 64 keys, 4 KB a value, 32 KB total. It is stored on the server, so keep secrets out of it. |
| `bot.timer.after / every / daily / cancel / list` | 10 timers per bot per server. `after` from 5 s, `every` from 60 s, up to 30 days. `daily` takes `'HH:MM'` and a time zone. |
| `bot.fetch(url, name)` | GET only, https only, JSON or text, hosts from `BOT_FETCH_HOSTS`, private addresses refused, 5 s timeout, 200 KB read. The answer arrives as a `fetch` event. |

The Developer page has a chat simulator that runs each step in the real sandbox (`POST /api/developer/test`, 30 a minute). Nothing is posted or requested for real.

**Prefix and commands.** Each bot has a prefix (default `/`, up to 3 characters) and a list of up to 25 commands, each a name plus a one-line description. When a message starts with the prefix, the chat box lists the commands of the bots installed in that server (only those allowed to read the channel), filtered as you type, with the bot's name beside each. Pick with the mouse, Tab or Enter; picking only inserts the text (`/roll `). The bot does its own parsing in `bot.on('message')`. Public bots have their command text checked like the description. Code: `client/src/BotCommands.jsx`, the editor in `client/src/Bots.jsx`.

Code: `server/bots.js`, `server/sandbox-core.js`, `server/sandbox.js`, `server/botrun.js`, `server/botstate.js`, `server/botfetch.js`, `server/bothost.js`, `client/src/Bots.jsx`, `client/src/BotCommands.jsx`, `client/src/BotSim.jsx`. Each has a `*-test.js`. The ones that need no database are `bots-logic`, `botstate`, `botfetch`, `botrun`, `sandbox` and `bothost`.

## Webhooks

A webhook is a secret address another service posts to. Someone with Manage server makes one in Server settings > Webhooks and chooses where its data goes: a text channel, one of the server's bots, or both (the bot wins, and the channel is used if the bot is removed). A server can have 10.

- **Address:** `/api/hooks/<server id>/<webhook id>/<token>`. The token is 256 random bits, shown once. Only its hash is stored. Renewing gives a new address and the old one stops working at once. Every wrong address gets the same `404`, and 30 wrong ones in a minute from one visitor get `429`.
- **Generic:** POST JSON like `{"content": "Deploy finished"}` (`text` and `message` also work). `@everyone`, mentions and sticker tokens are defused. A webhook that feeds a bot accepts any JSON object, up to 30 KB, and the bot gets it as `e.json`.
- **GitHub:** paste the payload URL and the secret Aduna shows into the repository's webhook settings with content type `application/json`. Aduna checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body) and turns push, pull request, review, issue, comment, release, star, fork and workflow run events into short messages. Other events are accepted and ignored. A repeated delivery id is posted once.
- **Limits:** 30 deliveries a minute per webhook, 512 KB a body, 30 changes an hour per person.
- **Safety:** titles, commit messages and branch names lose control and text-direction characters, get Markdown and mention tokens escaped, and are length-capped. Links are shown only for https addresses.

Code: `server/webhooks.js`, the webhooks block in `server/index.js`, `client/src/Webhooks.jsx`. Tests: `webhooks-test.js` (no Postgres needed) and `webhooks-flow-test.js` (needs Postgres and the bot sandbox).

## Themes, emoji and other client pieces

- **Themes.** Parchment is the default, with five light and five dark themes, "match my device", and a custom theme (a light or dark base plus a background and accent colour; the app builds the rest). The choice is kept in `localStorage`. A server owner can give a server a theme, and the app fades to it while you are on that server. This can be turned off under Appearance. The logic is in `client/src/themes.js` and the picker is `client/src/Appearance.jsx`.
- **Theme gallery.** Anyone can publish a theme. Because a theme is only a base and two colours, it can't carry CSS, pictures or links. Rules are in `server/themegallery.js`: text must stay readable, names and descriptions are filtered, 20 themes per person and 6 an hour, and a theme is hidden after 3 reports from accounts older than a day.
- **Emoji picker.** Full Unicode set with search, categories and skin tones, plus custom emoji. The data is generated from `emojibase-data` into `client/src/emoji-data.json`. Regenerate it with `npm --prefix client run emoji-data` after upgrading that package.
- **Custom emoji.** Uploads are checked for type, size, shape and name, and duplicates are detected. Three reports switch an emoji off for everyone.
- **Polls and call history.** Polls in text channels (up to 10 answers, optional time limit, single or multiple choice). Finished calls show as a line in the DM.

## Installable app and Android

Aduna is an installable web app (`client/public/manifest.webmanifest`, `sw.js`, `pwa.js`). `sw.js` caches nothing. The Windows installer in `desktop/` is unsigned, so Windows warns about it.

`mobile/` builds an Android app (a Capacitor shell around the live site) with native Firebase push notifications. Setup and publishing are in `mobile/README.md`. Server side: `server/fcm.js` and the `POST /api/push/fcm` route. Client side: the native branch of `client/src/notify.js`.
