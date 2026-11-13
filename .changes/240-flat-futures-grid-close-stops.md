---
bump: patch
section: Fixed
---
- Closing a futures grid at market or limit with no open position now stops the bot instead of sending a zero-size close and leaving it open with no orders; a refused close order is retried
