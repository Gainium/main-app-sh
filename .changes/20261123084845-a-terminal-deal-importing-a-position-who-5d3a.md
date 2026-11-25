---
bump: patch
section: Fixed
---
- A terminal deal importing a position whose size and price give no tradable quantity is refused with a message instead of opening an empty deal that can never be saved; such deals already stored are cancelled on their next restart, and a futures deal's average now ignores entry rows that filled nothing
