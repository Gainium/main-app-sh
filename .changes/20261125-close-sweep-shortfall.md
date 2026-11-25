---
bump: patch
section: Fixed
---
- A spot long deal whose closing sell the exchange refused for insufficient balance no longer closes as an ordinary profit: if the coins are still on the account but held by other open orders, the deal stays open and keeps closing the rest by limit; otherwise it closes, records the unsold amount and tells the user.
