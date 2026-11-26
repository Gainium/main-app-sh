---
bump: patch
section: Fixed
---
- Bot create via the v2 API now refuses numeric text that is only partly a number (such as "3,5" or "3abc"), matching how the bot reads it.
