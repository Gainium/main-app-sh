---
bump: patch
section: Fixed
---
- A stop loss whose level cannot be worked out (0 or not a number) is skipped and reported once instead of being checked against the price, which closed short deals at market on the next tick
