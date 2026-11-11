# Aduna

A chat app in the style of Discord: servers with channels, direct messages, group chats, voice and video calls, profiles, bots. DMs and group chats are end-to-end encrypted.

I built it on my own, and I'm publishing the source so anyone can check what it does with their data. Nobody outside the project has audited it. If you read the code and find something wrong, please tell me.

Node.js, Express and Socket.IO on the server, React (Vite) in the browser, Postgres for storage.

The source is visible for reading only. See [LICENSE](LICENSE).

## Using Aduna

- **In the browser:** [aduna.onrender.com](https://aduna.onrender.com). In Chrome or Edge you can also install it as an app from the address bar.
- **Windows and Android:** the installer and the APK are on the [releases page](https://github.com/goodbeanie/aduna/releases). The Windows installer is not code-signed, so Windows may warn you before it runs.

## What it does

- Servers with text channels, roles, invite codes, custom emoji and server themes
- Direct messages, group chats, friends and friend requests
- Replies, reactions, @mentions, polls, edits and deletes
- Images, video, audio and files up to 20 MB, with GIF search
- One-to-one voice and video calls with screen sharing, and voice channels
- Profiles with avatars, banners, bios, statuses and community themes
- Credits you can earn by chatting and finishing quests (or buy), spent on profile badges
- Bots written in JavaScript that run in a sandbox, and webhooks (for example from GitHub) that post into a channel
- English, French and Spanish
- Moderation tools: reports, warnings, mutes and suspensions, and unsafe link protection

## What is private, and what isn't

This is the part most worth checking against the code.

**Encrypted in the browser, so the server can't read it**
- Direct messages and group chats: the text, the files, and the voice and video call setup inside DMs.
- Your private identity key. It is wrapped with a key derived from your password before it leaves the browser.

**The server can read**
- Messages in server channels. They are not end-to-end encrypted, the same as Discord. They are still encrypted at rest (see below).
- Who talks to whom and when in DMs, and which emoji were used for reactions.
- A plain-text preview of each one-to-one DM, up to 140 characters. The sender's app attaches it so the recipient's phone notification can show what was said. It is on by default, and the recipient can turn it off in Settings > Notifications ("Show message text in notifications"). The server doesn't store it, but it does see it and hands it to the push service. Group chats don't send previews.
- Whether a DM carried a GIF or an event phrase. The browser reports this so credits events can count it.
- Signalling for voice channels. Audio itself goes peer to peer and is encrypted by WebRTC, but the setup messages pass through the server in the clear.
- Your email address, username, profile and friend list. Your email is never shown to other people. The only place anyone else sees it is a join application, which admins read if applications are switched on.

**How the DM encryption works** (all of it is in `client/src/crypto.js`)
1. At sign-up the browser makes an ECDH P-256 keypair. The public key goes to the server.
2. For each conversation, both people derive the same AES-256-GCM key from their own private key and the other person's public key. The server stores ciphertext and a random IV.
3. The private key is wrapped with AES-GCM using a key from PBKDF2 (SHA-256, 250,000 iterations) of your password. The wrapped copy is stored on the server so you can sign in on another device. The server can't open it without your password. In the browser the unlocked key is non-extractable.
4. Group chats use a shared AES key that is wrapped separately for each member (`newGroupKey` and `wrapGroupKey` in `crypto.js`, membership handling in `client/src/useGroups.js` and `server/groups.js`).
5. The lock icon in a DM shows a safety number. Compare it with the other person over a call to check that nobody swapped keys.

**Losing access**
- There is a recovery key: 160 random bits shown to you once and never stored by the server, which wraps the identity key a second time. Resetting with it keeps your messages.
- If you turned on email recovery, a reset link creates a new identity key, and older DMs can't be read afterwards.
- With neither a recovery key nor email recovery, a lost password can't be recovered.
- Someone who gets your password can unlock your key. Use a strong, unique one.

**Encryption at rest** (`server/db.js`). Every record is encrypted with AES-256-GCM by the server before it is written to Postgres. The table name and row id are bound into the ciphertext, so rows can't be copied onto each other. Someone with only the database or a backup of it gets ciphertext. The server itself holds the key, so this does not protect channel messages from the server. Passwords are stored as bcrypt hashes inside encrypted records.

**Links in messages.** Every link is checked in the browser, so this also works in encrypted chats (`client/src/linksafe.js`). Lookalike addresses, link shorteners and program downloads are hidden behind a warning, and a blocklist of known bad domains is blocked outright. The server only sees an address if you press "Check with Google" on a suspicious link in a DM, or if the link is in a server channel and the Google Safe Browsing lookup is turned on. Details are in `server/linksafe.js`.

**Browser hardening** (`server/security.js`). A Content-Security-Policy that only allows scripts from the site itself, no framing, `nosniff`, a strict referrer policy, and `no-store` on API responses. Login uses an httpOnly cookie, so scripts on the page can't read it.

**Not done:** no outside audit, no key rotation yet, and two-factor login is optional and not enforced. Treat it as a careful attempt, not a guarantee.

## Where things are

```
server/index.js          REST API and Socket.IO
server/db.js             encrypted persistence (records, images, files)
server/security.js       browser headers, login lockout, password and email rules
server/groups.js         group chats
server/linksafe.js       link blocklist and Safe Browsing lookup
server/moderation.js     warnings, mutes, suspensions, IP bans
server/credits.js        credits and quests
server/bots*.js, sandbox*.js, webhooks.js    bots and webhooks
client/src/crypto.js     all of the end-to-end encryption
client/src/useGroups.js  group key handling in the browser
client/src/linksafe.js   link checks in the browser
client/src/App.jsx       app state and layout
client/src/Chat.jsx      messages and composer
client/src/files.js      attachment upload, download and decryption
desktop/, mobile/        Windows wrapper and Android app (Capacitor)
```

## Contact

Found a bug or a security problem? Open an issue on this repository.

---

© 2026 Nathan VanCaeseele. All rights reserved. See [LICENSE](LICENSE).
