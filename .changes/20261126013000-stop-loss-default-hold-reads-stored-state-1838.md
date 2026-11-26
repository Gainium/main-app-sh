---
bump: patch
section: Fixed
---
- A stop loss with no saved close condition on a deal already past its level is no longer closed at market when the bot restarts from its saved snapshot; the hold is decided on the stored bot and deal, not the in-memory copy
