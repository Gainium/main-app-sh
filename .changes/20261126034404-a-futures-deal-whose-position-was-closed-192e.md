---
bump: patch
section: Fixed
---
- A futures deal whose position was closed on the exchange outside the bot (liquidation, hand close, another tool) is booked at the price and fees of the exchange's own closing fills, marked closed outside the bot, and the user is told; where the exchange does not report those fills the deal is flagged profit unknown instead of showing a near-zero result. A take profit refused for a position that has been gone for an hour now closes the deal instead of leaving it open, and the fills-priced close no longer leaves the deal open.
