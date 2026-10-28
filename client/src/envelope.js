// A direct or group message's plaintext is a small JSON envelope, so the text and the attachment details are encrypted together.
// Older messages are plain strings. Shared by DMs (App.jsx) and group chats (useGroups.js).
import { INVITE_CODE_RE } from './Invite.jsx';

export const wrapDm = (text, attachments, invite) => JSON.stringify({ v: 1, t: text, a: attachments || [], ...(invite ? { i: invite } : {}) });

export const unwrapDm = (s) => {
  try {
    const o = JSON.parse(s);
    if (o && o.v === 1 && typeof o.t === 'string') return { text: o.t, attachments: Array.isArray(o.a) ? o.a : [], invite: typeof o.i === 'string' && INVITE_CODE_RE.test(o.i) ? o.i : undefined };
  } catch { /* an older message: plain text */ }
  return { text: s, attachments: [] };
};
