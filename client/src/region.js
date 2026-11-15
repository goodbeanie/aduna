// Which country's prices to show, and how. Aduna sells in Canada (CAD) and the US (USD); each item has a fixed price in both, so the client
// only picks which of the two numbers to draw.
// The server still decides what is charged; this is only about what is shown before checkout.

const KEY = 'aduna.country';
// US time zones; anything else defaults to Canada, where the CAD price is the one that is set
const US_ZONES = /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Sitka|Nome|Adak|Metlakatla|Yakutat|Menominee|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/Honolulu|US\/.+)$/;

// What the person chose last (at checkout or with the price switch), else a guess from their time zone and language.
export function homeCountry(countries = ['CA', 'US']) {
  if (countries.length === 1) return countries[0];
  try { const saved = localStorage.getItem(KEY); if (saved && countries.includes(saved)) return saved; } catch { /* storage can be off */ }
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser */ }
  const guess = US_ZONES.test(tz) ? 'US' : 'CA';
  return countries.includes(guess) ? guess : countries[0];
}

export function rememberCountry(country) {
  try { if (country === 'CA' || country === 'US') localStorage.setItem(KEY, country); } catch { /* storage can be off */ }
}

const fmt = (cents, cur) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: cur.toUpperCase() });
export const money = fmt;

// The province or state the person picked at checkout. Only needed when the card fee is on: where a card surcharge is allowed it is shown as its own
// line, elsewhere (and in Quebec) it is part of the price, and the server tells the two apart by this.
const REGION_KEY = 'aduna.region';
export const REGIONS = {
  CA: { label: 'Province', list: [['AB', 'Alberta'], ['BC', 'British Columbia'], ['MB', 'Manitoba'], ['NB', 'New Brunswick'], ['NL', 'Newfoundland and Labrador'], ['NS', 'Nova Scotia'], ['NT', 'Northwest Territories'], ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Prince Edward Island'], ['QC', 'Quebec'], ['SK', 'Saskatchewan'], ['YT', 'Yukon']] },
  US: { label: 'State', list: [['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming']] },
};
export function savedRegion(country) {
  try { const v = localStorage.getItem(REGION_KEY) || ''; const [c, r] = v.split('-'); return c === country && REGIONS[country]?.list.some(([code]) => code === r) ? r : ''; } catch { return ''; }
}
export function rememberRegion(country, region) {
  try { if (region) localStorage.setItem(REGION_KEY, country + '-' + region); else localStorage.removeItem(REGION_KEY); } catch { /* storage can be off */ }
}

// An item ({ cents: US price, cadCents: Canadian price }) as the person in `country` sees it: { text: '$2.79', code: 'CAD', cents, currency }.
// An item with no Canadian price (or when only USD is sold) shows its US price.
export function priceFor(item, country) {
  const cad = country !== 'US' && Number.isInteger(item?.cadCents) && item.cadCents > 0;
  const cents = cad ? item.cadCents : item.cents, currency = cad ? 'cad' : 'usd';
  return { text: fmt(cents, currency), code: currency.toUpperCase(), cents, currency };
}
