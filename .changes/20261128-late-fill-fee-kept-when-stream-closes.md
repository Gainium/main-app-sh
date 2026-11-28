---
bump: patch
section: Fixed
---
- A late fill fee is no longer lost when the bot's order stream closes in the same moment as the fill; every late fee that cannot be saved is now logged with its reason
