---
bump: patch
section: Fixed
---
- A grid bot that stops itself (take profit or stop loss with the stop action, liquidation, a filled close order, missing exchange info) now cancels part-filled levels too, instead of leaving them resting on the exchange
