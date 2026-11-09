// How many characters one message may have. Free accounts: 2,000. Aduna Plus: 4,000.
// The server has its own copy of these numbers (server/msglimits.js) and is the one that really enforces them: change both together.
export const FREE_CHARS = 2000;
export const PLUS_CHARS = 4000;

// `me` is the signed-in user as the app has it (me.plus is true while the paid storage plan is active)
export const charLimit = (me) => (me && me.plus ? PLUS_CHARS : FREE_CHARS);
