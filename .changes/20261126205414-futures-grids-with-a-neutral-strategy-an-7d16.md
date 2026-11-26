---
bump: patch
section: Fixed
---
- Futures grids with a neutral strategy and no value-changed take profit or stop loss now value their open position against the entry of the fills not yet matched into a grid round trip, the same entry their close books at, instead of the average of every fill. Realized plus unrealized profit now adds up to what the bot's own fills produced. The figures can differ from the exchange's, which values the position at its average entry. Closing profit is unchanged.
