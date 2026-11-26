---
bump: patch
section: Fixed
---
- Futures grid take profit and stop loss ("stop and sell") no longer stop working when the close order fills only partly; the filled part is booked into the position and profit, and the rest of the position is closed, also after a restart
