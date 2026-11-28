---
bump: patch
section: Fixed
---
- Starting or saving a spot DCA or combo bot now warns, per pair, when another bot on the same exchange account trades that pair in the opposite direction: both bots draw on one wallet balance, so either may be unable to close a deal in full. The bot still starts and trades as before.
