// Lounge: a server's info page. It is a tab of its own, next to the channels, and the people who manage the server arrange it:
//   lounge = { enabled, template, tagline, look: {...}, sections: [ { id, type, enabled, heading, ... } ] }
// The title block (the server's logo, name and the tagline) is always first; `sections` are the widgets under it, in the order they are shown.
// `enabled` is "show the lounge to members": while it is off only people with Manage server see it (to build it in peace).
//
// Like namestyle.js this has no Express / Postgres imports: clean() is a plain function (input, server record) -> { value } or { error },
// so it can be unit tested (server/lounge-test.js). index.js calls it from PUT /api/servers/:id/lounge.
// Keep the ids below in sync with client/src/lounge.js, which has the templates and draws each look.
const crypto = require('crypto');

const LIMITS = { sections: 12, text: 4, tagline: 140, heading: 40, body: 1000, announcement: 300, buttons: 4, links: 6, channels: 8, label: 24, url: 300 };
const TEMPLATE_IDS = ['magazine', 'compact', 'classic', 'minimal', 'custom'];
const TYPES = ['buttons', 'about', 'announcement', 'live', 'channels', 'members', 'links', 'text'];
const SINGLE = new Set(TYPES.filter((t) => t !== 'text')); // each of these once; plain text blocks may repeat (LIMITS.text)
const LOOK = {
  background: ['glow', 'mesh', 'banner', 'plain'],
  cards: ['filled', 'glass', 'outline'],
  font: ['default', 'rounded', 'serif', 'mono', 'display'],
  banner: ['tall', 'normal', 'short'],
  title: ['left', 'center', 'right'],
};
const DEFAULT_LOOK = { accent: 'auto', background: 'banner', cards: 'glass', font: 'default', banner: 'normal', title: 'center' };
const HEX = /^#[0-9a-fA-F]{6}$/;
const URL_OK = /^https:\/\/[^\s<>"'\\]+$/i;
const ID_OK = /^[a-z0-9]{4,16}$/;

class Bad extends Error {}
const bad = (m) => { throw new Bad(m); };

// Text from a request: control characters become spaces (a multi-line field keeps its line breaks), trimmed, and not longer than `max` characters.
const text = (v, max, what, multi) => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') bad(`${what} must be text`);
  const t = v.replace(multi ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ').trim();
  if (Array.from(t).length > max) bad(`${what} can be up to ${max} characters`);
  return t;
};
const url = (v, what) => {
  const t = text(v, LIMITS.url, what);
  if (!URL_OK.test(t)) bad(`${what} must be a link that starts with https://`);
  return t;
};
const list = (v, max, what) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad(`${what} must be a list`);
  if (v.length > max) bad(`${what} can have up to ${max} entries`);
  return v;
};
const newId = (taken) => { let id; do id = crypto.randomBytes(4).toString('hex'); while (taken.has(id)); return id; };

function cleanLook(l) {
  if (l === undefined || l === null) return { ...DEFAULT_LOOK };
  if (typeof l !== 'object' || Array.isArray(l)) bad('The look must be an object');
  const out = {};
  if (l.accent === undefined || l.accent === 'auto') out.accent = 'auto';
  else if (typeof l.accent === 'string' && HEX.test(l.accent)) out.accent = l.accent.toLowerCase();
  else bad('Pick an accent colour');
  for (const k of Object.keys(LOOK)) {
    const v = l[k] === undefined ? DEFAULT_LOOK[k] : l[k];
    if (!LOOK[k].includes(v)) bad(`Unknown ${k} style`);
    out[k] = v;
  }
  return out;
}

// channels that still exist in this server (a deleted channel just drops out of a widget instead of breaking the save)
const channelIdsOf = (s) => new Set((s.channels || []).map((c) => c.id));

function cleanSection(raw, s, ids) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('Each section must be an object');
  if (!TYPES.includes(raw.type)) bad('Unknown section type');
  const id = typeof raw.id === 'string' && ID_OK.test(raw.id) && !ids.has(raw.id) ? raw.id : newId(ids);
  ids.add(id);
  const sec = { id, type: raw.type, enabled: raw.enabled !== false, heading: text(raw.heading, LIMITS.heading, 'A heading') };
  const chans = channelIdsOf(s);
  switch (raw.type) {
    case 'about': case 'text':
      sec.text = text(raw.text, LIMITS.body, 'The text', true);
      break;
    case 'announcement':
      sec.text = text(raw.text, LIMITS.announcement, 'The announcement', true);
      break;
    case 'channels': {
      const seen = new Set();
      sec.channelIds = list(raw.channelIds, LIMITS.channels, 'Channels').filter((c) => typeof c === 'string' && chans.has(c) && !seen.has(c) && seen.add(c));
      break;
    }
    case 'buttons': {
      sec.items = [];
      for (const it of list(raw.items, LIMITS.buttons, 'Buttons')) {
        if (!it || typeof it !== 'object') bad('Each button must be an object');
        const label = text(it.label, LIMITS.label, 'A button label');
        if (!label) continue; // an empty row from the editor
        if (it.channelId !== undefined && it.channelId !== null && it.channelId !== '') {
          if (typeof it.channelId === 'string' && chans.has(it.channelId)) sec.items.push({ label, channelId: it.channelId });
          continue; // pointed at a channel that is gone: leave the button out
        }
        sec.items.push({ label, url: url(it.url, `The link for "${label}"`) });
      }
      break;
    }
    case 'links': {
      sec.items = [];
      for (const it of list(raw.items, LIMITS.links, 'Links')) {
        if (!it || typeof it !== 'object') bad('Each link must be an object');
        const label = text(it.label, LIMITS.label, 'A link label');
        if (!label) continue;
        sec.items.push({ label, url: url(it.url, `The link for "${label}"`) });
      }
      break;
    }
    default: break; // live and members have nothing to set: they show what is happening
  }
  return sec;
}

// -> { value } (the lounge as it is stored) or { error }
function clean(input, s) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Send the lounge settings');
    const template = input.template === undefined ? 'custom' : input.template;
    if (!TEMPLATE_IDS.includes(template)) bad('Unknown template');
    const raw = list(input.sections, LIMITS.sections, 'Sections');
    const ids = new Set(), singles = new Set();
    let texts = 0;
    const sections = raw.map((r) => {
      const sec = cleanSection(r, s, ids);
      if (SINGLE.has(sec.type)) { if (singles.has(sec.type)) bad(`There can be only one "${sec.type}" section`); singles.add(sec.type); }
      else if (++texts > LIMITS.text) bad(`There can be up to ${LIMITS.text} text sections`);
      return sec;
    });
    return { value: { enabled: input.enabled === true, template, tagline: text(input.tagline, LIMITS.tagline, 'The tagline'), look: cleanLook(input.look), sections } };
  } catch (e) {
    if (e instanceof Bad) return { error: e.message };
    throw e;
  }
}

module.exports = { LIMITS, TEMPLATE_IDS, TYPES, LOOK, DEFAULT_LOOK, clean };
