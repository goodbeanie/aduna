# Ads plan for Aduna (planning notes, nothing built yet)

Goal: allow ads without breaking "everything that costs money on Discord is free here".
Approach: rewarded ads that people choose to watch, plus a few quiet placements.
Nothing in chat or voice.

The app already has credits, a Shop and a Quests tab, so most of the plumbing exists.

## Placements that aren't annoying

- **Watch for credits (opt-in).** A "Watch a short ad, earn credits" button on the Quests tab, capped at about 3 to 5 a day. Nobody is forced to watch. The credits feed what the Shop already sells.
- **Sponsored card in Shop or Quests.** One clearly labelled "Sponsored" card, styled like a normal item. Static, no autoplay.
- **Promoted marketplace items.** Creators pay credits to feature their sticker packs or emoji. Cheap to build, on-brand, and it sends credits back to creators.
- **Never:** pre-rolls, popups, banners in chat, ads in voice channels, or anything that plays when you open a profile.

## Things to sort out before building

- **Ad network.** Most rewarded-video networks target mobile apps and games. Web and Electron support is limited and approval is stricter. Confirm the network accepts a chat app, since some restrict user-generated-content apps.
- **Credit farming.** Grant reward credits only from a server-side callback from the ad network, never from the client. Add daily caps and rate limits.
- **Privacy.** Ads usually mean tracking: consent prompt for EU and UK users and for anyone under 18, and a privacy policy update.
- **Messaging.** "Everything that costs money on Discord is free here" still holds if ads are optional, but say so in the video and the description so it doesn't look like a bait and switch.

## Suggested order

1. Promoted marketplace items and one sponsored card (no ad network, no consent flow needed).
2. Rewarded video, once a network is chosen.

## Open decision

Ads from a network, or self-serve sponsorship paid for by creators and partners? This decides what gets built first.
Next step once decided: read the Shop and Quests code and sketch the changes.
Kept separate from the footage work, which is still waiting.
