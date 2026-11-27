---
bump: patch
section: Fixed
---
- A Binance USDⓈ-M or COIN-M deal whose position was closed outside the bot (by hand on the exchange, or by the venue) is now priced from the venue's closing fills instead of being booked with an unknown profit: the account-fills read now names the deal's symbol, which Binance requires
