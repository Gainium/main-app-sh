---
bump: patch
section: Fixed
---
- A DCA take profit is no longer replaced while the exchange has not confirmed the old one was cancelled; the bot checks again with a back-off and replaces it once the old order is gone
