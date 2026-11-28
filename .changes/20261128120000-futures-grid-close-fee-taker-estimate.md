---
bump: patch
section: Fixed
---
- Futures grid bots now estimate the fee of a position close that took liquidity (a market close, or a limit close that filled on arrival) at the taker rate when the exchange reports no fee, instead of the maker rate, so profit is no longer overstated on those closes
