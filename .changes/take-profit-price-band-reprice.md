---
bump: patch
section: Fixed
---
- A deal's take profit the price has already passed, refused by the exchange's price band, is now re-sent at the market price instead of the same price, and the bot reports an error if the exchange refuses that too
