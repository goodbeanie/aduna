// Which version of the Terms of Service (client/public/terms.html) people have agreed to.
// Change VERSION whenever the terms change in a way people should agree to again, and put the same date in "Last updated" on the page.
// Every account that has not accepted this version gets the agree screen the next time Aduna opens.
const VERSION = '2026-11-20';

const stamp = (at) => ({ version: VERSION, at });
const needed = (u) => !u.bot && !(u.termsAccepted && u.termsAccepted.version === VERSION);

module.exports = { VERSION, stamp, needed };
