// Clip links in chat text. Kept apart from ClipEmbed.jsx (which pulls in the whole Clips player) so the chat can check for clip links
// without loading any Clips code while Clips are switched off (CLIPS_ENABLED in features.js).
const LINK_RE = /https?:\/\/([^\s/<>]+)\/clips\/([a-f0-9]{16})(?![A-Za-z0-9_-])/gi;

// Clip ids in a piece of message text (at most 3), only for links to this site, so each can be drawn as a card.
export function clipIdsIn(text) {
  const out = [];
  if (!text) return out;
  const hosts = new Set([location.host.toLowerCase(), 'aduna.dpdns.org']);
  for (const m of String(text).matchAll(LINK_RE)) {
    if (!hosts.has(m[1].toLowerCase())) continue;
    const id = m[2].toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= 3) break;
  }
  return out;
}

// True when the message is nothing but one clip link: the card says it all, so the bare link is not repeated above it.
export function isOnlyClipLink(text) {
  const t = String(text || '').trim();
  const ids = clipIdsIn(t);
  return ids.length === 1 && t.replace(LINK_RE, '').trim() === '';
}
