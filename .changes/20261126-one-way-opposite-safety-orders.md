---
bump: patch
section: Fixed
---
- On one-way futures accounts, a DCA or combo safety order that would only reduce another bot's opposite position on the same symbol is held and retried instead of sent, and a new deal or safety order is also held while the exchange position cannot be read and an opposite-direction bot trades that symbol
