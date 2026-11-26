---
bump: patch
section: Fixed
---
- Safety orders and take profits Binance refuses for sitting outside its price band (`PERCENT_PRICE_BY_SIDE`) are now held and placed once the price comes within range, with one notice to the user, instead of being re-sent on every bot reload; a deal's take profit held this way is reported as missing from the exchange, and a missing take profit's re-sends stay given up across restarts
