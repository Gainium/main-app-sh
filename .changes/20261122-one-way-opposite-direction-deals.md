---
bump: patch
section: Fixed
---
- On one-way futures accounts, a DCA or combo bot no longer opens a deal against the opposite direction the account already holds on that symbol, and a take-profit refused because the net position is on the other side is reported as an error instead of being booked as a profitable close
