// Which country's prices to show, and how. Aduna sells in Canada (CAD) and the US (USD); the price is set in CAD and the server works the
// US price out from the live exchange rate (server/fx.js), so the client only picks which of the two numbers to draw.
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

// An item ({ cents: US price, cadCents: Canadian price }) as the person in `country` sees it: { text: '$2.79', code: 'CAD', cents, currency }.
// An item with no Canadian price (or when only USD is sold) shows its US price.
export function priceFor(item, country) {
  const cad = country !== 'US' && Number.isInteger(item?.cadCents) && item.cadCents > 0;
  const cents = cad ? item.cadCents : item.cents, currency = cad ? 'cad' : 'usd';
  return { text: fmt(cents, currency), code: currency.toUpperCase(), cents, currency };
}

// "1 US dollar is about 1.38 Canadian dollars" for the small print under the prices; '' when there is no rate to speak of.
export function rateNote(fx) {
  return fx && fx.rate ? `US prices follow the exchange rate (1 USD ≈ ${fx.rate.toFixed(2)} CAD).` : '';
}
