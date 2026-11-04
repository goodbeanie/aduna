// Feature releases (server/features.js). The server tells each signed-in person which features are on for them in `me.features`:
// { 'feature-id': 'live' | 'testing' }. 'testing' only ever appears for creator accounts, so a feature that is still being tried out is
// invisible to everybody else. Gate new UI with it:   {hasFeature(me, 'rewarded-ads') && <WatchAd />}
// The server enforces the same rule on its routes (needFeature), so hiding a button here is only the polite half.
export const hasFeature = (me, id) => !!(me && me.features && Object.prototype.hasOwnProperty.call(me.features, id));

// 'live', 'testing' (a creator trying it out) or null (not on for this person): use it to show a small "Testing" tag on unreleased work
export const featureState = (me, id) => (hasFeature(me, id) ? me.features[id] : null);

// Master switch for the Clips section. false = Clips are hidden everywhere in the app (the server also refuses the Clips routes, see CLIPS_ENABLED in server/index.js).
export const CLIPS_ENABLED = false;
