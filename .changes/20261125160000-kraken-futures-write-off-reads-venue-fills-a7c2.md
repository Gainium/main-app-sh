---
bump: patch
section: Fixed
---
- A Kraken Futures order the venue no longer describes is checked against the account's fill history before it is written off, so an order that filled while the order stream was down is booked as filled instead of cancelled with nothing executed
