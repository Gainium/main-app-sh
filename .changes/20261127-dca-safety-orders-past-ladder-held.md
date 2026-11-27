---
bump: patch
section: Fixed
---
- DCA safety orders are no longer moved to the market price and re-sent every cycle when the price has gone far past the deal's deepest safety level; they wait for the price to come back and the bot shows one warning instead of an error
- A safety order moved to the market price and refused as below the exchange's minimum order value now waits for the price with one warning instead of putting the bot in error each cycle
