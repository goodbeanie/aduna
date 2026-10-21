'use strict';
// The theme gallery: rules for publishing, listing and reporting themes (no Express, no database: tested by themegallery-test.js).
//
// A theme is only { dark, bg, accent }: two colours and a light/dark flag. The app builds every other colour from them
// (client/src/themes.js buildPalette), so a published theme can never carry CSS, images or links: the worst a bad one can do is look ugly.
// What this file adds is (1) a readability check, so nobody can publish text that vanishes into its background,
// (2) name and description filters, (3) per-person limits, and (4) reports that hide a theme once enough established accounts agree.
const listing = require('./listing');

const THEME = { maxOwned: 20, perHour: 6, nameMin: 2, nameMax: 30, descMax: 120, page: 24, reportsToHide: 3, minContrast: 4.5, minAccent: 3 };
const HEX = /^#[0-9a-fA-F]{6}$/;

// ---- colour maths: the same formulas as client/src/themes.js (themegallery-test.js checks the two agree on the built-in themes) ----
const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const A = parse(a), B = parse(b); return hex(A.map((v, i) => v + (B[i] - v) * t)); };
const luminance = (h) => { const [r, g, b] = parse(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const textOn = ({ dark, bg }) => (dark ? mix(bg, '#ffffff', 0.88) : mix(bg, '#000000', 0.84)); // --text in buildPalette
const mutedOn = ({ dark, bg }) => mix(bg, dark ? '#ffffff' : '#000000', dark ? 0.55 : 0.52); // --muted in buildPalette

// Returns { dark, bg, accent } (lowercase) or null when it is not a theme at all.
function cleanSeed(t) {
  if (!t || typeof t !== 'object' || typeof t.dark !== 'boolean' || typeof t.bg !== 'string' || typeof t.accent !== 'string') return null;
  if (!HEX.test(t.bg) || !HEX.test(t.accent)) return null;
  return { dark: t.dark, bg: t.bg.toLowerCase(), accent: t.accent.toLowerCase() };
}

// null when readable, otherwise a sentence for the person publishing.
function readabilityProblem(seed) {
  if (contrast(textOn(seed), seed.bg) < THEME.minContrast) return seed.dark
    ? 'Text would be hard to read: a dark theme needs a darker background.'
    : 'Text would be hard to read: a light theme needs a lighter background.';
  if (contrast(mutedOn(seed), seed.bg) < 2.2) return 'Secondary text would nearly vanish on this background. Move the background further towards black or white.';
  if (contrast(seed.accent, seed.bg) < THEME.minAccent) return 'The accent is too close to the background, so buttons and highlights would be hard to see. Pick a stronger accent.';
  return null;
}

const squash = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Checks a publish request. Returns { ok: { name, description, seed } } or { error }.
function checkPublish(body, words) {
  const seed = cleanSeed(body && body.seed);
  if (!seed) return { error: 'That is not a valid theme.' };
  const name = squash(body.name, THEME.nameMax), description = squash(body.description, THEME.descMax);
  if (name.length < THEME.nameMin) return { error: `Give the theme a name (at least ${THEME.nameMin} characters).` };
  if (listing.blockedWord(name, words, { compact: true }) || listing.blockedWord(description, words)) return { error: 'The name or description contains words that are not allowed in the gallery.' };
  if (listing.hasLink(name) || listing.hasLink(description)) return { error: 'Names and descriptions cannot contain links.' };
  const problem = readabilityProblem(seed);
  if (problem) return { error: problem };
  return { ok: { name, description, seed } };
}

const sameSeed = (a, b) => a.dark === b.dark && a.bg === b.bg && a.accent === b.accent;

// Why this person may not publish another theme right now, or null.
function publishLimit(all, uid, seed, now) {
  const mine = all.filter((t) => t.ownerId === uid && !t.hidden);
  if (mine.length >= THEME.maxOwned) return `You can publish up to ${THEME.maxOwned} themes. Delete one first.`;
  if (all.filter((t) => t.ownerId === uid && now - t.createdAt < 3600e3).length >= THEME.perHour) return 'You are publishing themes very fast. Try again in a little while.';
  if (mine.some((t) => sameSeed(t.seed, seed))) return 'You already published a theme with exactly these colours.';
  return null;
}

// A report counts toward hiding only from an account old enough that a batch of throwaway accounts cannot remove a theme.
const reportCount = (t, users, now) => listing.countedReports(t.reports || [], users, now);
const shouldHide = (t, users, now) => reportCount(t, users, now) >= THEME.reportsToHide;

// reports is a list of { by, at }: one per person
function addReport(t, uid, now) {
  if (!t.reports) t.reports = [];
  if (!t.reports.some((r) => r.by === uid)) t.reports.push({ by: uid, at: now });
}

function view(t, uid, users) {
  const a = users[t.ownerId];
  return { id: t.id, name: t.name, description: t.description, seed: t.seed, uses: t.uses || 0, createdAt: t.createdAt, mine: t.ownerId === uid,
    author: a ? { id: a.id, displayName: a.displayName || a.username } : { id: t.ownerId, displayName: 'Someone' } };
}

// The gallery page: sort 'popular' (most used, then newest) or 'new'; mode 'light' | 'dark' | undefined; q matches name, description, author.
function list(all, users, { sort = 'popular', mode, q, offset = 0, limit = THEME.page, uid } = {}) {
  const needle = String(q || '').trim().toLowerCase().slice(0, 40);
  let rows = all.filter((t) => !t.hidden);
  if (mode === 'light' || mode === 'dark') rows = rows.filter((t) => t.seed.dark === (mode === 'dark'));
  if (needle) rows = rows.filter((t) => `${t.name} ${t.description} ${users[t.ownerId]?.displayName || ''}`.toLowerCase().includes(needle));
  rows.sort(sort === 'new' ? (a, b) => b.createdAt - a.createdAt : (a, b) => (b.uses || 0) - (a.uses || 0) || b.createdAt - a.createdAt);
  const start = Math.max(0, Math.min(Number(offset) || 0, 100000)), n = Math.max(1, Math.min(Number(limit) || THEME.page, THEME.page));
  const slice = rows.slice(start, start + n);
  return { themes: slice.map((t) => view(t, uid, users)), more: start + n < rows.length };
}

module.exports = { THEME, cleanSeed, readabilityProblem, checkPublish, publishLimit, reportCount, shouldHide, addReport, view, list, textOn, contrast };
