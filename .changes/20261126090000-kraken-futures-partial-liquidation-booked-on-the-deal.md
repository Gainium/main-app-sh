---
bump: patch
section: Fixed
---
- Kraken Futures: a partial liquidation is now booked on the DCA and Combo deals that held the position (newest deal first): the liquidated quantity leaves the deal, the loss is realised at the liquidation price, take profit and grid exits are re-sized to what is left, and the user is told. A periodic check of the account's fills books a liquidation the realtime feed missed.
