---
bump: patch
section: Fixed
---
- A stop-loss split no longer rests limit slices at the stop price: slices chase the market, time out to market, and a breached floor executes the rest
