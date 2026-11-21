---
bump: patch
section: Fixed
---
- A Binance DCA or Combo safety order or Combo grid order the price already ran through, refused by Binance's percent-price filter, is now re-sent once at the market price like on other exchanges, and shows an error if it still cannot be placed
