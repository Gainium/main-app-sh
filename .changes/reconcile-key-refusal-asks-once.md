---
bump: patch
section: Fixed
---
- An order check after a user-stream reconnect stops on the first lookup the exchange refuses because the API key may not read orders, instead of asking about every order three times; the orders stay as they were
