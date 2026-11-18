# Server boosts plan (planning notes, nothing built yet)

Members spend credits to boost a server. Boosts are paid with credits only, no real money, in line with
"everything that costs money on Discord is free here".

## Tiers

All boosts last 14 days. Perks stack upward.

| Level | Cost | Perks |
|-------|------|-------|
| 1 | 1000 credits | Server explorer boost, booster tag |
| 2 | 2000 credits | Level 1 perks, 1080p 60fps screenshare for everyone in the server's voice channels |
| 3 | 3000 credits | Level 2 perks, 1.5x credit multiplier on messages in the server |

The 1.5x multiplier: credits earned from messages in the server add to the user's message credit limit.

## Rules

- Boosts don't combine. 3 x level 1 is still level 1.
- Upgrading means paying the full price of the new level (a level 1 booster who wants level 3 pays 3000).
- The server runs at the highest active level. While level 3 is active, levels 1 and 2 can't be bought.
- If someone buys level 1 and someone else then buys level 3, the level 1 booster keeps their tag until their own boost would have ended.
- The booster tag belongs to the person and only shows in that server.

## Refunds

- No refunds when a user asks.
- If the server is deleted, every booster gets the unused part of their boost back, in credits.
- refund = price x (time remaining / 14 days), rounded down at the end, not per day.
- Use exact time remaining (hours or minutes), not whole days, so a boost deleted the same day can't return 100%.
- Example: 1000 credits, server deleted after 3 days. 1000 x 11/14 = 785.7, refund 785.
- This applies to boosts hidden behind a higher level too, based on their own timer.
- Boosts that are queued and haven't started get a full refund.
- Refund goes to the person who paid. It is not counted as earned credits, so it doesn't touch the message credit limit.

## Still to decide

- **Hidden boosts.** When level 3 covers a level 1, does the level 1 timer keep running or pause? Leaning towards pause, so the booster doesn't lose time they paid for. Either way, when level 3 ends the server should fall back to the highest boost still running.
- **Same-level buys.** Can a second level 2 extend the first (28 days, queued) or just overlap? Queueing is simplest.
- **Renewing your own boost early.** Extend from the current end date or restart?
- **Upgrade discount.** Full price on upgrade means the lower boost's credits are mostly wasted. Option: credit for the remaining time.
- **Multiplier cap.** Does 1.5x apply to everyone's messages or only the booster's? Add a cap so it can't inflate credits.
- **Booster leaves or gets banned.** Does the boost keep running or end?
- **Abuse.** Create a server, boost it, delete it for the refund. A minimum server age before boosting, or a delay before deletion finalizes, would stop most of it. Also check whether owners boosting their own server can be farmed.
- **Where it plugs in.** Explorer sorting is in `GET /api/explore` in `server/index.js` (tags and name matches already boost ranking there). Credits and the Shop are the other places to read before sketching the changes.
