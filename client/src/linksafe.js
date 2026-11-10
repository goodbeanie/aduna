// Unsafe link detection, the browser's half. Pure functions (no React, no network), tested by client/scripts/linksafe-test.mjs.
//
// Direct messages and group chats are end-to-end encrypted, so the server cannot read the links in them: this check runs here, on each link as it is shown.
// analyzeLink(url, blocked) -> { level, host, reasons }
//   level 'block'  a domain on the blocklist (server/link-blocklist.json + /admin > Links), or an address that is never a web page (javascript:, data:).
//                  No way through.
//   level 'warn'   looks suspicious: a lookalike or disguised address, a link shortener, an executable download. Hidden behind "Show anyway".
//   level 'ok'     nothing found.
// `reasons` is a list of { code, text } saying why, in plain words for the warning dialog.
// The live lookup (Google Safe Browsing, server/linksafe.js) is a fourth step that only runs on links that came out as 'warn'; see LinkGuard.jsx.

// ---------- the blocklist ----------
// A listed domain blocks itself and every address under it (evil.example blocks login.evil.example too).
export function blockedBy(host, domains) {
  if (!host || !domains || !domains.size) return null;
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    if (domains.has(d)) return d;
  }
  return domains.has(host) ? host : null;
}

// ---------- punycode (RFC 3492), so a host written as xn--... can be read the way a person would see it ----------
export function punycodeDecode(input) {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const out = [];
  let basic = input.lastIndexOf('-');
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) {
    if (input.charCodeAt(j) >= 0x80) return null;
    out.push(input.charCodeAt(j));
  }
  const adapt = (delta, n, first) => {
    let k = 0;
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / n);
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
  };
  let n = 128, i = 0, bias = 72;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length;) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (idx >= input.length) return null;
      const c = input.charCodeAt(idx++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  try { return String.fromCodePoint(...out); } catch { return null; }
}

// the host as a person sees it: every xn-- label decoded (a label that cannot be decoded stays as written)
export function unicodeHost(host) {
  return host.split('.').map((l) => (l.startsWith('xn--') ? punycodeDecode(l.slice(4)) || l : l)).join('.');
}

// ---------- lookalike and disguised addresses ----------
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Cherokee'];
const SCRIPT_RE = SCRIPTS.map((s) => [s, new RegExp('\\p{Script=' + s + '}', 'u')]);
// letters of these scripts are the ones that pass for Latin letters (а, е, о, р, с, х ...); other scripts (Japanese, Arabic ...) are ordinary names
function scriptsIn(label) {
  const found = new Set();
  for (const [name, re] of SCRIPT_RE) if (re.test(label)) found.add(name);
  return found;
}
function lookalikeLabel(label) {
  const s = scriptsIn(label);
  const confusable = [...s].filter((x) => x !== 'Latin');
  if (!confusable.length) return false;
  return s.has('Latin') || confusable.length > 1 || /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}]/u.test(label);
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

// a few big names people are impersonated as, with the domains that really are theirs
const BRANDS = {
  discord: ['discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.media', 'discordstatus.com', 'discord.gift', 'discord.new', 'discord.dev'],
  steam: ['steampowered.com', 'steamcommunity.com', 'steamstatic.com', 'steam-chat.com'],
  roblox: ['roblox.com', 'rbxcdn.com', 'roblox.qq.com'],
  paypal: ['paypal.com', 'paypal.me', 'paypalobjects.com'],
  google: ['google.com', 'google.ca', 'google.co.uk', 'google.de', 'google.fr', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'goo.gl'],
  apple: ['apple.com', 'icloud.com'],
  microsoft: ['microsoft.com', 'live.com', 'office.com', 'microsoftonline.com', 'xbox.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.me', 'messenger.com'],
  instagram: ['instagram.com'],
  netflix: ['netflix.com'],
  amazon: ['amazon.com', 'amazon.ca', 'amazon.co.uk', 'amazon.de', 'amzn.to', 'amazonaws.com'],
  coinbase: ['coinbase.com'],
  binance: ['binance.com'],
  epicgames: ['epicgames.com'],
  aduna: ['aduna.onrender.com'],
};
const BAIT = new Set(['login', 'log-in', 'signin', 'verify', 'verification', 'secure', 'security', 'gift', 'gifts', 'nitro', 'free', 'claim', 'account', 'accounts', 'support', 'wallet', 'airdrop', 'giveaway', 'promo', 'auth', 'update', 'help', 'billing', 'confirm', 'recover', 'unlock', 'reward', 'rewards', 'bonus', 'drop', 'robux', 'vbucks']);
const RISKY_TLD = new Set(['xyz', 'top', 'click', 'site', 'online', 'gift', 'icu', 'cyou', 'buzz', 'tk', 'ml', 'ga', 'cf', 'gq', 'work', 'support', 'rest', 'fit', 'monster', 'cfd', 'sbs']);
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'co.in', 'co.za', 'com.br', 'com.mx', 'com.tr', 'com.cn', 'co.kr']);

function registrable(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  return SECOND_LEVEL.has(p.slice(-2).join('.')) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}
const LEET = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const deLeet = (s) => s.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/[013457@$]/g, (c) => LEET[c] || c).replace(/[-_]/g, '');
const isOfficial = (host, brand) => BRANDS[brand].some((d) => host === d || host.endsWith('.' + d));

