---
bump: patch
section: Fixed
---
- Futures combo deals whose exchange position is smaller than the deal records now tell the user once, with both quantities, and stop re-sending the closing grid orders the exchange keeps refusing until the deal's position changes
