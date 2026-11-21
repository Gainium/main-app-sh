---
bump: minor
section: Added
---
- Closing a deal by hand can now be done at market, with a limit (at the current price or a chosen price), with a chasing limit or as a split order, each with its own timeout; `closeDCADeal` / `closeComboDeal` take `execution` and `limitPrice`
