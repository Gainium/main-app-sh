---
bump: patch
section: Fixed
---
- Combo grid orders the market has already passed are re-sent at the price the exchange accepts instead of being refused at a stale price on every retry, and an order the exchange still refuses on price now puts the bot in error
