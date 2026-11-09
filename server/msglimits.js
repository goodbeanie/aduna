// How long a message may be. Free accounts get the original size, Aduna Plus (the paid storage plan) gets double.
// The browser has its own copy of the two character numbers in client/src/msgLimit.js: change both together.
//
// Server channel messages are plain text, so the character limit is enforced as written.
// DMs and group chats are end-to-end encrypted: the server cannot count the characters, only the size of the ciphertext, so
// for those the limit is a ciphertext size that is generous enough for the character limit even in the widest alphabets.
const FREE_CHARS = 2000;
const PLUS_CHARS = 4000;
const FREE_CIPHER = 12000;
const PLUS_CIPHER = 24000;

const chars = (plus) => (plus ? PLUS_CHARS : FREE_CHARS);
const cipher = (plus) => (plus ? PLUS_CIPHER : FREE_CIPHER);

module.exports = { FREE_CHARS, PLUS_CHARS, FREE_CIPHER, PLUS_CIPHER, chars, cipher };
