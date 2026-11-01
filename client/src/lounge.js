import './namestyle.css'; // the bundled fonts the lounge fonts use

// Lounge: a server's info page (a tab of its own, next to the channels). The server (server/lounge.js) validates and stores it:
//   server.lounge = { enabled, template, tagline, look: { accent, background, cards, font, banner, title }, sections: [ { id, type, enabled, heading, ... } ] }
// Keep the ids and limits in sync with server/lounge.js. The title block (logo, name, tagline) is always first; sections are the widgets under it.

export const LIMITS = { sections: 12, text: 4, tagline: 140, heading: 40, body: 1000, announcement: 300, buttons: 4, links: 6, channels: 8, label: 24, url: 300 };

// label = the widget's name in the editor and its default heading on the page
export const SECTION_TYPES = {
  buttons: { label: 'Buttons', icon: 'link', blurb: 'Quick buttons to a channel or a link', single: true },
  about: { label: 'About', icon: 'rules', blurb: 'A few words about the server', single: true },
  announcement: { label: 'Announcement', icon: 'megaphone', blurb: 'One note you want everyone to see', single: true },
  live: { label: 'Live now', icon: 'speaker', blurb: 'Who is in voice right now', single: true },
  channels: { label: 'Channels', icon: 'hash', blurb: 'Channels you pick, as big tiles', single: true },
  members: { label: 'Members', icon: 'users', blurb: 'Who is online right now', single: true },
  links: { label: 'Links', icon: 'globe', blurb: 'Your site, socials, a wiki', single: true },
  text: { label: 'Text block', icon: 'edit', blurb: 'Anything else you want to say', single: false },
};

export const DEFAULT_LOOK = { accent: 'auto', background: 'banner', cards: 'glass', font: 'default', banner: 'normal', title: 'center' };
export const ACCENTS = ['#ff8a1f', '#ff4d6d', '#ff5fc8', '#9b5cff', '#5b7cff', '#2aa8ff', '#17b8a6', '#3fbf4f', '#e6b800', '#8a8f98'];
export const LOOK_OPTIONS = {
  background: [['glow', 'Glow'], ['mesh', 'Mesh'], ['banner', 'Banner blur'], ['plain', 'Plain']],
  cards: [['filled', 'Filled'], ['glass', 'Glass'], ['outline', 'Outline']],
  font: [['default', 'Default'], ['rounded', 'Rounded'], ['serif', 'Serif'], ['mono', 'Mono'], ['display', 'Display']],
  banner: [['tall', 'Tall'], ['normal', 'Normal'], ['short', 'Short']],
  title: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']],
};
export const LOOK_LABELS = { background: 'Background', cards: 'Cards', font: 'Font', banner: 'Banner height', title: 'Title' };

// rows = a tiny picture of the layout for the template card: each row has `n` blocks and a height
export const TEMPLATES = [
  { id: 'magazine', label: 'Magazine', blurb: 'Big hero, big tiles', rows: [{ n: 1, h: 20 }, { n: 2, h: 14 }, { n: 2, h: 14 }],
    look: { banner: 'tall', cards: 'glass', background: 'banner', title: 'center', font: 'default' }, sections: ['buttons', 'about', 'live', 'channels', 'members'] },
  { id: 'compact', label: 'Compact', blurb: 'Short and dense', rows: [{ n: 1, h: 7 }, { n: 1, h: 7 }, { n: 1, h: 7 }],
    look: { banner: 'short', cards: 'filled', background: 'plain', title: 'left', font: 'default' }, sections: ['about', 'live', 'links'] },
  { id: 'classic', label: 'Classic', blurb: 'Welcome, voice and rules', rows: [{ n: 1, h: 10 }, { n: 1, h: 14 }, { n: 2, h: 12 }],
    look: { banner: 'normal', cards: 'outline', background: 'glow', title: 'center', font: 'serif' }, sections: ['announcement', 'about', 'channels', 'live', 'links'] },
  { id: 'minimal', label: 'Minimal', blurb: 'Just the essentials', rows: [{ n: 1, h: 12 }, { n: 2, h: 10 }],
    look: { banner: 'short', cards: 'outline', background: 'plain', title: 'left', font: 'rounded' }, sections: ['about', 'channels'] },
];

export const newId = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');

const isText = (c) => !c.type || c.type === 'text' || c.type === 'announcements';
// A new widget with sensible starting content taken from the server itself (its description, its rules and first text channels).
export function newSection(type, server) {
  const sec = { id: newId(), type, enabled: true, heading: '' };
  const chans = server?.channels || [];
  switch (type) {
    case 'about': sec.text = (server?.description || `Welcome to ${server?.name || 'our server'}!`).slice(0, LIMITS.body); break;
    case 'text': case 'announcement': sec.text = ''; break;
    case 'channels': sec.channelIds = chans.filter((c) => c.type !== 'voice').slice(0, 6).map((c) => c.id); break;
    case 'buttons': {
      sec.items = [];
      const rules = chans.find((c) => c.type === 'rules'), hi = chans.find(isText);
      if (rules) sec.items.push({ label: 'Read the rules', channelId: rules.id });
      if (hi) sec.items.push({ label: 'Say hi', channelId: hi.id });
      break;
    }
    case 'links': sec.items = [{ label: '', url: '' }]; break;
    default: break;
  }
  return sec;
}

// A whole draft from a template. `keep` carries what a template never overwrites: the switch for members and the tagline.
export function fromTemplate(id, server, keep = {}) {
  const t = TEMPLATES.find((x) => x.id === id) || TEMPLATES[0];
  return { enabled: !!keep.enabled, template: t.id, tagline: keep.tagline || '', look: { ...DEFAULT_LOOK, ...t.look }, sections: t.sections.map((type) => newSection(type, server)) };
}

// What the editor starts from: the saved lounge, or a fresh one (Magazine) for a server that has none yet.
export function draftOf(server) {
  const l = server.lounge;
  if (!l) return fromTemplate('magazine', server);
  return { enabled: !!l.enabled, template: l.template || 'custom', tagline: l.tagline || '', look: { ...DEFAULT_LOOK, ...l.look }, sections: (l.sections || []).map((s) => ({ ...s })) };
}

// "Auto" follows the server's own theme colour, so a themed server looks like itself without anyone choosing a colour.
export const accentOf = (look, server) => (look.accent && look.accent !== 'auto' ? look.accent : server?.theme?.accent || '#e8743b');
// readable text on top of the accent (buttons, the live dot): dark on a light colour, white on a dark one
export function onColor(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  if (!Number.isFinite(n)) return '#fff';
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#1a1209' : '#ffffff';
}

// "example.com" -> "https://example.com" (the server only accepts https links)
export const fixUrl = (u) => { const t = String(u || '').trim(); return !t || /^https?:\/\//i.test(t) ? t : 'https://' + t; };
// What is sent to the server: links completed, nothing else changed (the server drops blank rows and unknown channels).
export function forSave(d) {
  return {
    ...d,
    sections: d.sections.map((s) => (s.items ? { ...s, items: s.items.map((i) => (i.url !== undefined ? { ...i, url: fixUrl(i.url) } : i)) } : s)),
  };
}
