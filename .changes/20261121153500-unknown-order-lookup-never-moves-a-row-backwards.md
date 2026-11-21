---
bump: patch
section: Fixed
---
- An order lookup during a deal close no longer downgrades an order the user stream already reported filled, so a grid exit filling at the moment of close is counted in the deal's balances and profit
