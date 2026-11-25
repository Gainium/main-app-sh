---
bump: patch
section: Fixed
---
- Futures deals closed by an exchange liquidation, or closed on the exchange outside the bot, are now booked closed at the price of the exchange's own closing fills instead of being left open or closed at zero; a liquidation the exchange runs in chunks closes the deal only once the position is gone
