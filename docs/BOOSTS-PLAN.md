# Server boosts

Members boost a server with credits. Rules live in `server/boosts.js`; tests in `server/boosts-test.js` (`npm run test:boosts`). Real-money boosting is not built.

## Tiers

All boosts last 14 days. Perks stack upward.

| Level | Credits | Perks |
|-------|---------|-------|
| 1 | 1000 | Server explorer boost (ranks above an equal match in `GET /api/explore`), booster tag |
| 2 | 2000 | Level 1 perks, 1080p 60fps screenshare for everyone in the server's voice channels |
| 3 | 3000 | Level 2 perks, 1.5x credits on messages sent in the server |

## Rules

- Boosts don't combine. 3 x level 1 is still level 1.
- The server runs at the highest running boost. While a higher level runs, a lower one can't be bought.
- A person has one boost per server. A higher level replaces their own lower boost at the full price (nothing is given back). To renew, wait until it has ended.
- Different people can overlap at the same level. There is no queueing or extending.
- A boost hidden behind a higher one keeps running. When the higher one ends, the server falls back to the highest boost still running, and the hidden booster keeps their tag until their own boost ends.
- The booster tag belongs to the person and only shows in that server.

## Free boost for Aduna Plus

Every calendar month (UTC) a Plus member gets one free level 3 boost for 14 days on any server they are in (`buyFree` in `boosts.js`, `POST /api/servers/:id/boost/free`). The month used is kept on the person as `freeBoostMonth`. It follows the normal rules: one boost per person per server, it replaces their own lower boost, and it can't be started on a server where they already have level 3 (that refusal doesn't use up the month). It is stored with `credits: 0`, so deleting the server refunds nothing for it. If Plus ends while it runs, the boost keeps running to its end.

## Message multiplier (decision)

At level 3 a message pays 1.5x (rounded). Only the base amount counts against the 40-credit daily cap. The extra is paid on top of the cap; the cap itself does not rise. Change this in `credits.js` (`rewardMessage`) if the cap should rise instead.

## Refunds

- No refunds when a user asks.
- If the server is deleted, every running boost gives back its unused time to the person who paid: price x (exact time left / 14 days), rounded down at the end. A boost hidden behind a higher level is refunded on its own timer.
- Example: 1000 credits, server deleted after 3 days: 1000 x 11/14 = 785.7, refund 785.
- Refunds use the `refund` grant kind in `credits.js`: they reduce `spent` and count as neither earned nor bought, so they don't touch the message cap.

## Where it plugs in

- `server/index.js`: `serverView` includes `boost: { level, boosters }`; `GET` and `POST /api/servers/:id/boost`; `destroyServer` refunds; `/api/explore` sorts and returns `boostLevel`.
- Client: "Boost server" in the server menu (`BoostModal.jsx`), the Booster tag in chat (`Chat.jsx`), and `useVoice` takes `boostLevel` so level 2+ servers share at Plus quality.

## Still to decide

- **Real money.** The credit packs already cost 2.99 USD for 1000 credits (3.99 CAD), so a level 1 money boost at 2.99 is the same price as buying the credits. To undercut, money boosts need a lower price (for example 1.99 for level 1). Also open: refunds as credits vs cash, tax, and Apple/Google in-app purchase rules for the mobile apps.
- **Booster leaves or gets banned.** Currently the boost keeps running.
- **Abuse.** Create a server, boost it, delete it for the refund. Consider a minimum server age before boosting, or a delay before deletion finalizes.
- **Upgrade discount.** Full price on upgrade wastes the lower boost's remaining value. Option: credit the remaining time.
- **Messaging.** "Everything that costs money on Discord is free here" needs rewording if money boosts are ever sold.