function brandOf(host) {
  const reg = registrable(host);
  const name = reg.split('.')[0]; // the first label of the registrable domain: "paypal-login" in login.paypal-login.xyz
  const tld = reg.slice(name.length + 1);
  const subs = host.length > reg.length ? host.slice(0, host.length - reg.length - 1).split('.') : [];
  const hasBait = (s) => s.split('-').some((t) => BAIT.has(t));
  for (const brand of Object.keys(BRANDS)) {
    if (isOfficial(host, brand)) continue;
    const tokens = name.split('-');
    if (subs.some((s) => s === brand || (s.split('-').includes(brand) && hasBait(s)))) return brand;   // paypal.com.evil.io, paypal-login.evil.io
    if (tokens.includes(brand) && tokens.length > 1 && hasBait(name)) return brand;                    // paypal-login.xyz, discord-nitro.gift
    if (name !== brand && deLeet(name) === brand) return brand;                                        // paypa1.com, disc0rd.com, rnicrosoft.com
    if (name === brand && RISKY_TLD.has(tld.split('.').pop())) return brand;                           // steam.xyz
  }
  return null;
}

// ---------- known bad patterns ----------
const SHORTENERS = new Set(['bit.ly', 'bitly.com', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'v.gd', 'cutt.ly', 'rb.gy', 'ow.ly', 'buff.ly', 'shorturl.at', 'tiny.cc', 'rebrand.ly', 'bit.do', 't.ly', 's.id', 'lnkd.in', 'soo.gd', 'clck.ru', 'cutt.us', 'shorte.st', 'adf.ly', 'bc.vc', 'ouo.io', 'qr.ae', 'trib.al', 'tr.ee', 'x.co', 'u.to', 'kutt.it', 'short.io', 'shrtco.de', 'urlz.fr', 'l.ead.me', 'link.tl', 'gg.gg', 'chilp.it', 'mcaf.ee', 'hyperurl.co', 'lc.cx', 'zpr.io', 'po.st', 'dlvr.it']);
const BAD_PROTOCOL = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);
const EXEC_EXT = /\.(?:exe|scr|bat|cmd|com|msi|msix|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|apk|dmg|pkg|lnk|reg|cpl|dll|iso|img|appimage|sh|bin|run|crx|xpi)$/i;

function decodePath(p) { try { return decodeURIComponent(p); } catch { return p; } }

export function analyzeLink(raw, blocked) {
  const reasons = [];
  let u;
  try { u = new URL(String(raw)); } catch { return { level: 'ok', host: '', reasons }; } // not an address: nothing to judge (Markdown only links real ones)
  if (BAD_PROTOCOL.has(u.protocol)) {
    reasons.push({ code: 'protocol', text: `It is a “${u.protocol}” address, which runs code or hands over data instead of opening a web page.` });
    return { level: 'block', host: u.hostname, reasons };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { level: 'ok', host: u.hostname, reasons };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');

  // 3. the blocklist
  const hit = blockedBy(host, blocked);
  if (hit) {
    reasons.push({ code: 'blocklist', text: `${hit} is on Aduna’s list of known phishing, scam and malware sites.` });
    return { level: 'block', host, reasons };
  }

  // 1. lookalike and disguised addresses
  if (u.username || u.password) reasons.push({ code: 'userinfo', text: 'The text before the @ is made to look like the site, but the link really goes to ' + host + '.' });
  if (IPV4.test(host) || host.startsWith('[')) reasons.push({ code: 'ip', text: 'It goes to a bare IP address instead of a website name. Real sites almost never do that in chat.' });
  const labels = host.split('.');
  if (labels.some((l) => l.startsWith('xn--'))) {
    const seen = unicodeHost(host);
    if (labels.some((l) => l.startsWith('xn--') && lookalikeLabel(punycodeDecode(l.slice(4)) || ''))) reasons.push({ code: 'lookalike', text: `The address uses look-alike letters: it reads “${seen}” but is really ${host}.` });
    else if (labels.some((l) => l.startsWith('xn--') && punycodeDecode(l.slice(4)) === null)) reasons.push({ code: 'lookalike', text: 'The address is written in a disguised form (' + host + ') that could not be read.' });
  } else if (/[^\x00-\x7f]/.test(host) && labels.some(lookalikeLabel)) {
    reasons.push({ code: 'lookalike', text: 'The address mixes look-alike letters from different alphabets.' });
  }
  if (/\.(?:zip|mov)$/.test(host)) reasons.push({ code: 'filetld', text: 'The address ends in .' + labels[labels.length - 1] + ', which looks like a file name but is a website.' });
  const brand = IPV4.test(host) ? null : brandOf(host);
  if (brand) reasons.push({ code: 'brand', text: `It looks like it is pretending to be ${brand[0].toUpperCase() + brand.slice(1)}, but the real address is ${registrable(host)}.` });

  // 2. known bad patterns
  if (SHORTENERS.has(registrable(host)) || SHORTENERS.has(host)) reasons.push({ code: 'shortener', text: 'It is a shortened link, so you cannot see where it really goes.' });
  const path = decodePath(u.pathname);
  if (EXEC_EXT.test(path)) reasons.push({ code: 'download', text: 'It points straight at a program or script file (' + path.split('/').pop().slice(0, 40) + '). Opening it could run or install something.' });
  else if (/\.(?:pdf|docx?|xlsx?|jpe?g|png|gif|txt|mp[34])\.(?:exe|scr|bat|cmd|js|vbs|lnk|jar|msi)$/i.test(path)) reasons.push({ code: 'download', text: 'The file name has a fake ending that hides a program.' });

  return { level: reasons.length ? 'warn' : 'ok', host, reasons };
}

// "login.evil.example" for the dialog: the address with the part that matters on its own line
export const addressParts = (raw) => {
  try { const u = new URL(String(raw)); return { host: u.hostname, rest: u.pathname + u.search + u.hash }; } catch { return { host: String(raw), rest: '' }; }
};
