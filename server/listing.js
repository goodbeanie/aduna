// Checks and rules for public server listings (no Express, no database: tested by listing-test.js).
// A public listing shows a name, a description and tags to strangers, so those are checked before they can go live,
// and every public server can be reported. Enough reports from established accounts hide the listing until it is reviewed.

const fold = (s) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't');

// Ordinary words that contain a blocked word; removed before the substring check used for names and tags.
const INNOCENT = ['therapist', 'niggardly', 'scunthorpe', 'cheil'];

// Free text (description): a word is blocked when it is a whole word (an optional plural s is fine), or when 2-3 neighbouring words
// run together into one ("kill yourself"). It is NOT matched inside other words, so "therapist" and "Scunthorpe" pass.
// Names and tags are short and have no sentences, so there the separators are dropped and longer words match anywhere (like emoji names).
function blockedWord(text, words, { compact = false } = {}) {
  const tokens = fold(String(text || '')).split(/[^a-z0-9]+/).filter(Boolean);
  const set = new Set(words);
  const hit = (t) => set.has(t) || (t.endsWith('s') && set.has(t.slice(0, -1)));
  for (let i = 0; i < tokens.length; i++) {
    if (hit(tokens[i])) return tokens[i];
    for (let n = 2; n <= 3 && i + n <= tokens.length; n++) { const j = tokens.slice(i, i + n).join(''); if (set.has(j)) return j; }
  }
  if (compact) {
    const joined = tokens.map((t) => INNOCENT.reduce((x, w) => x.split(w).join(''), t)).join('');
    for (const w of words) if (w.length >= 5 && joined.includes(w)) return w;
  }
  return null;
}

// Links in a description are how listings get used for scams and for advertising other communities.
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|me|ly|co|xyz|ru|cn|tk|ml|app|link|club|top|info|to)\b|\bdiscord\s*\.?\s*gg\b|\binvite\/[a-z0-9_-]{3,})/i;
const hasLink = (text) => LINK.test(String(text || '').replace(/\s*\.\s*/g, '.').replace(/\[dot\]|\(dot\)/gi, '.'));

// Returns null when fine, otherwise a sentence for the owner.
function listingProblem(s, words) {
  const nm = blockedWord(s.name, words, { compact: true });
  if (nm) return 'The server name is not allowed on a public listing. Rename the server or keep it unlisted.';
  if (hasLink(s.name)) return 'A public server name cannot contain a link.';
  if (blockedWord(s.description, words)) return 'The description contains words that are not allowed on a public listing.';
  if (hasLink(s.description)) return 'Descriptions cannot contain links. Share your invite link inside Aduna instead.';
  for (const t of s.tags || []) if (blockedWord(t, words, { compact: true })) return `The tag "${t}" is not allowed.`;
  return null;
}
// Each check on its own, for editing a single field.
const textProblem = (kind, value, words) => listingProblem(kind === 'description' ? { description: value } : kind === 'tags' ? { tags: value } : { name: value }, words);

const REASONS = ['inappropriate', 'spam', 'illegal', 'impersonation', 'other'];
const LISTING = { reportsToHide: 5, minAgeMs: 24 * 3600 * 1000, perHour: 10, maxDetails: 500 };

// A report counts toward hiding only when the reporter's account is old enough, so a fresh batch of throwaway accounts cannot
// remove a server. Every report is still kept for the reviewer.
function countedReports(reports, users, now, minAgeMs = LISTING.minAgeMs) {
  const seen = new Set();
  for (const r of reports || []) {
    const u = users[r.by];
    if (u && now - (u.createdAt || 0) >= minAgeMs) seen.add(r.by);
  }
  return seen.size;
}

module.exports = { blockedWord, hasLink, listingProblem, textProblem, countedReports, REASONS, LISTING };
