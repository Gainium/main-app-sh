---
bump: patch
section: Fixed
---
- A safety order that never reached the exchange and had been set aside as unreadable is now retired and placed again once the exchange confirms it does not exist. Before, the deal kept counting it as resting on the exchange.
