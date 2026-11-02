// Sticker helpers shared by the chat, the picker and the notifications. The rules live in server/stickers.js; this is only the wire format.
// A sticker is a message whose whole text is `<stk:ID>`; ID is the id of the stored picture (32 hex characters), so it loads from /api/images/:id.

const ONLY = /^<stk:([0-9a-f]{32})>$/;

export const STICKER_LABEL = 'Sent a sticker';
export const stickerToken = (id) => `<stk:${id}>`;
// the sticker id when the whole message is one sticker token, else null
export const stickerIdOf = (content) => { const m = ONLY.exec(String(content ?? '').trim()); return m ? m[1] : null; };
// the picture: the first frame only (still) or the whole animation
export const stickerSrc = (id, still = false) => `/api/images/${id}${still ? '?still=1' : ''}`;
// what to show where only a line of text fits (a notification, a reply bar): the label instead of the raw token
export const plainText = (text) => (stickerIdOf(text) ? STICKER_LABEL : text);
