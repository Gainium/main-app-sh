---
bump: patch
section: Fixed
---
- Spot deals are put on hold when the exchange changes a token's ratio (the price and the base balance both jumped by a like factor that no trade explains): take profit, safety orders and automatic closes pause until the deals are converted to the new units, and a manual close still runs
