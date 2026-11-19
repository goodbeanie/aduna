# Server boosts plan (planning notes, nothing built yet)

Members can boost a server with credits or with real money. Either way the boost is the same.

## Tiers

All boosts last 14 days. Perks stack upward.

| Level | Credits | Real money | Perks |
|-------|---------|------------|-------|
| 1 | 1000 | 2.99 | Server explorer boost, booster tag |
| 2 | 2000 | 5.99 | Level 1 perks, 1080p 60fps screenshare for everyone in the server's voice channels |
| 3 | 3000 | 7.99 | Level 2 perks, 1.5x credit multiplier on messages in the server |

Each money price is 1.00 below what the same credits would cost to buy, so paying with money directly is always the cheaper way to boost.

The 1.5x multiplier: credits earned from messages in the server add to the user's message credit limit.

## Rules

- Boosts don't combine. 3 x level 1 is still level 1.
- Upgrading means paying the full price of the new level (a level 1 booster who wants level 3 pays 3000 credits or 7.99).
- The server runs at the highest active level. While level 3 is active, levels 1 and 2 can't be bought.
- If someone buys level 1 and someone else then buys level 3, the level 1 booster keeps their tag until their own boost would have ended.
- The booster tag belongs to the person and only shows in that server.
- A boost paid with credits and one paid with money count the same. Nothing is gated on how it was paid for.

## Refunds

- No refunds when a user asks.
- If the server is deleted, every booster gets the unused part of their boost back.
- refund = price x (time remaining / 14 days), rounded down at the end, not per day.
- Use exact time remaining (hours or minutes), not whole days, so a boost deleted the same day can't return 100%.
- Credit example: 1000 credits, server deleted after 3 days. 1000 x 11/14 = 785.7, refund 785.
- This applies to boosts hidden behind a higher level too, based on their own timer.
- Boosts that are queued and haven't started get a full refund.
- Refund goes to the person who paid. Credit refunds are not counted as earned credits, so they don't touch the message credit limit.
- Real money boosts: see the open decision below.

## Still to decide

- **Real money refunds.** Deleting a server could return the unused part as credits instead of money. That avoids card refunds and chargeback handling but needs to be stated clearly at checkout. Full cash refunds are possible but cost payment fees and extra work.
- **Currency and tax.** The prices need a currency (USD?), and the payment provider has to handle sales tax or VAT.
- **Payment provider.** Stripe or similar for web and desktop. On the iOS and Android apps, selling digital perks usually has to go through Apple and Google in-app purchase, which take a cut. Check before building the mobile side.
- **Messaging.** The line "everything that costs money on Discord is free here" needs rewording if boosts can be bought. The credit price keeps a free path, which helps, but say so plainly in the video and description.
- **Credit-to-money gap.** 1000 credits vs 2.99 sets what a credit is worth. The "1.00 cheaper than buying credits" rule assumes there is a credit pack to compare against, and the repo has none yet. Decide the credit pack prices first, then the boost prices follow (pack price for the same credits minus 1.00). If credits are easy to earn, the paid option is a convenience. If they are slow to earn, it reads as pay to win. Worth checking against how fast people actually earn credits.
- **Hidden boosts.** When level 3 covers a level 1, does the level 1 timer keep running or pause? Leaning towards pause, so the booster doesn't lose time they paid for. Either way, when level 3 ends the server should fall back to the highest boost still running.
- **Same-level buys.** Can a second level 2 extend the first (28 days, queued) or just overlap? Queueing is simplest.
- **Renewing your own boost early.** Extend from the current end date or restart?
- **Upgrade discount.** Full price on upgrade means the lower boost's value is mostly wasted. Option: credit for the remaining time.
- **Multiplier cap.** Does 1.5x apply to everyone's messages or only the booster's? Add a cap so it can't inflate credits.
- **Booster leaves or gets banned.** Does the boost keep running or end?
- **Abuse.** Create a server, boost it, delete it for the refund. A minimum server age before boosting, or a delay before deletion finalizes, would stop most of it. Also check whether owners boosting their own server can be farmed.
- **Where it plugs in.** Explorer sorting is in `GET /api/explore` in `server/index.js` (tags and name matches already boost ranking there). Credits and the Shop are the other places to read before sketching the changes.
