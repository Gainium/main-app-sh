---
bump: patch
section: Fixed
---
- An order the exchange never confirmed no longer stays open forever once its deal has closed: the bot now asks the exchange about it once when it loads, marks it canceled if the exchange never had it, and records it if it did, without placing anything again
